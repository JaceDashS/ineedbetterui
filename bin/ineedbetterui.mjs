#!/usr/bin/env node
// Command-line entry of the ineedbetterui npm package: starts the transcript
// server and registers the skill for Codex and Claude Code.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recordsDirFor, sessionIdFor } from '../plugins/ineedbetterui/skills/ineedbetterui/lib/paths.mjs';

const APP_NAME = 'ineedbetterui';
const INSTALL_MARKER = '.ineedbetterui-install.json';
const HEALTH_TIMEOUT_MS = 600;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const skillSource = path.join(packageRoot, 'plugins', APP_NAME, 'skills', APP_NAME);
const serverPath = path.join(skillSource, `${APP_NAME}.mjs`);

function skillTargets() {
  const home = os.homedir();
  return [
    { tool: 'Codex', dir: path.join(home, '.agents', 'skills', APP_NAME), usage: `$${APP_NAME}` },
    { tool: 'Claude Code', dir: path.join(home, '.claude', 'skills', APP_NAME), usage: `/${APP_NAME}` }
  ];
}

function isOurInstall(dir) {
  return fs.existsSync(path.join(dir, INSTALL_MARKER));
}

function installSkill(target) {
  if (fs.existsSync(target.dir) && !isOurInstall(target.dir)) {
    return `skipped, ${target.dir} exists and was not installed by ${APP_NAME}`;
  }
  fs.rmSync(target.dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target.dir), { recursive: true });
  // Private notes (*.private.*) stay in the repository and never reach agents.
  fs.cpSync(skillSource, target.dir, { recursive: true, filter: source => !/\.private\./.test(path.basename(source)) });
  const marker = { app: APP_NAME, version: packageJson.version, source: skillSource, installedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(target.dir, INSTALL_MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  return `installed ${target.dir} (use ${target.usage})`;
}

function install() {
  console.log(`${APP_NAME} ${packageJson.version}`);
  for (const target of skillTargets()) console.log(`${target.tool}: ${installSkill(target)}`);
}

function uninstall() {
  for (const target of skillTargets()) {
    if (!fs.existsSync(target.dir)) {
      console.log(`${target.tool}: not installed`);
    } else if (!isOurInstall(target.dir)) {
      console.log(`${target.tool}: skipped, ${target.dir} was not installed by ${APP_NAME}`);
    } else {
      fs.rmSync(target.dir, { recursive: true, force: true });
      console.log(`${target.tool}: removed ${target.dir}`);
    }
  }
  console.log(`Transcripts were kept in each project's node_modules/.${APP_NAME} folder.`);
  console.log(`\nTo remove the command as well, run: npm uninstall -g ${APP_NAME}`);
}

function checkHealth(port) {
  return new Promise(resolve => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/health', timeout: HEALTH_TIMEOUT_MS }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const health = JSON.parse(body);
          resolve(response.statusCode === 200 && health.app === APP_NAME ? health : null);
        } catch {
          resolve(null);
        }
      });
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => { request.destroy(); resolve(null); });
  });
}

