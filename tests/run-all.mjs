import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = ['sync-test.mjs', 'render-test.mjs', 'core-test.mjs', 'cli-test.mjs'];
const failed = [];

for (const suite of suites) {
  console.log(`===== ${suite} =====`);
  const result = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit' });
  if (result.status !== 0) failed.push(suite);
}

console.log(failed.length ? `\nFailed: ${failed.join(', ')}` : '\nAll test suites passed.');
process.exit(failed.length ? 1 : 0);
