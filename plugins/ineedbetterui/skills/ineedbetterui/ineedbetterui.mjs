#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const APP_NAME = 'ineedbetterui';
const MAX_REQUEST_BYTES = 2_000_000;
const DEFAULT_MAX_RESPONSE_CHARS = 3_000;
const DEFAULT_MAX_UNSEEN_EVENTS = 20;
const PREVIEW_CHARS = 200;
const GENESIS_HASH = '0'.repeat(16);
const HEALTH_TIMEOUT_MS = 600;
const KINDS = new Set(['question', 'report', 'decision', 'error', 'done', 'other']);
const QUESTION_MODES = new Set(['cleaned', 'raw']);

const projectPath = fs.realpathSync.native(process.cwd());
// A stable ID for the project folder: lets a new start recognise the server
// already running for this project.
const sessionId = createHash('sha256')
  .update(process.platform === 'win32' ? projectPath.toLowerCase() : projectPath)
  .digest('hex')
  .slice(0, 12);
// Records live inside the project, in node_modules/.ineedbetterui. Most projects
// already ignore node_modules, and the folder's own .gitignore covers the rest.
const sessionDir = path.join(projectPath, 'node_modules', `.${APP_NAME}`);
const dataPath = path.join(sessionDir, 'transcript.jsonl');

function ensureSessionDir() {
  fs.mkdirSync(sessionDir, { recursive: true });
  const ignoreFile = path.join(sessionDir, '.gitignore');
  if (!fs.existsSync(ignoreFile)) fs.writeFileSync(ignoreFile, '*\n', 'utf8');
}
// Broadcast is on unless --no-broadcast is given; other arguments are ignored.
const broadcastMode = !process.argv.slice(2).includes('--no-broadcast');
let serverPort = null;

function nowIso() {
  const date = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const minutes = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
    + `${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/[<>&\u2028\u2029]/g, char => ({
      '<': '\\u003c',
      '>': '\\u003e',
      '&': '\\u0026',
      '\u2028': '\\u2028',
      '\u2029': '\\u2029'
    }[char]));
}

// A small, dependency-free byte-mode QR encoder for the broadcast access URL.
// Version 4-L holds up to 80 UTF-8 bytes, which is ample for a local HTTP URL.
const QR_VERSION = 4;
const QR_SIZE = 17 + QR_VERSION * 4;
const QR_DATA_CODEWORDS = 80;
const QR_ECC_CODEWORDS = 20;

function gfMultiply(left, right) {
  let result = 0;
  let a = left;
  let b = right;
  while (b > 0) {
    if (b & 1) result ^= a;
    b >>>= 1;
    a <<= 1;
    if (a & 0x100) a ^= 0x11d;
  }
  return result;
}

function qrGeneratorPolynomial(eccLength) {
  let generator = [1];
  let root = 1;
  for (let index = 0; index < eccLength; index += 1) {
    const next = Array(generator.length + 1).fill(0);
    generator.forEach((coefficient, coefficientIndex) => {
      next[coefficientIndex] ^= coefficient;
      next[coefficientIndex + 1] ^= gfMultiply(coefficient, root);
    });
    generator = next;
    root = gfMultiply(root, 2);
  }
  return generator;
}

function qrErrorCorrection(data, eccLength) {
  const generator = qrGeneratorPolynomial(eccLength);
  const remainder = Array(eccLength).fill(0);
  data.forEach(byte => {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[eccLength - 1] = 0;
    for (let index = 0; index < eccLength; index += 1) {
      remainder[index] ^= gfMultiply(generator[index + 1], factor);
    }
  });
  return remainder;
}

function qrMask(mask, row, column) {
  if (mask === 0) return (row + column) % 2 === 0;
  if (mask === 1) return row % 2 === 0;
  if (mask === 2) return column % 3 === 0;
  if (mask === 3) return (row + column) % 3 === 0;
  if (mask === 4) return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
  if (mask === 5) return (row * column) % 2 + (row * column) % 3 === 0;
  if (mask === 6) return ((row * column) % 2 + (row * column) % 3) % 2 === 0;
  return ((row * column) % 3 + (row + column) % 2) % 2 === 0;
}

function qrSetFunction(matrix, functions, x, y, value) {
  if (x < 0 || x >= QR_SIZE || y < 0 || y >= QR_SIZE) return;
  matrix[y][x] = Boolean(value);
  functions[y][x] = true;
}

function qrDrawFinder(matrix, functions, centerX, centerY) {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const dark = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6
        && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      qrSetFunction(matrix, functions, centerX + dx - 3, centerY + dy - 3, dark);
    }
  }
}

function qrDrawAlignment(matrix, functions, centerX, centerY) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      qrSetFunction(matrix, functions, centerX + dx, centerY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function qrReserveFormat(functions) {
  for (let index = 0; index < 15; index += 1) {
    const vertical = index < 6 ? index : index < 8 ? index + 1 : QR_SIZE - 15 + index;
    const horizontal = index < 8 ? QR_SIZE - index - 1 : index < 9 ? 15 - index : 14 - index;
    functions[vertical][8] = true;
    functions[8][horizontal] = true;
  }
  functions[QR_SIZE - 8][8] = true;
}

function qrFormatBits(mask) {
  const data = (1 << 3) | mask; // Error correction level L is format value 01.
  let remainder = data << 10;
  const generator = 0x537;
  while (remainder >= 0x400) {
    remainder ^= generator << (Math.floor(Math.log2(remainder)) - 10);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function qrDrawFormat(matrix, functions, mask) {
  const bits = qrFormatBits(mask);
  for (let index = 0; index < 15; index += 1) {
    const bit = ((bits >>> index) & 1) !== 0;
    const vertical = index < 6 ? index : index < 8 ? index + 1 : QR_SIZE - 15 + index;
    const horizontal = index < 8 ? QR_SIZE - index - 1 : index < 9 ? 15 - index : 14 - index;
    qrSetFunction(matrix, functions, 8, vertical, bit);
    qrSetFunction(matrix, functions, horizontal, 8, bit);
  }
  qrSetFunction(matrix, functions, 8, QR_SIZE - 8, true);
}

function qrDrawCodewords(matrix, functions, codewords) {
  let bitIndex = 0;
  let upward = true;
  for (let right = QR_SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let offset = 0; offset < QR_SIZE; offset += 1) {
      const row = upward ? QR_SIZE - 1 - offset : offset;
      for (let side = 0; side < 2; side += 1) {
        const column = right - side;
        if (functions[row][column]) continue;
        matrix[row][column] = bitIndex < codewords.length * 8
          ? ((codewords[Math.floor(bitIndex / 8)] >>> (7 - (bitIndex % 8))) & 1) !== 0
          : false;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
  if (bitIndex < codewords.length * 8) throw new Error('QR 데이터 배치에 실패했습니다.');
}

function qrPenalty(matrix) {
  let penalty = 0;
  const size = matrix.length;
  for (let row = 0; row < size; row += 1) {
    let runColor = matrix[row][0];
    let runLength = 1;
    for (let column = 1; column <= size; column += 1) {
      if (column < size && matrix[row][column] === runColor) {
        runLength += 1;
      } else {
        if (runLength >= 5) penalty += 3 + runLength - 5;
        if (column < size) { runColor = matrix[row][column]; runLength = 1; }
      }
    }
  }
  for (let column = 0; column < size; column += 1) {
    let runColor = matrix[0][column];
    let runLength = 1;
    for (let row = 1; row <= size; row += 1) {
      if (row < size && matrix[row][column] === runColor) {
        runLength += 1;
      } else {
        if (runLength >= 5) penalty += 3 + runLength - 5;
        if (row < size) { runColor = matrix[row][column]; runLength = 1; }
      }
    }
  }
  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const value = matrix[row][column];
      if (matrix[row][column + 1] === value && matrix[row + 1][column] === value && matrix[row + 1][column + 1] === value) penalty += 3;
    }
  }
  const pattern = [true, false, true, true, true, false, true];
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column <= size - pattern.length; column += 1) {
      if (!pattern.every((value, index) => matrix[row][column + index] === value)) continue;
      const before = column >= 4 && matrix[row].slice(column - 4, column).every(value => !value);
      const after = column + 11 <= size && matrix[row].slice(column + 7, column + 11).every(value => !value);
      if (before || after) penalty += 40;
    }
  }
  for (let column = 0; column < size; column += 1) {
    for (let row = 0; row <= size - pattern.length; row += 1) {
      if (!pattern.every((value, index) => matrix[row + index][column] === value)) continue;
      let before = row >= 4;
      for (let index = 1; before && index <= 4; index += 1) before = !matrix[row - index][column];
      let after = row + 11 <= size;
      for (let index = 7; after && index <= 10; index += 1) after = !matrix[row + index][column];
      if (before || after) penalty += 40;
    }
  }
  let dark = 0;
  matrix.forEach(line => line.forEach(value => { if (value) dark += 1; }));
  penalty += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return penalty;
}

function makeQrCode(text) {
  const payload = Buffer.from(String(text), 'utf8');
  const bits = [0, 1, 0, 0];
  for (let index = 7; index >= 0; index -= 1) bits.push((payload.length >>> index) & 1);
  payload.forEach(byte => { for (let index = 7; index >= 0; index -= 1) bits.push((byte >>> index) & 1); });
  if (bits.length > QR_DATA_CODEWORDS * 8) throw new Error('브로드캐스트 URL이 QR 코드 용량을 초과합니다.');
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let index = 0; index < bits.length; index += 8) data.push(bits.slice(index, index + 8).reduce((value, bit) => (value << 1) | bit, 0));
  let pad = 0xec;
  while (data.length < QR_DATA_CODEWORDS) { data.push(pad); pad ^= 0xfd; }
  const codewords = data.concat(qrErrorCorrection(data, QR_ECC_CODEWORDS));
  const matrix = Array.from({ length: QR_SIZE }, () => Array(QR_SIZE).fill(null));
  const functions = Array.from({ length: QR_SIZE }, () => Array(QR_SIZE).fill(false));
  qrDrawFinder(matrix, functions, 3, 3);
  qrDrawFinder(matrix, functions, QR_SIZE - 4, 3);
  qrDrawFinder(matrix, functions, 3, QR_SIZE - 4);
  [6, QR_SIZE - 7].forEach(centerY => [6, QR_SIZE - 7].forEach(centerX => {
    if (!functions[centerY][centerX]) qrDrawAlignment(matrix, functions, centerX, centerY);
  }));
  for (let index = 8; index < QR_SIZE - 8; index += 1) {
    if (!functions[6][index]) qrSetFunction(matrix, functions, index, 6, index % 2 === 0);
    if (!functions[index][6]) qrSetFunction(matrix, functions, 6, index, index % 2 === 0);
  }
  qrReserveFormat(functions);
  qrDrawCodewords(matrix, functions, codewords);
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = matrix.map(line => line.slice());
    for (let row = 0; row < QR_SIZE; row += 1) {
      for (let column = 0; column < QR_SIZE; column += 1) {
        if (!functions[row][column]) candidate[row][column] = candidate[row][column] !== qrMask(mask, row, column);
      }
    }
    qrDrawFormat(candidate, functions, mask);
    const score = qrPenalty(candidate);
    if (score < bestScore) { bestScore = score; best = candidate; }
  }
  return { size: QR_SIZE, modules: best.flat().map(value => value ? '1' : '0').join('') };
}

function normalizeQr(value) {
  if (!value || !Number.isInteger(value.size) || value.size < 21 || value.size > 177 || typeof value.modules !== 'string') return null;
  if (value.modules.length !== value.size * value.size || /[^01]/.test(value.modules)) return null;
  return { size: value.size, modules: value.modules };
}

function emptyCurrentState() {
  return {
    entries: [],
    byId: new Map(),
    outline: { done: false, items: [] },
    pin: null,
    replyTarget: null,
    questionMode: 'cleaned',
    maxResponseChars: DEFAULT_MAX_RESPONSE_CHARS,
    maxUnseenEvents: DEFAULT_MAX_UNSEEN_EVENTS,
    broadcast: null
  };
}

function eventEntry(event) {
  return {
    id: event.id,
    kind: event.kind,
    time: event.time,
    heading: event.heading || '',
    body: event.body || '',
    rawBody: event.rawBody,
    cleanedBody: event.cleanedBody,
    questionMode: event.questionMode,
    clientRef: event.clientRef,
    replyTo: typeof event.replyTo === 'string' && event.replyTo ? event.replyTo : undefined,
    broadcastId: typeof event.broadcastId === 'string' && event.broadcastId ? event.broadcastId : undefined,
    broadcastUrl: typeof event.broadcastUrl === 'string' && event.broadcastUrl ? event.broadcastUrl : undefined,
    broadcastPort: Number.isInteger(event.broadcastPort) ? event.broadcastPort : undefined,
    qr: normalizeQr(event.qr) || undefined,
    notes: [],
    revisions: []
  };
}

function applyEvent(current, event) {
  if (!event || typeof event !== 'object') return;
  if (event.t === 'entry' && typeof event.id === 'string') {
    const entry = eventEntry(event);
    current.entries.push(entry);
    current.byId.set(entry.id, entry);
    if (entry.broadcastUrl && entry.qr) {
      current.broadcast = {
        enabled: true,
        id: entry.broadcastId || entry.id,
        url: entry.broadcastUrl,
        port: entry.broadcastPort || null,
        entryId: entry.id
      };
    }
    if (event.kind !== 'question' && current.replyTarget) current.replyTarget = null;
    return;
  }
  if (event.t === 'note' && current.byId.has(event.target)) {
    current.byId.get(event.target).notes.push({
      id: event.id,
      target: event.target,
      time: event.time,
      anchor: typeof event.anchor === 'string' ? event.anchor : '',
      title: typeof event.title === 'string' ? event.title : '',
      text: typeof event.text === 'string' ? event.text : ''
    });
    return;
  }
  if (event.t === 'revision' && current.byId.has(event.target)) {
    const entry = current.byId.get(event.target);
    const revision = { id: event.id, target: event.target, time: event.time, body: event.body || '' };
    entry.revisions.push(revision);
    entry.body = revision.body;
    return;
  }
  if (event.t === 'pin') {
    const target = typeof event.target === 'string' && event.target ? event.target : null;
    current.pin = {
      target,
      source: event.source === 'user' ? 'user' : 'agent'
    };
    if (current.replyTarget && current.replyTarget !== target) current.replyTarget = null;
    return;
  }
  if (event.t === 'outline') {
    current.outline = {
      done: event.done === true,
      items: Array.isArray(event.items) ? event.items : []
    };
    return;
  }
  if (event.t === 'reply-target') {
    const target = typeof event.target === 'string' && event.target ? event.target : null;
    if (!target) {
      current.replyTarget = null;
      return;
    }
    if (current.pin?.target === target && current.byId.get(target)?.kind !== 'question') current.replyTarget = target;
    return;
  }
  if (event.t === 'settings') {
    if (QUESTION_MODES.has(event.questionMode)) current.questionMode = event.questionMode;
    if (Number.isInteger(event.maxResponseChars) && event.maxResponseChars >= 0) current.maxResponseChars = event.maxResponseChars;
    if (Number.isInteger(event.maxUnseenEvents) && event.maxUnseenEvents >= 0) current.maxUnseenEvents = event.maxUnseenEvents;
  }
}

function loadRuntime() {
  const current = emptyCurrentState();
  const allEntries = new Map();
  const clientRefs = new Map();
  const events = [];
  let nextEntryNo = 0;
  let head = GENESIS_HASH;

  const contents = fs.existsSync(dataPath) ? fs.readFileSync(dataPath, 'utf8') : '';
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Every line extends a hash chain, so a client that remembers one hash can
    // be told exactly which events it has not seen.
    head = createHash('sha256').update(`${head}\n${line}`).digest('hex').slice(0, 16);
    let event = null;
    try {
      event = JSON.parse(line);
    } catch {}
    if (!event || typeof event !== 'object') {
      events.push({ hash: head, event: null });
      continue;
    }
    events.push({ hash: head, event });
    if (event.t === 'entry' && typeof event.id === 'string') {
      const match = /^a-(\d+)$/.exec(event.id);
      if (match) nextEntryNo = Math.max(nextEntryNo, Number(match[1]));
      const entry = eventEntry(event);
      allEntries.set(entry.id, entry);
      if (typeof entry.clientRef === 'string' && entry.clientRef) clientRefs.set(entry.clientRef, entry);
    }
    if (event.t === 'reset') {
      current.entries = [];
      current.byId = new Map();
      current.outline = { done: false, items: [] };
      current.pin = null;
      current.replyTarget = null;
      current.questionMode = 'cleaned';
      current.maxResponseChars = DEFAULT_MAX_RESPONSE_CHARS;
      current.maxUnseenEvents = DEFAULT_MAX_UNSEEN_EVENTS;
      current.broadcast = null;
      continue;
    }
    applyEvent(current, event);
  }

  const hashIndex = new Map([[GENESIS_HASH, -1]]);
  events.forEach((item, index) => hashIndex.set(item.hash, index));
  return { current, allEntries, clientRefs, nextEntryNo, events, head, hashIndex };
}

let runtime = loadRuntime();

// Returns the new head hash, which is the hash of the event just written.
function appendEvent(event) {
  ensureSessionDir();
  fs.appendFileSync(dataPath, `${JSON.stringify(event)}\n`, 'utf8');
  runtime = loadRuntime();
  return runtime.head;
}

function textPreview(text) {
  const chars = Array.from(text || '');
  if (chars.length <= PREVIEW_CHARS) return { body: text || '' };
  return { preview: chars.slice(0, PREVIEW_CHARS).join(''), length: chars.length, truncated: true };
}

// A compact view of one event for agents. Responses and their revisions are
// previewed; questions, notes, pins, outlines and settings are sent in full.
function eventSummary({ hash, event }) {
  if (!event) return { hash, t: 'invalid' };
  const item = { hash, t: event.t, time: event.time };
  if (event.t === 'entry') {
    Object.assign(item, { id: event.id, kind: event.kind, heading: event.heading || '' });
    if (event.replyTo) item.replyTo = event.replyTo;
    if (event.broadcastUrl) item.broadcastUrl = event.broadcastUrl;
    if (event.kind === 'question') return Object.assign(item, { body: event.body || '', questionMode: event.questionMode });
    return Object.assign(item, textPreview(event.body));
  }
  if (event.t === 'note') {
    return Object.assign(item, { id: event.id, target: event.target, anchor: event.anchor || '', title: event.title || '', text: event.text || '' });
  }
  if (event.t === 'revision') {
    Object.assign(item, { id: event.id, target: event.target });
    return Object.assign(item, runtime.allEntries.get(event.target)?.kind === 'question' ? { body: event.body || '' } : textPreview(event.body));
  }
  if (event.t === 'pin' || event.t === 'reply-target') return Object.assign(item, { target: event.target || null, source: event.source });
  if (event.t === 'outline') return Object.assign(item, { done: event.done === true, items: Array.isArray(event.items) ? event.items : [] });
  if (event.t === 'settings') {
    for (const key of ['questionMode', 'maxResponseChars', 'maxUnseenEvents']) if (key in event) item[key] = event[key];
  }
  return item;
}

// Compares a client's last known head with the chain. `ownHash` is the event
// written by the current request, which the client already knows about.
function syncResult(knownHead, { ownHash = null, limit } = {}) {
  const result = { head: runtime.head, eventCount: runtime.events.length };
  const index = typeof knownHead === 'string' ? runtime.hashIndex.get(knownHead) : undefined;
  if (index === undefined) {
    const status = typeof knownHead === 'string' && knownHead ? 'unknown' : 'none';
    const unseen = limit > 0 ? runtime.events.slice(-limit).map(eventSummary) : [];
    return { ...result, status, unseenCount: null, truncated: false, unseen };
  }
  const later = runtime.events.slice(index + 1).filter(item => item.hash !== ownHash);
  const cap = limit ?? runtime.current.maxUnseenEvents;
  const shown = cap > 0 ? later.slice(-cap) : later;
  return {
    ...result,
    status: later.length ? 'behind' : 'current',
    unseenCount: later.length,
    truncated: shown.length < later.length,
    unseen: shown.map(eventSummary)
  };
}

function writeResponse(res, status, payload, knownHead, ownHash = null) {
  return jsonResponse(res, status, { ok: true, ...payload, state: stateSummary(), sync: syncResult(knownHead, { ownHash }) });
}

function entryRef(entry) {
  const result = { id: entry.id, kind: entry.kind, time: entry.time, heading: entry.heading };
  if (entry.replyTo) result.replyTo = entry.replyTo;
  return Object.assign(result, { noteCount: entry.notes.length, revisionCount: entry.revisions.length });
}

function publicEntry(entry, full = false) {
  const result = {
    id: entry.id,
    kind: entry.kind,
    time: entry.time,
    heading: entry.heading
  };
  if (entry.replyTo) result.replyTo = entry.replyTo;
  if (!full) return result;
  result.body = entry.body;
  result.notes = entry.notes.map(note => ({ ...note }));
  result.revisions = entry.revisions.map(revision => ({ ...revision }));
  if (entry.kind === 'question') {
    result.rawBody = entry.rawBody ?? entry.body;
    result.cleanedBody = entry.cleanedBody ?? entry.body;
    result.questionMode = entry.questionMode || 'cleaned';
  }
  if (entry.clientRef) result.clientRef = entry.clientRef;
  if (full && entry.broadcastUrl && entry.qr) {
    result.broadcastId = entry.broadcastId || entry.id;
    result.broadcastUrl = entry.broadcastUrl;
    result.broadcastPort = entry.broadcastPort;
    result.qr = { ...entry.qr };
  }
  return result;
}

function stateSummary() {
  const current = runtime.current;
  const lastEntry = current.entries.at(-1);
  const candidatePinTarget = current.pin?.target ? current.byId.get(current.pin.target) : null;
  const pinTarget = candidatePinTarget && candidatePinTarget.kind !== 'question'
    ? candidatePinTarget
    : null;
  const replyTarget = pinTarget && current.replyTarget === pinTarget.id
    ? pinTarget.id
    : null;
  return {
    mode: 'record',
    outline: current.outline.items.map(item => ({ ...item })),
    outlineDone: current.outline.done,
    pin: pinTarget ? {
      target: pinTarget.id,
      source: current.pin.source,
      revisionCount: pinTarget.revisions.length
    } : null,
    replyTarget,
    questionMode: current.questionMode,
    broadcast: broadcastMode && current.broadcast ? { ...current.broadcast } : null,
    maxResponseChars: current.maxResponseChars,
    maxUnseenEvents: current.maxUnseenEvents,
    head: runtime.head,
    eventCount: runtime.events.length,
    lastEntry: lastEntry ? { id: lastEntry.id, kind: lastEntry.kind, time: lastEntry.time } : null,
    entryCount: current.entries.length
  };
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function errorResponse(res, status, message, extra = {}) {
  jsonResponse(res, status, { ok: false, error: message, written: false, ...extra });
}

function htmlResponse(res, body) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_REQUEST_BYTES) {
        reject(new Error('요청 본문이 너무 큽니다.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON 본문을 읽을 수 없습니다.'));
      }
    });
    req.on('error', reject);
  });
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name}은(는) 비어 있을 수 없습니다.`);
  return value;
}

