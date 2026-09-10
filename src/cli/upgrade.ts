import { Console, Effect, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { realpathSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { ensureServer } from '../client/connection';
import { Client } from '@pipes/protocol';
import { PipesError } from '@pipes/protocol';
import { isSourceCheckout } from '../self';
import { version } from '../version';
import { connection } from './connection';

/** Release asset name for a platform, matching scripts/install.sh. */
export const assetForPlatform = (platform: string, arch: string): string | undefined => {
  switch (`${platform}-${arch}`) {
    case 'darwin-arm64':
      return 'pipes-darwin-arm64';
    case 'darwin-x64':
      return 'pipes-darwin-x64-baseline';
    case 'linux-x64':
      return 'pipes-linux-x64-baseline';
    case 'linux-arm64':
      return 'pipes-linux-arm64';
    default:
      return undefined;
  }
};

export const parseTag = (tag: string): string => tag.replace(/^v/, '');

const parseVersion = (value: string) => {
  const [core = '', pre] = value.replace(/^v/, '').split('-');
  return { parts: core.split('.').map(Number), pre };
};

/** Negative when current is older, positive when newer, zero when equal. */
export const compareVersions = (current: string, latest: string): number => {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  const length = Math.max(a.parts.length, b.parts.length);
  for (let index = 0; index < length; index++) {
    const diff = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (Number.isNaN(diff)) {
      return current < latest ? -1 : 1;
    }
    if (diff !== 0) {
      return Math.sign(diff);
    }
  }
  if (a.pre === b.pre) {
    return 0;
  }
  if (a.pre === undefined) {
    return 1;
  }
  if (b.pre === undefined) {
    return -1;
  }
  return a.pre < b.pre ? -1 : 1;
};

const Release = Schema.Struct({ tag_name: Schema.NonEmptyString });

export const fetchLatestTag = Effect.fn('upgrade.latestTag')(function* (apiUrl: string) {
  const release = yield* Effect.tryPromise({
    catch: (error) => new PipesError({ message: `Cannot reach ${apiUrl}: ${String(error)}` }),
    try: async () => {
      const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
      if (process.env.GITHUB_TOKEN) {
        headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      }
      const response = await fetch(apiUrl, { headers });
      if (!response.ok) {
        throw new Error(`GitHub API responded with ${response.status}.`);
      }
      return await response.json();
    },
  });
  const tag = yield* Schema.decodeUnknownEffect(Release)(release).pipe(
    Effect.mapError(() => new PipesError({ message: `Unexpected release data from ${apiUrl}.` })),
    Effect.map(({ tag_name }) => tag_name),
  );
  if (!/^v?\d+\.\d+\.\d+/.test(tag)) {
    return yield* new PipesError({ message: `Unexpected release tag ${tag} from ${apiUrl}.` });
  }
  return tag;
});

export const swapBinary = Effect.fn('upgrade.swap')(function* (url: string, executable: string) {
  const body = yield* Effect.tryPromise({
    catch: (error) => new PipesError({ message: `Download failed: ${String(error)}` }),
    try: async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`GitHub responded with ${response.status} for ${url}.`);
      }
      return await response.arrayBuffer();
    },
  });
  const temporary = `${executable}.new-${process.pid}`;
  yield* Effect.tryPromise({
    catch: (error) => new PipesError({ message: `Cannot replace ${executable}: ${String(error)}` }),
    try: async () => {
      try {
        await writeFile(temporary, Buffer.from(body), { mode: 0o755 });
        await rename(temporary, executable);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    },
  });
  if (process.platform === 'darwin') {
    try {
      Bun.spawnSync(['xattr', '-d', 'com.apple.quarantine', executable]);
    } catch {
      // Best effort; curl-installed binaries usually carry no quarantine flag.
    }
  }
});

export const performUpgrade = Effect.fn('upgrade.perform')(function* (input: {
  arch: string;
  assetBase: string;
  check: boolean;
  currentVersion: string;
  executable: string;
  platform: string;
  tag: string;
}) {
  const asset = assetForPlatform(input.platform, input.arch);
  if (!asset) {
    return yield* new PipesError({
      message: `No Pipes binary for ${input.platform}-${input.arch} (macOS and Linux only; Windows users can use WSL).`,
    });
  }
  const latest = parseTag(input.tag);
  const comparison = compareVersions(input.currentVersion, latest);
  if (comparison >= 0) {
    return { latest, status: 'up-to-date' as const };
  }
  if (input.check) {
    return { latest, status: 'available' as const };
  }
  yield* swapBinary(`${input.assetBase}/${input.tag}/${asset}`, input.executable);
  return { latest, status: 'upgraded' as const };
});

export const upgrade = Command.make(
  'upgrade',
  {
    check: Flag.boolean('check').pipe(
      Flag.withDefault(false),
      Flag.withDescription('Only check for updates'),
    ),
  },
  Effect.fn(function* ({ check }) {
    if (isSourceCheckout) {
      return yield* new PipesError({
        message:
          'Upgrade runs from an installed binary. From source, use git pull and bun run build.',
      });
    }
    const executable = yield* Effect.try({
      catch: () => new PipesError({ message: 'Cannot locate the installed binary.' }),
      try: () => realpathSync(process.execPath),
    });
    const repo = process.env.PIPES_REPO ?? 'peelar/pipes';
    const tag = yield* fetchLatestTag(`https://api.github.com/repos/${repo}/releases/latest`);
    const running = yield* ensureServer(connection, false).pipe(
      Effect.as(true),
      Effect.catchTag('PipesError', (error) =>
        error.message === 'pipes server is not running.'
          ? Effect.succeed(false)
          : Effect.fail(error),
      ),
    );
    const result = yield* performUpgrade({
      arch: process.arch,
      assetBase: `https://github.com/${repo}/releases/download`,
      check,
      currentVersion: version,
      executable,
      platform: process.platform,
      tag,
    });
    if (result.status === 'up-to-date') {
      yield* Console.log(`Already up to date (pipes ${version}).`);
    } else if (result.status === 'available') {
      yield* Console.log(
        `Update available: ${result.latest} (current ${version}). Run pipes upgrade to install it.`,
      );
    } else {
      yield* Console.log(`Upgraded to ${result.latest}.`);
      if (running) {
        const client = yield* Client;
        yield* client.shutdown();
        yield* ensureServer(connection);
        yield* Console.log('Server restarted.');
      }
    }
  }),
).pipe(Command.withDescription('Upgrade the installed binary to the latest release'));
