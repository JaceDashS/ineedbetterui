const PREVIEW_CHARS = 200;
// What an agent must keep doing for the whole conversation, said again now and
// then. Instructions read once are the first thing a long conversation loses,
// and the server has no other way to reach an agent that has forgotten them.
const REMINDER = 'Reminder: record every user message as a question before you answer it, and every reply you give, nothing else. If you have lost your place, run "ineedbetterui status".';
const REMINDER_EVERY = 10;

function textPreview(text) {
  const chars = Array.from(text || '');
  if (chars.length <= PREVIEW_CHARS) return { body: text || '' };
  return { preview: chars.slice(0, PREVIEW_CHARS).join(''), length: chars.length, truncated: true };
}

function eventSummary(runtime, { hash, event }) {
  if (!event) return { hash, t: 'invalid' };
  const item = { hash, t: event.t, time: event.time };
  if (event.t === 'entry') {
    Object.assign(item, { id: event.id, kind: event.kind, heading: event.heading || '' });
    if (event.replyTo) item.replyTo = event.replyTo;
    if (event.broadcastUrl) item.broadcastUrl = event.broadcastUrl;
    if (event.outlineNo) item.outlineNo = event.outlineNo;
    if (Array.isArray(event.missedTurns) && event.missedTurns.length) item.missedTurns = [...event.missedTurns];
    if (event.agent) item.agent = event.agent;
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

export function syncResult(runtime, knownHead, { ownHash = null, limit } = {}) {
  const result = { head: runtime.head, eventCount: runtime.events.length };
  const known = typeof knownHead === 'string' ? runtime.hashIndex.get(knownHead) : undefined;
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
    unseen: shown.map(item => eventSummary(runtime, item))
  };
}

export function nextHint(runtime, writer, sync, replyTarget = null) {
  const hints = [];
  if (sync.status === 'none' || sync.status === 'unknown') {
    if (sync.unseenCount) hints.push('sync.unseen holds the conversation so far (possibly with other agents); read it and continue from it.');
    hints.push('Send the returned sync.head as knownHead on every write.');
  } else if (sync.status === 'behind') {
    hints.push('sync.unseen holds events you have not seen (other agents or the user); take them into account.');
  }
  if (sync.truncated) hints.push('Only the latest events were sent; fetch more with GET /api/entries?last=N&full=1 if you need them.');
  const last = runtime.current.entries.at(-1);
  if (last?.kind === 'question') {
    if (replyTarget) hints.push(`Add reply is on: this turn's reply edits pinned entry ${replyTarget.id}. Read it with GET /api/entries/${replyTarget.id} and send the change to POST /api/pin/edit as old and new.`);
    else hints.push(`Record your reply to the user when you give it, with turn ${runtime.current.turn.no}.`);
    const limit = runtime.current.maxResponseChars;
    if (limit > 0) hints.push(`Keep what you write within ${limit} characters; if it does not fit, write it shorter rather than splitting it in two.`);
    hints.push('Recording that reply closes the turn. While you work, say what you are doing with POST /api/progress {"text": "..."}; it is shown to the user and not recorded.');
  } else if (runtime.current.turn.open) {
    hints.push(`Record your reply to the user when you give it, with turn ${runtime.current.turn.no}; it closes the turn.`);
  } else {
    hints.push(`Record the user's next message as a question (rawBody + cleanedBody), turn ${(runtime.turnNo.get(writer) || 0) + 1}, before replying.`);
  }
  // On the first write of an agent that knows nothing, and every tenth turn
  // after that: often enough to outlast a compaction, rare enough to ignore.
  const counted = runtime.turnNo.get(writer) || 0;
  const lost = sync.status === 'none' || sync.status === 'unknown';
  if (writer && writer !== 'user' && (lost || (counted > 0 && counted % REMINDER_EVERY === 0))) hints.push(REMINDER);
  return hints.join(' ');
}

export function turnBrief(runtime, sync, replyTarget = null, outlineItem = null) {
  const turn = {};
  const limit = runtime.current.maxResponseChars;
  if (limit > 0) turn.replyLimit = limit;
  if (replyTarget) turn.replyTo = replyTarget.id;
  if (outlineItem) turn.outline = { no: outlineItem.no, title: outlineItem.title };
  if (sync.unseen.length) {
    const kinds = {};
    for (const event of sync.unseen) kinds[event.t] = (kinds[event.t] || 0) + 1;
    turn.unseen = { count: sync.unseenCount ?? sync.unseen.length, kinds, in: 'sync.unseen' };
  }
  return turn;
}

export function publicEntry(entry, full = false) {
  const result = { id: entry.id, kind: entry.kind, time: entry.time, heading: entry.heading };
  if (entry.replyTo) result.replyTo = entry.replyTo;
  if (entry.revises) result.revises = entry.revises;
  if (entry.outlineNo) result.outlineNo = entry.outlineNo;
  if (entry.agent) result.agent = entry.agent;
  if (entry.turn) result.turn = entry.turn;
  if (entry.missedTurns) result.missedTurns = [...entry.missedTurns];
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
  if (entry.broadcastUrl && entry.qr) {
    result.broadcastId = entry.broadcastId || entry.id;
    result.broadcastUrl = entry.broadcastUrl;
    result.broadcastPort = entry.broadcastPort;
    result.qr = { ...entry.qr };
  }
  return result;
}
