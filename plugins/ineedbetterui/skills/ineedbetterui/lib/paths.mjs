// Project folder rules shared by the server and the ineedbetterui command, so
// both always find the same records folder and running server.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const APP_NAME = 'ineedbetterui';

export function realProjectPath(folder) {
  return fs.realpathSync.native(folder);
}

// A stable ID for the project folder: lets a new start recognise the server
// already running for this project.
export function sessionIdFor(folder) {
  const real = realProjectPath(folder);
  return createHash('sha256').update(process.platform === 'win32' ? real.toLowerCase() : real).digest('hex').slice(0, 12);
}

// Records live inside the project, in node_modules/.ineedbetterui. Most projects
// already ignore node_modules, and the folder's own .gitignore covers the rest.
export function recordsDirFor(folder) {
  return path.join(realProjectPath(folder), 'node_modules', `.${APP_NAME}`);
}