// Stops the server that records the project in the current folder.
async function stop() {
  const sessionId = sessionIdFor(process.cwd());
  const recordsDir = recordsDirFor(process.cwd());
  const infoFile = path.join(recordsDir, 'project.json');
  let info = null;
  try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch {}
  // project.json names the running server; older versions used server-<port>.html.
  const legacy = fs.existsSync(recordsDir) ? fs.readdirSync(recordsDir).filter(name => /^server-\d+\.html$/.test(name)) : [];
  const ports = new Set([info?.server?.port, ...legacy.map(name => Number(/^server-(\d+)\.html$/.exec(name)[1]))].filter(Number.isInteger));
  let stopped = 0;
  for (const port of ports) {
    const health = await checkHealth(port);
    if (health?.sessionId !== sessionId) continue;
    try {
      process.kill(health.pid);
      stopped += 1;
      console.log(`Stopped the ${APP_NAME} server for this folder (PID ${health.pid}, port ${port}).`);
    } catch (error) {
      console.log(`Could not stop PID ${health.pid}: ${error.message}`);
    }
  }
  // A killed process cannot clean up after itself (on Windows it gets no signal),
  // so the server entry, open.html and older info files are removed here.
  if (info?.server) {
    delete info.server;
    fs.writeFileSync(infoFile, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  }
  for (const name of ['open.html', ...legacy]) fs.rmSync(path.join(recordsDir, name), { force: true });
  if (!stopped) console.log(`No running ${APP_NAME} server was found for this folder.`);
}

// ---------- writing to the running server ----------
// Recording through curl costs an agent a URL, a header, a hand-written JSON
// body and, on Windows, an encoding trap. These commands take files and flags
// instead, and keep the head between calls, so a record is one line.

const HEADS_FILE = 'cli-heads.json';

function readFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s);
      if (inline !== undefined) flags[name] = inline;
      else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) flags[name] = true;
      else { flags[name] = argv[i + 1]; i += 1; }
    } else rest.push(arg);
  }
  return { flags, rest };
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// A flag is either text (--text "...") or a file (--file reply.md, - for stdin).
function readContent(flags, textName, fileName) {
  if (typeof flags[textName] === 'string') return flags[textName];
  const source = flags[fileName];
  if (source === undefined) return undefined;
  if (source === true) throw new Error(`--${fileName} needs a path, or - for standard input.`);
  return source === '-' ? readStdin() : fs.readFileSync(source, 'utf8');
}

// The server for this folder, from the file it writes when it starts.
async function runningBase() {
  const recordsDir = recordsDirFor(process.cwd());
  let info = null;
  try { info = JSON.parse(fs.readFileSync(path.join(recordsDir, 'project.json'), 'utf8')); } catch {}
  const port = info?.server?.port;
  if (!Number.isInteger(port)) {
    throw new Error(`No running ${APP_NAME} server was found for this folder. Start it with "${APP_NAME}" and try again.`);
  }
  const health = await checkHealth(port);
  if (health?.sessionId !== sessionIdFor(process.cwd())) {
    throw new Error(`The ${APP_NAME} server for this folder is not answering on port ${port}. Start it with "${APP_NAME}" and try again.`);
  }
  return { base: `http://127.0.0.1:${port}`, recordsDir };
}

// The head is the agent's place in the transcript. Keeping it here means the
// agent never has to carry it from one command to the next.
function headStore(recordsDir) {
  const file = path.join(recordsDir, HEADS_FILE);
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  return {
    get: token => read()[token],
    set: (token, head) => {
      const heads = read();
      heads[token] = head;
      try { fs.writeFileSync(file, `${JSON.stringify(heads, null, 2)}\n`, 'utf8'); } catch {}
    }
  };
}

// Registered agents live in project.json, keyed by token, so an agent that
// lost its token to a compacted context finds it here instead of registering
// again under a new name.
function registeredAgents() {
  const recordsDir = recordsDirFor(process.cwd());
  let info = null;
  try { info = JSON.parse(fs.readFileSync(path.join(recordsDir, 'project.json'), 'utf8')); } catch {}
  const agents = info?.agents && typeof info.agents === 'object' ? info.agents : {};
  return Object.entries(agents)
    .filter(([, agent]) => agent?.name)
    .map(([token, agent]) => ({ token, name: agent.name, model: agent.model || '', createdAt: agent.createdAt, lastSeenAt: agent.lastSeenAt }))
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
}

// ---------- finding your place again ----------
// An agent whose context was compacted keeps nothing: not the token, not the
// head, not the turn it was on. Everything it needs is on this computer
// already, in project.json and in the running server, so one command gives it
// back rather than leaving the agent to guess or register a second time.

