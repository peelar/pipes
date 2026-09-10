import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Child processes must re-invoke this Pipes installation, never a source path.
// In development the entry source exists on disk and children spawn through it
// (`bun src/main.ts …`). In a compiled binary the sources are embedded, so the
// binary invokes itself with no script argument.
const entrySource = (() => {
  try {
    return fileURLToPath(new URL('./main.ts', import.meta.url));
  } catch {
    return undefined;
  }
})();
const entryPrefix = entrySource && existsSync(entrySource) ? [entrySource] : [];

/** How to spawn this Pipes installation as a child process. */
export const selfCommand = (args: ReadonlyArray<string>) => ({
  args: [...entryPrefix, ...args],
  executable: process.execPath,
});

/** True when running from a source checkout instead of a compiled binary. */
export const isSourceCheckout = entryPrefix.length > 0;
