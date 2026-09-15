import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
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
  check('same clientRef is deduplicated', dup.status === 200 && dup.data.deduplicated === true && dup.data.state.entryCount === 1);
  await call('PATCH', '/api/settings', { questionMode: 'raw' });
  check('question in raw mode uses rawBody', (await call('POST', '/api/entries', { kind: 'question', rawBody: 'raw 2', cleanedBody: 'clean 2' })).data.entry.body === 'raw 2');

  await call('PATCH', '/api/settings', { maxResponseChars: 10 });
  const ok10 = await call('POST', '/api/entries', { kind: 'report', body: '0123456789' });
  check('10-char response accepted', ok10.status === 201);
  const over = await call('POST', '/api/entries', { kind: 'report', body: '01234567890' });
  check('11-char response rejected with limit and length', over.status === 400 && over.data.maxResponseChars === 10 && over.data.length === 11);
  check('revision over limit rejected', (await call('POST', `/api/entries/${ok10.data.entry.id}/revisions`, { body: '01234567890' })).status === 400);
  check('negative unseen cap rejected', (await call('PATCH', '/api/settings', { maxUnseenEvents: -1 })).status === 400);
  await call('PATCH', '/api/settings', { maxResponseChars: 0 });
  check('limit 0 is unlimited', (await call('POST', '/api/entries', { kind: 'report', body: 'x'.repeat(5000) })).status === 201);

  const reportId = ok10.data.entry.id;
  check('question cannot be pinned', (await call('POST', '/api/pin', { target: cleaned.data.entry.id })).status === 400);
  await call('POST', '/api/pin', { target: reportId });
  await call('POST', '/api/reply-target', { target: reportId });
  await call('POST', '/api/entries', { kind: 'question', body: 'follow-up' });
  const reply = await call('POST', '/api/entries', { kind: 'report', body: 'reply body' });
  check('next response gets replyTo', reply.data.entry.replyTo === reportId && reply.data.state.replyTarget === null);
  const revision = await call('POST', `/api/entries/${reportId}/revisions`, { body: 'revised' });
  const fullList = await call('GET', '/api/entries?full=1&limit=1000');
  check('revision replaces body and keeps history', revision.data.entry.revisionCount === 1 && fullList.data.entries.find(entry => entry.id === reportId)?.body === 'revised');
  check('outline stored', (await call('PATCH', '/api/outline', { done: false, items: [{ no: '1', title: 'a', type: 'report', status: 'active', current: true }] })).data.state.outline.length === 1);

  server.child.kill();
  await new Promise(resolve => server.child.on('exit', resolve));
  await new Promise(resolve => setTimeout(resolve, 250));
  server = startServer();
  base = urlOf(await server.output);
  const afterRestart = (await call('GET', '/api/state')).data;
  check('state survives restart', afterRestart.entryCount === 6 && afterRestart.questionMode === 'raw' && afterRestart.maxResponseChars === 0 && afterRestart.pin?.target === reportId && afterRestart.outline.length === 1, JSON.stringify(afterRestart));

  const linesBefore = fs.readFileSync(dataFile, 'utf8').trim().split('\n').length;
  check('reset without confirm rejected', (await call('POST', '/api/reset', {})).status === 400);
  const reset = await call('POST', '/api/reset', { confirm: true });
  const linesAfter = fs.readFileSync(dataFile, 'utf8').trim().split('\n');
  check('reset clears current state', reset.data.state.entryCount === 0 && reset.data.state.pin === null);
  check('reset appends one line', linesAfter.length === linesBefore + 1 && JSON.parse(linesAfter.at(-1)).t === 'reset');
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
