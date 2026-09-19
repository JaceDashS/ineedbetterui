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
// Events that only switch a current value; kept out of the hash chain.
// reply-target is the older name of pin-reply and is still read.
const STATE_EVENTS = new Set(['pin', 'pin-reply', 'reply-target', 'settings', 'broadcast', 'outline']);

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
    // Add reply: the ID of the pinned entry this turn's reply will edit, or null.
    pinReply: null,
    questionMode: 'cleaned',
    maxResponseChars: DEFAULT_MAX_RESPONSE_CHARS,
    maxUnseenEvents: DEFAULT_MAX_UNSEEN_EVENTS,
    broadcast: null,
    // A turn opens when a question is recorded and closes with a final reply.
    turn: { open: false, since: null }
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
    final: event.final === true ? true : undefined,
    revises: typeof event.revises === 'string' && event.revises ? event.revises : undefined,
    patch: event.patch && typeof event.patch.old === 'string' && typeof event.patch.new === 'string' ? { old: event.patch.old, new: event.patch.new } : undefined,
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
    if (event.kind !== 'question' && current.pinReply) current.pinReply = null;
    if (event.kind === 'question') current.turn = { open: true, since: event.time };
    else if (event.final === true) current.turn = { open: false, since: null };
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
    if (current.pinReply && current.pinReply !== target) current.pinReply = null;
    return;
  }
  if (event.t === 'outline') {
    current.outline = {
      done: event.done === true,
      items: Array.isArray(event.items) ? event.items : []
    };
    return;
  }
  // Add reply for the pinned entry. pin-reply carries {active, target}; the
  // older reply-target carried only target (null meaning off).
  if (event.t === 'pin-reply' || event.t === 'reply-target') {
    const target = typeof event.target === 'string' && event.target ? event.target : null;
    const active = event.t === 'pin-reply' ? event.active === true : Boolean(target);
    if (!active || !target) {
      current.pinReply = null;
      return;
    }
    if (current.pin?.target === target && current.byId.get(target)?.kind !== 'question') current.pinReply = target;
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

function emptyRuntime() {
  return {
    current: emptyCurrentState(),
    allEntries: new Map(),
    clientRefs: new Map(),
    nextEntryNo: 0,
    events: [],
    head: GENESIS_HASH,
    hashIndex: new Map([[GENESIS_HASH, -1]]),
    fileBytes: Buffer.alloc(0),
    // Index in events of the last reset line; -1 means the start of the chain.
    lastResetIndex: -1,
    // Counts outline changes (and resets) and never goes back, so an agent
    // that remembers the number can tell when the outline changed.
    outlineVersion: 0,
    // Counts state switches (pin, Add reply, settings, broadcast), which are
    // not in the hash chain, so open pages can still tell that they changed.
    stateVersion: 0
  };
}

// Applies one transcript line to the runtime. Loading the file and appending
// to it share this, so an append costs one line instead of a full reread.
function ingestLine(rt, line) {
  if (!line.trim()) return;
  let event = null;
  try {
    event = JSON.parse(line);
  } catch {}
  // State switches only change the current value; their history would be
  // noise to an agent. They are applied but kept out of the hash chain, and
  // agents get their current values in `state` and `turn`.
  if (event && typeof event === 'object' && STATE_EVENTS.has(event.t)) {
    rt.stateVersion += 1;
    if (event.t === 'outline') rt.outlineVersion += 1;
    applyEvent(rt.current, event);
    return;
  }
  // Every conversation line extends a hash chain, so a client that remembers
  // one hash can be told exactly which events it has not seen.
  rt.head = createHash('sha256').update(`${rt.head}\n${line}`).digest('hex').slice(0, 16);
  rt.hashIndex.set(rt.head, rt.events.length);
  if (!event || typeof event !== 'object') {
    rt.events.push({ hash: rt.head, event: null });
    return;
  }
  rt.events.push({ hash: rt.head, event });
  if (event.t === 'entry' && typeof event.id === 'string') {
    const match = /^a-(\d+)$/.exec(event.id);
    if (match) rt.nextEntryNo = Math.max(rt.nextEntryNo, Number(match[1]));
    const entry = eventEntry(event);
    rt.allEntries.set(entry.id, entry);
    if (typeof entry.clientRef === 'string' && entry.clientRef) rt.clientRefs.set(entry.clientRef, entry);
  }
  if (event.t === 'reset') rt.outlineVersion += 1;
  if (event.t === 'reset') {
    rt.lastResetIndex = rt.events.length - 1;
    const { current } = rt;
    current.entries = [];
    current.byId = new Map();
    current.outline = { done: false, items: [] };
    current.pin = null;
    current.pinReply = null;
    current.questionMode = 'cleaned';
    current.maxResponseChars = DEFAULT_MAX_RESPONSE_CHARS;
    current.maxUnseenEvents = DEFAULT_MAX_UNSEEN_EVENTS;
    current.broadcast = null;
    current.turn = { open: false, since: null };
    return;
  }
  applyEvent(rt.current, event);
}

function readTranscript() {
  return fs.existsSync(dataPath) ? fs.readFileSync(dataPath) : Buffer.alloc(0);
}

function loadRuntime(bytes = readTranscript()) {
  const rt = emptyRuntime();
  for (const line of bytes.toString('utf8').split(/\r?\n/)) ingestLine(rt, line);
  rt.fileBytes = bytes;
  return rt;
}

let runtime = loadRuntime();

// Returns the new head hash, which is the hash of the event just written.
// Only the new line is parsed and hashed. The server keeps the bytes it
// expects on disk; if the file differs (a hand edit, another process), it is
// replayed in full first. Comparing bytes catches even a same-size edit made
// within the file system's timestamp resolution, which a size or mtime check
// would miss.
function appendEvent(event) {
  ensureSessionDir();
  const onDisk = readTranscript();
  if (!onDisk.equals(runtime.fileBytes)) runtime = loadRuntime(onDisk);
  const line = JSON.stringify(event);
  const bytes = Buffer.from(`${line}\n`, 'utf8');
  const headBefore = runtime.head;
  fs.appendFileSync(dataPath, bytes);
  ingestLine(runtime, line);
  runtime.fileBytes = Buffer.concat([runtime.fileBytes, bytes]);
  notifyWatchers();
  // A state switch adds no hash, so there is no own event to leave out of sync.
  return runtime.head === headBefore ? null : runtime.head;
}

// Open pages listen on /api/events (Server-Sent Events). Every write goes
// through appendEvent, so the server knows the moment something changes and
// pushes the new head instead of waiting for the page to ask.
const watchers = new Set();
const WATCH_KEEPALIVE_MS = 25_000;

function watchMessage() {
  return JSON.stringify({ head: runtime.head, state: runtime.stateVersion });
}

function notifyWatchers() {
  const message = `data: ${watchMessage()}\n\n`;
  for (const res of watchers) res.write(message);
}

function openWatch(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive'
  });
  res.write(`retry: 2000\ndata: ${watchMessage()}\n\n`);
  watchers.add(res);
  // A comment line now and then keeps proxies and idle timeouts from closing the stream.
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), WATCH_KEEPALIVE_MS);
  req.on('close', () => {
    clearInterval(keepalive);
    watchers.delete(res);
  });
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
    if (event.final === true) item.final = true;
    // A new version of a pinned document is sent as the change, not the whole
    // document again; the full text is at GET /api/entries/<id>.
    if (event.revises && event.patch) return Object.assign(item, { revises: event.revises, old: event.patch.old, new: event.patch.new });
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
  const known = typeof knownHead === 'string' ? runtime.hashIndex.get(knownHead) : undefined;
  // An agent without a head we know (a new agent joining the thread, or one
  // that lost its head) knows nothing yet, so it is sent the conversation since
  // the last reset, capped like any other sync.
  const index = known ?? runtime.lastResetIndex;
  const later = runtime.events.slice(index + 1).filter(item => item.hash !== ownHash);
  const cap = limit ?? runtime.current.maxUnseenEvents;
  const shown = cap > 0 ? later.slice(-cap) : later;
  let status = later.length ? 'behind' : 'current';
  if (known === undefined) status = typeof knownHead === 'string' && knownHead ? 'unknown' : 'none';
  return {
    ...result,
    status,
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
  if (sync.status === 'none' || sync.status === 'unknown') {
    if (sync.unseenCount) hints.push('sync.unseen holds the conversation so far (possibly with other agents); read it and continue from it.');
    hints.push('Send the returned sync.head as knownHead on every write.');
  } else if (sync.status === 'behind') {
    hints.push('sync.unseen holds events you have not seen (other agents or the user); take them into account.');
  }
  if (sync.truncated) hints.push('Only the latest events were sent; fetch more with GET /api/entries?last=N&full=1 if you need them.');
  const last = runtime.current.entries.at(-1);
  const target = activeReplyTarget();
  if (last?.kind === 'question') {
    if (target) hints.push(`Add reply is on: this turn's reply edits pinned entry ${target.id}. Read it with GET /api/entries/${target.id} and send the change to POST /api/pin/edit as old and new.`);
    else hints.push('Record your reply to the user when you give it.');
    const limit = runtime.current.maxResponseChars;
    if (limit > 0) hints.push(`Keep what you write within ${limit} characters, or split it.`);
    hints.push('Mark the last reply of this turn final:true; until then the turn stays open and no other question can be recorded.');
  } else if (runtime.current.turn.open) {
    hints.push('The turn is still open: mark the last reply of this turn final:true.');
  } else {
    hints.push("Record the user's next message as a question (rawBody + cleanedBody) before replying.");
  }
  return hints.join(' ');
}

