import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const serverScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'ineedbetterui', 'skills', 'ineedbetterui', 'ineedbetterui.mjs');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function startServer(cwd, args = ['--no-broadcast'], { env = process.env, children, timeout = 15_000 } = {}) {
  const child = spawn(process.execPath, [serverScript, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (children) children.push(child);
  let text = '';
  let settled = false;
  let timer;
  let resolveReady;
  let rejectReady;
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('server did not start: ' + text));
    }, timeout);
  });
  const inspect = chunk => {
    text += chunk;
    if (settled) return;
    const announced = /(?:listening on|already running on) http:\/\/127\.0\.0\.1:\d+\//.test(text);
    const broadcastReady = !args.includes('--broadcast') || /broadcast access on/.test(text);
    if (announced && broadcastReady) {
      settled = true;
      clearTimeout(timer);
      resolveReady(text);
    }
  };
  child.stdout.on('data', inspect);
  child.stderr.on('data', inspect);
  exited.then(() => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveReady(text);
  }, rejectReady);
  const url = () => /(?:listening on|already running on) (http:\/\/127\.0\.0\.1:\d+)/.exec(text)?.[1];
  return { child, ready, exited, output: () => text, url, port: () => Number(new URL(url()).port) };
}

export async function stopServer(server, settleMs = 0) {
  if (server.child.exitCode === null) {
    server.child.kill();
    await server.exited;
  }
  if (settleMs) await sleep(settleMs);
}
