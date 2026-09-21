import fs from 'node:fs';

// Windows refuses to remove a directory that a process still holds as its
// working directory, and a killed server takes a moment to let go: a suite that
// spawned servers inside its temp folder can fail to delete it right after
// killing them. Losing a temp folder costs nothing; failing a run that passed
// every check costs an afternoon, so this retries and then gives up out loud.
export async function removeTemp(dir, { attempts = 15, waitMs = 200 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (attempt === attempts) {
        console.log(`(could not remove ${dir}: ${error.code}; it is only a temporary folder)`);
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
  return false;
}
