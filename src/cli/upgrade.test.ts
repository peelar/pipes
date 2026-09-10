import { expect, test } from 'bun:test';
import { Effect } from 'effect';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assetForPlatform,
  compareVersions,
  fetchLatestTag,
  parseTag,
  performUpgrade,
  swapBinary,
} from './upgrade';

test('asset names match install.sh for supported platforms', () => {
  expect(assetForPlatform('darwin', 'arm64')).toBe('pipes-darwin-arm64');
  expect(assetForPlatform('darwin', 'x64')).toBe('pipes-darwin-x64-baseline');
  expect(assetForPlatform('linux', 'x64')).toBe('pipes-linux-x64-baseline');
  expect(assetForPlatform('linux', 'arm64')).toBe('pipes-linux-arm64');
  expect(assetForPlatform('win32', 'x64')).toBeUndefined();
});

test('version comparison orders releases and strips tags', () => {
  expect(parseTag('v0.0.2')).toBe('0.0.2');
  expect(parseTag('0.0.2')).toBe('0.0.2');
  expect(compareVersions('0.0.1', '0.0.2')).toBeLessThan(0);
  expect(compareVersions('0.0.2', '0.0.2')).toBe(0);
  expect(compareVersions('0.1.0', '0.0.9')).toBeGreaterThan(0);
  expect(compareVersions('v0.0.1', '0.0.2')).toBeLessThan(0);
  expect(compareVersions('1.2', '1.2.0')).toBe(0);
  expect(compareVersions('1.0.0-dev', '1.0.0')).toBeLessThan(0);
});

test('latest tag reads the release API and rejects bad responses', async () => {
  const ok = Bun.serve({
    fetch: () => Response.json({ tag_name: 'v9.9.9' }),
    port: 0,
  });
  try {
    expect(await Effect.runPromise(fetchLatestTag(`http://127.0.0.1:${ok.port}/latest`))).toBe(
      'v9.9.9',
    );
  } finally {
    await ok.stop(true);
  }
  const broken = Bun.serve({ fetch: () => new Response('nope', { status: 500 }), port: 0 });
  try {
    await expect(
      Effect.runPromise(fetchLatestTag(`http://127.0.0.1:${broken.port}/latest`)),
    ).rejects.toThrow('500');
  } finally {
    await broken.stop(true);
  }
});

test('binary swap replaces the executable and keeps it runnable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pipes-upgrade-'));
  const executable = join(directory, 'pipes');
  await writeFile(executable, 'old', { mode: 0o755 });
  const server = Bun.serve({ fetch: () => new Response('new'), port: 0 });
  try {
    await Effect.runPromise(swapBinary(`http://127.0.0.1:${server.port}/asset`, executable));
    expect(await readFile(executable, 'utf8')).toBe('new');
    expect((await stat(executable)).mode & 0o111).toBeGreaterThan(0);
  } finally {
    await server.stop(true);
  }
  const missing = Bun.serve({ fetch: () => new Response('gone', { status: 404 }), port: 0 });
  try {
    await expect(
      Effect.runPromise(swapBinary(`http://127.0.0.1:${missing.port}/asset`, executable)),
    ).rejects.toThrow('404');
    expect(await readFile(executable, 'utf8')).toBe('new');
  } finally {
    await missing.stop(true);
  }
});

test('upgrade reports status without downloading when already current', async () => {
  const unreachable = 'http://127.0.0.1:1';
  const current = await Effect.runPromise(
    performUpgrade({
      arch: 'arm64',
      assetBase: unreachable,
      check: false,
      currentVersion: '0.0.2',
      executable: join(tmpdir(), 'pipes-test-never-touched'),
      platform: 'darwin',
      tag: 'v0.0.2',
    }),
  );
  expect(current).toEqual({ latest: '0.0.2', status: 'up-to-date' });
  const available = await Effect.runPromise(
    performUpgrade({
      arch: 'arm64',
      assetBase: unreachable,
      check: true,
      currentVersion: '0.0.1',
      executable: join(tmpdir(), 'pipes-test-never-touched'),
      platform: 'darwin',
      tag: 'v0.0.2',
    }),
  );
  expect(available).toEqual({ latest: '0.0.2', status: 'available' });
  await expect(
    Effect.runPromise(
      performUpgrade({
        arch: 'x64',
        assetBase: unreachable,
        check: false,
        currentVersion: '0.0.1',
        executable: join(tmpdir(), 'pipes-test-never-touched'),
        platform: 'win32',
        tag: 'v0.0.2',
      }),
    ),
  ).rejects.toThrow('No Pipes binary for win32-x64');
});

test('upgrade downloads and swaps when an update applies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pipes-upgrade-'));
  const executable = join(directory, 'pipes');
  await writeFile(executable, 'old', { mode: 0o755 });
  const server = Bun.serve({ fetch: () => new Response('new'), port: 0 });
  try {
    const result = await Effect.runPromise(
      performUpgrade({
        arch: 'arm64',
        assetBase: `http://127.0.0.1:${server.port}`,
        check: false,
        currentVersion: '0.0.1',
        executable,
        platform: 'darwin',
        tag: 'v0.0.2',
      }),
    );
    expect(result).toEqual({ latest: '0.0.2', status: 'upgraded' });
    expect(await readFile(executable, 'utf8')).toBe('new');
  } finally {
    await server.stop(true);
  }
});