// What the agent needs before writing this turn's reply, sent with the
// response to the question it records at the start of the turn. Only what
// changes how or where the reply is written; everything else is in `state`.
function turnBrief(sync) {
  const turn = {};
  const limit = runtime.current.maxResponseChars;
  if (limit > 0) turn.replyLimit = limit;
  const target = activeReplyTarget();
  if (target) turn.replyTo = target.id;
  const outline = runtime.current.outline;
  if (!outline.done) {
    const item = outline.items.find(entry => entry?.current === true) || outline.items.find(entry => entry?.status === 'active');
    if (item) turn.outline = { no: item.no, title: item.title, status: item.status };
  }
  if (sync.unseen.length) {
    const kinds = {};
    for (const event of sync.unseen) kinds[event.t] = (kinds[event.t] || 0) + 1;
    // Only a summary: the events themselves are in sync.unseen of the same response.
    turn.unseen = { count: sync.unseenCount ?? sync.unseen.length, kinds, in: 'sync.unseen' };
  }
  return turn;
}

// `brief` adds the turn brief; it is set when a question is recorded.
function writeResponse(res, status, payload, knownHead, ownHash = null, { brief = false } = {}) {
  const sync = syncResult(knownHead, { ownHash });
  const turn = brief ? { turn: turnBrief(sync) } : {};
  return jsonResponse(res, status, { ok: true, ...payload, ...turn, ...outlineVersionField(), state: responseState(res), sync, next: nextHint(sync) });
}