function statusHint(live, agents, turn) {
  if (!live) return `The server for this folder is not running, so nothing can be recorded. Start it with "${APP_NAME}" from the project folder, tell the user the address, and record from the next message on.`;
  if (!agents.length) return `No agent is registered for this project. Register with "${APP_NAME} register --model <your model>", keep the token, and record the user's next message as a question, turn 1.`;
  const hints = [];
  const mine = agents.length === 1 ? agents[0] : null;
  if (mine) hints.push(`You are ${mine.name}; pass --token ${mine.token} (the only registered agent is used by default).`);
  else hints.push(`Several agents are registered: ${agents.map(agent => `${agent.name} (${agent.model || 'unknown model'}, last turn ${agent.lastTurn ?? 0})`).join(', ')}. Say which one you are with --agent <name>; register again only if none of them is you.`);
  if (turn?.open) hints.push(`Turn ${turn.no} is open, held by ${turn.agent}: if that is you, record its reply with --turn ${turn.no}; if it is not, wait rather than recording.`);
  else if (mine) hints.push(`The user's next message is turn ${(mine.lastTurn || 0) + 1}.`);
  hints.push('Record every user message as a question before you answer it, and every reply you give.');
  return hints.join(' ');
}

async function status() {
  const recordsDir = recordsDirFor(process.cwd());
  let info = null;
  try { info = JSON.parse(fs.readFileSync(path.join(recordsDir, 'project.json'), 'utf8')); } catch {}
  const port = info?.server?.port;
  const health = Number.isInteger(port) ? await checkHealth(port) : null;
  const live = health?.sessionId === sessionIdFor(process.cwd());
  const base = live ? `http://127.0.0.1:${port}` : null;
  const get = async route => {
    if (!base) return null;
    try { return await (await fetch(base + route)).json(); } catch { return null; }
  };
  const [state, registry, recent] = await Promise.all([get('/api/state'), get('/api/agents'), get('/api/entries?last=5')]);
  const seen = new Map((registry?.agents || []).map(agent => [agent.name, agent]));
  const agents = registeredAgents().map(agent => ({
    ...agent,
    lastTurn: seen.get(agent.name)?.lastTurn ?? 0,
    holdsTurn: seen.get(agent.name)?.holdsTurn === true
  }));
  const turn = state?.turn || null;
  console.log(JSON.stringify({
    ok: true,
    app: APP_NAME,
    project: process.cwd(),
    records: recordsDir,
    server: live ? { running: true, url: base, pid: health.pid, broadcast: health.broadcast === true } : { running: false },
    agents,
    turn,
    entryCount: state?.entryCount ?? null,
    outline: state?.outline ?? null,
    pin: state?.pin ?? null,
    recent: recent?.entries || [],
    next: statusHint(live, agents, turn)
  }, null, 2));
}

function agentTokenFrom(flags) {
  const token = typeof flags.token === 'string' ? flags.token : process.env.INEEDBETTERUI_TOKEN;
  if (!token) {
    throw new Error(`No agent token. Register once with "${APP_NAME} register --model <your model>", then pass --token or set INEEDBETTERUI_TOKEN.`);
  }
  return token;
}

async function send(route, payload, token) {
  const { base, recordsDir } = await runningBase();
  const heads = token ? headStore(recordsDir) : null;
  const head = heads?.get(token);
  if (head && payload.knownHead === undefined) payload.knownHead = head;
  const response = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(token ? { 'X-Ineedbetterui-Agent': token } : {}) },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (heads && data?.sync?.head) heads.set(token, data.sync.head);
  console.log(JSON.stringify(data, null, 2));
  if (!response.ok) process.exitCode = 1;
}

async function register(argv) {
  const { flags } = readFlags(argv);
  const model = typeof flags.model === 'string' ? flags.model : null;
  if (!model) throw new Error('register needs --model <the model you run as>, for example --model claude-opus-5.');
  await send('/api/agents', { model }, null);
}

