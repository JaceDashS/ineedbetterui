// End-to-end check of the npm package: pack, global install into a temporary
// prefix, skill registration, start/stop and uninstall.
// Every user folder is redirected to a temporary directory.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResults } from './helpers/results.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const { check, finish } = createResults({ jsonDetails: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'inbu-cli-')));
const dirs = Object.fromEntries(['home', 'home2', 'home3', 'codex', 'prefix', 'project', 'project2'].map(name => [name, path.join(tmp, name)]));
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

const baseEnv = { ...process.env, USERPROFILE: dirs.home, HOME: dirs.home, CODEX_HOME: dirs.codex };
const quote = value => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);

function run(command, args, options = {}) {
  const result = isWindows
    ? spawnSync([command, ...args].map(quote).join(' '), { encoding: 'utf8', shell: true, env: baseEnv, ...options })
    : spawnSync(command, args, { encoding: 'utf8', env: baseEnv, ...options });
  return { code: result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
}

const projectRecords = path.join(dirs.project, 'node_modules', '.ineedbetterui');
const codexSkill = home => path.join(home, '.agents', 'skills', 'ineedbetterui');
const claudeSkill = home => path.join(home, '.claude', 'skills', 'ineedbetterui');
const bin = isWindows ? path.join(dirs.prefix, 'ineedbetterui.cmd') : path.join(dirs.prefix, 'bin', 'ineedbetterui');
let server = null;

try {
  // ---------- package contents ----------
  // A private file is placed in the skill folder so the exclusion is tested
  // even where no *.private.* file happens to exist.
  const probe = path.join(repo, 'plugins', 'ineedbetterui', 'skills', 'ineedbetterui', 'references', 'probe.ko.private.md');
  fs.writeFileSync(probe, 'private probe\n');
  const dryRun = run('npm', ['pack', '--dry-run', '--json'], { cwd: repo });
  fs.rmSync(probe, { force: true });
  let packed = [];
  try { packed = JSON.parse(dryRun.out.slice(dryRun.out.indexOf('['))) [0].files.map(file => file.path.replace(/\\/g, '/')); } catch {}
  const required = ['package.json', 'LICENSE', 'bin/ineedbetterui.mjs', 'plugins/ineedbetterui/skills/ineedbetterui/SKILL.md', 'plugins/ineedbetterui/skills/ineedbetterui/ineedbetterui.mjs', 'plugins/ineedbetterui/skills/ineedbetterui/references/reference.md', 'plugins/ineedbetterui/skills/ineedbetterui/lib/qr.mjs', 'plugins/ineedbetterui/skills/ineedbetterui/lib/paths.mjs', 'plugins/ineedbetterui/skills/ineedbetterui/ui/page.html', 'plugins/ineedbetterui/skills/ineedbetterui/ui/page.css', 'plugins/ineedbetterui/skills/ineedbetterui/ui/page.js'];
  check('package includes bin, skill, server and reference', required.every(file => packed.includes(file)), packed);
  check('package excludes tests, tester and private files', !packed.some(file => /^(tests|tester)\/|\.private\./.test(file)), packed);

  const pack = run('npm', ['pack', '--pack-destination', tmp, '--silent'], { cwd: repo });
  const tgz = path.join(tmp, pack.out.trim().split(/\r?\n/).pop());
  check('npm pack creates a tarball', fs.existsSync(tgz), pack.out);

  // ---------- global install runs postinstall ----------
  const install = run('npm', ['install', '-g', '--prefix', dirs.prefix, tgz, '--no-audit', '--no-fund']);
  check('global install succeeds and creates the command', install.code === 0 && fs.existsSync(bin), install.out);
  check('postinstall registers the skill for Codex', fs.existsSync(path.join(codexSkill(dirs.home), 'SKILL.md')) && fs.existsSync(path.join(codexSkill(dirs.home), 'ineedbetterui.mjs')) && fs.existsSync(path.join(codexSkill(dirs.home), '.ineedbetterui-install.json')), install.out);
  check('postinstall registers the skill for Claude Code', fs.existsSync(path.join(claudeSkill(dirs.home), 'SKILL.md')) && fs.existsSync(path.join(claudeSkill(dirs.home), 'references', 'reference.md')), install.out);
  check('postinstall does not touch the Codex config', !fs.existsSync(path.join(dirs.codex, 'config.toml')));

  const versionOut = run(bin, ['--version']);
  check('ineedbetterui --version prints the package version', versionOut.out.trim() === version, versionOut.out);

  // ---------- a folder we did not create is never overwritten ----------
  const foreign = claudeSkill(dirs.home2);
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, 'SKILL.md'), 'user content');
  const skip = run(bin, ['install'], { env: { ...baseEnv, USERPROFILE: dirs.home2, HOME: dirs.home2 } });
  check('install skips a same-named skill folder it did not create', fs.readFileSync(path.join(foreign, 'SKILL.md'), 'utf8') === 'user content' && /skipped/.test(skip.out), skip.out);

  // ---------- start and stop through the command ----------
  let output = '';
  server = isWindows
    ? spawn(`${quote(bin)} --no-broadcast`, { cwd: dirs.project, env: baseEnv, shell: true })
    : spawn(bin, ['--no-broadcast'], { cwd: dirs.project, env: baseEnv });
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  for (let attempt = 0; attempt < 100 && !/listening on http:\/\/127\.0\.0\.1:\d+/.test(output); attempt += 1) await sleep(100);
  const port = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1]);
  const health = port ? await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() : null;
  check('ineedbetterui starts the server for the current folder', health?.app === 'ineedbetterui', output);
  const ignoreFile = path.join(projectRecords, '.gitignore');
  check('records go to node_modules/.ineedbetterui with a .gitignore', fs.existsSync(ignoreFile) && fs.readFileSync(ignoreFile, 'utf8') === '*\n' && fs.existsSync(path.join(projectRecords, 'project.json')), output);

  // ---------- recording through the command ----------
  // What an agent used to spend on a URL, a header, JSON quoting and, on
  // Windows, an encoding trap: the point is that awkward text survives it.
  const registered = JSON.parse(run(bin, ['register', '--model', 'claude-opus-5'], { cwd: dirs.project }).out);
  check('register gives a name from the model and a token', /^claude-[a-z]+$/.test(registered.agent) && typeof registered.token === 'string', registered);
  const withToken = { cwd: dirs.project, env: { ...baseEnv, INEEDBETTERUI_TOKEN: registered.token } };
  const awkward = 'C:\\Users\\"a b"\\x.txt 경로와 "따옴표"';
  // Text a shell would mangle goes in a file, which is why the flags take one.
  const questionFile = path.join(dirs.project, 'question.txt');
  fs.writeFileSync(questionFile, awkward, 'utf8');
  const asked = JSON.parse(run(bin, ['record', 'question', '--turn', '1', '--rawFile', questionFile, '--cleaned', 'Asking about the path.'], withToken).out);
  check('record question from a file keeps quotes, backslashes and non-ASCII exactly', asked.entry?.rawBody === awkward, asked.entry);
  const replyFile = path.join(dirs.project, 'reply.md');
  const replyText = '한 줄\n\n```js\nconst re = /a\\b//;\n```\n';
  fs.writeFileSync(replyFile, replyText, 'utf8');
  check('progress is sent for the open turn and not recorded', JSON.parse(run(bin, ['progress', '--turn', '1', '읽는 중입니다'], withToken).out).written === false);
  const replied = JSON.parse(run(bin, ['record', 'report', '--turn', '1', '--file', replyFile], withToken).out);
  check('record report takes the body from a file, unchanged', replied.entry?.body === replyText, replied.entry);
  const gap = run(bin, ['record', 'question', '--turn', '3', '--raw', 'x', '--cleaned', 'x'], withToken);
  check('a skipped turn is refused, by number, with a non-zero exit code', gap.code !== 0 && /Turn 2 .* never recorded/.test(gap.out), gap);
  const noToken = run(bin, ['record', 'report', '--turn', '1', '--text', 'x'], { cwd: dirs.project });
  check('recording without a token says to register first', noToken.code !== 0 && /register --model/.test(noToken.out), noToken.out);

  const stopOut = run(bin, ['stop'], { cwd: dirs.project });
  await sleep(500);
  let stillUp = true;
  try { await fetch(`http://127.0.0.1:${port}/api/health`); } catch { stillUp = false; }
  const recordFiles = fs.existsSync(projectRecords) ? fs.readdirSync(projectRecords) : [];
  const projectInfo = JSON.parse(fs.readFileSync(path.join(projectRecords, 'project.json'), 'utf8'));
  check('ineedbetterui stop stops it and clears the server entry and open.html', /Stopped/.test(stopOut.out) && !stillUp && projectInfo.server === undefined && !recordFiles.includes('open.html') && !recordFiles.some(name => name.startsWith('server-')), { out: stopOut.out, projectInfo, recordFiles });
  check('ineedbetterui stop with no server says so', /No running/.test(run(bin, ['stop'], { cwd: dirs.project }).out));

  // ---------- a project-local install does not register skills ----------
  run('npm', ['init', '-y'], { cwd: dirs.project2 });
  const local = run('npm', ['install', tgz, '--no-audit', '--no-fund'], { cwd: dirs.project2, env: { ...baseEnv, USERPROFILE: dirs.home3, HOME: dirs.home3 } });
  check('project-local install does not register skills', local.code === 0 && !fs.existsSync(claudeSkill(dirs.home3)) && !fs.existsSync(codexSkill(dirs.home3)), local.out);

  // ---------- uninstall ----------
  const remove = run(bin, ['uninstall']);
  check('uninstall removes both skill folders', !fs.existsSync(codexSkill(dirs.home)) && !fs.existsSync(claudeSkill(dirs.home)), remove.out);
  check('uninstall keeps the project records', fs.existsSync(path.join(projectRecords, 'project.json')), remove.out);
  const npmRemove = run('npm', ['uninstall', '-g', '--prefix', dirs.prefix, 'ineedbetterui']);
  check('npm uninstall -g removes the command', npmRemove.code === 0 && !fs.existsSync(bin), npmRemove.out);
} finally {
  if (server && server.exitCode === null) server.kill();
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

finish();