function publicEntry(entry, full = false) {
  const result = {
    id: entry.id,
    kind: entry.kind,
    time: entry.time,
    heading: entry.heading
  };
  if (entry.replyTo) result.replyTo = entry.replyTo;
  if (entry.revises) result.revises = entry.revises;
  if (entry.final) result.final = true;
  if (!full) return result;
  result.body = entry.body;
  if (entry.patch) result.patch = { ...entry.patch };
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
  const replyActive = Boolean(pinTarget && current.pinReply === pinTarget.id);
  return {
    mode: 'record',
    outline: current.outline.items.map(item => ({ ...item })),
    outlineDone: current.outline.done,
    pin: pinTarget ? {
      target: pinTarget.id,
      source: current.pin.source,
      revisionCount: pinTarget.revisions.length,
      replyActive
    } : null,
    turn: { open: turnLocked(), since: current.turn.since },
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
// Agents get every write back with the state, so it is kept small: the whole
// outline and the broadcast QR code stay out (GET /api/outline, GET /api/state).
// The page marks its requests and gets the full state it draws from.
function responseState(res) {
  const full = stateSummary();
  if (res.fromPage) return full;
  const { outline, outlineDone, broadcast, ...rest } = full;
  return { ...rest, broadcast: broadcast ? { enabled: broadcast.enabled, url: broadcast.url, port: broadcast.port } : null };
}

// The outline's version, only while there is an outline. An agent that sees a
// number different from the one it remembers reads GET /api/outline.
function outlineVersionField() {
  const { outline } = runtime.current;
  return !outline.done && outline.items.length ? { outlineVersion: runtime.outlineVersion } : {};
}

function errorResponse(res, status, message, extra = {}) {
  jsonResponse(res, status, { ok: false, error: message, written: false, ...outlineVersionField(), state: responseState(res), ...extra });
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
  const target = runtime.current.pinReply;
  if (!target || runtime.current.pin?.target !== target) return null;
  const entry = runtime.current.byId.get(target);
  return entry && entry.kind !== 'question' ? entry : null;
}

// A turn is locked from the moment a question is recorded until a reply marked
// final, so turns never interleave. A turn nobody closes unlocks after
// TURN_LOCK_MS, so a stopped agent cannot block the transcript for good.
const TURN_LOCK_MS = 10 * 60 * 1000;

function turnLocked() {
  const { turn } = runtime.current;
  return turn.open && Date.now() - Date.parse(turn.since) < TURN_LOCK_MS;
}

function statusError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readFinal(body) {
  if (body.final !== undefined && typeof body.final !== 'boolean') throw new Error('final must be true or false.');
  return body.final === true;
}

// The one editing rule shared by pin edits and the outline: `old` is copied
// exactly from the current text and must occur in it once; it is replaced by
// `new`, which may be anything (add context to both to insert, leave `new`
// empty to delete). Anything ambiguous is refused, never guessed.
function applyPatch(current, body, where, refetch) {
  if (typeof body.old !== 'string' || !body.old) throw new Error(`old must be a non-empty string copied exactly from ${where}.`);
  if (typeof body.new !== 'string') throw new Error('new must be a string (it may be empty to delete old).');
  const count = current.split(body.old).length - 1;
  if (count === 0) throw new Error(`old was not found in ${where}; copy it exactly, or ${refetch}.`);
  if (count > 1) throw new Error(`old occurs ${count} times in ${where}; include more surrounding text so it occurs once.`);
  return current.replace(body.old, () => body.new);
}

// The outline as text, one item per line: `no | title | type | status`, with
// ` | current` on the current item. Agents edit it with old/new like a body.
function serializeOutline(items) {
  return items.map(item => [item.no, item.title, item.type || '', item.status, ...(item.current === true ? ['current'] : [])].join(' | ')).join('\n') + (items.length ? '\n' : '');
}

function parseOutline(text) {
  return text.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    const parts = line.split(' | ');
    const current = parts.at(-1)?.trim() === 'current';
    if (current) parts.pop();
    if (parts.length < 4) throw new Error(`Outline line ${index + 1} must read "no | title | type | status" (add " | current" to the current item): ${line}`);
    const status = parts.pop().trim();
    const type = parts.pop().trim();
    const no = parts.shift().trim();
    const item = { no, title: parts.join(' | ').trim(), type, status };
    if (current) item.current = true;
    return item;
  });
}

