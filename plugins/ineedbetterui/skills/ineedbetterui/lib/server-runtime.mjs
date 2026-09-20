import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { makeQrCode } from './qr.mjs';

const HEALTH_TIMEOUT_MS = 600;
const START_LOCK_STALE_MS = 10_000;
const START_LOCK_WAIT_MS = 100;
const START_LOCK_TRIES = 150;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createServerRuntime({
  appName, sessionId, sessionDir, dataPath, initialBroadcastMode,
  requestHandler, ensureSessionDir, nowIso, appendEvent, projectInfoStore
}) {
  const { legacyInfoFiles, openPageHtml, openPagePath, readProjectInfo, removeFile, writeProjectInfo } = projectInfoStore;
  let broadcastMode = initialBroadcastMode;
  const accessToken = createHash('sha256').update(`${sessionId}:${process.pid}:${Date.now()}:${Math.random()}`).digest('base64url').slice(0, 16);
  let serverPort = null;
  let httpServer = null;
  let broadcastInfo = null;

  const state = () => ({ accessToken, broadcastInfo, broadcastMode, serverPort });
  const setBroadcastMode = value => { broadcastMode = value; };

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
    return broadcastMode
      ? `http://${broadcastHostAddress()}:${port}/?t=${accessToken}`
      : `http://127.0.0.1:${port}/`;
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
            finish(response.statusCode === 200 && health.app === appName ? health : null);
          } catch { finish(null); }
        });
      });
      request.on('error', () => finish(null));
      request.on('timeout', () => { request.destroy(); finish(null); });
    });
  }

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
      broadcastMode = !on;
      updateBroadcastInfo();
      appendEvent({
        t: 'broadcast', time: nowIso(), enabled: broadcastMode,
        url: broadcastInfo ? broadcastInfo.url : null,
        port: serverPort, error: error.message
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

  function projectPort() {
    return 40_000 + (Number.parseInt(sessionId.slice(0, 8), 16) % 20_000);
  }

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

  async function chooseServer() {
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

  function cleanUpOnExit() {
    process.on('exit', () => {
      try { if (readProjectInfo()?.server?.pid === process.pid) writeProjectInfo(null); } catch {}
      try { if (fs.readFileSync(openPagePath(), 'utf8').includes(`data-pid="${process.pid}"`)) removeFile(openPagePath()); } catch {}
    });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
      process.on(signal, () => process.exit(0));
    }
  }

  async function start() {
    ensureSessionDir();
    const release = await acquireStartLock();
    let started;
    try {
      started = await chooseServer();
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
      console.log(`${appName} already running on http://127.0.0.1:${started.running.port}/`);
      return;
    }
    console.log(`${appName} listening on http://127.0.0.1:${serverPort}/`);
    console.log(`records ${dataPath}`);
    if (broadcastMode) {
      updateBroadcastInfo();
      console.log(`broadcast access on ${broadcastInfo.url}`);
    }
  }

  return { applyBroadcast, broadcastHostAddress, isLoopbackRequest, setBroadcastMode, start, state, updateBroadcastInfo };
}
