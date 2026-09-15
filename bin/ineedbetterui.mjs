#!/usr/bin/env node
// Command-line entry of the ineedbetterui npm package: starts the transcript
// server and registers the skill for Codex and Claude Code.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_NAME = 'ineedbetterui';
const INSTALL_MARKER = '.ineedbetterui-install.json';
const HEALTH_TIMEOUT_MS = 600;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const skillSource = path.join(packageRoot, 'plugins', APP_NAME, 'skills', APP_NAME);
const serverPath = path.join(skillSource, `${APP_NAME}.mjs`);

// Must match the records folder rules in the server.
function recordsDirFor(folder) {
  return path.join(fs.realpathSync.native(folder), 'node_modules', `.${APP_NAME}`);
}

// Must match the session ID rules in the server.
function sessionIdFor(folder) {
  const real = fs.realpathSync.native(folder);
  return createHash('sha256').update(process.platform === 'win32' ? real.toLowerCase() : real).digest('hex').slice(0, 12);
}

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
  fs.cpSync(skillSource, target.dir, { recursive: true });
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
  const files = fs.existsSync(recordsDir) ? fs.readdirSync(recordsDir).filter(name => /^server-\d+\.html$/.test(name)) : [];
  let stopped = 0;
  for (const name of files) {
    const port = Number(/^server-(\d+)\.html$/.exec(name)[1]);
    const health = await checkHealth(port);
    if (health?.sessionId === sessionId) {
      try {
        process.kill(health.pid);
        stopped += 1;
        console.log(`Stopped the ${APP_NAME} server for this folder (PID ${health.pid}, port ${port}).`);
      } catch (error) {
        console.log(`Could not stop PID ${health.pid}: ${error.message}`);
        continue;
      }
    }
    fs.rmSync(path.join(recordsDir, name), { force: true });
  }
  if (!stopped) console.log(`No running ${APP_NAME} server was found for this folder.`);
}

function help() {
  console.log(`${APP_NAME} ${packageJson.version}

Usage:
  ${APP_NAME} [--no-broadcast]   Start (or reuse) the server for the project in this folder
  ${APP_NAME} stop               Stop the server for the project in this folder
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