const OUTLINE_STATUSES = new Set(['pending', 'active', 'done']);

// The outline is sent whole every time, so a bad item is refused rather than
// stored and shown half-broken on the page. An empty list is allowed.
function validateOutline(items) {
  if (items === undefined) return;
  if (!Array.isArray(items)) throw new Error('items must be an array.');
  items.forEach((item, index) => {
    const at = `items[${index}]`;
    if (!item || typeof item !== 'object') throw new Error(`${at} must be an object.`);
    if (typeof item.no !== 'string' || !item.no.trim()) throw new Error(`${at}.no must be a string such as "2" or "2-1".`);
    if (typeof item.title !== 'string' || !item.title.trim()) throw new Error(`${at}.title must not be empty.`);
    if (!OUTLINE_STATUSES.has(item.status)) throw new Error(`${at}.status must be pending, active or done.`);
    if (item.current !== undefined && typeof item.current !== 'boolean') throw new Error(`${at}.current must be a boolean.`);
  });
  if (items.filter(item => item.current === true).length > 1) throw new Error('Only one outline item can be current:true.');
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && url.pathname === '/api/events') return openWatch(req, res);
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
    const replyTo = url.searchParams.get('replyTo');
    // replyTo lists the replies linked to one entry, wherever they are, so the
    // page can show a pinned reply's thread without loading the whole list.
    const list = replyTo ? runtime.current.entries.filter(entry => entry.replyTo === replyTo) : runtime.current.entries;
    const total = list.length;
    const after = url.searchParams.get('after');
    const before = url.searchParams.get('before');
    const last = Number.parseInt(url.searchParams.get('last') ?? '', 10);
    let limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 1_000);
    let start = after ? list.findIndex(entry => entry.id === after) + 1 : 0;
    if (before) {
      // The `limit` entries right before `before`: the page loads older
      // entries this way when the reader scrolls up.
      const end = list.findIndex(entry => entry.id === before);
      start = Math.max(0, (end < 0 ? total : end) - limit);
      limit = Math.min(limit, (end < 0 ? total : end) - start);
    } else if (Number.isInteger(last) && last > 0) {
      limit = Math.min(last, 1_000);
      start = Math.max(0, total - limit);
    }
    const entries = list.slice(start, start + limit).map(entry => publicEntry(entry, full));
    return jsonResponse(res, 200, {
      ok: true,
      entries,
      nextAfter: entries.at(-1)?.id || after || null,
      hasMore: start + entries.length < total,
      hasBefore: start > 0
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/broadcast') {
    return errorResponse(res, 400, 'Broadcast is a setting now: PATCH /api/settings {"broadcast": true|false}, from the page on this computer.');
  }
  if (req.method === 'PATCH' && url.pathname === '/api/settings') {
    try {
      const body = await readJson(req);
      const has = key => Object.prototype.hasOwnProperty.call(body, key);
      // Every field is checked before anything is written, so a request is
      // applied whole or not at all.
      const event = { t: 'settings', time: nowIso() };
      if (has('questionMode')) {
        if (!QUESTION_MODES.has(body.questionMode)) throw new Error('questionMode must be cleaned or raw.');
        event.questionMode = body.questionMode;
      }
      for (const key of ['maxResponseChars', 'maxUnseenEvents']) {
        if (!has(key)) continue;
        if (!Number.isInteger(body[key]) || body[key] < 0) throw new Error(`${key} must be an integer of 0 or more.`);
        event[key] = body[key];
      }
      // Broadcast widens who can reach the server, so only this computer may
      // switch it. Unlike the other settings it is not kept across restarts:
      // a restarted server is local again unless started with --broadcast.
      if (has('broadcast')) {
        if (typeof body.broadcast !== 'boolean') throw new Error('broadcast must be true or false.');
        if (!isLoopbackRequest(req)) throw new Error('Broadcast can only be switched from the page on this computer.');
      }
      const switchBroadcast = has('broadcast') && body.broadcast !== broadcastMode;
      if (Object.keys(event).length === 2 && !has('broadcast')) throw new Error('No setting was given.');
      let ownHash = null;
      if (Object.keys(event).length > 2) ownHash = appendEvent(event);
      if (switchBroadcast) {
        broadcastMode = body.broadcast;
        updateBroadcastInfo();
        appendEvent({
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
      }
      return writeResponse(res, 200, { written: Boolean(ownHash) || switchBroadcast }, body.knownHead, ownHash);
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
      if (body.kind === 'question' && !(hasRaw && hasCleaned)) throw new Error("A question needs both rawBody (the user's words) and cleanedBody (your cleaned version, in the conversation's language).");
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
        return writeResponse(res, 200, { written: false, deduplicated: true, entry: publicEntry(existing, true) }, body.knownHead, null, { brief: existing.kind === 'question' });
      }
      if (body.kind === 'question' && turnLocked()) {
        throw statusError(409, 'Another turn is in progress, so this message was not recorded. Tell the user that it cannot be recorded right now because another conversation turn is still in progress, and that they can ask you to try again later. Do not record a reply, and do not retry on your own; record the message again only when the user asks you to.');
      }
      const final = readFinal(body);
      if (body.kind === 'question' && final) throw new Error('A question cannot be final; mark the last reply of the turn final.');
      const pinned = body.kind === 'question' ? null : activeReplyTarget();
      if (pinned) throw new Error(`Add reply is on for pinned entry ${pinned.id}: this turn's reply edits that document. Send it to POST /api/pin/edit as old and new.`);
      if (body.kind !== 'question') enforceResponseLimit(sourceBody);
      const id = `a-${runtime.nextEntryNo + 1}`;
      const event = {
        t: 'entry',
        id,
        kind: body.kind,
        time: nowIso(),
        heading: typeof body.heading === 'string' ? body.heading : '',
        body: sourceBody
      };
      if (final) event.final = true;
      if (body.kind === 'question') {
        event.rawBody = rawBody;
        event.cleanedBody = cleanedBody;
        event.questionMode = runtime.current.questionMode;
      }
      if (clientRef) event.clientRef = clientRef;
      const ownHash = appendEvent(event);
      return writeResponse(res, 201, { written: true, entry: publicEntry(runtime.current.byId.get(id), true) }, body.knownHead, ownHash, { brief: body.kind === 'question' });
    } catch (error) {
      return errorResponse(res, error.status || 400, error.message, error.maxResponseChars === undefined ? {} : { maxResponseChars: error.maxResponseChars, length: error.length });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/pin/edit') {
    try {
      const body = await readJson(req);
      const pinned = activeReplyTarget();
      if (!pinned) throw new Error('Add reply is off, so the pinned document cannot be edited. Do not edit it another way: reply to the user asking them to pin the reply and turn on Add reply, then make the edit in the next turn.');
      if (body.body !== undefined) throw new Error('A pinned document is edited only with old and new; send the part that changes.');
      const final = readFinal(body);
      const document = applyPatch(pinned.body || '', body, 'the pinned document', `read it with GET /api/entries/${pinned.id}`);
      requiredText(document, 'The edited document');
      // The limit is on what the agent writes this turn, not on the document.
      enforceResponseLimit(body.new);
      // The edit becomes a new reply holding the whole new document. The pin
      // moves to it and Add reply turns off; the old version stays as it was.
      const id = `a-${runtime.nextEntryNo + 1}`;
      const event = {
        t: 'entry',
        id,
        kind: pinned.kind,
        time: nowIso(),
        heading: typeof body.heading === 'string' ? body.heading : pinned.heading,
        body: document,
        revises: pinned.id,
        patch: { old: body.old, new: body.new }
      };
      if (final) event.final = true;
      const ownHash = appendEvent(event);
      appendEvent({ t: 'pin', time: nowIso(), target: id, source: 'agent' });
      return writeResponse(res, 201, { written: true, entry: publicEntry(runtime.current.byId.get(id), true) }, body.knownHead, ownHash);
    } catch (error) {
      return errorResponse(res, error.status || 400, error.message, error.maxResponseChars === undefined ? {} : { maxResponseChars: error.maxResponseChars, length: error.length });
    }
  }
  if (parts[0] === 'api' && parts[1] === 'entries' && parts[2]) {
    const id = decodeURIComponent(parts[2]);
    try {
      const entry = currentEntry(id);
      if (req.method === 'GET' && !parts[3]) {
        return jsonResponse(res, 200, { ok: true, entry: publicEntry(entry, true) });
      }
      // Recorded replies never change. A reply is worked on as a document by
      // pinning it and turning on Add reply; see POST /api/pin/edit.
      if (req.method === 'POST' && (parts[3] === 'notes' || parts[3] === 'revisions')) {
        throw new Error('Recorded replies cannot be edited. To correct something, say so in a new reply; to work on a reply as a document, the user pins it and turns on Add reply, then send the change to POST /api/pin/edit.');
      }
      return errorResponse(res, 404, 'Unsupported endpoint.');
    } catch (error) {
      return errorResponse(res, 400, error.message, error.maxResponseChars === undefined ? {} : { maxResponseChars: error.maxResponseChars, length: error.length });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/outline') {
    const { outline } = runtime.current;
    const { outlineVersion } = outlineVersionField();
    return jsonResponse(res, 200, { ok: true, done: outline.done, text: serializeOutline(outline.items), ...(outlineVersion === undefined ? {} : { version: outlineVersion }) });
  }
  if (req.method === 'PATCH' && url.pathname === '/api/outline') {
    try {
      const body = await readJson(req);
      const event = { t: 'outline', time: nowIso(), done: body.done === true, items: [] };
      if (body.done !== undefined && typeof body.done !== 'boolean') throw new Error('done must be a boolean.');
      if (['text', 'old', 'items'].filter(key => body[key] !== undefined).length > 1) {
        throw new Error('Send one of text (the whole outline), old and new (a part to replace), or items, not several.');
      }
      if (!event.done) {
        if (body.old !== undefined) {
          // The old text must still be in the outline, so an edit never applies
          // to lines that changed since the agent read them; turns do not overlap.
          const text = applyPatch(serializeOutline(runtime.current.outline.items), body, 'the outline', 'read it again with GET /api/outline');
          event.items = parseOutline(text);
          event.patch = { old: body.old, new: body.new };
        } else if (body.text !== undefined) {
          if (typeof body.text !== 'string') throw new Error('text must be a string.');
          event.items = parseOutline(body.text);
        } else if (body.items !== undefined) {
          validateOutline(body.items);
          event.items = body.items;
        } else if (body.done === undefined) {
          throw new Error('Send text (the whole outline), old and new with version (a part to replace), or done:true.');
        }
        // done:false alone clears the outline to an empty one.
        validateOutline(event.items);
      }
      const ownHash = appendEvent(event);
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

  // Add reply: the page switches it for the pinned entry. The agent never calls
  // this; it sends the edit itself to POST /api/pin/edit.
  if (req.method === 'POST' && url.pathname === '/api/pin/reply') {
    try {
      const body = await readJson(req);
      if (typeof body.active !== 'boolean') throw new Error('This switches Add reply for the pinned entry and needs {"active": true|false}. To edit the pinned document, send old and new to POST /api/pin/edit.');
      const pinned = runtime.current.pin?.target ? currentEntry(runtime.current.pin.target) : null;
      if (body.active && (!pinned || pinned.kind === 'question')) throw new Error('Pin a reply before turning on Add reply.');
      const source = req.headers['x-ineedbetterui-ui'] === '1' ? 'user' : 'agent';
      const ownHash = appendEvent({ t: 'pin-reply', time: nowIso(), active: body.active, target: body.active ? pinned.id : null, source });
      return writeResponse(res, 200, { written: true }, body.knownHead, ownHash);
    } catch (error) {
      return errorResponse(res, 400, error.message);
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/reply-target') {
    return errorResponse(res, 400, 'This endpoint was renamed: switch Add reply with POST /api/pin/reply {"active": true|false}.');
  }


  if (req.method === 'POST' && url.pathname === '/api/reset') {
    try {
      const body = await readJson(req);
      // Resetting is the user's decision, made with the button in the page's
      // settings on this computer, and never while an agent is answering.
      if (req.headers['x-ineedbetterui-ui'] !== '1' || !isLoopbackRequest(req)) {
        throw new Error('Only the user resets the conversation, with the Reset button in the page\'s settings on this computer. If the user asks you to reset, tell them where that button is.');
      }
      if (turnLocked()) throw statusError(409, 'A turn is in progress; reset after its final reply.');
      if (body.confirm !== true) throw new Error('Reset needs confirm:true.');
      const ownHash = appendEvent({ t: 'reset', time: nowIso() });
      return writeResponse(res, 200, { written: true }, body.knownHead, ownHash);
    } catch (error) {
      return errorResponse(res, error.status || 400, error.message);
    }
  }

  return errorResponse(res, 404, 'API route not found.');
}

// The page is assembled once from ui/: the shell with the stylesheet and the
// script inlined. It carries no transcript data; the script loads that from
// the API after the page is shown, so the page is the same small file however
// long the transcript grows.
const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const readUi = name => fs.readFileSync(path.join(uiDir, name), 'utf8');
const pageHtml = readUi('page.html')
  .replace('/*CSS*/', () => readUi('page.css'))
  .replace('/*JS*/', () => readUi('page.js'));

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const READ_METHODS = new Set(['GET', 'HEAD']);

// Guards a local server against other web pages: a Host check stops DNS
// rebinding, and requiring a JSON body plus a same-origin Origin stops
// cross-site form posts.
function requestRefusal(req, url) {
  const allowedHosts = new Set(LOCAL_HOSTNAMES);
  if (broadcastMode) allowedHosts.add(broadcastHostAddress());
  if (!allowedHosts.has(url.hostname)) return 'Host not allowed.';
  if (READ_METHODS.has(req.method)) return null;
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
      res.fromPage = req.headers['x-ineedbetterui-ui'] === '1';
      const refusal = requestRefusal(req, url);
      if (refusal) return errorResponse(res, 403, refusal);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method === 'GET' && url.pathname === '/') {
        return htmlResponse(res, pageHtml);
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
// The page to open in a browser; it redirects to the running server.
function openPagePath() {
  return path.join(sessionDir, 'open.html');
}

function openPageHtml(port) {
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

// Older versions named the running server in server-<port>.html. Their ports
// are still checked (such a server may be running) and the files removed.
const LEGACY_INFO_PATTERN = /^server-(\d+)\.html$/;

function legacyInfoFiles() {
  try {
    return fs.readdirSync(sessionDir).flatMap(name => {
      const match = LEGACY_INFO_PATTERN.exec(name);
      return match ? [{ file: path.join(sessionDir, name), port: Number(match[1]) }] : [];
    });
  } catch {
    return [];
  }
}

function removeFile(file) {
  try { fs.unlinkSync(file); } catch {}
}

function projectInfoPath() {
  return path.join(sessionDir, 'project.json');
}

function readProjectInfo() {
  try { return JSON.parse(fs.readFileSync(projectInfoPath(), 'utf8')); } catch { return null; }
}

// project.json is the one place that says where this project's server runs:
// `server` is {port, pid, startedAt} while it runs and absent otherwise. It is
// written whole to a temporary file and renamed over, so a reader never sees
// half of it.
function writeProjectInfo(server) {
  const previous = readProjectInfo();
  const info = {
    app: APP_NAME,
    sessionId,
    projectPath,
    createdAt: previous?.createdAt || nowIso(),
    lastStartedAt: server ? nowIso() : (previous?.lastStartedAt || nowIso())
  };
  if (server) info.server = server;
  const temp = `${projectInfoPath()}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, projectInfoPath());
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

// The project's own port, tried when nothing better is known: every start of
// the project tries the same number.
function projectPort() {
  return 40_000 + (Number.parseInt(sessionId.slice(0, 8), 16) % 20_000);
}

const START_LOCK_STALE_MS = 10_000;
const START_LOCK_WAIT_MS = 100;
const START_LOCK_TRIES = 150;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Starting is: check for a running server, bind a port, record it. start.lock,
// created only if absent (exclusive on every platform), lets one start at a
// time through all three, so each start sees what the one before recorded and
// a project ends with one server. A lock left by a start that died is ignored
// once it is older than START_LOCK_STALE_MS.
async function acquireStartLock() {
  const lock = path.join(sessionDir, 'start.lock');
  for (let attempt = 0; attempt < START_LOCK_TRIES; attempt += 1) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return () => removeFile(lock);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > START_LOCK_STALE_MS) removeFile(lock); } catch {}
      await sleep(START_LOCK_WAIT_MS);
    }
  }
  throw new Error('Another start of this project did not finish (start.lock). Run the command again.');
}

async function ourServerOn(port) {
  const health = await checkHealth(port);
  return health?.sessionId === sessionId ? health : null;
}

// Runs under the start lock. A server recorded in project.json (or in an older
// server-<port>.html) that answers as this project is reused. Otherwise this
// start binds the recorded port, the project port, then any free port; a port
// that turns out to be taken is asked once more whether it is this project's.
async function startServer() {
  const known = [readProjectInfo()?.server?.port, ...legacyInfoFiles().map(file => file.port)].filter(Number.isInteger);
  for (const port of new Set(known)) {
    const running = await ourServerOn(port);
    if (running) return { running };
  }
  for (const port of new Set([...known, projectPort()])) {
    const bound = await bindServer(port);
    if (!bound.error) return { server: bound.server };
    bound.server.close();
    if (bound.error.code === 'EADDRINUSE') {
      const running = await ourServerOn(port);
      if (running) return { running };
    }
  }
  const free = await bindServer(0);
  if (free.error) throw free.error;
  return { server: free.server };
}

// On a normal exit the server takes itself out of project.json and removes
// open.html, unless a newer server of the project has already replaced them.
function cleanUpOnExit() {
  process.on('exit', () => {
    try { if (readProjectInfo()?.server?.pid === process.pid) writeProjectInfo(null); } catch {}
    try { if (fs.readFileSync(openPagePath(), 'utf8').includes(`data-pid="${process.pid}"`)) removeFile(openPagePath()); } catch {}
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(signal, () => process.exit(0));
  }
}

async function main() {
  ensureSessionDir();
  const release = await acquireStartLock();
  let started;
  try {
    started = await startServer();
    if (!started.running) {
      httpServer = started.server;
      const address = httpServer.address();
      serverPort = address && typeof address === 'object' ? address.port : null;
      if (!serverPort) {
        httpServer.close();
        throw new Error('Could not read the server port.');
      }
      for (const file of legacyInfoFiles()) removeFile(file.file);
      writeProjectInfo({ port: serverPort, pid: process.pid, startedAt: nowIso() });
      fs.writeFileSync(openPagePath(), openPageHtml(serverPort), 'utf8');
      cleanUpOnExit();
    }
  } finally {
    release();
  }
  if (started.running) {
    // Broadcast is a switch on the running server, so a different mode is not a
    // reason to refuse.
    console.log(`${APP_NAME} already running on http://127.0.0.1:${started.running.port}/`);
    return;
  }
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