function turnFrom(flags) {
  const turn = Number(flags.turn);
  if (!Number.isInteger(turn) || turn < 1) {
    throw new Error("record needs --turn <n>: the position of the user's message in the conversation, counted from 1.");
  }
  return turn;
}

async function record(argv) {
  const { flags, rest } = readFlags(argv);
  const kind = rest[0];
  if (!kind) throw new Error('record needs a kind: question, report, decision, error, done or other.');
  const payload = { kind, turn: turnFrom(flags) };
  if (typeof flags.heading === 'string') payload.heading = flags.heading;
  if (typeof flags.clientRef === 'string') payload.clientRef = flags.clientRef;
  if (kind === 'question') {
    const raw = readContent(flags, 'raw', 'rawFile');
    const cleaned = readContent(flags, 'cleaned', 'cleanedFile');
    if (raw === undefined || cleaned === undefined) {
      throw new Error("A question needs the user's words and your cleaned version: --raw <text> or --rawFile <path>, and --cleaned <text> or --cleanedFile <path>.");
    }
    payload.rawBody = raw;
    payload.cleanedBody = cleaned;
  } else {
    const body = readContent(flags, 'text', 'file') ?? (rest.length > 1 ? rest.slice(1).join(' ') : undefined);
    if (body === undefined) throw new Error('A reply needs --file <path> (- for standard input) or --text "...".');
    payload.body = body;
  }
  await send('/api/entries', payload, agentTokenFrom(flags));
}

async function progress(argv) {
  const { flags, rest } = readFlags(argv);
  const text = readContent(flags, 'text', 'file') ?? rest.join(' ');
  if (!text.trim()) throw new Error('progress needs what you are doing: progress --turn <n> "reading the outline code".');
  await send('/api/progress', { text, turn: turnFrom(flags) }, agentTokenFrom(flags));
}

function help() {
  console.log(`${APP_NAME} ${packageJson.version}

Usage:
  ${APP_NAME} [--no-broadcast]   Start (or reuse) the server for the project in this folder
  ${APP_NAME} stop               Stop the server for the project in this folder
  ${APP_NAME} status             Server, registered agents, open turn and recent entries
  ${APP_NAME} register --model M         Get an agent name and token for this session
  ${APP_NAME} record <kind> --turn N ... Record a question or a reply
  ${APP_NAME} progress --turn N "..."    Say what you are doing (not recorded)
  ${APP_NAME} install            Register the skill for Codex and Claude Code
  ${APP_NAME} uninstall          Remove the skill (transcripts stay in each project)
  ${APP_NAME} --version | --help

Transcripts are kept in <project>/node_modules/.${APP_NAME}/.
Use the skill in an agent session: Codex "$${APP_NAME}", Claude Code "/${APP_NAME}".`);
}

const [command] = process.argv.slice(2);

try {
  if (command === '--version' || command === '-v') {
    console.log(packageJson.version);
  } else if (command === '--help' || command === '-h' || command === 'help') {
    help();
  } else if (command === 'install') {
    install();
  } else if (command === 'uninstall') {
    uninstall();
  } else if (command === 'stop') {
    await stop();
  } else if (command === 'status') {
    await status();
  } else if (command === 'register') {
    await register(process.argv.slice(3));
  } else if (command === 'record') {
    await record(process.argv.slice(3));
  } else if (command === 'progress') {
    await progress(process.argv.slice(3));
  } else if (command === 'postinstall') {
    // npm runs this after every install. Register skills only for global installs,
    // and never fail the npm install because of it.
    if (process.env.npm_config_global === 'true') {
      try {
        install();
      } catch (error) {
        console.warn(`[${APP_NAME}] Skill registration failed: ${error.message}\nRun "${APP_NAME} install" to retry.`);
      }
    }
  } else if (command === undefined || command === 'start' || command.startsWith('--')) {
    await import(pathToFileURL(serverPath).href);
  } else {
    help();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
