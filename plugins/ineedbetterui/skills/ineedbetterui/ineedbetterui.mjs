#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME, realProjectPath, recordsDirFor, sessionIdFor } from './lib/paths.mjs';
import { makeQrCode } from './lib/qr.mjs';

const MAX_REQUEST_BYTES = 2_000_000;
const DEFAULT_MAX_RESPONSE_CHARS = 3_000;
const DEFAULT_MAX_UNSEEN_EVENTS = 20;
const PREVIEW_CHARS = 200;
const GENESIS_HASH = '0'.repeat(16);
const HEALTH_TIMEOUT_MS = 600;
const KINDS = new Set(['question', 'report', 'decision', 'error', 'done', 'other']);
const QUESTION_MODES = new Set(['cleaned', 'raw']);

const projectPath = realProjectPath(process.cwd());
const sessionId = sessionIdFor(projectPath);
const sessionDir = recordsDirFor(projectPath);
const dataPath = path.join(sessionDir, 'transcript.jsonl');

function ensureSessionDir() {
  fs.mkdirSync(sessionDir, { recursive: true });
  const ignoreFile = path.join(sessionDir, '.gitignore');
  if (!fs.existsSync(ignoreFile)) fs.writeFileSync(ignoreFile, '*\n', 'utf8');
}
// Broadcast is off unless --broadcast is given; --no-broadcast is still accepted
// and ignored. The page on this computer can turn it on and off while running.
let broadcastMode = process.argv.slice(2).includes('--broadcast');
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
  if (event.t === 'broadcast') {
    current.broadcast = event.enabled === true
      ? { enabled: true, url: event.url || null, port: Number.isInteger(event.port) ? event.port : null }
      : null;
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
  if (event.t === 'broadcast') return Object.assign(item, { enabled: event.enabled === true, url: event.url || null, port: event.port || null });
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

// One short reminder of the recording rules in every write response. Responses
// arrive late in the agent's context, so the rules survive a long session or a
// compacted one without repeating SKILL.md.
function nextHint(sync) {
  const hints = [];
  if (sync.status === 'none' || sync.status === 'unknown') hints.push('Send the returned sync.head as knownHead on every write.');
  const last = runtime.current.entries.at(-1);
  if (last?.kind === 'question') hints.push('Record your reply to the user when you give it.');
  else hints.push("Record the user's next message as a question (rawBody + cleanedBody) before replying.");
  const target = activeReplyTarget();
  if (target) hints.push(`Your next reply is linked to pinned entry ${target.id}.`);
  return hints.join(' ');
}

function writeResponse(res, status, payload, knownHead, ownHash = null) {
  const sync = syncResult(knownHead, { ownHash });
  return jsonResponse(res, status, { ok: true, ...payload, state: stateSummary(), sync, next: nextHint(sync) });
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
    broadcast: broadcastInfo ? { ...broadcastInfo } : null,
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

// Every rejection carries the current settings, so an agent never needs a second
// call to find out which limit or mode caused it.
function errorResponse(res, status, message, extra = {}) {
  jsonResponse(res, status, { ok: false, error: message, written: false, state: stateSummary(), ...extra });
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
        reject(new Error('The request body is too large.'));
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
        reject(new Error('The request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must not be empty.`);
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
    const error = new Error(`A reply can be at most ${maxResponseChars} characters (this one has ${count}). Split or rewrite it; do not cut it off.`);
    error.maxResponseChars = maxResponseChars; error.length = count;
    throw error;
  }
}

function currentEntry(id) {
  if (!/^a-\d+$/.test(id) || !runtime.current.byId.has(id)) throw new Error('The target reply was not found.');
  return runtime.current.byId.get(id);
}

function pinEntry(id) {
  const entry = currentEntry(id);
  if (entry.kind === 'question') throw new Error('Questions cannot be pinned; pin a reply.');
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
  if (runtime.current.pin?.target !== id) throw new Error('Only the pinned reply can be the reply target.');
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

  if (req.method === 'POST' && url.pathname === '/api/broadcast') {
    try {
      const body = await readJson(req);
      if (typeof body.on !== 'boolean') throw new Error('on must be true or false.');
      if (!isLoopbackRequest(req)) throw new Error('Broadcast can only be switched from the page on this computer.');
      if (body.on === broadcastMode) return writeResponse(res, 200, { written: false }, body.knownHead);
      broadcastMode = body.on;
      updateBroadcastInfo();
      const ownHash = appendEvent({
        t: 'broadcast',
        time: nowIso(),
        enabled: broadcastMode,
        url: broadcastInfo ? broadcastInfo.url : null,
        port: serverPort,
        source: req.headers['x-ineedbetterui-ui'] === '1' ? 'user' : 'agent'
      });
      // Rebind only once this response is on the wire: changing the listening
      // address drops the open connections, including this one.
      res.on('finish', () => setTimeout(() => { void applyBroadcast(broadcastMode); }, 50));
      return writeResponse(res, 200, { written: true }, body.knownHead, ownHash);
    } catch (error) {
      return errorResponse(res, 400, error.message);
    }
  }

  if (req.method === 'PATCH' && url.pathname === '/api/settings') {
    try {
      const body = await readJson(req);
      const event = { t: 'settings', time: nowIso() };
      if (Object.prototype.hasOwnProperty.call(body, 'questionMode')) {
        if (!QUESTION_MODES.has(body.questionMode)) throw new Error('questionMode must be cleaned or raw.');
        event.questionMode = body.questionMode;
      }
      for (const key of ['maxResponseChars', 'maxUnseenEvents']) {
        if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
        if (!Number.isInteger(body[key]) || body[key] < 0) throw new Error(`${key} must be an integer of 0 or more.`);
        event[key] = body[key];
      }
      if (Object.keys(event).length === 2) throw new Error('No setting was given.');
      const ownHash = appendEvent(event);
      return writeResponse(res, 200, { written: true }, body.knownHead, ownHash);
    } catch (error) {
      return errorResponse(res, 400, error.message);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/entries') {
    try {
      const body = await readJson(req);
      if (!KINDS.has(body.kind)) throw new Error('kind must be question, report, decision, error, done or other.');
      const hasBody = typeof body.body === 'string';
      const hasRaw = typeof body.rawBody === 'string';
      const hasCleaned = typeof body.cleanedBody === 'string';
      if (!hasBody && !hasRaw && !hasCleaned) throw new Error('Send body, or rawBody and cleanedBody for a question.');
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
        if (entry.kind === 'question') throw new Error('Notes cannot be added to a question.');
        if (runtime.current.pin?.target !== id) throw new Error('Notes can only be added to the pinned reply; pin it first.');
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
      return errorResponse(res, 404, 'Unsupported endpoint.');
    } catch (error) {
      return errorResponse(res, 400, error.message, error.maxResponseChars === undefined ? {} : { maxResponseChars: error.maxResponseChars, length: error.length });
    }
  }

  if (req.method === 'PATCH' && url.pathname === '/api/outline') {
    try {
      const body = await readJson(req);
      if (typeof body.done !== 'boolean') throw new Error('done must be a boolean.');
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
      if (body.target !== null && typeof body.target !== 'string') throw new Error('target must be a reply ID or null.');
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
      if (body.target !== null && typeof body.target !== 'string') throw new Error('target must be the pinned reply ID or null.');
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
      if (body.confirm !== true) throw new Error('Reset needs confirm:true; send it only when the user asks to reset.');
      const ownHash = appendEvent({ t: 'reset', time: nowIso() });
      return writeResponse(res, 200, { written: true }, body.knownHead, ownHash);
    } catch (error) {
      return errorResponse(res, 400, error.message);
    }
  }

  return errorResponse(res, 404, 'API route not found.');
}

// The page is assembled once from ui/: the shell with the stylesheet and the
// script inlined, so it is still served as a single HTML response.
const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const readUi = name => fs.readFileSync(path.join(uiDir, name), 'utf8');
const pageShell = readUi('page.html')
  .replace('/*CSS*/', () => readUi('page.css'))
  .replace('/*JS*/', () => readUi('page.js'));

function pageHtml(currentState, entries) {
  const initial = safeJson({
    state: stateSummary(),
    entries: entries.map(entry => publicEntry(entry, true))
  });
  return pageShell.replace('@@INITIAL@@', () => initial);
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const READ_METHODS = new Set(['GET', 'HEAD']);

// Guards a local server against other web pages: a Host check stops DNS
// rebinding, and requiring a JSON body plus a same-origin Origin stops
// cross-site form posts. Other computers on the LAN may only read.
function requestRefusal(req, url) {
  const allowedHosts = new Set(LOCAL_HOSTNAMES);
  if (broadcastMode) allowedHosts.add(broadcastHostAddress());
  if (!allowedHosts.has(url.hostname)) return 'Host not allowed.';
  if (READ_METHODS.has(req.method)) return null;
  if (!isLoopbackRequest(req)) return 'Other computers can only read this transcript.';
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return 'Writes need Content-Type: application/json.';
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return 'Cross-origin writes are not accepted.';
  return null;
}

function requestHandler(req, res) {
  return (async () => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const refusal = requestRefusal(req, url);
      if (refusal) return errorResponse(res, 403, refusal);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname.endsWith('.html'))) {
        return htmlResponse(res, pageHtml(runtime.current, runtime.current.entries));
      }
      return errorResponse(res, 404, 'Not found.');
    } catch (error) {
      return errorResponse(res, 500, error.message || 'Server error');
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

let httpServer = null;
let broadcastInfo = null;

function isLoopbackRequest(req) {
  const address = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function updateBroadcastInfo() {
  if (!broadcastMode || !serverPort) {
    broadcastInfo = null;
    return null;
  }
  const url = accessUrl(serverPort);
  broadcastInfo = { enabled: true, url, port: serverPort, qr: makeQrCode(url) };
  return broadcastInfo;
}

// Switches the listening address without restarting the process, so the port,
// the records and the running agent session all stay as they are.
function rebindServer(on) {
  return new Promise((resolve, reject) => {
    if (!httpServer || !serverPort) {
      reject(new Error('The server has not started yet.'));
      return;
    }
    httpServer.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      const onError = listenError => { httpServer.removeListener('listening', onListening); reject(listenError); };
      const onListening = () => { httpServer.removeListener('error', onError); resolve(); };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(serverPort, on ? '0.0.0.0' : '127.0.0.1');
    });
    httpServer.closeIdleConnections?.();
    httpServer.closeAllConnections?.();
  });
}

async function applyBroadcast(on) {
  try {
    await rebindServer(on);
  } catch (error) {
    // Keep serving on the address that still works and record what happened.
    broadcastMode = !on;
    updateBroadcastInfo();
    appendEvent({
      t: 'broadcast',
      time: nowIso(),
      enabled: broadcastMode,
      url: broadcastInfo ? broadcastInfo.url : null,
      port: serverPort,
      error: error.message
    });
    try { await rebindServer(broadcastMode); } catch {}
  }
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
    // Broadcast is a switch on the running server now, so a different mode is
    // no longer a reason to refuse.
    console.log(`${APP_NAME} already running on http://127.0.0.1:${running.port}/`);
    return;
  }

  // No live server answered for this session, so any info file left here is stale.
  for (const file of files) removeFile(file.file);
  const server = await startServer(files.map(file => file.port));
  httpServer = server;
  const address = server.address();
  serverPort = address && typeof address === 'object' ? address.port : null;
  if (!serverPort) {
    server.close();
    throw new Error('Could not read the server port.');
  }

  ensureSessionDir();
  writeProjectInfo();
  const infoFile = infoFilePath(serverPort);
  fs.writeFileSync(infoFile, infoFileHtml(serverPort), 'utf8');
  removeInfoFileOnExit(infoFile);
  console.log(`${APP_NAME} listening on http://127.0.0.1:${serverPort}/`);
  console.log(`records ${dataPath}`);

  if (broadcastMode) {
    updateBroadcastInfo();
    console.log(`broadcast access on ${broadcastInfo.url}`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
