import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'ineedbetterui', 'skills', 'ineedbetterui', 'ineedbetterui.mjs');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'inbu-core-')));
const dir = path.join(tmp, 'project');
fs.mkdirSync(dir);
const realDir = fs.realpathSync.native(dir);
const sessionId = createHash('sha256').update(process.platform === 'win32' ? realDir.toLowerCase() : realDir).digest('hex').slice(0, 12);
const dataFile = path.join(realDir, 'node_modules', '.ineedbetterui', 'transcript.jsonl');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });

function startServer() {
  const child = spawn(process.execPath, [script, '--no-broadcast'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('timeout: ' + text)), 10000);
    const onData = chunk => {
      text += chunk;
      if (/listening on|already running/.test(text)) { clearTimeout(timer); resolve(text); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
  return { child, output };
}
const urlOf = text => /(?:listening on|already running on) (http:\/\/127\.0\.0\.1:\d+)/.exec(text)?.[1];

let server = startServer();
let base = urlOf(await server.output);
check('server starts', Boolean(base));
const call = async (method, url, body) => {
  const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};

try {
  const second = startServer();
  check('second start reuses running server', urlOf(await second.output) === base);
  await new Promise(resolve => second.child.on('exit', resolve));

  const cleaned = await call('POST', '/api/entries', { kind: 'question', rawBody: 'raw text', cleanedBody: 'clean text', clientRef: 'q1' });
  check('question in cleaned mode uses cleanedBody', cleaned.status === 201 && cleaned.data.entry.body === 'clean text' && cleaned.data.entry.rawBody === 'raw text');
  const dup = await call('POST', '/api/entries', { kind: 'question', rawBody: 'raw text', cleanedBody: 'clean text', clientRef: 'q1' });
  check('same clientRef is deduplicated, even while the turn is open', dup.status === 200 && dup.data.deduplicated === true && dup.data.state.entryCount === 1);
  check('a question opens the turn', cleaned.data.state.turn.open === true, cleaned.data.state.turn);

  // One turn at a time: a question is refused until the turn's final reply.
  const blocked = await call('POST', '/api/entries', { kind: 'question', rawBody: 'raw 2', cleanedBody: 'clean 2' });
  check('a question while a turn is open is refused with 409 and no retry until the user asks', blocked.status === 409 && /Another turn is in progress/.test(blocked.data.error) && /only when the user asks/.test(blocked.data.error), blocked.data);
  const step = await call('POST', '/api/entries', { kind: 'report', body: 'working on it' });
  check('a reply without final keeps the turn open and says so', step.status === 201 && step.data.state.turn.open === true && /final:true/.test(step.data.next), step.data.next);
  const closing = await call('POST', '/api/entries', { kind: 'report', body: 'done', final: true });
  check('a final reply closes the turn', closing.data.entry.final === true && closing.data.state.turn.open === false && closing.data.next.includes("Record the user's next message"), closing.data);
  check('a question cannot be final', (await call('POST', '/api/entries', { kind: 'question', rawBody: 'x', cleanedBody: 'x', final: true })).status === 400);
  await call('PATCH', '/api/settings', { questionMode: 'raw' });
  check('question in raw mode uses rawBody', (await call('POST', '/api/entries', { kind: 'question', rawBody: 'raw 2', cleanedBody: 'clean 2' })).data.entry.body === 'raw 2');

  await call('PATCH', '/api/settings', { maxResponseChars: 10 });
  const ok10 = await call('POST', '/api/entries', { kind: 'report', body: '0123456789' });
  check('10-char response accepted', ok10.status === 201);
  const over = await call('POST', '/api/entries', { kind: 'report', body: '01234567890' });
  check('11-char response rejected with limit and length', over.status === 400 && over.data.maxResponseChars === 10 && over.data.length === 11);
  const revisionRefused = await call('POST', `/api/entries/${ok10.data.entry.id}/revisions`, { body: 'x' });
  check('recorded replies cannot be revised', revisionRefused.status === 400 && /cannot be edited/.test(revisionRefused.data.error), revisionRefused.data);
  check('notes cannot be added any more', (await call('POST', `/api/entries/${ok10.data.entry.id}/notes`, { text: 'x' })).status === 400);
  check('negative unseen cap rejected', (await call('PATCH', '/api/settings', { maxUnseenEvents: -1 })).status === 400);
  await call('PATCH', '/api/settings', { maxResponseChars: 0 });
  check('limit 0 is unlimited', (await call('POST', '/api/entries', { kind: 'report', body: 'x'.repeat(5000), final: true })).status === 201);

  const reportId = ok10.data.entry.id;
  check('question cannot be pinned', (await call('POST', '/api/pin', { target: cleaned.data.entry.id })).status === 400);

  // Working on a pinned reply as a document.
  await call('PATCH', '/api/settings', { maxResponseChars: 1200 });
  await call('PATCH', '/api/outline', { done: false, items: [{ no: '1', title: 'Intro', status: 'done' }, { no: '2', title: 'Details', status: 'active', current: true }] });
  const doc = await call('POST', '/api/entries', { kind: 'report', body: 'The estimate is 0.27.\nThe estimate is rounded.' });
  const docId = doc.data.entry.id;
  await call('POST', '/api/pin', { target: docId });
  check('a pin switch does not move the head', (await call('GET', '/api/state')).data.head === doc.data.sync.head);
  await call('POST', '/api/reply-target', { target: docId });
  const briefed = await call('POST', '/api/entries', { kind: 'question', rawBody: 'add that it is noisy', cleanedBody: 'Add that it is noisy.', knownHead: ok10.data.sync.head });
  const turn = briefed.data.turn || {};
  check('question response carries the turn brief', turn.replyLimit === 1200 && turn.replyTo === docId && turn.outline?.no === '2' && turn.outline?.status === 'active' && turn.unseen?.count >= 2 && turn.unseen.kinds.entry >= 1 && turn.unseen.kinds.pin === undefined && turn.unseen.kinds.settings === undefined && turn.unseen.in === 'sync.unseen' && briefed.data.sync.unseen.length === turn.unseen.count, turn);
  check('the next hint sends the reply to the pin edit and names the limit', /Add reply is on/.test(briefed.data.next) && /POST \/api\/pin\/edit/.test(briefed.data.next) && /within 1200 characters/.test(briefed.data.next), briefed.data.next);
  const normal = await call('POST', '/api/entries', { kind: 'report', body: 'A normal reply.' });
  check('a normal reply while Add reply is on is refused and points to the pin edit', normal.status === 400 && /pin\/edit/.test(normal.data.error), normal.data);
  const edit = body => call('POST', '/api/pin/edit', body);
  check('a pin edit refuses a whole body', (await edit({ body: 'everything' })).status === 400);
  const ambiguous = await edit({ old: 'The estimate', new: 'X' });
  check('a pin edit refuses an old text that occurs twice', ambiguous.status === 400 && /occurs 2 times/.test(ambiguous.data.error), ambiguous.data);
  check('a pin edit refuses an old text that is not there', (await edit({ old: 'is 0.31', new: 'y' })).status === 400);
  const edited = await edit({ old: 'is 0.27.', new: 'is 0.27, and noisy.', final: true });
  const editedId = edited.data.entry?.id;
  check('a pin edit records a new reply with the whole document and the change', edited.status === 201 && edited.data.entry.revises === docId && edited.data.entry.body === 'The estimate is 0.27, and noisy.\nThe estimate is rounded.' && edited.data.entry.patch.new === 'is 0.27, and noisy.', edited.data.entry);
  check('the pin moves to the new version and Add reply turns off', edited.data.state.pin?.target === editedId && edited.data.state.replyTarget === null, edited.data.state);
  check('a final pin edit closes the turn', edited.data.state.turn.open === false);
  check('the earlier version is left as it was', (await call('GET', `/api/entries/${docId}`)).data.entry.body === 'The estimate is 0.27.\nThe estimate is rounded.');
  const shared = (await call('GET', `/api/sync?knownHead=${briefed.data.sync.head}`)).data.unseen.at(-1);
  check('other agents get the change, not the whole document', shared?.revises === docId && shared.new === 'is 0.27, and noisy.' && shared.body === undefined && shared.preview === undefined, shared);
  check('a pin edit without Add reply is refused', (await edit({ old: 'noisy', new: 'loud' })).status === 400);
  check('question without cleanedBody is refused', (await call('POST', '/api/entries', { kind: 'question', rawBody: 'only raw' })).status === 400);
  check('question with only body is refused', (await call('POST', '/api/entries', { kind: 'question', body: 'plain' })).status === 400);
  check('outline item with a bad status is refused', (await call('PATCH', '/api/outline', { done: false, items: [{ no: '1', title: 'a', status: 'doing' }] })).status === 400);
  check('outline item without a title is refused', (await call('PATCH', '/api/outline', { done: false, items: [{ no: '1', status: 'active' }] })).status === 400);
  check('outline with two current items is refused', (await call('PATCH', '/api/outline', { done: false, items: [{ no: '1', title: 'a', status: 'active', current: true }, { no: '2', title: 'b', status: 'pending', current: true }] })).status === 400);
  const emptied = await call('PATCH', '/api/outline', { done: false, items: [] });
  check('empty unfinished outline is accepted, and without an outline there is no outlineVersion', emptied.status === 200 && emptied.data.outlineVersion === undefined, emptied.data);
  const outlineText = '1 | Basics | report | active | current\n2 | Training | report | pending\n2-1 | Add noise | report | pending\n3 | Sampling | report | pending\n';
  const created = await call('PATCH', '/api/outline', { text: outlineText });
  const read = (await call('GET', '/api/outline')).data;
  check('outline text round-trips through GET /api/outline, with the same version as the write', created.status === 200 && read.text === outlineText && Number.isInteger(created.data.outlineVersion) && read.version === created.data.outlineVersion, read);
  check('an outline change is state: it does not move the head', created.data.sync.head === emptied.data.sync.head);
  check('write responses to agents leave the whole outline out', created.data.state.outline === undefined && created.data.state.outlineDone === undefined, created.data.state);
  const other = await call('POST', '/api/entries', { kind: 'report', body: 'unrelated', final: true });
  check('every write response carries the outline version while there is an outline', other.data.outlineVersion === created.data.outlineVersion, other.data.outlineVersion);
  const moved = await call('PATCH', '/api/outline', { old: '1 | Basics | report | active | current\n2 | Training | report | pending', new: '1 | Basics | report | done\n2 | Training | report | active | current' });
  const afterMove = (await call('GET', '/api/state')).data.outline;
  check('an outline edit changes only the lines in old, moves current in one request and bumps the version', moved.status === 200 && moved.data.outlineVersion > created.data.outlineVersion && afterMove[0].status === 'done' && afterMove[1].current === true && afterMove.length === 4, afterMove);
  check('an outline edit is not an unseen event', (await call('GET', `/api/sync?knownHead=${created.data.sync.head}`)).data.unseen.every(event => event.t !== 'outline'));
  check('an edit whose old text is no longer there is refused', (await call('PATCH', '/api/outline', { old: '1 | Basics | report | active | current', new: 'x' })).status === 400);
  check('an edit leaving two current items is refused', (await call('PATCH', '/api/outline', { old: '3 | Sampling | report | pending', new: '3 | Sampling | report | active | current' })).status === 400);
  check('an edit breaking the line format is refused', (await call('PATCH', '/api/outline', { old: '3 | Sampling | report | pending', new: '3 Sampling' })).status === 400);
  const inserted = await call('PATCH', '/api/outline', { old: '2-1 | Add noise | report | pending\n', new: '2-1 | Add noise | report | pending\n2-2 | Predict noise | report | pending\n' });
  check('lines can be inserted with old/new', inserted.status === 200 && (await call('GET', '/api/state')).data.outline.map(item => item.no).join() === '1,2,2-1,2-2,3');
  await call('PATCH', '/api/outline', { text: '1 | A | B | report | active\n' });
  check('titles may contain a pipe', (await call('GET', '/api/state')).data.outline[0].title === 'A | B');
  const finished = await call('PATCH', '/api/outline', { done: true });
  check('a finished outline has no outlineVersion', finished.data.outlineVersion === undefined && (await call('GET', '/api/outline')).data.version === undefined);
  const restarted = await call('PATCH', '/api/outline', { done: false, items: [{ no: '1', title: 'a', type: 'report', status: 'active', current: true }] });
  check('a new outline gets a version never used before', restarted.data.outlineVersion > moved.data.outlineVersion && (await call('GET', '/api/state')).data.outline.length === 1, restarted.data.outlineVersion);

  const countBeforeRestart = (await call('GET', '/api/state')).data.entryCount;
  server.child.kill();
  await new Promise(resolve => server.child.on('exit', resolve));
  await new Promise(resolve => setTimeout(resolve, 250));
  server = startServer();
  base = urlOf(await server.output);
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
  const written = await call('POST', '/api/entries', { kind: 'report', body: 'pushed' });
  check('a write pushes the new head to open streams', (await pushed).head === written.data.sync.head);
  await reader.cancel();
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
  await call('POST', '/api/reset', { confirm: true });
  const a1 = await call('POST', '/api/entries', { kind: 'report', body: 'A answer 1' });
  check('multi-agent: the first agent on an empty thread sees nothing', a1.data.sync.status === 'none' && a1.data.sync.unseen.length === 0, a1.data.sync);
  const a2 = await call('POST', '/api/entries', { kind: 'report', body: 'A answer 2', knownHead: a1.data.sync.head });
  check('multi-agent: A does not get its own answer back', a2.data.sync.status === 'current' && a2.data.sync.unseen.length === 0, a2.data.sync);
  const b3 = await call('POST', '/api/entries', { kind: 'report', body: 'B answer 3' });
  const b3Bodies = b3.data.sync.unseen.map(event => event.body);
  check('multi-agent: B joining without a head sees answers 1 and 2 but not the reset or its own', b3.data.sync.status === 'none' && b3Bodies.join('|') === 'A answer 1|A answer 2' && b3.data.next.includes('conversation so far'), b3.data.sync);
  const a4 = await call('POST', '/api/entries', { kind: 'report', body: 'A answer 4', knownHead: a2.data.sync.head });
  check('multi-agent: A answering 4 learns only about answer 3', a4.data.sync.status === 'behind' && a4.data.sync.unseen.map(event => event.body).join('|') === 'B answer 3', a4.data.sync);
  const b5 = await call('POST', '/api/entries', { kind: 'report', body: 'B answer 5', knownHead: b3.data.sync.head });
  check('multi-agent: B answering 5 learns only about answer 4', b5.data.sync.unseen.map(event => event.body).join('|') === 'A answer 4', b5.data.sync);
  const asked = await call('POST', '/api/entries', { kind: 'question', rawBody: 'hint q', cleanedBody: 'hint q' });
  check('write response reminds to send knownHead', asked.data.next.includes('knownHead'), asked.data.next);
  check('after a question the hint asks for the reply', asked.data.next.includes('Record your reply'), asked.data.next);
  const answered = await call('POST', '/api/entries', { kind: 'report', body: 'answer', final: true, knownHead: asked.data.sync.head });
  check('after the final reply the hint asks for the next question, without the knownHead reminder', answered.data.next.startsWith("Record the user's next message") && !answered.data.next.includes('knownHead'), answered.data.next);
  const linesBefore = fs.readFileSync(dataFile, 'utf8').trim().split('\n').length;
  check('reset without confirm rejected', (await call('POST', '/api/reset', {})).status === 400);
  const reset = await call('POST', '/api/reset', { confirm: true });
  const linesAfter = fs.readFileSync(dataFile, 'utf8').trim().split('\n');
  check('reset clears current state', reset.data.state.entryCount === 0 && reset.data.state.pin === null);
  check('reset appends one line', linesAfter.length === linesBefore + 1 && JSON.parse(linesAfter.at(-1)).t === 'reset');
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
  server.child.kill();
}
await new Promise(resolve => setTimeout(resolve, 400));
fs.rmSync(tmp, { recursive: true, force: true });

for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n      ${result.detail}`}`);
const failed = results.filter(result => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
