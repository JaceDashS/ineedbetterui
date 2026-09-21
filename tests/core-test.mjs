import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApiClient } from './helpers/api-client.mjs';
import { createResults } from './helpers/results.mjs';
import { sleep, startServer, stopServer } from './helpers/server.mjs';
import { removeTemp } from './helpers/temp.mjs';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'inbu-core-')));
const dir = path.join(tmp, 'project');
fs.mkdirSync(dir);
const realDir = fs.realpathSync.native(dir);
const sessionId = createHash('sha256').update(process.platform === 'win32' ? realDir.toLowerCase() : realDir).digest('hex').slice(0, 12);
const dataFile = path.join(realDir, 'node_modules', '.ineedbetterui', 'transcript.jsonl');
const { check, finish } = createResults();

const runServer = () => startServer(dir);
let server = runServer();
await server.ready;
let base = server.url();
check('server starts', Boolean(base));
const apiClient = createApiClient();
const call = (method, route, body, headers) => apiClient.request(base, method, route, body, headers);
// Resetting is done by the user from the page, which says so on every write.
const asPage = { 'X-Ineedbetterui-Agent': 'user' };

try {
  const second = runServer();
  await second.ready;
  check('second start reuses running server', second.url() === base);
  await second.exited;

  const cleaned = await call('POST', '/api/entries', { kind: 'question', rawBody: 'raw text', cleanedBody: 'clean text', clientRef: 'q1' });
  check('question in cleaned mode uses cleanedBody', cleaned.status === 201 && cleaned.data.entry.body === 'clean text' && cleaned.data.entry.rawBody === 'raw text');
  const dup = await call('POST', '/api/entries', { kind: 'question', rawBody: 'raw text', cleanedBody: 'clean text', clientRef: 'q1' });
  check('same clientRef is deduplicated, even while the turn is open', dup.status === 200 && dup.data.deduplicated === true && dup.data.state.entryCount === 1);
  check('a question opens the turn', cleaned.data.state.turn.open === true, cleaned.data.state.turn);

  // The user may say several things before the agent answers: an answer it was
  // stopped from giving must not lock them out of their own transcript.
  const stacked = await call('POST', '/api/entries', { kind: 'question', rawBody: 'raw 2', cleanedBody: 'clean 2' });
  check('the same agent may record another message before it has answered', stacked.status === 201 && stacked.data.state.turn.open === true, stacked.data.state.turn);
  await sleep(5);
  const working = await call('POST', '/api/progress', { text: 'reading the outline code' });
  // The lock frees a turn nobody is working on, so saying what you are doing
  // starts its ten minutes again: work that takes longer keeps its turn.
  check('progress starts the turn clock again', Date.parse(working.data.state.turn.since) > Date.parse(stacked.data.entry.time), { since: working.data.state.turn.since, question: stacked.data.entry.time });
  check('progress is shown, not recorded, and keeps the turn open', working.status === 200 && working.data.written === false && working.data.state.turn.progress === 'reading the outline code' && working.data.state.entryCount === 2, working.data);
  check('progress must say something, and cannot be a reply in disguise', (await call('POST', '/api/progress', { text: '' })).status === 400 && (await call('POST', '/api/progress', { text: 'x'.repeat(201) })).status === 400);
  const closing = await call('POST', '/api/entries', { kind: 'report', body: 'done' });
  check('the reply closes the turn and clears the progress line', closing.data.state.turn.open === false && closing.data.state.turn.progress === null && closing.data.next.includes("Record the user's next message"), closing.data);
  check('a second reply in the same turn is refused', (await call('POST', '/api/entries', { kind: 'report', body: 'more' })).status === 409);
  check('progress without an open turn is refused', (await call('POST', '/api/progress', { text: 'still going' })).status === 409);
  check('final is refused and says why', (await call('POST', '/api/entries', { kind: 'question', rawBody: 'x', cleanedBody: 'x', final: true })).status === 400);
  await call('PATCH', '/api/settings', { questionMode: 'raw' });
  check('question in raw mode uses rawBody', (await call('POST', '/api/entries', { kind: 'question', rawBody: 'raw 2', cleanedBody: 'clean 2' })).data.entry.body === 'raw 2');
  await call('POST', '/api/entries', { kind: 'report', body: 'answered' });

  await call('PATCH', '/api/settings', { maxResponseChars: 10 });
  await call('POST', '/api/entries', { kind: 'question', rawBody: 'ten?', cleanedBody: 'ten?' });
  const ok10 = await call('POST', '/api/entries', { kind: 'report', body: '0123456789' });
  check('10-char response accepted', ok10.status === 201);
  await call('POST', '/api/entries', { kind: 'question', rawBody: 'eleven?', cleanedBody: 'eleven?' });
  const over = await call('POST', '/api/entries', { kind: 'report', body: '01234567890' });
  check('11-char response rejected with limit and length', over.status === 400 && over.data.maxResponseChars === 10 && over.data.length === 11);
  const revisionRefused = await call('POST', `/api/entries/${ok10.data.entry.id}/revisions`, { body: 'x' });
  check('recorded replies cannot be revised', revisionRefused.status === 400 && /cannot be edited/.test(revisionRefused.data.error), revisionRefused.data);
  check('notes cannot be added any more', (await call('POST', `/api/entries/${ok10.data.entry.id}/notes`, { text: 'x' })).status === 400);
  check('broadcast must be a boolean setting', (await call('PATCH', '/api/settings', { broadcast: 'yes' })).status === 400);
  const mixed = await call('PATCH', '/api/settings', { broadcast: true, maxResponseChars: -1 });
  check('a settings request with one bad field applies nothing, broadcast included', mixed.status === 400 && (await call('GET', '/api/state')).data.broadcast === null && (await call('GET', '/api/health')).data.broadcast === false, mixed.data);
  check('negative unseen cap rejected', (await call('PATCH', '/api/settings', { maxUnseenEvents: -1 })).status === 400);
  await call('PATCH', '/api/settings', { maxResponseChars: 0 });
  check('limit 0 is unlimited', (await call('POST', '/api/entries', { kind: 'report', body: 'x'.repeat(5000) })).status === 201);

  const reportId = ok10.data.entry.id;
  check('question cannot be pinned', (await call('POST', '/api/pin', { target: cleaned.data.entry.id })).status === 400);

  // Working on a pinned reply as a document.
  await call('PATCH', '/api/settings', { maxResponseChars: 1200 });
  await call('PATCH', '/api/outline', { items: [{ no: '1', title: 'Intro' }, { no: '2', title: 'Details' }] });
  await call('PATCH', '/api/outline/status', { items: [{ no: '1', status: 'active' }] });
  await call('PATCH', '/api/outline/status', { items: [{ no: '1', status: 'done' }, { no: '2', status: 'active' }] });
  await call('POST', '/api/entries', { kind: 'question', rawBody: 'the document?', cleanedBody: 'the document?' });
  const doc = await call('POST', '/api/entries', { kind: 'report', body: 'The estimate is 0.27.\nThe estimate is rounded.' });
  const docId = doc.data.entry.id;
  await call('POST', '/api/pin', { target: docId });
  check('a pin switch does not move the head', (await call('GET', '/api/state')).data.head === doc.data.sync.head);
  check('Add reply needs {active: true|false} and points agents to the pin edit', (await call('POST', '/api/pin/reply', { target: docId })).status === 400);
  check('the old reply-target endpoint explains the new name', /POST \/api\/pin\/reply/.test((await call('POST', '/api/reply-target', { target: docId })).data.error));
  const replyOn = await call('POST', '/api/pin/reply', { active: true });
  check('Add reply turns on for the pinned entry and shows in state.pin', replyOn.status === 200 && replyOn.data.state.pin.replyActive === true, replyOn.data.state.pin);
  const briefed = await call('POST', '/api/entries', { kind: 'question', rawBody: 'add that it is noisy', cleanedBody: 'Add that it is noisy.', knownHead: ok10.data.sync.head });
  const turn = briefed.data.turn || {};
  check('question response carries the turn brief', turn.replyLimit === 1200 && turn.replyTo === docId && turn.outline?.no === '2' && turn.outline?.title === 'Details' && turn.unseen?.count >= 2 && turn.unseen.kinds.entry >= 1 && turn.unseen.kinds.pin === undefined && turn.unseen.kinds.settings === undefined && turn.unseen.in === 'sync.unseen' && briefed.data.sync.unseen.length === turn.unseen.count, turn);
  check('the next hint sends the reply to the pin edit and names the limit', /Add reply is on/.test(briefed.data.next) && /POST \/api\/pin\/edit/.test(briefed.data.next) && /within 1200 characters/.test(briefed.data.next), briefed.data.next);
  const normal = await call('POST', '/api/entries', { kind: 'report', body: 'A normal reply.' });
  check('a normal reply while Add reply is on is refused and points to the pin edit', normal.status === 400 && /pin\/edit/.test(normal.data.error), normal.data);
  const edit = body => call('POST', '/api/pin/edit', body);
  check('a pin edit refuses a whole body', (await edit({ body: 'everything' })).status === 400);
  const ambiguous = await edit({ old: 'The estimate', new: 'X' });
  check('a pin edit refuses an old text that occurs twice', ambiguous.status === 400 && /occurs 2 times/.test(ambiguous.data.error), ambiguous.data);
  check('a pin edit refuses an old text that is not there', (await edit({ old: 'is 0.31', new: 'y' })).status === 400);
  const edited = await edit({ old: 'is 0.27.', new: 'is 0.27, and noisy.' });
  const editedId = edited.data.entry?.id;
  check('a pin edit records a new reply with the whole document and the change', edited.status === 201 && edited.data.entry.revises === docId && edited.data.entry.body === 'The estimate is 0.27, and noisy.\nThe estimate is rounded.' && edited.data.entry.patch.new === 'is 0.27, and noisy.', edited.data.entry);
  check('the pin moves to the new version and Add reply turns off', edited.data.state.pin?.target === editedId && edited.data.state.pin.replyActive === false, edited.data.state);
  check('a pin edit is the turn\'s reply, so it closes the turn', edited.data.state.turn.open === false);
  check('the earlier version is left as it was', (await call('GET', `/api/entries/${docId}`)).data.entry.body === 'The estimate is 0.27.\nThe estimate is rounded.');
  const shared = (await call('GET', `/api/sync?knownHead=${briefed.data.sync.head}`)).data.unseen.at(-1);
  check('other agents get the change, not the whole document', shared?.revises === docId && shared.new === 'is 0.27, and noisy.' && shared.body === undefined && shared.preview === undefined, shared);
  check('a pin edit without Add reply is refused', (await edit({ old: 'noisy', new: 'loud' })).status === 400);
  check('question without cleanedBody is refused', (await call('POST', '/api/entries', { kind: 'question', rawBody: 'only raw' })).status === 400);
  check('question with only body is refused', (await call('POST', '/api/entries', { kind: 'question', body: 'plain' })).status === 400);
  const ui = asPage;
  await call('DELETE', '/api/outline', undefined, ui);
  check('an item carrying a status is refused', (await call('PATCH', '/api/outline', { items: [{ no: '1', title: 'a', status: 'active' }] })).status === 400);
  check('an item without a title is refused', (await call('PATCH', '/api/outline', { items: [{ no: '1' }] })).status === 400);
  check('two items sharing a number are refused', (await call('PATCH', '/api/outline', { items: [{ no: '1', title: 'a' }, { no: '1', title: 'b' }] })).status === 400);
  check('an empty outline is refused, and without an outline there is no outlineVersion', (await call('PATCH', '/api/outline', { items: [] })).status === 400 && (await call('GET', '/api/state')).data.outlineVersion === undefined);

  const items = [{ no: '1', title: 'Basics', type: 'report' }, { no: '2', title: 'Training', type: 'report' }, { no: '2-1', title: 'Add noise', type: 'report' }, { no: '3', title: 'Sampling', type: 'report' }];
  const created = await call('PATCH', '/api/outline', { items });
  const read = (await call('GET', '/api/outline')).data;
  check('a new outline starts every item at pending, with the same version as the write', created.status === 200 && read.items.every(item => item.status === 'pending') && read.items.length === 4 && read.version === created.data.outlineVersion, read);
  check('an outline change is state: it does not move the head', created.data.sync.head === (await call('GET', '/api/sync')).data.head);
  check('write responses to agents leave the whole outline out', created.data.state.outline === undefined, created.data.state);
  check('an outline change is not an unseen event', (await call('GET', '/api/sync?knownHead=' + created.data.sync.head)).data.unseen.every(event => event.t !== 'outline'));

  check('a status may not jump from pending to done', (await call('PATCH', '/api/outline/status', { items: [{ no: '1', status: 'done' }] })).status === 400);
  check('a status on an unknown number is refused', (await call('PATCH', '/api/outline/status', { items: [{ no: '9', status: 'active' }] })).status === 400);
  check('a status on an item with sub-items is refused', (await call('PATCH', '/api/outline/status', { items: [{ no: '2', status: 'active' }] })).status === 400);
  const moved = await call('PATCH', '/api/outline/status', { items: [{ no: '1', status: 'active' }] });
  check('a status move bumps the version', moved.status === 200 && moved.data.outlineVersion > created.data.outlineVersion);
  const stepped = await call('PATCH', '/api/outline/status', { items: [{ no: '1', status: 'done' }, { no: '2-1', status: 'active' }] });
  const derived = (await call('GET', '/api/outline')).data.items;
  check('a parent is active because its sub-item is, and nothing stores current', stepped.status === 200 && derived[1].status === 'active' && derived[2].status === 'active' && derived.every(item => item.current === undefined), derived);
  await call('POST', '/api/entries', { kind: 'report', body: 'closing' });
  check('the turn brief names the deepest active item', (await call('POST', '/api/entries', { kind: 'question', rawBody: 'and then?', cleanedBody: 'And then?' })).data.turn?.outline?.no === '2-1');
  await call('POST', '/api/entries', { kind: 'report', body: 'ok' });
  check('a parent is done once every sub-item is', (await call('PATCH', '/api/outline/status', { items: [{ no: '2-1', status: 'done' }] })).status === 200 && (await call('GET', '/api/outline')).data.items[1].status === 'done');
  const half = await call('PATCH', '/api/outline/status', { items: [{ no: '3', status: 'active' }, { no: '1', status: 'pending' }] });
  check('one bad move in a request rolls the whole request back', half.status === 400 && (await call('GET', '/api/outline')).data.items[3].status === 'pending', half.data.error);

  const version = (await call('GET', '/api/outline')).data.version;
  check('an edit at the wrong version is refused', (await call('PATCH', '/api/outline', { version: version - 1, items })).status === 409);
  const renamed = await call('PATCH', '/api/outline', { version, items: [...items.slice(0, 2), { no: '2-1', title: 'Mix in noise', type: 'report' }, { no: '2-2', title: 'Predict noise', type: 'report' }, { no: '4', title: 'Sampling', type: 'report' }] });
  const editedItems = (await call('GET', '/api/outline')).data.items;
  check('an edit renames, adds and renumbers while keeping the statuses it had', renamed.status === 200 && editedItems.map(item => item.no).join() === '1,2,2-1,2-2,4' && editedItems[2].title === 'Mix in noise' && editedItems[2].status === 'done' && editedItems[4].status === 'pending', editedItems);
  check('an edit dropping an item is refused', (await call('PATCH', '/api/outline', { version: renamed.data.outlineVersion, items: items.slice(0, 2) })).status === 400);
  check('an edit renumbering an item that has started is refused', (await call('PATCH', '/api/outline', { version: renamed.data.outlineVersion, items: [{ no: '1', title: 'Basics' }, { no: '2', title: 'Training' }, { no: '2-9', title: 'Mix in noise' }, { no: '2-2', title: 'Predict noise' }, { no: '4', title: 'Sampling' }] })).status === 400);
  check('agents cannot clear the outline', (await call('PATCH', '/api/outline', { done: true })).status === 400 && (await call('DELETE', '/api/outline')).status === 403);
  check('the user clears it from the page, and then a new outline is allowed', (await call('DELETE', '/api/outline', undefined, ui)).status === 200 && (await call('GET', '/api/outline')).data.items.length === 0);
  const restarted = await call('PATCH', '/api/outline', { items: [{ no: '1', title: 'a', type: 'report' }] });
  check('a new outline gets a version never used before', restarted.data.outlineVersion > renamed.data.outlineVersion && (await call('GET', '/api/state')).data.outline.length === 1, restarted.data.outlineVersion);

  const countBeforeRestart = (await call('GET', '/api/state')).data.entryCount;
  await stopServer(server, 250);
  server = runServer();
  await server.ready;
  base = server.url();
  const afterRestart = (await call('GET', '/api/state')).data;
  check('state survives restart', afterRestart.entryCount === countBeforeRestart && afterRestart.questionMode === 'raw' && afterRestart.maxResponseChars === 1200 && afterRestart.pin?.target === editedId && afterRestart.outline.length === 1, JSON.stringify(afterRestart));

  const stream = await fetch(base + '/api/events');
  const reader = stream.body.getReader();
  const readMessage = async () => {
    let text = '';
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    return JSON.parse(/data: (.*)/.exec(text)[1]);
  };
  const opened = await readMessage();
  check('events stream starts with the current head', stream.headers.get('content-type').startsWith('text/event-stream') && typeof opened.head === 'string', opened);
  const pushed = readMessage();
  const written = await call('POST', '/api/entries', { kind: 'question', rawBody: 'pushed?', cleanedBody: 'pushed?' });
  check('a write pushes the new head to open streams', (await pushed).head === written.data.sync.head);
  await reader.cancel();
  await call('POST', '/api/entries', { kind: 'report', body: 'pushed' });
  const all = (await call('GET', '/api/entries?limit=1000')).data.entries;
  const lastTwo = await call('GET', '/api/entries?last=2');
  check('entries?last reports older entries with hasBefore', lastTwo.data.hasBefore === true && lastTwo.data.entries.at(-1).id === all.at(-1).id);
  const older = await call('GET', `/api/entries?before=${lastTwo.data.entries[0].id}&limit=2`);
  check('entries?before returns the entries right before the given one', older.data.entries.map(entry => entry.id).join() === all.slice(-4, -2).map(entry => entry.id).join(), older.data);
  const oldest = await call('GET', `/api/entries?before=${all[1].id}&limit=5`);
  check('entries?before at the start returns what exists and no hasBefore', oldest.data.entries.length === 1 && oldest.data.hasBefore === false, oldest.data);
  // replyTo threads come only from older records now; the filter still works.
  const threaded = await call('GET', `/api/entries?replyTo=${docId}&limit=1000`);
  check('entries?replyTo lists only replies to that entry', threaded.status === 200 && threaded.data.entries.every(entry => entry.replyTo === docId), threaded.data);
  const page = await (await fetch(base + '/')).text();
  check('the page carries no transcript data', !page.includes('initial-data') && !page.includes(all.at(-1).id + '"'));
  check('only / serves the page', (await fetch(base + '/anything.html')).status === 404);
  // Two agents share one thread: A answers 1 and 2, B joins with answer 3,
  // then A answers 4 and must learn about 3 only.
  const agentReset = await call('POST', '/api/reset', { confirm: true });
  check('an agent cannot reset; it is told the user has a button for it', agentReset.status === 400 && /Reset button/.test(agentReset.data.error), agentReset.data);
  await call('POST', '/api/reset', { confirm: true }, asPage);
  const ask = (text, knownHead) => call('POST', '/api/entries', { kind: 'question', rawBody: text, cleanedBody: text, knownHead });
  const reply = (text, knownHead) => call('POST', '/api/entries', { kind: 'report', body: text, knownHead });
  const a1q = await ask('A q1');
  check('multi-agent: the first agent on an empty thread sees nothing', a1q.data.sync.status === 'none' && a1q.data.sync.unseen.length === 0, a1q.data.sync);
  const a1 = await reply('A answer 1', a1q.data.sync.head);
  const a2q = await ask('A q2', a1.data.sync.head);
  const a2 = await reply('A answer 2', a2q.data.sync.head);
  check('multi-agent: A does not get its own answer back', a2.data.sync.status === 'current' && a2.data.sync.unseen.length === 0, a2.data.sync);
  const b3q = await ask('B q3');
  const b3Bodies = b3q.data.sync.unseen.map(event => event.body);
  check('multi-agent: B joining without a head sees the thread so far but not the reset or its own', b3q.data.sync.status === 'none' && b3Bodies.join('|') === 'A q1|A answer 1|A q2|A answer 2' && b3q.data.next.includes('conversation so far'), b3q.data.sync);
  const b3 = await reply('B answer 3', b3q.data.sync.head);
  const a4q = await ask('A q4', a2.data.sync.head);
  check('multi-agent: A learns only what B added', a4q.data.sync.status === 'behind' && a4q.data.sync.unseen.map(event => event.body).join('|') === 'B q3|B answer 3', a4q.data.sync);
  const a4 = await reply('A answer 4', a4q.data.sync.head);
  const b5q = await ask('B q5', b3.data.sync.head);
  check('multi-agent: B learns only what A added', b5q.data.sync.unseen.map(event => event.body).join('|') === 'A q4|A answer 4', b5q.data.sync);
  await reply('B answer 5', b5q.data.sync.head);
  // ---------- who wrote it ----------
  const register = model => call('POST', '/api/agents', { model });
  const asAgent = async (token, method, url, body) => call(method, url, body, { 'X-Ineedbetterui-Agent': token });
  const one = (await register('claude-opus-5')).data;
  const two = (await register('claude-opus-5')).data;
  check('registering gives a name from the model and an animal', /^claude-[a-z]+$/.test(one.agent), one);
  check('a second agent of the same model gets a different name and token', two.agent !== one.agent && two.token !== one.token, two);
  check('a write with no identity is refused with 401', (await fetch(base + '/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'question', rawBody: 'x', cleanedBody: 'x' }) })).status === 401);
  check('an unknown token is refused', (await asAgent('nope', 'POST', '/api/entries', { kind: 'question', rawBody: 'x', cleanedBody: 'x' })).status === 401);
  check('reading needs no identity', (await fetch(base + '/api/state')).status === 200);

  const mine = await asAgent(one.token, 'POST', '/api/entries', { kind: 'question', rawBody: 'who?', cleanedBody: 'Who is there?' });
  check('an entry records the name of whoever wrote it', mine.data.entry.agent === one.agent, mine.data.entry);
  check('an entry carries the turn it belongs to', mine.data.entry.turn === 1, mine.data.entry);
  check('the open turn belongs to that agent', mine.data.state.turn.agent === one.agent, mine.data.state.turn);
  const intruder = await asAgent(two.token, 'POST', '/api/entries', { kind: 'report', body: 'not mine' });
  check("another agent cannot answer someone else's turn, and is told who is", intruder.status === 409 && intruder.data.error.includes(one.agent), intruder.data.error);
  check("another agent cannot report progress on it either", (await asAgent(two.token, 'POST', '/api/progress', { text: 'meddling' })).status === 409);
  const cutIn = await asAgent(two.token, 'POST', '/api/entries', { kind: 'question', rawBody: 'mine now', cleanedBody: 'Mine now.' });
  check('another agent cannot start a turn over this one, and is told who holds it', cutIn.status === 409 && cutIn.data.error.includes(one.agent) && /only when the user asks/.test(cutIn.data.error), cutIn.data.error);
  const again = await asAgent(one.token, 'POST', '/api/entries', { kind: 'question', rawBody: 'actually', cleanedBody: 'Actually, never mind that.' });
  check('the agent that holds the turn may add to it, which is what an interrupted answer looks like', again.status === 201 && again.data.state.turn.agent === one.agent, again.data.state.turn);
  await asAgent(one.token, 'POST', '/api/progress', { text: 'still here' });
  check('a new message clears what the agent last said it was doing', (await asAgent(one.token, 'POST', '/api/entries', { kind: 'question', rawBody: 'and', cleanedBody: 'And one more.' })).data.state.turn.progress === null);
  const ours = await asAgent(one.token, 'POST', '/api/entries', { kind: 'report', body: 'mine' });
  check('the turn owner answers it and the turn is free again', ours.status === 201 && ours.data.entry.agent === one.agent && ours.data.state.turn.open === false, ours.data.state.turn);
  // An agent that lost its context asks who is registered and how far each got.
  const connected = (await call('GET', '/api/agents')).data;
  const listed = connected.agents.find(agent => agent.name === one.agent);
  check('the registry says who is registered and how far each one got', listed?.lastTurn === 3 && listed.holdsTurn === false && listed.model === 'claude-opus-5', connected);
  check('the registry hands out no tokens', !JSON.stringify(connected).includes(one.token), connected);

  // ---------- the agent counts the user's messages ----------
  const three = (await register('gpt-5-codex')).data;
  const counted = (body, token = three.token) => asAgent(token, 'POST', '/api/entries', body);
  const first = await counted({ kind: 'question', rawBody: 'one', cleanedBody: 'One.', turn: 7 });
  check('an agent joining mid-conversation sets its own baseline', first.status === 201 && first.data.state.turn.no === 7, first.data.state.turn);
  check('a reply belongs to the turn it answers', (await counted({ kind: 'report', body: 'answer', turn: 7 })).status === 201);
  const skipped = await counted({ kind: 'question', rawBody: 'three', cleanedBody: 'Three.', turn: 9 });
  check('a turn that was never recorded is refused as a gap, by number', skipped.status === 409 && /Turn 8 .* never recorded/.test(skipped.data.error) && skipped.data.error.includes('record turn 8 now'), skipped.data.error);
  const wideGap = await counted({ kind: 'question', rawBody: 'later', cleanedBody: 'Later.', turn: 11 });
  check('several missing turns are named as a list', wideGap.status === 409 && /Turns 8, 9 and 10 of this conversation were never recorded/.test(wideGap.data.error), wideGap.data.error);
  const back = await counted({ kind: 'question', rawBody: 'again', cleanedBody: 'Again.', turn: 7, clientRef: 'other' });
  check('a turn number already recorded is refused, and says which one is next', back.status === 409 && /you are at turn 7/.test(back.data.error), back.data.error);
  check('a gap says how to record it when the messages are gone', /recovered/.test(skipped.data.error), skipped.data.error);
  check('recovered is refused where there is no gap', (await counted({ kind: 'question', rawBody: 'no gap', cleanedBody: 'No gap.', turn: 8, recovered: true, clientRef: 'nogap' })).status === 400);
  const recovered = await counted({ kind: 'question', rawBody: 'two', cleanedBody: 'Two.', turn: 8 });
  check('the skipped turn can still be recorded, because the agent still has it', recovered.status === 201 && recovered.data.state.turn.no === 8, recovered.data.state.turn);
  const wrongReply = await counted({ kind: 'report', body: 'answer', turn: 9 });
  check("a reply numbered past the open turn says the user's message is missing", wrongReply.status === 409 && /This is turn 8, not turn 9/.test(wrongReply.data.error), wrongReply.data.error);
  check('progress belongs to the open turn too', (await asAgent(three.token, 'POST', '/api/progress', { text: 'thinking', turn: 9 })).status === 409);
  check('a write with no turn number is refused', (await counted({ kind: 'report', body: 'answer', turn: null })).status === 400);
  check('turn must be a whole number from 1', (await counted({ kind: 'report', body: 'answer', turn: 0 })).status === 400 && (await counted({ kind: 'report', body: 'answer', turn: 1.5 })).status === 400);
  const retry = { kind: 'question', rawBody: 'four', cleanedBody: 'Four.', turn: 9 };
  await counted({ kind: 'report', body: 'answer', turn: 8 });
  const once = await counted(retry);
  const twice = await counted(retry);
  check('a question carries its own retry key, so recording a turn twice is one entry', once.status === 201 && twice.data.deduplicated === true, twice.data);
  await counted({ kind: 'report', body: 'answer', turn: 9 });

  // A compacted context cannot produce the missing messages, so the gap is
  // recorded as a gap and the turn numbers stay true to the conversation.
  const four = (await register('claude-opus-5')).data;
  await asAgent(four.token, 'POST', '/api/entries', { kind: 'question', rawBody: 'first', cleanedBody: 'First.', turn: 1 });
  await asAgent(four.token, 'POST', '/api/entries', { kind: 'report', body: 'answer', turn: 1 });
  const lost = await asAgent(four.token, 'POST', '/api/entries', { kind: 'question', rawBody: 'after the gap', cleanedBody: 'After the gap.', turn: 5, recovered: true });
  check('a recovered question records the gap it jumps over', lost.status === 201 && JSON.stringify(lost.data.entry.missedTurns) === '[2,3,4]' && lost.data.state.turn.no === 5, lost.data.entry);
  check('the gap is on the line in the transcript, not only in the response', fs.readFileSync(dataFile, 'utf8').includes('"missedTurns":[2,3,4]'));
  check('recovered belongs to a question, not a reply', (await asAgent(four.token, 'POST', '/api/entries', { kind: 'report', body: 'x', turn: 5, recovered: true })).status === 400);
  await asAgent(four.token, 'POST', '/api/entries', { kind: 'report', body: 'answer after the gap', turn: 5 });


  const registry = JSON.parse(fs.readFileSync(path.join(path.dirname(dataFile), 'project.json'), 'utf8'));
  check('registrations are kept in project.json, not the transcript', Object.values(registry.agents).some(agent => agent.name === one.agent && agent.lastSeenAt) && !fs.readFileSync(dataFile, 'utf8').includes('"t":"agent"'), Object.keys(registry.agents).length);
  check('the page is the user, and says so with the same header', (await call('POST', '/api/pin', { target: ours.data.entry.id }, asPage)).data.state.pin.source === 'user');
  await call('POST', '/api/pin', { target: null }, asPage);

  // An agent that knows nothing yet, and one every tenth turn, is told again
  // what recording is: a long conversation loses the instructions it read once.
  const fresh = (await register('gpt-5-codex')).data;
  const firstWrite = await asAgent(fresh.token, 'POST', '/api/entries', { kind: 'question', rawBody: 'hello', cleanedBody: 'Hello.', turn: 1 });
  check('a first write reminds the agent what recording is', firstWrite.data.next.includes('Reminder: record every user message'), firstWrite.data.next);
  await asAgent(fresh.token, 'POST', '/api/entries', { kind: 'report', body: 'answer', turn: 1, knownHead: firstWrite.data.sync.head });
  let head = null;
  for (let turn = 2; turn <= 10; turn += 1) {
    const question = await asAgent(fresh.token, 'POST', '/api/entries', { kind: 'question', rawBody: 'q' + turn, cleanedBody: 'Q' + turn, turn, knownHead: head });
    head = question.data.sync.head;
    const reply = await asAgent(fresh.token, 'POST', '/api/entries', { kind: 'report', body: 'a' + turn, turn, knownHead: head });
    head = reply.data.sync.head;
    if (turn === 9) check('an agent in step is not reminded on every turn', !reply.data.next.includes('Reminder:'), reply.data.next);
    if (turn === 10) check('every tenth turn says the rule again', reply.data.next.includes('Reminder: record every user message'), reply.data.next);
  }

  const asked = await call('POST', '/api/entries', { kind: 'question', rawBody: 'hint q', cleanedBody: 'hint q' });
  check('write response reminds to send knownHead', asked.data.next.includes('knownHead'), asked.data.next);
  check('after a question the hint asks for the reply', asked.data.next.includes('Record your reply'), asked.data.next);
  const answered = await call('POST', '/api/entries', { kind: 'report', body: 'answer', knownHead: asked.data.sync.head });
  check('after the reply the hint asks for the next question, without the knownHead reminder', answered.data.next.startsWith("Record the user's next message") && !answered.data.next.includes('knownHead'), answered.data.next);
  const linesBefore = fs.readFileSync(dataFile, 'utf8').trim().split('\n').length;
  // A turn the agent stops answering: the user ends it from the page, and the
  // question keeps the mark so the conversation does not read as finished.
  const abandoned = await call('POST', '/api/entries', { kind: 'question', rawBody: 'are you there?', cleanedBody: 'Are you there?' });
  check('an agent cannot cancel a turn itself', (await call('POST', '/api/turn/cancel', {})).status === 400);
  const cancelled = await call('POST', '/api/turn/cancel', {}, asPage);
  check('the user cancels the open turn from the page', cancelled.status === 200 && cancelled.data.state.turn.open === false && cancelled.data.state.turn.cancelled !== null, cancelled.data.state.turn);
  check('the cancel response says the turn takes no reply', /takes no reply/.test(cancelled.data.next), cancelled.data.next);
  check('cancelling with no open turn is refused', (await call('POST', '/api/turn/cancel', {}, asPage)).status === 409);
  const late = await call('POST', '/api/entries', { kind: 'report', body: 'sorry, here it is' });
  check('a reply to a cancelled turn is refused and told why', late.status === 409 && /cancelled turn/.test(late.data.error), late.data.error);
  check('progress on a cancelled turn is refused too', (await call('POST', '/api/progress', { text: 'still going' })).status === 409);
  const marked = (await call('GET', '/api/entries/' + abandoned.data.entry.id)).data;
  check('the cancelled question carries the mark', (marked.entry || marked).cancelled === true, marked);
  check('the cancellation is on the chain, so agents see it in sync', fs.readFileSync(dataFile, 'utf8').includes('"t":"turn"'));
  const afterCancel = await call('POST', '/api/entries', { kind: 'question', rawBody: 'next one', cleanedBody: 'Next one.' });
  check('the next question is accepted after a cancelled turn', afterCancel.status === 201);
  await call('POST', '/api/entries', { kind: 'report', body: 'answer' });

  check('reset without confirm rejected', (await call('POST', '/api/reset', {}, asPage)).status === 400);
  await call('POST', '/api/entries', { kind: 'question', rawBody: 'wait', cleanedBody: 'wait' });
  check('reset is refused while a turn is open', (await call('POST', '/api/reset', { confirm: true }, asPage)).status === 409);
  await call('POST', '/api/entries', { kind: 'report', body: 'ok' });
  const linesBeforeReset = fs.readFileSync(dataFile, 'utf8').trim().split('\n').length;
  const reset = await call('POST', '/api/reset', { confirm: true }, asPage);
  const linesAfter = fs.readFileSync(dataFile, 'utf8').trim().split('\n');
  check('reset clears current state', reset.data.state.entryCount === 0 && reset.data.state.pin === null);
  check('reset appends one line', linesAfter.length === linesBeforeReset + 1 && JSON.parse(linesAfter.at(-1)).t === 'reset');
  const raw = (method, route, headers, body) => new Promise((resolve, reject) => {
    const target = new URL(base + route);
    const request = http.request({ hostname: '127.0.0.1', port: target.port, path: route, method, headers }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.end(body);
  });
  const host = new URL(base).host;
  check('foreign Host is refused (DNS rebinding)', await raw('GET', '/api/sync', { host: 'evil.example:' + new URL(base).port }) === 403);
  check('text/plain POST is refused (cross-site form)', await raw('POST', '/api/reset', { host, 'content-type': 'text/plain' }, '{"confirm":true}') === 403);
  check('cross-origin JSON POST is refused', await raw('POST', '/api/reset', { host, 'content-type': 'application/json', origin: 'http://evil.example' }, '{"confirm":true}') === 403);
  check('localhost Host is allowed', await raw('GET', '/api/state', { host: 'localhost:' + new URL(base).port }) === 200);
  check('GET / serves the page', (await (await fetch(base + '/')).text()).includes('<title>I Need Better UI</title>'));
} finally {
  await stopServer(server, 400);
}
await removeTemp(tmp);

finish();