function responseCharCount(value) {
  return Array.from(value).length;
}

function enforceResponseLimit(value) {
  const maxResponseChars = runtime.current.maxResponseChars;
  if (maxResponseChars === 0) return;
  const count = responseCharCount(value);
  if (count > maxResponseChars) {
    const error = new Error(`응답 본문은 최대 ${maxResponseChars}자까지 기록할 수 있습니다. (현재 ${count}자)`);
    error.maxResponseChars = maxResponseChars; error.length = count;
    throw error;
  }
}

function currentEntry(id) {
  if (!/^a-\d+$/.test(id) || !runtime.current.byId.has(id)) throw new Error('대상 응답을 찾을 수 없습니다.');
  return runtime.current.byId.get(id);
}

function pinEntry(id) {
  const entry = currentEntry(id);
  if (entry.kind === 'question') throw new Error('질문은 핀할 수 없습니다.');
  return entry;
}

function activeReplyTarget() {
  const target = runtime.current.replyTarget;
  if (!target || runtime.current.pin?.target !== target) return null;
  const entry = runtime.current.byId.get(target);
  return entry && entry.kind !== 'question' ? entry : null;
}

function replyTargetEntry(id) {
  const entry = pinEntry(id);
  if (runtime.current.pin?.target !== id) throw new Error('현재 고정된 응답만 추가 응답 대상으로 지정할 수 있습니다.');
  return entry;
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return jsonResponse(res, 200, { ok: true, app: APP_NAME, sessionId, pid: process.pid, port: serverPort, broadcast: broadcastMode });
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    return jsonResponse(res, 200, stateSummary());
  }
  if (req.method === 'GET' && url.pathname === '/api/sync') {
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
    const options = { limit: Number.isInteger(limit) && limit >= 0 ? limit : undefined };
    return jsonResponse(res, 200, { ok: true, ...syncResult(url.searchParams.get('knownHead'), options) });
  }
  if (req.method === 'GET' && url.pathname === '/api/entries') {
    const full = url.searchParams.get('full') === '1';
    const total = runtime.current.entries.length;
    const after = url.searchParams.get('after');
    const last = Number.parseInt(url.searchParams.get('last') ?? '', 10);
    let limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 1_000);
    let start = after ? runtime.current.entries.findIndex(entry => entry.id === after) + 1 : 0;
    if (Number.isInteger(last) && last > 0) {
      limit = Math.min(last, 1_000);
      start = Math.max(0, total - limit);
    }
    const entries = runtime.current.entries.slice(start, start + limit).map(entry => publicEntry(entry, full));
    return jsonResponse(res, 200, {
      ok: true,
      entries,
      nextAfter: entries.at(-1)?.id || after || null,
      hasMore: start + entries.length < total
    });
  }

  if (req.method === 'PATCH' && url.pathname === '/api/settings') {
    try {
      const body = await readJson(req);
      const event = { t: 'settings', time: nowIso() };
      if (Object.prototype.hasOwnProperty.call(body, 'questionMode')) {
        if (!QUESTION_MODES.has(body.questionMode)) throw new Error('questionMode은 cleaned 또는 raw여야 합니다.');
        event.questionMode = body.questionMode;
      }
      for (const key of ['maxResponseChars', 'maxUnseenEvents']) {
        if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
        if (!Number.isInteger(body[key]) || body[key] < 0) throw new Error(`${key}는 0 이상의 정수여야 합니다.`);
        event[key] = body[key];
      }
      if (Object.keys(event).length === 2) throw new Error('설정값이 필요합니다.');
      const ownHash = appendEvent(event);
      return writeResponse(res, 200, { written: true }, body.knownHead, ownHash);
    } catch (error) {
      return errorResponse(res, 400, error.message);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/entries') {
    try {
      const body = await readJson(req);
      if (!KINDS.has(body.kind)) throw new Error('kind이 올바르지 않습니다.');
      const hasBody = typeof body.body === 'string';
      const hasRaw = typeof body.rawBody === 'string';
      const hasCleaned = typeof body.cleanedBody === 'string';
      if (!hasBody && !hasRaw && !hasCleaned) throw new Error('body 또는 rawBody/cleanedBody가 필요합니다.');
      const fallback = hasBody ? body.body : (hasRaw ? body.rawBody : body.cleanedBody);
      const rawBody = body.kind === 'question' ? (hasRaw ? body.rawBody : fallback) : undefined;
      const cleanedBody = body.kind === 'question' ? (hasCleaned ? body.cleanedBody : fallback) : undefined;
      const sourceBody = body.kind === 'question'
        ? (runtime.current.questionMode === 'raw' ? rawBody : cleanedBody)
        : fallback;
      const clientRef = typeof body.clientRef === 'string' ? body.clientRef : '';
      requiredText(sourceBody, 'body');
      if (clientRef && runtime.clientRefs.has(clientRef)) {
        const existing = runtime.clientRefs.get(clientRef);
        return writeResponse(res, 200, { written: false, deduplicated: true, entry: publicEntry(existing, true) }, body.knownHead);
      }
      if (body.kind !== 'question') enforceResponseLimit(sourceBody);
      const replyTarget = body.kind === 'question' ? null : activeReplyTarget();
      const id = `a-${runtime.nextEntryNo + 1}`;
      const event = {
        t: 'entry',
        id,
        kind: body.kind,
        time: nowIso(),
        heading: typeof body.heading === 'string' ? body.heading : '',
        body: sourceBody
      };
      if (replyTarget) event.replyTo = replyTarget.id;
      if (body.kind === 'question') {
        event.rawBody = rawBody;
        event.cleanedBody = cleanedBody;
        event.questionMode = runtime.current.questionMode;
      }
      if (clientRef) event.clientRef = clientRef;
      const ownHash = appendEvent(event);
      return writeResponse(res, 201, { written: true, entry: publicEntry(runtime.current.byId.get(id), true) }, body.knownHead, ownHash);
    } catch (error) {
      return errorResponse(res, 400, error.message, error.maxResponseChars === undefined ? {} : { maxResponseChars: error.maxResponseChars, length: error.length });
    }
  }

  if (parts[0] === 'api' && parts[1] === 'entries' && parts[2]) {
    const id = decodeURIComponent(parts[2]);
    try {
      const entry = currentEntry(id);
      if (req.method === 'GET' && !parts[3]) {
        return jsonResponse(res, 200, { ok: true, entry: publicEntry(entry, true) });
      }
      if (req.method === 'POST' && parts[3] === 'notes') {
        const body = await readJson(req);
        if (entry.kind === 'question') throw new Error('질문에는 노트를 추가할 수 없습니다.');
        if (runtime.current.pin?.target !== id) throw new Error('현재 고정된 응답에만 노트를 추가할 수 있습니다.');
        const note = {
          t: 'note',
          id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          target: id,
          time: nowIso(),
          anchor: typeof body.anchor === 'string' ? body.anchor : '',
          title: typeof body.title === 'string' ? body.title : '',
          text: requiredText(body.text, 'text')
        };
        const ownHash = appendEvent(note);
        const anchorFound = Boolean(note.anchor) && entry.body.includes(note.anchor);
        return writeResponse(res, 201, { written: true, anchorFound, entry: entryRef(runtime.current.byId.get(id)) }, body.knownHead, ownHash);
      }
      if (req.method === 'POST' && parts[3] === 'revisions') {
        const body = await readJson(req);
        const revisionBody = requiredText(body.body, 'body');
        if (entry.kind !== 'question') enforceResponseLimit(revisionBody);
        const revision = {
          t: 'revision',
          id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          target: id,
          time: nowIso(),
          body: revisionBody
        };
        const ownHash = appendEvent(revision);
        return writeResponse(res, 201, { written: true, entry: entryRef(runtime.current.byId.get(id)) }, body.knownHead, ownHash);
      }
      return errorResponse(res, 404, '지원하지 않는 엔드포인트입니다.');
    } catch (error) {
      return errorResponse(res, 400, error.message, error.maxResponseChars === undefined ? {} : { maxResponseChars: error.maxResponseChars, length: error.length });
    }
  }

  if (req.method === 'PATCH' && url.pathname === '/api/outline') {
    try {
      const body = await readJson(req);
      if (typeof body.done !== 'boolean') throw new Error('done은 boolean이어야 합니다.');
      const ownHash = appendEvent({
        t: 'outline',
        time: nowIso(),
        done: body.done,
        items: body.done ? [] : (Array.isArray(body.items) ? body.items : [])
      });
      return writeResponse(res, 200, { written: true }, body.knownHead, ownHash);
    } catch (error) {
      return errorResponse(res, 400, error.message);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/pin') {
    try {
      const body = await readJson(req);
      if (body.target !== null && typeof body.target !== 'string') throw new Error('target은 응답 ID 또는 null이어야 합니다.');
      if (body.target) pinEntry(body.target);
      const source = req.headers['x-ineedbetterui-ui'] === '1' ? 'user' : 'agent';
      const ownHash = appendEvent({ t: 'pin', time: nowIso(), target: body.target, source });
      return writeResponse(res, 200, { written: true }, body.knownHead, ownHash);
    } catch (error) {
      return errorResponse(res, 400, error.message);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/reply-target') {
    try {
      const body = await readJson(req);
      if (body.target !== null && typeof body.target !== 'string') throw new Error('target은 현재 고정된 응답 ID 또는 null이어야 합니다.');
      if (body.target) replyTargetEntry(body.target);
      const source = req.headers['x-ineedbetterui-ui'] === '1' ? 'user' : 'agent';
      const ownHash = appendEvent({ t: 'reply-target', time: nowIso(), target: body.target, source });
      return writeResponse(res, 200, { written: true }, body.knownHead, ownHash);
    } catch (error) {
      return errorResponse(res, 400, error.message);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/reset') {
    try {
      const body = await readJson(req);
      if (body.confirm !== true) throw new Error('confirm:true가 필요합니다.');
      const ownHash = appendEvent({ t: 'reset', time: nowIso() });
      return writeResponse(res, 200, { written: true }, body.knownHead, ownHash);
    } catch (error) {
      return errorResponse(res, 400, error.message);
    }
  }

  return errorResponse(res, 404, 'API 경로를 찾을 수 없습니다.');
}

function pageHtml(currentState, entries) {
  const initial = safeJson({
    state: stateSummary(),
    entries: entries.map(entry => publicEntry(entry, true))
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>I Need Better UI</title>
<style>
:root{color-scheme:light;--bg:#f5f6fa;--fg:#202532;--card:#fff;--muted:#606879;--line:#d9dfea;--accent:#245ac7;--nested-bg:#eef2f9;--code-bg:#f6f8fa;--tok-comment:#656d76;--tok-string:#1a7f37;--tok-keyword:#8250df;--tok-number:#b35900;--tok-function:#245ac7;--outline-h:45vh;--pinned-h:auto;--sidebar:276px}
[data-theme="dark"]{color-scheme:dark;--bg:#141820;--fg:#eef1f7;--card:#202632;--muted:#a8b2c4;--line:#394456;--accent:#94b7ff;--nested-bg:#283142;--code-bg:#161b22;--tok-comment:#8b949e;--tok-string:#7ee787;--tok-keyword:#c792ea;--tok-number:#ffa657;--tok-function:#94b7ff}
*{box-sizing:border-box}
html{scroll-padding-top:12px}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 system-ui,-apple-system,"Segoe UI","Noto Sans KR",sans-serif}
button,select,input{font:inherit}
button,select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 10px}
button{cursor:pointer}
button:disabled{cursor:not-allowed;opacity:.55}
.app-shell{display:block;width:100%;min-height:100vh;margin:0}
.sidebar{position:fixed;left:0;top:0;width:56px;height:100vh;overflow:hidden;border-right:1px solid var(--line);background:var(--card);box-shadow:8px 0 24px #0003;z-index:20;transform:translateX(0);transition:width .22s cubic-bezier(.2,.8,.2,1)}
.sidebar{--sidebar-width:min(84vw,320px)}
.sidebar.open{width:var(--sidebar-width)}
.sidebar-resize{position:absolute;right:0;top:0;bottom:0;width:7px;z-index:3;cursor:ew-resize;touch-action:none;display:none}
.sidebar.open .sidebar-resize{display:block}
.sidebar-resize:hover,.sidebar-resize:focus-visible{background:var(--line)}
.sidebar.resizing,.sidebar.resizing .sidebar-content,.sidebar.resizing .sidebar-footer,.sidebar.resizing .sidebar-toggle{transition:none}
.sidebar.resizing{user-select:none}
.sidebar-top{position:relative;display:flex;align-items:center;height:60px;padding:12px 56px 12px 10px;border-bottom:1px solid var(--line);overflow:hidden}
.sidebar-heading{display:flex;align-items:center;min-width:200px;height:36px;opacity:0;transform:translateX(-8px);visibility:hidden;pointer-events:none;transition:opacity .16s ease,transform .22s cubic-bezier(.2,.8,.2,1),visibility 0s linear .22s}
.sidebar.open .sidebar-heading{opacity:1;transform:translateX(0);visibility:visible;pointer-events:auto;transition-delay:.05s,.05s,0s}
.sidebar-top h1{font-size:18px;line-height:1.2;margin:0;white-space:nowrap}
.sidebar-toggle{display:grid;place-items:center;width:36px;height:36px;padding:0;margin:0;box-shadow:0 2px 8px #0002}
.sidebar .sidebar-toggle{position:absolute;top:12px;left:10px;z-index:2;transition:transform .22s cubic-bezier(.2,.8,.2,1)}
.sidebar.open .sidebar-toggle{transform:translateX(calc(var(--sidebar-width) - 56px))}
#theme{display:flex;align-items:center;justify-content:center;gap:8px;width:36px;height:36px;padding:0;white-space:nowrap;overflow:hidden}
.sidebar.open #theme{justify-content:flex-start;width:auto;min-width:132px;padding:0 10px}
.sidebar:not(.open) .sidebar-footer{display:flex;align-items:center;justify-content:center}
.sidebar:not(.open) #theme{align-items:center;justify-content:center;gap:0;margin:0;line-height:0}
.sidebar:not(.open) #theme .label-full{display:none}
.theme-icon{display:block;flex:0 0 20px;width:20px;height:20px}
.theme-sun{display:none}
[data-theme="dark"] .theme-sun{display:block}
[data-theme="dark"] .theme-moon{display:none}
.menu-icon{position:relative;display:block;width:20px;height:20px;overflow:visible}
.menu-line{position:absolute;left:2px;width:16px;height:2px;border-radius:2px;background:currentColor;transform-origin:center;transition:transform .22s cubic-bezier(.2,.8,.2,1),opacity .16s ease}
.menu-line.line-top{top:3px}
.menu-line.line-middle{top:9px}
.menu-line.line-bottom{top:15px}
.menu-icon.is-open .line-top{transform:translateY(6px) rotate(45deg)}
.menu-icon.is-open .line-middle{opacity:0;transform:scaleX(.2)}
.menu-icon.is-open .line-bottom{transform:translateY(-6px) rotate(-45deg)}
.sidebar-content{width:55px;padding:14px 8px;transition:width .22s cubic-bezier(.2,.8,.2,1),padding .22s cubic-bezier(.2,.8,.2,1);will-change:width,padding}
.sidebar.open .sidebar-content{width:calc(var(--sidebar-width) - 1px);padding:14px 14px 72px}
.sidebar-footer{position:absolute;left:0;bottom:0;width:55px;padding:12px 9px;background:var(--card);border-top:1px solid var(--line);transition:width .22s cubic-bezier(.2,.8,.2,1),padding .22s cubic-bezier(.2,.8,.2,1)}
.sidebar.open .sidebar-footer{width:calc(var(--sidebar-width) - 1px);padding:12px 14px}
.sidebar-controls{padding:10px 0;border-bottom:1px solid var(--line)}
.check-row{display:grid;gap:8px}
.check-label{display:flex;align-items:center;gap:7px;min-height:24px;cursor:pointer;white-space:nowrap;overflow:hidden}
.check-label input{accent-color:var(--accent)}
.question-mode-label{font-size:14px}
.sidebar:not(.open) .check-label{justify-content:center;gap:4px}
.hint{width:291px;color:var(--muted);font-size:12px;max-height:20px;margin:4px 0 0;opacity:1;overflow:hidden;white-space:nowrap;transition:max-height .22s cubic-bezier(.2,.8,.2,1),margin .22s cubic-bezier(.2,.8,.2,1),opacity .16s ease}
.sidebar:not(.open) .hint{max-height:0;margin-top:0;opacity:0}
.sidebar:not(.open) .outline-wrap,.outline-wrap:not(.is-visible){height:0;min-height:0;margin-top:0;padding-top:0;opacity:0;visibility:hidden;pointer-events:none}
.label-full,.label-short{display:inline-block;overflow:hidden;white-space:nowrap;vertical-align:bottom;transition:max-width .22s cubic-bezier(.2,.8,.2,1),opacity .16s ease}
.label-full{max-width:240px;opacity:1}
.label-short{max-width:0;opacity:0}
.sidebar:not(.open) .label-full{max-width:0;opacity:0}
.sidebar:not(.open) .label-short{max-width:24px;opacity:1}
.legend{padding:12px 0 2px}
.legend h2{width:291px;font-size:14px;max-height:24px;margin:0 0 8px;opacity:1;overflow:hidden;white-space:nowrap;transition:max-height .22s cubic-bezier(.2,.8,.2,1),margin .22s cubic-bezier(.2,.8,.2,1),opacity .16s ease}
.legend-list{display:grid;gap:6px;margin:0;padding:0;list-style:none;transition:gap .22s cubic-bezier(.2,.8,.2,1)}
.legend-item{border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:6px;padding:5px 8px;font-size:12px;line-height:1.35;white-space:nowrap;overflow:hidden;transition:padding .22s cubic-bezier(.2,.8,.2,1)}
.legend-description{display:inline-block;max-width:230px;opacity:1;overflow:hidden;vertical-align:bottom;white-space:nowrap;transition:max-width .22s cubic-bezier(.2,.8,.2,1),opacity .16s ease}
.sidebar:not(.open) .legend{padding-top:12px}
.sidebar:not(.open) .legend h2{max-height:0;margin-bottom:0;opacity:0}
.sidebar:not(.open) .legend-list{gap:5px}
.sidebar:not(.open) .legend-description{max-width:0;opacity:0}
.sidebar:not(.open) .legend-item{padding:5px 2px;text-align:center;white-space:nowrap}
.legend-item[data-kind="question"]{border-left-color:#8a92a3}
[data-theme="dark"] .legend-item[data-kind="question"]{border-left-color:#7d8699}
.legend-item[data-kind="report"]{border-left-color:var(--accent)}
.legend-item[data-kind="decision"]{border-left-color:#bb8b22}
[data-theme="dark"] .legend-item[data-kind="decision"]{border-left-color:#d9a441}
.legend-item[data-kind="error"]{border-left-color:#de5964}
[data-theme="dark"] .legend-item[data-kind="error"]{border-left-color:#e8828b}
.legend-item[data-kind="done"]{border-left-color:#329b77}
[data-theme="dark"] .legend-item[data-kind="done"]{border-left-color:#5fc79d}
.legend-item[data-kind="other"]{border-left-color:#7a5ec2}
[data-theme="dark"] .legend-item[data-kind="other"]{border-left-color:#a98ff0}
.outline-wrap{width:100%;min-width:0;margin-top:12px;padding-top:12px;border-top:1px solid var(--line);height:var(--outline-h);min-height:48px;display:flex;flex-direction:column;overflow:hidden;opacity:1;visibility:visible;transition:height .22s cubic-bezier(.2,.8,.2,1),min-height .22s cubic-bezier(.2,.8,.2,1),margin-top .22s cubic-bezier(.2,.8,.2,1),padding-top .22s cubic-bezier(.2,.8,.2,1),opacity .16s ease,visibility 0s linear .22s}
.sidebar.open .outline-wrap{transition-delay:0s,0s,0s,.05s,0s,0s}
.sidebar.open .outline-wrap{min-height:min(96px,var(--outline-available,45vh));max-height:var(--outline-available,45vh)}
.outline-wrap h2{flex:none}
.sidebar.resizing-outline .outline-wrap{transition:none;user-select:none}
.outline-wrap h2{font-size:14px;margin:0 0 6px}
.outline-scroll{min-height:0;overflow:auto;border:1px solid var(--line);border-radius:8px}
.outline-scroll table{border-collapse:collapse;width:100%;min-width:320px;table-layout:fixed;font-size:12px}
.outline-scroll th,.outline-scroll td{padding:6px 7px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.outline-scroll th{position:relative}
.outline-column-handle{position:absolute;top:0;right:-5px;bottom:0;width:10px;padding:0;border:0;border-radius:0;background:transparent;color:var(--line);cursor:col-resize;touch-action:none;z-index:1}
.outline-column-handle:before{content:"";position:absolute;top:4px;bottom:4px;left:4px;width:2px;border-radius:1px;background:currentColor;opacity:.48}
.outline-column-handle:hover,.outline-column-handle:focus-visible{color:var(--muted)}
.outline-column-handle:focus-visible{outline:1px solid var(--accent);outline-offset:-1px}
.resizing-outline-columns{user-select:none}
.outline-scroll tr:last-child td{border-bottom:0}
.outline-scroll tr[data-sub] td:nth-child(2){padding-left:22px}
.outline-scroll tr[aria-current="step"]{font-weight:700}
.outline-resize{height:9px;flex:none;cursor:ns-resize;display:flex;justify-content:center;align-items:center;touch-action:none}
.outline-resize:before{content:"";width:36px;height:3px;border-radius:2px;background:var(--line)}
.content{width:100%;min-width:0;padding:70px clamp(18px,4vw,48px) 24px 70px}
.entries-list{display:flex;flex-direction:column;gap:16px}
.entry{position:relative;max-width:88%;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:10px;padding:18px 52px 18px 18px;overflow-wrap:anywhere;transition:margin .18s ease,max-width .18s ease}
.entries-list .entry[data-kind="question"]{align-self:flex-end;margin-left:12%;border-top-right-radius:4px}
.entries-list .entry:not([data-kind="question"]){align-self:flex-start;margin-right:12%;border-top-left-radius:4px}
.pinned .entry[data-kind="question"]{margin-left:12%;border-top-right-radius:4px}
.pinned .entry:not([data-kind="question"]){margin-right:12%;border-top-left-radius:4px}
.entry[data-kind="question"]{border-left-color:#8a92a3}
[data-theme="dark"] .entry[data-kind="question"]{border-left-color:#7d8699}
.entry[data-kind="report"]{border-left-color:var(--accent)}
.entry[data-kind="decision"]{border-left-color:#bb8b22}
[data-theme="dark"] .entry[data-kind="decision"]{border-left-color:#d9a441}
.entry[data-kind="error"]{border-left-color:#de5964}
[data-theme="dark"] .entry[data-kind="error"]{border-left-color:#e8828b}
.entry[data-kind="done"]{border-left-color:#329b77}
[data-theme="dark"] .entry[data-kind="done"]{border-left-color:#5fc79d}
.entry[data-kind="other"]{border-left-color:#7a5ec2}
[data-theme="dark"] .entry[data-kind="other"]{border-left-color:#a98ff0}
.entry-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px}
time,.muted{color:var(--muted);font-size:12px}
.kind-label,.mode-label{color:var(--muted);font-size:12px}
.entry h3{font-size:17px;line-height:1.4;margin:5px 0 10px}
.entry p{margin:0 0 10px}
.entry p:last-child{margin-bottom:0}
.entry-actions{position:absolute;right:12px;top:12px}
.pin-toggle{display:grid;place-items:center;width:32px;height:32px;padding:0;color:var(--muted);background:var(--card);border:1px solid var(--line);border-radius:7px}
.pin-toggle:hover,.pin-toggle:focus-visible{color:var(--accent);border-color:var(--accent)}
.pin-toggle[data-active="true"]{color:var(--accent);border-color:var(--accent);background:var(--bg)}
.pin-symbol{display:block;width:18px;height:18px}
.entry code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--bg);border-radius:4px;padding:1px 4px}
.entry pre{overflow:auto;background:var(--bg);padding:12px;border-radius:7px}
.entry pre code{padding:0;background:transparent}
.entry ul,.entry ol{margin:6px 0 10px;padding-left:24px}
.entry table{border-collapse:collapse;min-width:100%;margin:8px 0 12px}
.entry .table-scroll{overflow-x:auto}
.entry td,.entry th{padding:6px 8px;border:1px solid var(--line);text-align:left}
.broadcast-entry .qr-card{display:grid;justify-items:start;gap:8px;margin:14px 0 0;padding:12px;background:var(--bg);border:1px solid var(--line);border-radius:8px}
.broadcast-entry .qr-card svg{display:block;width:min(280px,100%);height:auto;image-rendering:pixelated;border:8px solid #fff;background:#fff}
.broadcast-entry .qr-card figcaption{color:var(--muted);font-size:13px}
.broadcast-entry .qr-card a{overflow-wrap:anywhere}
.note{border-left:3px solid var(--accent);background:var(--nested-bg);padding:9px 12px;margin:10px 0}
.reply-entry{background:var(--nested-bg)}.reply-entry .note{background:var(--card)}
.entry pre.code-block{background:var(--code-bg);border:1px solid var(--line);border-radius:8px;overflow-x:auto;white-space:pre;padding:12px;margin:10px 0}
.code-block code{white-space:pre}.tok-comment{color:var(--tok-comment);font-style:italic}.tok-string{color:var(--tok-string)}.tok-keyword{color:var(--tok-keyword)}.tok-number{color:var(--tok-number)}.tok-function{color:var(--tok-function)}
.note strong{display:block;margin-bottom:2px}
.pinned{position:sticky;top:0;z-index:12;margin:0 0 18px;padding:0 0 8px;background:var(--bg);border-bottom:1px solid var(--line);box-shadow:0 4px 12px #0001;height:var(--pinned-h,auto);max-height:80vh;display:flex;flex-direction:column;min-height:0}
.pinned-scroll{min-height:0;flex:1 1 auto;overflow:auto}
.pinned-resize{height:9px;flex:none;display:flex;justify-content:center;align-items:center;cursor:ns-resize;touch-action:none}
.pinned-resize:before{content:"";width:36px;height:3px;border-radius:2px;background:var(--line)}
.pinned-resize:hover,.pinned-resize:focus-visible{background:var(--line)}
.resizing-pinned{user-select:none}
.pinned .entry{padding-right:156px}
.pin-icon{position:absolute;top:15px;right:16px;color:var(--accent)}
.reply-toggle{position:absolute;top:12px;right:52px;display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:5px 9px;color:var(--muted);background:var(--card);border:1px solid var(--line);border-radius:7px;white-space:nowrap}
.reply-toggle:hover,.reply-toggle:focus-visible{color:var(--accent);border-color:var(--accent)}
.reply-toggle[data-active="true"]{color:var(--card);background:var(--accent);border-color:var(--accent);box-shadow:0 0 0 2px var(--accent)}
.reply-list{display:grid;gap:10px;margin:14px 0 0 18px;padding:12px 0 0 14px;border-left:2px solid var(--line)}
.pinned .reply-list .entry{max-width:100%;margin:0;padding:14px 18px;border-radius:8px}
.empty{color:var(--muted);text-align:center;padding:48px 20px}
.sidebar-backdrop{position:fixed;inset:0;display:block;background:#0006;opacity:0;visibility:hidden;pointer-events:none;z-index:19;transition:opacity .22s ease,visibility .22s ease}
.sidebar-backdrop.open{opacity:1;visibility:visible;pointer-events:auto}
[hidden]{display:none!important}
@media(max-width:1024px){
  .content{padding:70px 18px 18px 70px}
  .entry{max-width:94%}
  .entries-list .entry[data-kind="question"],.pinned .entry[data-kind="question"]{margin-left:6%}
  .entries-list .entry:not([data-kind="question"]),.pinned .entry:not([data-kind="question"]){margin-right:6%}
}
</style>
</head>
<body>
<div class="sidebar-backdrop" id="backdrop"></div>
<div class="app-shell">
<aside class="sidebar" id="sidebar">
  <div class="sidebar-resize" id="sidebar-resize" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" aria-controls="sidebar" tabindex="0"></div>
  <div class="sidebar-top"><div class="sidebar-heading"><h1 id="app-title">I Need Better UI</h1></div><button class="sidebar-toggle" id="sidebar-toggle" type="button" aria-label="Open sidebar" aria-controls="sidebar" aria-expanded="false" title="Open sidebar"><span class="menu-icon" aria-hidden="true"><span class="menu-line line-top"></span><span class="menu-line line-middle"></span><span class="menu-line line-bottom"></span></span></button></div>
  <div class="sidebar-content">
    <div class="sidebar-controls">
      <div class="check-row">
        <label class="check-label" title="Pinned"><input type="checkbox" id="vis-pin" checked><span id="vis-pin-label"><span class="label-full">Pinned</span><span class="label-short" aria-hidden="true">P</span></span></label>
        <label class="check-label question-mode-label" title="Use AI-cleaned questions"><input type="checkbox" id="question-mode" checked><span id="question-mode-label"><span class="label-full">Use AI-cleaned questions</span><span class="label-short" aria-hidden="true">AI</span></span></label>
      </div>
      <p class="hint" id="question-mode-hint">Unchecked records the user's original wording.</p>
      <label class="max-response-label" for="max-response-chars">Max response chars</label><input id="max-response-chars" type="number" min="0" step="1"><p class="hint">0 = unlimited</p>
      <label class="max-response-label" for="max-unseen-events">Max unseen events</label><input id="max-unseen-events" type="number" min="0" step="1"><p class="hint">Sent to agents per sync · 0 = unlimited</p>
    </div>
    <section class="legend" aria-labelledby="legend-heading"><h2 id="legend-heading">Entry colors</h2><ul class="legend-list">
      <li class="legend-item" data-kind="question" title="Question — User message"><strong><span class="label-full">Question</span><span class="label-short" aria-hidden="true">Q</span></strong><span class="legend-description"> — User message</span></li>
      <li class="legend-item" data-kind="report" title="Report — Progress or explanation"><strong><span class="label-full">Report</span><span class="label-short" aria-hidden="true">R</span></strong><span class="legend-description"> — Progress or explanation</span></li>
      <li class="legend-item" data-kind="decision" title="Decision — Awaiting your choice"><strong><span class="label-full">Decision</span><span class="label-short" aria-hidden="true">D</span></strong><span class="legend-description"> — Awaiting your choice</span></li>
      <li class="legend-item" data-kind="error" title="Error — Failure or blocked step"><strong><span class="label-full">Error</span><span class="label-short" aria-hidden="true">E</span></strong><span class="legend-description"> — Failure or blocked step</span></li>
      <li class="legend-item" data-kind="done" title="Done — Completed work"><strong><span class="label-full">Done</span><span class="label-short" aria-hidden="true">D</span></strong><span class="legend-description"> — Completed work</span></li>
      <li class="legend-item" data-kind="other" title="Other — Other response"><strong><span class="label-full">Other</span><span class="label-short" aria-hidden="true">O</span></strong><span class="legend-description"> — Other response</span></li>
    </ul></section>
    <section class="outline-wrap" id="outline-section" hidden><h2 id="outline-heading">Outline</h2><div class="outline-scroll" id="outline-scroll"></div><div class="outline-resize" id="outline-resize" role="separator" aria-label="Resize outline" aria-orientation="horizontal"></div></section>
  </div>
  <div class="sidebar-footer"><button id="theme" type="button" aria-label="Switch to dark theme" title="Switch to dark theme"><svg class="theme-icon theme-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"></path></svg><svg class="theme-icon theme-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.1A8.5 8.5 0 0 1 9.9 3.5 8.5 8.5 0 1 0 20.5 14.1Z"></path></svg><span id="theme-label" class="label-full">Dark Mode</span></button></div>
</aside>
<main class="content">
  <section class="pinned" id="pinned" hidden><div class="pinned-scroll" id="pinned-scroll"></div><div class="pinned-resize" id="pinned-resize" role="separator" aria-label="Resize pinned response" aria-orientation="horizontal" aria-controls="pinned-scroll" hidden></div></section>
  <section id="entries-section"><div class="entries-list" id="entries-list"></div><p class="empty" id="empty" hidden></p></section>
</main>
</div>
<script id="initial-data" type="application/json">${initial}</script>
<script>
(() => {
  'use strict';
  const initial = JSON.parse(document.getElementById('initial-data').textContent);
  const root = document.documentElement;
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('backdrop');
  const outlineSection = document.getElementById('outline-section');
  const outlineScroll = document.getElementById('outline-scroll');
  const pinned = document.getElementById('pinned');
  const pinnedScroll = document.getElementById('pinned-scroll');
  const pinnedResize = document.getElementById('pinned-resize');
  const entriesList = document.getElementById('entries-list');
  const empty = document.getElementById('empty');
  const pageKey = location.pathname;
  const viewKey = 'agent-view:' + pageKey;
  const themeKey = 'agent-theme:' + pageKey;
  const visKey = 'agent-vis:' + pageKey;
  const sidebarKey = 'agent-sidebar:v3:' + pageKey;
  const sidebarWidthKey = 'agent-sidebar-width:' + pageKey;
  const outlineHKey = 'agent-outline-h:' + pageKey;
  const outlineColumnsKey = 'agent-outline-columns:' + pageKey;
  const pinnedHKey = 'agent-pinned-h:' + pageKey;
  const outlineColumnDefaults = [0.12, 0.42, 0.22, 0.24];
  const outlineColumnMinimums = [40, 96, 60, 60];
  const defaults = { pin: true };
  const read = (storage, key) => { try { return storage.getItem(key); } catch { return null; } };
  const write = (storage, key, value) => { try { storage.setItem(key, value); } catch {} };
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  const language = 'en';
  const strings = { en: { title: 'I Need Better UI', themeLight: 'Switch to light theme', themeDark: 'Switch to dark theme', lightMode: 'Light Mode', darkMode: 'Dark Mode', collapse: 'Collapse sidebar', expand: 'Expand sidebar', outline: 'Outline', pinned: 'Pinned', pin: 'Pin', unpin: 'Unpin', addReply: 'Add reply', addReplyActive: 'Add reply (on)', replies: 'Replies', note: 'Note', empty: 'No entries yet.', questionMode: 'Use AI-cleaned questions', questionHintCleaned: 'Checked records the concise AI-cleaned wording.', questionHintRaw: "Unchecked records the user's original wording.", resizeColumns: 'Resize outline columns', broadcast: 'Broadcast access', scanBroadcast: 'Scan this QR code to open the broadcast', cleaned: 'AI-cleaned', raw: 'Original', kind: { question: 'Question', report: 'Report', decision: 'Decision', error: 'Error', done: 'Done', other: 'Other' } } };
  let view = { ...defaults };
  try {
    const savedView = JSON.parse(read(localStorage, visKey) || 'null');
    if (savedView && typeof savedView.pin === 'boolean') view.pin = savedView.pin;
  } catch {}
  let state = initial.state;
  let entries = initial.entries || [];
  let lastSignature = '';
  let questionBusy = false;
  let limitBusy = false;
  let outlineColumns = outlineColumnDefaults.slice();
  try {
    const savedColumns = JSON.parse(read(localStorage, outlineColumnsKey) || 'null');
    if (Array.isArray(savedColumns) && savedColumns.length === outlineColumnDefaults.length && savedColumns.every(value => Number.isFinite(value) && value > 0)) {
      const total = savedColumns.reduce((sum, value) => sum + value, 0);
      if (total > 0) outlineColumns = savedColumns.map(value => value / total);
    }
  } catch {}

  function L() { return strings[language]; }
  function setDualLabel(id, full, short) { const node = document.getElementById(id); node.querySelector('.label-full').textContent = full; node.querySelector('.label-short').textContent = short; }
  function updateThemeButton() { const button = document.getElementById('theme'); const dark = root.dataset.theme === 'dark'; const label = dark ? L().themeLight : L().themeDark; button.setAttribute('aria-label', label); button.setAttribute('title', label); document.getElementById('theme-label').textContent = dark ? L().lightMode : L().darkMode; }
  function statusLabel(status) { return { pending: 'Pending', active: 'Active', done: 'Done' }[status] || status || ''; }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>\"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[char]));
  }
  function inlineMarkdown(value) {
    let text = escapeHtml(value);
    const tokens = [];
    const hold = html => { tokens.push(html); return '\\u0001' + (tokens.length - 1) + '\\u0002'; };
    text = text.replace(/\\x60([^\\x60\\n]+)\\x60/g, (_, code) => hold('<code>' + code + '</code>'));
    text = text.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, (_, label, url) => {
      if (!/^(?:https?:\\/\\/|mailto:|\\/|#)/i.test(url)) return label;
      return '<a href="' + url + '" target="_blank" rel="noreferrer">' + label + '</a>';
    });
    text = text.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    return text.replace(/\\u0001(\\d+)\\u0002/g, (_, index) => tokens[Number(index)]);
  }
  function cells(line) {
    let value = line.trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|')) value = value.slice(0, -1);
    return value.split('|').map(cell => cell.trim());
  }
  function tableSeparator(line) { return /^\\s*\\|?\\s*:?-{3,}:?\\s*(?:\\|\\s*:?-{3,}:?\\s*)+\\|?\\s*$/.test(line); }
  const CODE_LANGUAGES = { js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', json: 'json', jsonl: 'json', py: 'py', python: 'py', sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash', ps1: 'ps1', powershell: 'ps1', pwsh: 'ps1', html: 'html', xml: 'html', svg: 'html', css: 'css' };
  const CODE_KEYWORDS = {
    js: new Set('as async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield'.split(' ')),
    json: new Set(['true', 'false', 'null']),
    py: new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return self try while with yield'.split(' ')),
    bash: new Set('case do done echo elif else esac exit export fi for function if in local return then until while'.split(' ')),
    ps1: new Set('$false $null $true begin break catch class continue do else elseif end exit filter finally for foreach function if in param process return switch throw trap try until while'.split(' ')),
    css: new Set(['!important'])
  };
  function codeLanguageName(tag) { return CODE_LANGUAGES[String(tag || '').toLowerCase()] || ''; }
  function highlightCode(source, tag) {
    const lang = codeLanguageName(tag);
    const text = String(source ?? '');
    if (!lang) return escapeHtml(text);
    try { return tokenizeCode(text, lang); } catch { return escapeHtml(text); }
  }
  // A small single-pass tokenizer. It only separates comments, strings, keywords,
  // numbers and names; every token is escaped before it is wrapped in a span.
  function tokenizeCode(source, lang) {
    const span = (kind, value) => '<span class="tok-' + kind + '">' + escapeHtml(value) + '</span>';
    const keywords = CODE_KEYWORDS[lang] || new Set();
    const quoted = /"(?:\\\\.|[^"\\\\\\n])*"?|'(?:\\\\.|[^'\\\\\\n])*'?/y;
    const template = /\\x60(?:\\\\.|[^\\x60\\\\])*\\x60?/y;
    const config = {
      js: { block: /\\/\\*[\\s\\S]*?(?:\\*\\/|$)/y, line: /\\/\\/[^\\n]*/y, strings: [quoted, template], word: /[A-Za-z_$][\\w$]*/y, calls: true },
      json: { strings: [quoted], word: /[A-Za-z_]\\w*/y, keys: true },
      py: { line: /#[^\\n]*/y, strings: [quoted], word: /[A-Za-z_]\\w*/y, calls: true },
      bash: { line: /#[^\\n]*/y, hashAfterSpace: true, strings: [quoted], word: /[A-Za-z_][\\w-]*/y, calls: true },
      ps1: { block: /<#[\\s\\S]*?(?:#>|$)/y, line: /#[^\\n]*/y, hashAfterSpace: true, strings: [quoted], word: /\\$?[A-Za-z_][\\w-]*/y, calls: true, lower: true },
      css: { block: /\\/\\*[\\s\\S]*?(?:\\*\\/|$)/y, strings: [quoted], word: /[@!]?-{0,2}[A-Za-z_][\\w-]*/y },
      html: { strings: [quoted] }
    }[lang];
    const numberRe = lang === 'css' ? /\\d+(?:\\.\\d+)?(?:px|em|rem|vh|vw|ms|s|%)?/y : /\\d+(?:\\.\\d+)?/y;
    const colonAhead = /\\s*:/y;
    const parenAhead = /\\s*\\(/y;
    const at = (re, pos) => { re.lastIndex = pos; return re.exec(source); };
    let out = '', i = 0, depth = 0, inTag = false, m;
    while (i < source.length) {
      const ch = source[i];
      if (lang === 'html') {
        if (!inTag) {
          if ((m = at(/<!--[\\s\\S]*?(?:-->|$)/y, i))) { out += span('comment', m[0]); i += m[0].length; continue; }
          if ((m = at(/<(\\/?)([A-Za-z][\\w:.-]*)/y, i))) { out += '&lt;' + m[1] + span('keyword', m[2]); i += m[0].length; inTag = true; continue; }
        } else {
          if (ch === '>') { out += '&gt;'; i += 1; inTag = false; continue; }
          if ((m = at(quoted, i))) { out += span('string', m[0]); i += m[0].length; continue; }
          if ((m = at(/[A-Za-z_:][\\w:.-]*/y, i))) { out += span('function', m[0]); i += m[0].length; continue; }
        }
        out += escapeHtml(ch); i += 1; continue;
      }
      if (config.block && (m = at(config.block, i))) { out += span('comment', m[0]); i += m[0].length; continue; }
      if (config.line && (!config.hashAfterSpace || i === 0 || /\\s/.test(source[i - 1])) && (m = at(config.line, i))) { out += span('comment', m[0]); i += m[0].length; continue; }
      const str = config.strings.map(re => at(re, i)).find(Boolean);
      if (str) { const end = i + str[0].length; out += span(config.keys && at(colonAhead, end) ? 'function' : 'string', str[0]); i = end; continue; }
      if ((m = at(config.word, i))) {
        const word = m[0]; const end = i + word.length; let kind = '';
        if (keywords.has(config.lower ? word.toLowerCase() : word) || (lang === 'css' && word[0] === '@')) kind = 'keyword';
        else if (lang === 'css' && depth > 0 && at(colonAhead, end)) kind = 'function';
        else if (lang === 'ps1' && /^[A-Za-z]+-[A-Za-z]+$/.test(word)) kind = 'function';
        else if (config.calls && at(parenAhead, end)) kind = 'function';
        out += kind ? span(kind, word) : escapeHtml(word); i = end; continue;
      }
      if ((m = at(numberRe, i))) { out += span('number', m[0]); i += m[0].length; continue; }
      if (ch === '{') depth += 1; else if (ch === '}') depth = Math.max(0, depth - 1);
      out += escapeHtml(ch); i += 1;
    }
    return out;
  }
  function renderMarkdown(value) {
    const lines = String(value ?? '').replace(/\\r\\n?/g, '\\n').split('\\n');
    const output = [];
    const fence = String.fromCharCode(96).repeat(3);
    const tildeFence = '~~~';
    let paragraph = [];
    let list = null;
    let code = null; let codeFence = null; let codeLanguage = '';
    const flushParagraph = () => { if (paragraph.length) { output.push('<p>' + paragraph.map(inlineMarkdown).join('<br>') + '</p>'); paragraph = []; } };
    const flushList = () => { if (list) { output.push('<' + list.type + '>' + list.items.map(item => '<li>' + inlineMarkdown(item) + '</li>').join('') + '</' + list.type + '>'); list = null; } };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (code !== null) {
        if (line.trim() === codeFence) { const source = code.join('\\n'); const langName = codeLanguageName(codeLanguage); const attr = langName ? ' data-lang="' + langName + '"' : ''; output.push('<pre class="code-block"' + attr + '><code>' + highlightCode(source, codeLanguage) + '</code></pre>'); code = null; codeFence = null; codeLanguage = ''; }
        else code.push(line);
        continue;
      }
      const opening = line.trim();
      if (opening.startsWith(fence) || opening.startsWith(tildeFence)) { flushParagraph(); flushList(); code = []; codeFence = opening.startsWith(tildeFence) ? tildeFence : fence; codeLanguage = opening.slice(3).trim().split(/\\s+/)[0].toLowerCase(); continue; }
      if (index + 1 < lines.length && line.includes('|') && tableSeparator(lines[index + 1])) {
        flushParagraph(); flushList();
        const head = cells(line); index += 1; const rows = [];
        while (index + 1 < lines.length && lines[index + 1].includes('|') && lines[index + 1].trim()) { index += 1; rows.push(cells(lines[index])); }
        let table = '<div class="table-scroll"><table><thead><tr>' + head.map(cell => '<th>' + inlineMarkdown(cell) + '</th>').join('') + '</tr></thead><tbody>';
        table += rows.map(row => '<tr>' + head.map((_, cellIndex) => '<td>' + inlineMarkdown(row[cellIndex] || '') + '</td>').join('') + '</tr>').join('');
        output.push(table + '</tbody></table></div>'); continue;
      }
      const unordered = /^\\s*-\\s+(.+)$/.exec(line);
      const ordered = /^\\s*\\d+\\.\\s+(.+)$/.exec(line);
      if (unordered || ordered) {
        flushParagraph(); const type = unordered ? 'ul' : 'ol';
        if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
        list.items.push((unordered || ordered)[1]); continue;
      }
      if (!line.trim()) { flushParagraph(); flushList(); continue; }
      flushList(); paragraph.push(line);
    }
    if (code !== null) { const source = code.join('\\n'); const langName = codeLanguageName(codeLanguage); const attr = langName ? ' data-lang="' + langName + '"' : ''; output.push('<pre class="code-block"' + attr + '><code>' + highlightCode(source, codeLanguage) + '</code></pre>'); }
    flushParagraph(); flushList();
    return output.join('');
  }
  function bodyHtml(entry) {
    let html = renderMarkdown(entry.body || '');
    const notes = Array.isArray(entry.notes) ? entry.notes : [];
    if (!notes.length) return html;
    const pending = [];
    notes.forEach(note => {
      const content = '<aside class="note" aria-label="' + escapeHtml(L().note) + ': ' + escapeHtml(note.anchor || '') + '"><strong>' + escapeHtml(note.title || L().note) + '</strong>' + renderMarkdown(note.text || '') + '</aside>';
      const anchor = escapeHtml(note.anchor || '');
      if (anchor) {
        const position = html.indexOf(anchor);
        if (position >= 0) { pending.push({ position: position + anchor.length, content }); return; }
      }
      html += content;
    });
    pending.sort((a, b) => b.position - a.position);
    pending.forEach(note => { html = html.slice(0, note.position) + note.content + html.slice(note.position); });
    return html;
  }
  function formatTime(value) {
    try { return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
    catch { return value; }
  }
  function svgPin() {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'pin-icon'); icon.setAttribute('width', '22'); icon.setAttribute('height', '22'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.8'); icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round'); icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', L().pinned);
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = L().pinned; icon.append(title);
    const pathNode = document.createElementNS('http://www.w3.org/2000/svg', 'path'); pathNode.setAttribute('d', 'M16 3 21 8 17 9 14 12 14 16 8 10 12 10 15 7 Z M11 13 4 20'); icon.append(pathNode);
    return icon;
  }
  function pinButtonIcon(active) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'pin-symbol'); icon.setAttribute('width', '18'); icon.setAttribute('height', '18'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('fill', active ? 'currentColor' : 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.8'); icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round'); icon.setAttribute('aria-hidden', 'true');
    const pathNode = document.createElementNS('http://www.w3.org/2000/svg', 'path'); pathNode.setAttribute('d', 'M16 3 21 8 17 9 14 12 14 16 8 10 12 10 15 7 Z M11 13 4 20'); icon.append(pathNode);
    return icon;
  }
  function addReplyButton(targetId) {
    const active = state.replyTarget === targetId;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'reply-toggle'; button.dataset.active = String(active); button.textContent = L().addReply; button.setAttribute('aria-label', active ? L().addReplyActive : L().addReply); button.setAttribute('title', active ? L().addReplyActive : L().addReply); button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', () => setReplyTarget(active ? null : targetId));
    return button;
  }
  function makeQrFigure(entry) {
    const qr = entry.qr;
    const size = Number(qr?.size);
    const modules = typeof qr?.modules === 'string' ? qr.modules : '';
    if (!Number.isInteger(size) || size < 21 || size > 177 || modules.length !== size * size || /[^01]/.test(modules)) return null;
    let url;
    try {
      url = new URL(entry.broadcastUrl);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
    } catch { return null; }
    const quiet = 4;
    const figure = document.createElement('figure'); figure.className = 'qr-card';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + (size + quiet * 2) + ' ' + (size + quiet * 2));
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', L().scanBroadcast); svg.setAttribute('focusable', 'false');
    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    background.setAttribute('width', String(size + quiet * 2)); background.setAttribute('height', String(size + quiet * 2)); background.setAttribute('fill', '#fff'); svg.append(background);
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        if (modules[row * size + column] !== '1') continue;
        const module = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        module.setAttribute('x', String(column + quiet)); module.setAttribute('y', String(row + quiet)); module.setAttribute('width', '1'); module.setAttribute('height', '1'); module.setAttribute('fill', '#000'); svg.append(module);
      }
    }
    const caption = document.createElement('figcaption'); caption.textContent = L().scanBroadcast;
    const link = document.createElement('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = url.href;
    figure.append(svg, caption, link);
    return figure;
  }
  function makeEntry(entry, isPinned, options = {}) {
    const article = document.createElement('article');
    article.className = 'entry'; article.dataset.kind = entry.kind; article.dataset.entryId = entry.id;
    if (options.reply) article.classList.add('reply-entry');
    if (entry.replyTo) article.dataset.replyTo = entry.replyTo;
    const meta = document.createElement('div'); meta.className = 'entry-meta';
    const time = document.createElement('time'); time.dateTime = entry.time; time.textContent = formatTime(entry.time); meta.append(time);
    const kind = document.createElement('span'); kind.className = 'kind-label'; kind.textContent = L().kind[entry.kind] || entry.kind; meta.append(kind);
    if (entry.kind === 'question') { const mode = document.createElement('span'); mode.className = 'mode-label'; mode.textContent = '· ' + (entry.questionMode === 'raw' ? L().raw : L().cleaned); meta.append(mode); }
    article.append(meta);
    if (entry.heading) { const heading = document.createElement('h3'); heading.innerHTML = inlineMarkdown(entry.heading); article.append(heading); }
    const body = document.createElement('div'); body.innerHTML = bodyHtml(entry); article.append(body);
    const qrFigure = makeQrFigure(entry);
    if (qrFigure) { article.classList.add('broadcast-entry'); article.append(qrFigure); }
    if (isPinned) { article.append(addReplyButton(entry.id)); article.append(svgPin()); }
    if (!isPinned && options.showPin !== false && entry.kind !== 'question') {
      const actions = document.createElement('div'); actions.className = 'entry-actions';
      const active = Boolean(state.pin && state.pin.target === entry.id);
      const pinButton = document.createElement('button'); pinButton.type = 'button'; pinButton.className = 'pin-toggle'; pinButton.dataset.active = String(active);pinButton.setAttribute('aria-label', active ? L().unpin : L().pin); pinButton.setAttribute('title', active ? L().unpin : L().pin); pinButton.setAttribute('aria-pressed', String(active)); pinButton.append(pinButtonIcon(active));
      pinButton.addEventListener('click', () => setPin(active ? null : entry.id)); actions.append(pinButton); article.append(actions);
    }
    return article;
  }
  function makePinnedEntry(entry) {
    const article = makeEntry(entry, true);
    const replies = entries.filter(item => item.replyTo === entry.id);
    if (replies.length) {
      const list = document.createElement('div'); list.className = 'reply-list'; list.setAttribute('aria-label', L().replies);
      replies.forEach(reply => list.append(makeEntry(reply, false, { reply: true, showPin: false })));
      article.append(list);
    }
    return article;
  }
  function addOutlineColumnHandle(cell, table, colgroup, index) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'outline-column-handle';
    handle.setAttribute('aria-label', L().resizeColumns);
    handle.setAttribute('title', L().resizeColumns);
    handle.setAttribute('aria-orientation', 'vertical');
    let drag = null;
    const finish = event => {
      if (!drag || (event && event.pointerId !== drag.pointerId)) return;
      const currentWidths = Array.from(colgroup.children).map(column => column.getBoundingClientRect().width);
      const total = currentWidths.reduce((sum, width) => sum + width, 0);
      if (total > 0) {
        outlineColumns = currentWidths.map(width => width / total);
        write(localStorage, outlineColumnsKey, JSON.stringify(outlineColumns));
      }
      drag = null;
      document.body.classList.remove('resizing-outline-columns');
    };
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const widths = Array.from(colgroup.children).map(column => column.getBoundingClientRect().width);
      drag = { pointerId: event.pointerId, startX: event.clientX, widths };
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('resizing-outline-columns');
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const pairTotal = drag.widths[index] + drag.widths[index + 1];
      const minimumLeft = outlineColumnMinimums[index];
      const minimumRight = outlineColumnMinimums[index + 1];
      const nextLeft = Math.min(Math.max(drag.widths[index] + event.clientX - drag.startX, minimumLeft), pairTotal - minimumRight);
      const nextWidths = drag.widths.slice();
      nextWidths[index] = nextLeft;
      nextWidths[index + 1] = pairTotal - nextLeft;
      const tableWidth = table.getBoundingClientRect().width;
      if (tableWidth > 0) nextWidths.forEach((width, columnIndex) => { colgroup.children[columnIndex].style.width = (width / tableWidth * 100) + '%'; });
    });
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    cell.append(handle);
  }
  function renderOutline() {
    const hasContent = state.outlineDone !== true && Array.isArray(state.outline) && state.outline.length > 0;
    outlineSection.hidden = !hasContent;
    outlineSection.classList.toggle('is-visible', hasContent);
    if (!hasContent) { outlineScroll.replaceChildren(); return; }
    const table = document.createElement('table');
    const colgroup = document.createElement('colgroup');
    outlineColumns.forEach(width => { const column = document.createElement('col'); column.style.width = (width * 100) + '%'; colgroup.append(column); });
    table.append(colgroup);
    const head = document.createElement('thead'); const headerRow = document.createElement('tr');
    ['#', L().outline, 'Type', 'Status'].forEach((value, index) => { const cell = document.createElement('th'); cell.textContent = value; if (index < outlineColumns.length - 1) addOutlineColumnHandle(cell, table, colgroup, index); headerRow.append(cell); }); head.append(headerRow); table.append(head);
    const body = document.createElement('tbody');
    state.outline.forEach(item => { const row = document.createElement('tr'); if (String(item.no || '').includes('-')) row.dataset.sub = '1'; if (item.current === true) row.setAttribute('aria-current', 'step'); [item.no || '', item.title || '', L().kind[item.type] || item.type || '', statusLabel(item.status)].forEach(value => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }); body.append(row); });
    table.append(body); outlineScroll.replaceChildren(table);
  }
  function render() {
    document.title = L().title; document.documentElement.lang = language;
    document.getElementById('app-title').textContent = L().title;
    const expanded = sidebar.classList.contains('open'); const sidebarToggle = document.getElementById('sidebar-toggle'); sidebarToggle.setAttribute('aria-label', expanded ? L().collapse : L().expand); sidebarToggle.setAttribute('title', expanded ? L().collapse : L().expand); sidebarToggle.setAttribute('aria-expanded', String(expanded)); sidebarToggle.querySelector('.menu-icon').classList.toggle('is-open', expanded);
    updateThemeButton(); setDualLabel('vis-pin-label', L().pinned, 'P'); setDualLabel('question-mode-label', L().questionMode, 'AI');
    document.getElementById('outline-heading').textContent = L().outline; empty.textContent = L().empty;
    document.getElementById('question-mode').checked = state.questionMode !== 'raw';
    document.getElementById('question-mode-hint').textContent = document.getElementById('question-mode').checked ? L().questionHintCleaned : L().questionHintRaw;
    const limitInput = document.getElementById('max-response-chars'); if (document.activeElement !== limitInput) limitInput.value = String(state.maxResponseChars ?? 3000);
    const unseenInput = document.getElementById('max-unseen-events'); if (document.activeElement !== unseenInput) unseenInput.value = String(state.maxUnseenEvents ?? 20);
    document.getElementById('vis-pin').checked = view.pin;
    renderOutline();
    const target = state.pin && state.pin.target ? entries.find(entry => entry.id === state.pin.target) : null;
    pinned.hidden = !target || !view.pin;
    pinnedScroll.replaceChildren();
    pinnedResize.hidden = pinned.hidden;
    if (target && view.pin) pinnedScroll.append(makePinnedEntry(target));
    // A reply belongs to its pinned parent while that parent remains pinned.
    // Keep the entry in the replayed state/JSONL, but render it only in the
    // pinned reply list to avoid showing it twice in the general conversation.
    // If the parent is unpinned, target is null and the reply naturally returns
    // to the general list (R-02).
    const generalEntries = target
      ? entries.filter(entry => entry.replyTo !== target.id)
      : entries;
    entriesList.replaceChildren(...generalEntries.map(entry => makeEntry(entry, false)));
    empty.hidden = entries.length > 0;
  }
  function applyTheme() {
    const saved = read(localStorage, themeKey); root.dataset.theme = saved || (systemTheme.matches ? 'dark' : 'light');
    updateThemeButton();
  }
  function saveView() { write(localStorage, visKey, JSON.stringify(view)); }
  function isAtBottom() {
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    return scrollY >= maxScroll - 24;
  }
  function scrollToBottom() {
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    scrollTo(0, maxScroll);
  }
  function isElementAtBottom(element) {
    return element.scrollTop + element.clientHeight >= element.scrollHeight - 24;
  }
  function scrollElementToBottom(element) {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  }
  function captureView() {
    const visible = Array.from(document.querySelectorAll('[data-entry-id]')).find(node => { const rect = node.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight; });
    return { atBottom: isAtBottom(), pinnedAtBottom: !pinned.hidden && isElementAtBottom(pinnedScroll), pinnedScrollTop: pinnedScroll.scrollTop, atTop: scrollY < 80, id: visible?.dataset.entryId, top: visible?.getBoundingClientRect().top, y: scrollY };
  }
  function restoreView(saved) {
    const restorePinned = () => {
      if (!pinned.hidden && saved?.pinnedAtBottom) scrollElementToBottom(pinnedScroll);
      else if (!pinned.hidden && Number.isFinite(saved?.pinnedScrollTop)) pinnedScroll.scrollTop = saved.pinnedScrollTop;
    };
    if (!saved) { scrollToBottom(); scrollElementToBottom(pinnedScroll); return; }
    if (saved.atBottom) { scrollToBottom(); restorePinned(); return; }
    if (saved.atTop) { scrollTo(0, 0); restorePinned(); return; }
    const node = Array.from(document.querySelectorAll('[data-entry-id]')).find(item => item.dataset.entryId === saved.id);
    if (node && Number.isFinite(saved.top)) scrollBy(0, node.getBoundingClientRect().top - saved.top);
    else scrollTo(0, saved.y || 0);
    restorePinned();
  }
  function signature(value) { return JSON.stringify({ entryCount: value.entryCount, last: value.lastEntry?.id || null, pin: value.pin, replyTarget: value.replyTarget || null, broadcast: value.broadcast || null, outline: value.outline, done: value.outlineDone, questionMode: value.questionMode, maxResponseChars: value.maxResponseChars, maxUnseenEvents: value.maxUnseenEvents }); }
  async function fetchJson(url, options) { const response = await fetch(url, options); const data = await response.json(); if (!response.ok || data.ok === false) throw new Error(data.error || 'Request failed.'); return data; }
  async function setPin(target) {
    try { const result = await fetchJson('/api/pin', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ineedbetterui-UI': '1' }, body: JSON.stringify({ target }) }); state = result.state; render(); }
    catch (error) { window.alert(error.message); }
  }
  async function setReplyTarget(target) {
    try { const result = await fetchJson('/api/reply-target', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ineedbetterui-UI': '1' }, body: JSON.stringify({ target }) }); state = result.state; render(); }
    catch (error) { window.alert(error.message); }
  }
  async function saveQuestionMode() {
    if (questionBusy) return;
    questionBusy = true; const checkbox = document.getElementById('question-mode'); const mode = checkbox.checked ? 'cleaned' : 'raw';
    try { const result = await fetchJson('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Ineedbetterui-UI': '1' }, body: JSON.stringify({ questionMode: mode }) }); state = result.state; render(); }
    catch (error) { checkbox.checked = !checkbox.checked; render(); window.alert(error.message); }
    finally { questionBusy = false; }
  }
  async function saveResponseLimit() {
    if (limitBusy) return;
    const input = document.getElementById('max-response-chars'); const previous = state.maxResponseChars; const value = Number(input.value);
    if (!Number.isInteger(value) || value < 0) { input.value = previous; return; }
    limitBusy = true;
    try { const result = await fetchJson('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Ineedbetterui-UI': '1' }, body: JSON.stringify({ maxResponseChars: value }) }); state = result.state; render(); }
    catch (error) { input.value = previous; window.alert(error.message); }
    finally { limitBusy = false; }
  }
  // Reads every page after the given entry ID, or the whole list when after is null.
  async function fetchEntries(after) {
    const collected = [];
    let cursor = after;
    for (;;) {
      const query = (cursor ? 'after=' + encodeURIComponent(cursor) + '&' : '') + 'limit=1000&full=1';
      const response = await fetchJson('/api/entries?' + query, { cache: 'no-store' });
      collected.push(...response.entries);
      if (!response.hasMore || !response.entries.length) return collected;
      cursor = response.nextAfter;
    }
  }
  async function refresh() {
    try {
      const next = await fetchJson('/api/state', { cache: 'no-store' }); const nextSignature = signature(next); if (nextSignature === lastSignature) return;
      const viewPosition = captureView();
      if (next.entryCount !== entries.length || next.lastEntry?.id !== entries.at(-1)?.id) {
        const lastId = entries.at(-1)?.id;
        let nextEntries = null;
        if (lastId && next.entryCount >= entries.length) {
          const added = await fetchEntries(lastId);
          if (entries.length + added.length === next.entryCount) nextEntries = entries.concat(added);
        }
        entries = nextEntries || await fetchEntries(null);
      }
      state = next; const limitInput = document.getElementById('max-response-chars'); if (document.activeElement !== limitInput) limitInput.value = String(next.maxResponseChars ?? 3000); lastSignature = nextSignature; render(); requestAnimationFrame(() => restoreView(viewPosition));
    } catch {}
  }
  document.getElementById('theme').addEventListener('click', () => { root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'; write(localStorage, themeKey, root.dataset.theme); updateThemeButton(); });
  systemTheme.addEventListener('change', () => { if (!read(localStorage, themeKey)) applyTheme(); });
  document.getElementById('question-mode').addEventListener('change', saveQuestionMode);
  document.getElementById('max-response-chars').addEventListener('change', saveResponseLimit);
  document.getElementById('max-unseen-events').addEventListener('change', async () => {
    const input = document.getElementById('max-unseen-events'); const previous = state.maxUnseenEvents; const value = Number(input.value);
    if (!Number.isInteger(value) || value < 0) { input.value = previous; return; }
    try { const result = await fetchJson('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Ineedbetterui-UI': '1' }, body: JSON.stringify({ maxUnseenEvents: value }) }); state = result.state; render(); }
    catch (error) { input.value = previous; window.alert(error.message); }
  });
  document.getElementById('vis-pin').addEventListener('change', event => { view.pin = event.target.checked; saveView(); render(); });
  const sidebarResize = document.getElementById('sidebar-resize');
  let sidebarDrag = null;
  let preferredSidebarWidth = Number.parseFloat(read(localStorage, sidebarWidthKey) || '') || 0;
  function setSidebarWidth(width) {
    const minimum = Math.min(innerWidth * 0.84, 320);
    const maximum = Math.min(minimum * 2, innerWidth);
    const next = Math.min(maximum, Math.max(minimum, width));
    sidebar.style.setProperty('--sidebar-width', next + 'px');
    sidebarResize.setAttribute('aria-valuemin', String(Math.round(minimum)));
    sidebarResize.setAttribute('aria-valuemax', String(Math.round(maximum)));
    sidebarResize.setAttribute('aria-valuenow', String(Math.round(next)));
    return next;
  }
  function finishSidebarResize() {
    if (!sidebarDrag) return;
    const pointerId = sidebarDrag.pointerId;
    sidebarDrag = null;
    sidebar.classList.remove('resizing');
    if (sidebarResize.hasPointerCapture(pointerId)) sidebarResize.releasePointerCapture(pointerId);
    write(localStorage, sidebarWidthKey, String(preferredSidebarWidth));
  }
  sidebarResize.addEventListener('pointerdown', event => {
    if (event.button !== 0 || sidebarDrag) return;
    event.preventDefault();
    sidebarDrag = { pointerId: event.pointerId, x: event.clientX, width: sidebar.getBoundingClientRect().width };
    sidebar.classList.add('resizing');
    sidebarResize.setPointerCapture(event.pointerId);
  });
  sidebarResize.addEventListener('pointermove', event => {
    if (!sidebarDrag || sidebarDrag.pointerId !== event.pointerId) return;
    preferredSidebarWidth = setSidebarWidth(sidebarDrag.width + event.clientX - sidebarDrag.x);
  });
  sidebarResize.addEventListener('pointerup', finishSidebarResize);
  sidebarResize.addEventListener('pointercancel', finishSidebarResize);
  sidebarResize.addEventListener('lostpointercapture', finishSidebarResize);
  sidebarResize.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const width = Number.parseFloat(sidebar.style.getPropertyValue('--sidebar-width'));
    preferredSidebarWidth = setSidebarWidth(event.key === 'Home' ? 0 : event.key === 'End' ? innerWidth : width + (event.key === 'ArrowRight' ? 16 : -16));
    write(localStorage, sidebarWidthKey, String(preferredSidebarWidth));
  });
  setSidebarWidth(preferredSidebarWidth);
  addEventListener('resize', () => setSidebarWidth(preferredSidebarWidth));
  const closeSidebar = () => { finishSidebarResize(); sidebar.classList.remove('open'); backdrop.classList.remove('open'); write(localStorage, sidebarKey, 'closed'); render(); };
  const openSidebar = () => { sidebar.classList.add('open'); backdrop.classList.add('open'); write(localStorage, sidebarKey, 'open'); render(); };
  document.getElementById('sidebar-toggle').addEventListener('click', () => { if (sidebar.classList.contains('open')) closeSidebar(); else openSidebar(); });
  backdrop.addEventListener('click', closeSidebar);
  const pinnedMinHeight = 96;
  let pinnedDrag = null;
  function clampPinnedHeight(value) {
    const maximum = Math.max(pinnedMinHeight, Math.floor(innerHeight * 0.8));
    return Math.min(Math.max(value, pinnedMinHeight), maximum);
  }
  function setPinnedHeight(value) {
    const next = clampPinnedHeight(value);
    pinned.style.setProperty('--pinned-h', next + 'px');
    pinnedResize.setAttribute('aria-valuemin', String(pinnedMinHeight));
    pinnedResize.setAttribute('aria-valuemax', String(Math.round(Math.max(pinnedMinHeight, innerHeight * 0.8))));
    pinnedResize.setAttribute('aria-valuenow', String(Math.round(next)));
    return next;
  }
  function updatePinnedBounds() {
    const current = Number.parseFloat(pinned.style.getPropertyValue('--pinned-h'));
    if (Number.isFinite(current)) setPinnedHeight(current);
  }
  function finishPinnedResize(event) {
    if (!pinnedDrag || (event && event.pointerId !== pinnedDrag.pointerId)) return;
    const pointerId = pinnedDrag.pointerId;
    pinnedDrag = null;
    document.body.classList.remove('resizing-pinned');
    if (pinnedResize.hasPointerCapture(pointerId)) pinnedResize.releasePointerCapture(pointerId);
    const height = Number.parseFloat(pinned.style.getPropertyValue('--pinned-h'));
    if (Number.isFinite(height)) write(localStorage, pinnedHKey, String(height));
  }
  pinnedResize.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pinned.hidden || pinnedDrag) return;
    event.preventDefault();
    pinnedDrag = { pointerId: event.pointerId, startY: event.clientY, startH: pinned.getBoundingClientRect().height };
    document.body.classList.add('resizing-pinned');
    pinnedResize.setPointerCapture(event.pointerId);
  });
  pinnedResize.addEventListener('pointermove', event => {
    if (!pinnedDrag || pinnedDrag.pointerId !== event.pointerId) return;
    setPinnedHeight(pinnedDrag.startH + event.clientY - pinnedDrag.startY);
  });
  pinnedResize.addEventListener('pointerup', finishPinnedResize);
  pinnedResize.addEventListener('pointercancel', finishPinnedResize);
  pinnedResize.addEventListener('lostpointercapture', finishPinnedResize);
  addEventListener('resize', updatePinnedBounds);
  const savedPinnedHeight = Number.parseFloat(read(localStorage, pinnedHKey) || '');
  if (Number.isFinite(savedPinnedHeight)) setPinnedHeight(savedPinnedHeight);
  const outlineResize = document.getElementById('outline-resize'); let resizing = false; let startY = 0; let startH = 0;
  function availableOutlineHeight() {
    return Math.max(0, Math.floor(sidebar.querySelector('.sidebar-footer').getBoundingClientRect().top - outlineSection.getBoundingClientRect().top - 8));
  }
  function updateOutlineBounds() {
    if (outlineSection.hidden || !sidebar.classList.contains('open')) return;
    outlineSection.style.setProperty('--outline-available', availableOutlineHeight() + 'px');
  }
  const clampHeight = value => Math.min(Math.max(value, 96), availableOutlineHeight());
  const outlineBoundsObserver = new ResizeObserver(updateOutlineBounds);
  outlineBoundsObserver.observe(sidebar.querySelector('.sidebar-content'));
  outlineBoundsObserver.observe(sidebar.querySelector('.sidebar-footer'));
  outlineBoundsObserver.observe(outlineSection);
  addEventListener('resize', updateOutlineBounds);
  sidebar.addEventListener('transitionend', updateOutlineBounds);
  outlineResize.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); resizing = true; startY = event.clientY; startH = outlineSection.getBoundingClientRect().height; sidebar.classList.add('resizing-outline'); outlineResize.setPointerCapture(event.pointerId); });
  outlineResize.addEventListener('pointermove', event => { if (resizing) root.style.setProperty('--outline-h', clampHeight(startH + event.clientY - startY) + 'px'); });
  const endResize = () => { if (!resizing) return; resizing = false; sidebar.classList.remove('resizing-outline'); write(localStorage, outlineHKey, getComputedStyle(root).getPropertyValue('--outline-h').trim()); };
  outlineResize.addEventListener('pointerup', endResize); outlineResize.addEventListener('pointercancel', endResize);
  applyTheme();
  const savedHeight = Number.parseFloat(read(localStorage, outlineHKey) || ''); if (Number.isFinite(savedHeight)) root.style.setProperty('--outline-h', Math.max(96, savedHeight) + 'px');
  if (read(localStorage, sidebarKey) === 'open') { sidebar.classList.add('open'); backdrop.classList.add('open'); }
  lastSignature = signature(state); render();
  try { const saved = JSON.parse(sessionStorage.getItem(viewKey) || 'null'); sessionStorage.removeItem(viewKey); requestAnimationFrame(() => restoreView(saved)); } catch {}
  addEventListener('pagehide', () => write(sessionStorage, viewKey, JSON.stringify(captureView())));
  setInterval(refresh, 2000);
})();
</script>
</body>
</html>`;
}

function requestHandler(req, res) {
  return (async () => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname.endsWith('.html'))) {
        return htmlResponse(res, pageHtml(runtime.current, runtime.current.entries));
      }
      return errorResponse(res, 404, '경로를 찾을 수 없습니다.');
    } catch (error) {
      return errorResponse(res, 500, error.message || '서버 오류');
    }
  })();
}

function broadcastHostAddress() {
  const interfaces = os.networkInterfaces();
  const addresses = Object.values(interfaces).flatMap(list => Array.isArray(list) ? list : []);
  const address = addresses.find(info => {
    const family = info && (info.family === 4 || info.family === 'IPv4');
    return family && !info.internal && !String(info.address).startsWith('169.254.');
  });
  return address ? address.address : '127.0.0.1';
}

function accessUrl(port) {
  return `http://${broadcastMode ? broadcastHostAddress() : '127.0.0.1'}:${port}/`;
}

function appendBroadcastEntry(port) {
  const url = accessUrl(port);
  const broadcastId = `broadcast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const id = `a-${runtime.nextEntryNo + 1}`;
  appendEvent({
    t: 'entry',
    id,
    kind: 'other',
    time: nowIso(),
    heading: 'Broadcast access QR code',
    body: `Scan the QR code to open this broadcast: ${url}`,
    broadcastId,
    broadcastUrl: url,
    broadcastPort: port,
    qr: makeQrCode(url)
  });
  return { id, url, broadcastId };
}

// A running server announces itself with server-<port>.html in the records folder.
// Opening the file in a browser redirects to the server.
const INFO_FILE_PATTERN = /^server-(\d+)\.html$/;

function infoFilePath(port) {
  return path.join(sessionDir, `server-${port}.html`);
}

function infoFileHtml(port) {
  const url = `http://127.0.0.1:${port}/`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=${url}">
<title>I Need Better UI</title>
</head>
<body data-app="${APP_NAME}" data-session-id="${sessionId}" data-port="${port}" data-pid="${process.pid}">
<p>Opening <a href="${url}">${url}</a>. If nothing happens, this ${APP_NAME} server is no longer running.</p>
</body>
</html>
`;
}

function listInfoFiles() {
  try {
    return fs.readdirSync(sessionDir).flatMap(name => {
      const match = INFO_FILE_PATTERN.exec(name);
      return match ? [{ file: path.join(sessionDir, name), port: Number(match[1]) }] : [];
    });
  } catch {
    return [];
  }
}

function removeFile(file) {
  try { fs.unlinkSync(file); } catch {}
}

function writeProjectInfo() {
  const file = path.join(sessionDir, 'project.json');
  let createdAt = nowIso();
  try { createdAt = JSON.parse(fs.readFileSync(file, 'utf8')).createdAt || createdAt; } catch {}
  const info = { app: APP_NAME, sessionId, projectPath, createdAt, lastStartedAt: nowIso() };
  fs.writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
}

function checkHealth(port) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/health', timeout: HEALTH_TIMEOUT_MS }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const health = JSON.parse(body);
          finish(response.statusCode === 200 && health.app === APP_NAME ? health : null);
        } catch { finish(null); }
      });
    });
    request.on('error', () => finish(null));
    request.on('timeout', () => { request.destroy(); finish(null); });
  });
}

function bindServer(candidate) {
  const server = http.createServer(requestHandler);
  return new Promise(resolve => {
    const onListening = () => { server.removeListener('error', onError); resolve({ server, error: null }); };
    const onError = error => { server.removeListener('listening', onListening); resolve({ server, error }); };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(candidate, broadcastMode ? '0.0.0.0' : '127.0.0.1');
  });
}

async function findRunningServer(files) {
  for (const file of files) {
    const health = await checkHealth(file.port);
    if (health?.sessionId === sessionId) return health;
  }
  return null;
}

async function startServer(preferredPorts) {
  for (const port of preferredPorts) {
    const result = await bindServer(port);
    if (!result.error) return result.server;
    result.server.close();
  }
  const result = await bindServer(0);
  if (result.error) throw result.error;
  return result.server;
}

function removeInfoFileOnExit(file) {
  process.on('exit', () => removeFile(file));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(signal, () => process.exit(0));
  }
}

async function main() {
  const files = listInfoFiles();
  const running = await findRunningServer(files);
  if (running) {
    if (running.broadcast !== broadcastMode) {
      const mode = running.broadcast ? '브로드캐스트' : '로컬 전용(--no-broadcast)';
      throw new Error(`이 폴더의 ${APP_NAME}가 이미 ${mode} 모드로 실행 중입니다(PID ${running.pid}, 포트 ${running.port}). 기존 서버를 종료한 뒤 다시 실행하세요.`);
    }
    console.log(`${APP_NAME} already running on http://127.0.0.1:${running.port}/`);
    return;
  }

  // No live server answered for this session, so any info file left here is stale.
  for (const file of files) removeFile(file.file);
  const server = await startServer(files.map(file => file.port));
  const address = server.address();
  serverPort = address && typeof address === 'object' ? address.port : null;
  if (!serverPort) {
    server.close();
    throw new Error('서버 포트를 확인하지 못했습니다.');
  }

  ensureSessionDir();
  writeProjectInfo();
  const infoFile = infoFilePath(serverPort);
  fs.writeFileSync(infoFile, infoFileHtml(serverPort), 'utf8');
  removeInfoFileOnExit(infoFile);
  console.log(`${APP_NAME} listening on http://127.0.0.1:${serverPort}/`);
  console.log(`records ${dataPath}`);

  if (broadcastMode) {
    const broadcast = appendBroadcastEntry(serverPort);
    console.log(`broadcast access on ${broadcast.url}`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
