#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME, realProjectPath, recordsDirFor, sessionIdFor } from './lib/paths.mjs';
import { ingestLine, loadRuntime, QUESTION_MODES } from './lib/transcript.mjs';
import { nextHint, publicEntry, syncResult, turnBrief } from './lib/sync.mjs';
import { activeOutlineItem, derivedOutline, mergeOutlineEdit, readOutlineInput, stepOutlineStatus } from './lib/outline.mjs';
import { applyPatch, checkOpenTurn, checkQuestionTurn, enforceResponseLimit, readTurnNo, refuseFinal, requiredText, statusError } from './lib/turns.mjs';
import { handleReadRoutes } from './lib/api/read.mjs';
import { handleSettingsRoutes } from './lib/api/settings.mjs';
import { handleOutlineRoutes } from './lib/api/outline.mjs';
import { handleMutationRoutes } from './lib/api/mutations.mjs';
import { createAgentRegistry, USER_NAME } from './lib/agents.mjs';
import { createProjectInfoStore } from './lib/project-info.mjs';
import { createServerRuntime } from './lib/server-runtime.mjs';

const MAX_REQUEST_BYTES = 2_000_000;
const KINDS = new Set(['question', 'report', 'decision', 'error', 'done', 'other']);

const projectPath = realProjectPath(process.cwd());
const sessionId = sessionIdFor(projectPath);
const sessionDir = recordsDirFor(projectPath);
const dataPath = path.join(sessionDir, 'transcript.jsonl');

function ensureSessionDir() {
  fs.mkdirSync(sessionDir, { recursive: true });
  const ignoreFile = path.join(sessionDir, '.gitignore');
  if (!fs.existsSync(ignoreFile)) fs.writeFileSync(ignoreFile, '*\n', 'utf8');
}
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


function readTranscript() {
  return fs.existsSync(dataPath) ? fs.readFileSync(dataPath) : Buffer.alloc(0);
}

let runtime = loadRuntime(readTranscript());

// Returns the new head hash, which is the hash of the event just written.
// Only the new line is parsed and hashed. The server keeps the bytes it
// expects on disk; if the file differs (a hand edit, another process), it is
// replayed in full first. Comparing bytes catches even a same-size edit made
// within the file system's timestamp resolution, which a size or mtime check
// would miss.
function clearProgress(event) {
  if (event.t === 'entry') runtime.progress = null;
}

