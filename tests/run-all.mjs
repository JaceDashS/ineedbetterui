import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = ['docs-test.mjs', 'sync-test.mjs', 'render-test.mjs', 'core-test.mjs', 'cli-test.mjs'];
const failed = [];

for (const suite of suites) {
  console.log(`===== ${suite} =====`);
  const result = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit' });
  // A suite that ends any way but 0 names how it ended: a signal or a missing
  // status says the process was torn down, which its own output never shows.
  if (result.status !== 0) failed.push(`${suite} (${result.signal ? 'signal ' + result.signal : 'exit ' + result.status})`);
}

console.log(failed.length ? `\nFailed: ${failed.join(', ')}` : '\nAll test suites passed.');
process.exit(failed.length ? 1 : 0);
