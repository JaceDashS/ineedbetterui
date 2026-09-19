import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'ineedbetterui', 'skills', 'ineedbetterui', 'ineedbetterui.mjs');
const isWindows = process.platform === 'win32';
const GENESIS = '0'.repeat(16);
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = [];

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'inbu-sync-')));
const recordsDir = dir => path.join(fs.realpathSync.native(dir), 'node_modules', '.ineedbetterui');
const sessionIdFor = dir => {
  const real = fs.realpathSync.native(dir);
  return createHash('sha256').update(isWindows ? real.toLowerCase() : real).digest('hex').slice(0, 12);
};
const serverFiles = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /^server-\d+\.html$/.test(name)) : [];

function run(cwd, args = [], env = process.env) {
  const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  const wantsBroadcastLine = args.includes('--broadcast');
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no ready output: ' + out)), 15000);
    const poll = setInterval(() => {
      const listening = /listening on http:\/\/127\.0\.0\.1:\d+\//.test(out);
      if (listening && (!wantsBroadcastLine || /broadcast access on/.test(out))) { clearInterval(poll); clearTimeout(timer); resolve(out); }
    }, 50);
    exited.then(() => { clearInterval(poll); clearTimeout(timer); resolve(out); });
  });
  return { child, ready, exited, output: () => out, port: () => Number(/listening on http:\/\/127\.0\.0\.1:(\d+)\//.exec(out)?.[1]) };
}

async function stop(proc) {
  if (proc.child.exitCode === null) { proc.child.kill(); await proc.exited; }
  await sleep(250);
}

async function api(port, method, route, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

// Switching broadcast rebinds the listener, so an idle keep-alive socket can be
// dropped between calls. Retry briefly instead of failing the check.
async function apiRetry(port, method, route, body, headers = {}) {
  let last = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { return await api(port, method, route, body, headers); } catch (error) { last = error; await sleep(300); }
  }
  throw last;
}

async function pageText(port) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { return await (await fetch(`http://127.0.0.1:${port}/`)).text(); } catch { await sleep(300); }
  }
  return '';
}

const dirA = path.join(tmp, 'project-a');
const dirB = path.join(tmp, 'project-b');
const dirC = path.join(tmp, 'project-c');
const dirD = path.join(tmp, 'project-d');
for (const dir of [dirA, dirB, dirC, dirD]) fs.mkdirSync(dir);
const dirAShort = path.join(os.tmpdir(), path.relative(fs.realpathSync.native(os.tmpdir()), dirA));