function appendEvent(event) {
  ensureSessionDir();
  const onDisk = readTranscript();
  if (!onDisk.equals(runtime.fileBytes)) runtime = loadRuntime(onDisk);
  const line = JSON.stringify(event);
  const bytes = Buffer.from(`${line}\n`, 'utf8');
  const headBefore = runtime.head;
  fs.appendFileSync(dataPath, bytes);
  ingestLine(runtime, line);
  clearProgress(event);
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

function writeResponse(res, status, payload, knownHead, ownHash = null, { brief = false } = {}) {
  const sync = syncResult(runtime, knownHead, { ownHash });
  const turn = brief ? { turn: turnBrief(runtime, sync, activeReplyTarget(), activeOutlineItem(runtime.current.outline.items)) } : {};
  return jsonResponse(res, status, { ok: true, ...payload, ...turn, ...outlineVersionField(), state: responseState(res), sync, next: nextHint(runtime, res.writer, sync, activeReplyTarget()) });
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
    outline: derivedOutline(current.outline.items),
    pin: pinTarget ? {
      target: pinTarget.id,
      source: current.pin.source,
      revisionCount: pinTarget.revisions.length,
      replyActive
    } : null,
    turn: { open: turnLocked(), since: current.turn.since, agent: turnLocked() ? current.turn.agent : null, no: turnLocked() ? current.turn.no : null, progress: turnLocked() ? runtime.progress : null },
    questionMode: current.questionMode,
    broadcast: serverRuntime.state().broadcastInfo ? { ...serverRuntime.state().broadcastInfo } : null,
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
  const { outline, broadcast, ...rest } = full;
  return { ...rest, broadcast: broadcast ? { enabled: broadcast.enabled, url: broadcast.url, port: broadcast.port } : null };
}

// The outline's version, only while there is an outline. An agent that sees a
// number different from the one it remembers reads GET /api/outline.
function outlineVersionField() {
  return runtime.current.outline.items.length ? { outlineVersion: runtime.outlineVersion } : {};
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

// A turn is locked from the moment a question is recorded until the reply to
// it, so turns never interleave. One question takes one reply: a reply too long
// for the limit is written shorter, never split in two. A turn nobody closes
// unlocks after TURN_LOCK_MS, so a stopped agent cannot block it for good.
const TURN_LOCK_MS = 10 * 60 * 1000;

function turnLocked() {
  const { turn } = runtime.current;
  return turn.open && Date.now() - Date.parse(turn.since) < TURN_LOCK_MS;
}

function refuseOtherTurn(res) {
  const { turn } = runtime.current;
  if (!turnLocked() || !turn.agent || turn.agent === res.writer) return;
  throw statusError(409, `${turn.agent} is answering this turn, so nothing was recorded. Wait for that reply and record the user's next message as a new question.`);
}

// The outline step a reply belongs to, written down as it is recorded so the
// page can tie the two together. The agent sends nothing for this.
function currentOutlineNo() {
  return activeOutlineItem(runtime.current.outline.items)?.no;
}

const projectInfoStore = createProjectInfoStore({
  appName: APP_NAME, sessionId, projectPath, sessionDir, nowIso
});
const { readProjectInfo, writeProjectInfo } = projectInfoStore;
const { identify, registerAgent } = createAgentRegistry({ readProjectInfo, writeProjectInfo, nowIso });
const serverRuntime = createServerRuntime({
  appName: APP_NAME, sessionId, sessionDir, dataPath,
  initialBroadcastMode: process.argv.slice(2).includes('--broadcast'),
  requestHandler, ensureSessionDir, nowIso, appendEvent, projectInfoStore
});

const OPEN_ROUTES = new Set(['/api/agents']);

const readApiContext = {
  appName: APP_NAME,
  sessionId,
  state: () => ({ runtime, ...serverRuntime.state() }),
  openWatch,
  jsonResponse,
  stateSummary,
  syncResult,
  publicEntry
};

const settingsApiContext = {
  state: serverRuntime.state,
  setBroadcastMode: serverRuntime.setBroadcastMode,
  questionModes: QUESTION_MODES,
  readJson,
  nowIso,
  isLoopbackRequest: serverRuntime.isLoopbackRequest,
  appendEvent,
  updateBroadcastInfo: serverRuntime.updateBroadcastInfo,
  applyBroadcast: serverRuntime.applyBroadcast,
  writeResponse,
  errorResponse
};

const outlineApiContext = {
  runtime: () => runtime,
  readJson,
  jsonResponse,
  errorResponse,
  writeResponse,
  responseState,
  appendEvent,
  nowIso,
  isLoopbackRequest: serverRuntime.isLoopbackRequest,
  derivedOutline,
  readOutlineInput,
  mergeOutlineEdit,
  stepOutlineStatus
};

const mutationApiContext = {
  runtime: () => runtime,
  kinds: KINDS,
  readJson,
  requiredText,
  readTurnNo,
  publicEntry,
  writeResponse,
  turnLocked,
  statusError,
  refuseFinal,
  checkQuestionTurn,
  checkOpenTurn,
  refuseOtherTurn,
  activeReplyTarget,
  enforceResponseLimit,
  currentOutlineNo,
  nowIso,
  appendEvent,
  errorResponse,
  applyPatch,
  currentEntry,
  jsonResponse,
  notifyWatchers,
  responseState,
  pinEntry,
  isLoopbackRequest: serverRuntime.isLoopbackRequest
};

async function handleApi(req, res, url) {
  if (req.method !== 'GET' && !OPEN_ROUTES.has(url.pathname) && !res.writer) {
    return errorResponse(res, 401, 'Say who you are: send the token from POST /api/agents as the X-Ineedbetterui-Agent header. Register once with the model you run as, then send that header with every write.');
  }
  if (req.method === 'POST' && url.pathname === '/api/agents') {
    try {
      const body = await readJson(req);
      if (body.model !== undefined && typeof body.model !== 'string') throw new Error('model must be a string, such as the model you run as.');
      const registered = registerAgent(body.model);
      return jsonResponse(res, 201, { ok: true, ...registered, next: `You are ${registered.agent}. Send token as the X-Ineedbetterui-Agent header with every write, and tell the user this name if they ask who is answering.` });
    } catch (error) {
      return errorResponse(res, 400, error.message);
    }
  }
  if (handleReadRoutes(req, res, url, readApiContext)) return;

  if (await handleSettingsRoutes(req, res, url, settingsApiContext)) return;

  if (await handleMutationRoutes(req, res, url, mutationApiContext)) return;

  if (await handleOutlineRoutes(req, res, url, outlineApiContext)) return;

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
  const { accessToken, broadcastMode } = serverRuntime.state();
  const allowedHosts = new Set(LOCAL_HOSTNAMES);
  if (broadcastMode) allowedHosts.add(serverRuntime.broadcastHostAddress());
  if (!allowedHosts.has(url.hostname)) return 'Host not allowed.';
  // This computer needs no token; anything else must bring the one from the
  // QR code or the shared address. The page itself is served without it: it
  // holds no transcript data and asks for the data with the token it kept.
  if (url.pathname.startsWith('/api/') && !serverRuntime.isLoopbackRequest(req) && url.searchParams.get('t') !== accessToken && req.headers['x-ineedbetterui-token'] !== accessToken) {
    return 'This device needs the access token: open the address from the QR code in the page settings.';
  }
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
      res.writer = identify(req);
      res.fromPage = res.writer === USER_NAME;
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

serverRuntime.start().catch(error => {
  console.error(error.message);
  process.exit(1);
});
