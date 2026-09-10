import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Child processes must re-invoke this Pipes installation, never a source path.
// In development the entry source lives at <root>/src/main.ts; this module
// finds it by searching upward so the lookup survives file moves. In a
// compiled binary the sources are embedded (no on-disk entry), so the binary
// invokes itself with no script argument.
const entrySource = (() => {
  try {
    let directory = import.meta.dirname;
    for (let depth = 0; depth < 8; depth++) {
      const candidate = join(directory, 'src/main.ts');
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = dirname(directory);
      if (parent === directory) {
        return undefined;
      }
      directory = parent;
    }
    return undefined;
  } catch {
    return undefined;
  }
})();
const entryPrefix = entrySource ? [entrySource] : [];

/** How to spawn this Pipes installation as a child process. */
export const selfCommand = (args: ReadonlyArray<string>) => ({
  args: [...entryPrefix, ...args],
  executable: process.execPath,
});

/** True when running from a source checkout instead of a compiled binary. */
export const isSourceCheckout = entryPrefix.length > 0;
