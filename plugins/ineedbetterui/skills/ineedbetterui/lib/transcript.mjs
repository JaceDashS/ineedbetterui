import { createHash } from 'node:crypto';

const DEFAULT_MAX_RESPONSE_CHARS = 3_000;
const DEFAULT_MAX_UNSEEN_EVENTS = 20;
const GENESIS_HASH = '0'.repeat(16);
export const QUESTION_MODES = new Set(['cleaned', 'raw']);

// Events that only switch a current value; kept out of the hash chain.
// reply-target is the older name of pin-reply and is still read.
const STATE_EVENTS = new Set(['pin', 'pin-reply', 'reply-target', 'settings', 'broadcast', 'outline']);

function normalizeQr(value) {
  if (!value || !Number.isInteger(value.size) || value.size < 21 || value.size > 177 || typeof value.modules !== 'string') return null;
  if (value.modules.length !== value.size * value.size || /[^01]/.test(value.modules)) return null;
  return { size: value.size, modules: value.modules };
}

function emptyCurrentState() {
  return {
    entries: [],
    byId: new Map(),
    outline: { items: [] },
    pin: null,
    pinReply: null,
    questionMode: 'cleaned',
    maxResponseChars: DEFAULT_MAX_RESPONSE_CHARS,
    maxUnseenEvents: DEFAULT_MAX_UNSEEN_EVENTS,
    broadcast: null,
    turn: { open: false, since: null, agent: null, no: null }
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
    outlineNo: typeof event.outlineNo === 'string' && event.outlineNo ? event.outlineNo : undefined,
    agent: typeof event.agent === 'string' && event.agent ? event.agent : undefined,
    turn: Number.isInteger(event.turn) && event.turn > 0 ? event.turn : undefined,
    missedTurns: Array.isArray(event.missedTurns) && event.missedTurns.every(Number.isInteger) && event.missedTurns.length ? [...event.missedTurns] : undefined,
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
    if (event.kind === 'question') current.turn = { open: true, since: event.time, agent: event.agent || null, no: event.turn || null };
    else current.turn = { open: false, since: null, agent: null, no: null };
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
    current.pin = { target, source: event.source === 'user' ? 'user' : 'agent' };
    if (current.pinReply && current.pinReply !== target) current.pinReply = null;
    return;
  }
  if (event.t === 'outline') {
    current.outline = { items: Array.isArray(event.items) ? event.items : [] };
    return;
  }
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
    lastResetIndex: -1,
    outlineVersion: 0,
    stateVersion: 0,
    progress: null,
    turnNo: new Map()
  };
}

export function ingestLine(rt, line) {
  if (!line.trim()) return;
  let event = null;
  try {
    event = JSON.parse(line);
  } catch {}
  if (event && typeof event === 'object' && STATE_EVENTS.has(event.t)) {
    rt.stateVersion += 1;
    if (event.t === 'outline') rt.outlineVersion += 1;
    applyEvent(rt.current, event);
    return;
  }
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
    if (event.kind === 'question' && Number.isInteger(event.turn) && event.agent) {
      rt.turnNo.set(event.agent, Math.max(rt.turnNo.get(event.agent) || 0, event.turn));
    }
  }
  if (event.t === 'reset') rt.outlineVersion += 1;
  if (event.t === 'reset') {
    rt.lastResetIndex = rt.events.length - 1;
    const { current } = rt;
    current.entries = [];
    current.byId = new Map();
    current.outline = { items: [] };
    current.pin = null;
    current.pinReply = null;
    current.questionMode = 'cleaned';
    current.maxResponseChars = DEFAULT_MAX_RESPONSE_CHARS;
    current.maxUnseenEvents = DEFAULT_MAX_UNSEEN_EVENTS;
    current.broadcast = null;
    current.turn = { open: false, since: null, agent: null, no: null };
    rt.turnNo = new Map();
    rt.clientRefs = new Map();
    return;
  }
  applyEvent(rt.current, event);
}

export function loadRuntime(bytes = Buffer.alloc(0)) {
  const rt = emptyRuntime();
  for (const line of bytes.toString('utf8').split(/\r?\n/)) ingestLine(rt, line);
  rt.fileBytes = bytes;
  return rt;
}