try {
  // ---------- storage in node_modules/.ineedbetterui ----------
  const first = run(dirA, ['--no-broadcast']);
  await first.ready;
  const P = first.port();
  const idA = sessionIdFor(dirA);
  const sessionA = recordsDir(dirA);
  check('server starts', Number.isInteger(P), first.output());
  check('server info file is in the records folder', serverFiles(sessionA).join() === `server-${P}.html`, serverFiles(sessionA));
  const ignoreA = path.join(sessionA, '.gitignore');
  check('records folder has a .gitignore that ignores everything', fs.existsSync(ignoreA) && fs.readFileSync(ignoreA, 'utf8') === '*\n');
  const project = JSON.parse(fs.readFileSync(path.join(sessionA, 'project.json'), 'utf8'));
  check('project.json records project path and session id', project.projectPath === fs.realpathSync.native(dirA) && project.sessionId === idA && project.app === 'ineedbetterui', project);
  for (let attempt = 0; attempt < 40 && !first.output().includes('records '); attempt += 1) await sleep(50);
  check('console prints the records path', first.output().includes(`records ${path.join(sessionA, 'transcript.jsonl')}`), first.output());
  const health = await api(P, 'GET', '/api/health');
  check('health: app name and session id', health.data.app === 'ineedbetterui' && health.data.sessionId === idA && health.data.broadcast === false, health.data);

  // ---------- session reuse ----------
  const second = run(dirAShort, ['--no-broadcast', '--port', '5', '--data', 'x.jsonl']);
  check('second start (short path) reuses the server', (await second.exited) === 0 && second.output().includes(`ineedbetterui already running on http://127.0.0.1:${P}/`), second.output());
  const other = run(dirA, ['--broadcast']);
  check('a start with --broadcast reuses the running server', (await other.exited) === 0 && other.output().includes(`already running on http://127.0.0.1:${P}/`), other.output());

  // ---------- hash sync ----------
  const s0 = await api(P, 'GET', '/api/sync');
  check('sync: empty log, no knownHead -> none with genesis head', s0.data.status === 'none' && s0.data.head === GENESIS && s0.data.eventCount === 0, s0.data);
  const q = await api(P, 'POST', '/api/entries', { kind: 'question', rawBody: 'raw', cleanedBody: 'clean', knownHead: GENESIS });
  check('sync: only own write -> current', q.status === 201 && q.data.sync.status === 'current' && q.data.sync.unseenCount === 0 && q.data.sync.head !== GENESIS && q.data.state.head === q.data.sync.head, q.data.sync);
  let headA = q.data.sync.head;
  await api(P, 'PATCH', '/api/settings', { questionMode: 'raw' }, { 'X-Ineedbetterui-UI': '1' });
  const a2 = await api(P, 'POST', '/api/entries', { kind: 'report', body: 'agent A report', final: true, knownHead: headA });
  check('sync: a user setting change is state, not an unseen event', a2.data.sync.status === 'current' && a2.data.sync.unseenCount === 0 && a2.data.state.questionMode === 'raw' && a2.data.sync.head !== headA, a2.data.sync);
  headA = a2.data.sync.head;

  const longReport = await api(P, 'POST', '/api/entries', { kind: 'report', body: 'r'.repeat(500) });
  const rId = longReport.data.entry.id;
  await api(P, 'POST', '/api/entries', { kind: 'question', rawBody: 'q'.repeat(400), cleanedBody: 'q'.repeat(400) });
  await api(P, 'POST', '/api/pin', { target: rId });
  await api(P, 'POST', '/api/reply-target', { target: rId });
  const edited = await api(P, 'POST', '/api/pin/edit', { old: 'r'.repeat(500), new: 'v'.repeat(300), final: true });
  const editedId = edited.data.entry.id;

  const s1 = await api(P, 'GET', `/api/sync?knownHead=${headA}`);
  const u = s1.data.unseen;
  check('sync: three unseen events in file order, pin switches left out', s1.data.status === 'behind' && s1.data.unseenCount === 3 && u.map(e => e.t).join(',') === 'entry,entry,entry', u.map(e => e.t));
  check('sync: long response is a 200-char preview', u[0].preview?.length === 200 && u[0].length === 500 && u[0].truncated === true && u[0].body === undefined, u[0]);
  check('sync: long question is sent in full', u[1].kind === 'question' && u[1].body?.length === 400, u[1]);
  check('sync: a pin edit is sent as its change', u[2].revises === rId && u[2].old === 'r'.repeat(500) && u[2].new === 'v'.repeat(300) && u[2].body === undefined && u[2].final === true, u[2]);
  check('sync: events carry 16-hex hashes and the last equals head', u.every(e => /^[0-9a-f]{16}$/.test(e.hash)) && u.at(-1).hash === s1.data.head);
  const fullEntry = await api(P, 'GET', `/api/entries/${editedId}`);
  check('GET /api/entries/:id returns the whole edited document', fullEntry.status === 200 && fullEntry.data.entry.body === 'v'.repeat(300) && fullEntry.data.entry.revises === rId, fullEntry.data);
  check('the pinned original is unchanged', (await api(P, 'GET', `/api/entries/${rId}`)).data.entry.body === 'r'.repeat(500));
  check('GET /api/entries/:id rejects an unknown id', (await api(P, 'GET', '/api/entries/a-99999')).status === 400);

  await api(P, 'PATCH', '/api/settings', { maxUnseenEvents: 2 });
  const s2 = await api(P, 'GET', `/api/sync?knownHead=${headA}`);
  check('sync: settings cap keeps the newest 2 and marks truncated', s2.data.unseenCount === 3 && s2.data.unseen.length === 2 && s2.data.truncated === true && s2.data.unseen.every(event => event.t !== 'settings' && event.t !== 'pin'), s2.data);
  const s3 = await api(P, 'GET', `/api/sync?knownHead=${headA}&limit=10`);
  check('sync: explicit limit overrides the cap', s3.data.unseen.length === 3 && s3.data.truncated === false);
  const s4 = await api(P, 'GET', '/api/sync?limit=2');
  check('sync: explicit last N without knownHead', s4.data.status === 'none' && s4.data.unseen.length === 2 && s4.data.unseen.at(-1).hash === s4.data.head);
  const s5 = await api(P, 'GET', '/api/sync?knownHead=ffffffffffffffff');
  check('sync: unknown head is treated as knowing nothing and gets the recent log', s5.data.status === 'unknown' && s5.data.unseen.length > 0 && Number.isInteger(s5.data.unseenCount) && s5.data.unseen.at(-1).hash === s5.data.head, s5.data);
  const stateNow = await api(P, 'GET', '/api/state');
  // eventCount counts chain lines only: 5 conversation lines; the settings, pin and Add reply switches are not in the chain.
  check('state exposes head, eventCount, maxUnseenEvents', stateNow.data.head === s5.data.head && stateNow.data.eventCount === 5 && stateNow.data.maxUnseenEvents === 2, stateNow.data);
  const last2 = await api(P, 'GET', '/api/entries?last=2&full=1');
  check('entries?last=2 returns the newest two', last2.data.entries.length === 2 && last2.data.entries.at(-1).id === stateNow.data.lastEntry.id);

  const d1 = await api(P, 'POST', '/api/entries', { kind: 'report', body: 'dup', clientRef: 'c1', knownHead: stateNow.data.head });
  const d2 = await api(P, 'POST', '/api/entries', { kind: 'report', body: 'dup', clientRef: 'c1', knownHead: d1.data.sync.head });
  check('sync: deduplicated retry is current and writes nothing', d2.data.deduplicated === true && d2.data.sync.status === 'current' && d2.data.sync.head === d1.data.sync.head, d2.data.sync);

  await api(P, 'POST', '/api/reset', { confirm: true });
  const s6 = await api(P, 'GET', `/api/sync?knownHead=${d1.data.sync.head}`);
  check('sync: reset is reported as an unseen event', s6.data.unseenCount === 1 && s6.data.unseen[0].t === 'reset', s6.data);

  const transcript = path.join(sessionA, 'transcript.jsonl');
  fs.appendFileSync(transcript, 'not json\n');
  const w1 = await api(P, 'POST', '/api/entries', { kind: 'report', body: 'after junk', knownHead: s6.data.head });
  check('sync: an externally appended invalid line is reported', w1.data.sync.unseenCount === 1 && w1.data.sync.unseen[0].t === 'invalid', w1.data.sync);
  const lines = fs.readFileSync(transcript, 'utf8').split('\n');
  lines[0] = lines[0].replace('"raw"', '"RAW"');
  fs.writeFileSync(transcript, lines.join('\n'));
  const w2 = await api(P, 'POST', '/api/entries', { kind: 'report', body: 'after tamper', knownHead: w1.data.sync.head });
  check('sync: rewriting an earlier line makes old heads unknown', w2.data.sync.status === 'unknown', w2.data.sync);
  const latestHead = w2.data.sync.head;

  // ---------- restart, stale file, same port, stable hashes ----------
  await stop(first);
  check('forced kill leaves a stale server file', serverFiles(sessionA).length === 1);
  const again = run(dirA, ['--no-broadcast']);
  await again.ready;
  check('restart reuses the previous port and replaces the stale file', again.port() === P && serverFiles(sessionA).join() === `server-${P}.html`, again.output());
  const s7 = await api(again.port(), 'GET', `/api/sync?knownHead=${latestHead}`);
  check('sync: head is identical after restart', s7.data.status === 'current', s7.data);

  if (isWindows) {
    let renameError = '';
    try { fs.renameSync(dirA, dirA + '-moving'); } catch (error) { renameError = error.code; }
    check('project folder cannot be moved while running (Windows)', renameError === 'EBUSY' || renameError === 'EPERM', renameError || 'rename succeeded');
  }
  check('only node_modules/.ineedbetterui is created in the project folder', fs.readdirSync(dirA).join() === 'node_modules' && fs.readdirSync(path.join(dirA, 'node_modules')).join() === '.ineedbetterui', fs.readdirSync(dirA));
  await stop(again);

  // ---------- previous port taken by another program ----------
  const b1 = run(dirB, ['--no-broadcast']);
  await b1.ready;
  const takenPort = b1.port();
  const sessionB = recordsDir(dirB);
  await stop(b1);
  const blocker = http.createServer((request, response) => { response.writeHead(404); response.end('other'); });
  await new Promise(resolve => blocker.listen(takenPort, '127.0.0.1', resolve));
  const b2 = run(dirB, ['--no-broadcast']);
  await b2.ready;
  check('occupied previous port: new port, stale file replaced', b2.port() !== takenPort && serverFiles(sessionB).join() === `server-${b2.port()}.html`, serverFiles(sessionB));
  await new Promise(resolve => blocker.close(resolve));
  await stop(b2);

  // ---------- renamed project folder keeps its records ----------
  const dirAMoved = dirA + '-moved';
  fs.renameSync(dirA, dirAMoved);
  const moved = run(dirAMoved, ['--no-broadcast']);
  await moved.ready;
  const idMoved = sessionIdFor(dirAMoved);
  const movedHealth = await api(moved.port(), 'GET', '/api/health');
  const movedTranscript = path.join(recordsDir(dirAMoved), 'transcript.jsonl');
  check('renamed folder: new session id, records moved with the folder', idMoved !== idA && movedHealth.data.sessionId === idMoved && fs.existsSync(movedTranscript) && fs.readFileSync(movedTranscript, 'utf8').includes('after tamper') && serverFiles(recordsDir(dirAMoved)).join() === `server-${moved.port()}.html`, movedHealth.data);
  await stop(moved);

  // ---------- broadcast is off by default and switches without a restart ----------
  const localOnly = run(dirC, []);
  await localOnly.ready;
  const localPort = localOnly.port();
  const beforeState = await api(localPort, 'GET', '/api/state');
  check('default start stays local and records no QR entry', !/broadcast access on/.test(localOnly.output()) && beforeState.data.broadcast === null && beforeState.data.entryCount === 0, { out: localOnly.output(), state: beforeState.data });
  // Broadcast is switched from the page, which gets the full state (with the QR code).
  const turnedOn = await api(localPort, 'POST', '/api/broadcast', { on: true }, { 'X-Ineedbetterui-UI': '1' });
  check('turning broadcast on returns the url and a QR code', turnedOn.data.state.broadcast?.enabled === true && /^http:\/\/[\d.]+:\d+\/$/.test(turnedOn.data.state.broadcast.url || '') && typeof turnedOn.data.state.broadcast.qr?.modules === 'string', turnedOn.data.state.broadcast);
  const afterOn = await apiRetry(localPort, 'GET', '/api/state');
  check('the same port keeps serving after the switch', afterOn.data.broadcast?.enabled === true && afterOn.data.entryCount === 0, afterOn.data.broadcast);
  const syncAfter = await apiRetry(localPort, 'GET', `/api/sync?knownHead=${beforeState.data.head}`);
  check('the switch is state: agents see it in state, not as an unseen event', syncAfter.data.unseen.every(event => event.t !== 'broadcast') && syncAfter.data.head === beforeState.data.head && afterOn.data.broadcast?.enabled === true, syncAfter.data);
  const turnedOff = await apiRetry(localPort, 'POST', '/api/broadcast', { on: false });
  check('turning broadcast off clears the state', turnedOff.data.state.broadcast === null, turnedOff.data.state);
  const rejected = await apiRetry(localPort, 'POST', '/api/entries', { kind: 'report', body: 'x'.repeat(20) , clientRef: null });
  check('a write response still carries the settings', rejected.data.state.maxResponseChars === 3000 && rejected.data.state.maxUnseenEvents === 20, rejected.data.state);
  const page = await pageText(localPort);
  const clientSource = page.slice(page.lastIndexOf('<script>') + '<script>'.length, page.lastIndexOf('</script>'));
  let compiled = true;
  try { new Function(clientSource); } catch (error) { compiled = error.message; }
  check('page client script compiles', compiled === true, String(compiled));
  check('page has the settings panel with both limits and the broadcast toggle', page.includes('id="settings-panel"') && page.includes('id="max-unseen-events"') && page.includes('id="max-response-chars"') && page.includes('id="broadcast-toggle"'), 'settings panel missing');
  check('page uses the new name', page.includes('<title>I Need Better UI</title>') && !/agent[- ]transcript/i.test(page), 'old name');
  await stop(localOnly);

  // ---------- git ignores the records without any node_modules rule ----------
  if (spawnSync('git', ['init', '-q'], { cwd: dirD, encoding: 'utf8' }).status === 0) {
    const local = run(dirD, ['--no-broadcast']);
    await local.ready;
    await api(local.port(), 'POST', '/api/entries', { kind: 'report', body: 'ignored by git' });
    const status = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: dirD, encoding: 'utf8' });
    check('git status stays clean in a repository without .gitignore', status.status === 0 && status.stdout.trim() === '' && fs.existsSync(path.join(recordsDir(dirD), 'transcript.jsonl')), `${status.stdout}${status.stderr}`);
    await stop(local);
  }
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  await sleep(400);
  fs.rmSync(tmp, { recursive: true, force: true });
}

for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n      ${result.detail}`}`);
const failed = results.filter(result => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
