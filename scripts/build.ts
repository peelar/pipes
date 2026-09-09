#!/usr/bin/env bun
// Builds the distributable single binary. Host platform by default;
// `--all` cross-compiles every supported target for a GitHub release.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
};
const asset = (target: string) => `pipes-${target.replace(/^bun-/, '')}`;
const argv = process.argv.slice(2);
const all = argv.includes('--all');
const targetFlag = argv.indexOf('--target');
const single = targetFlag >= 0 ? argv[targetFlag + 1] : undefined;
const known = [
  'bun-darwin-arm64',
  'bun-darwin-x64-baseline',
  'bun-linux-x64-baseline',
  'bun-linux-arm64',
];
const targets = all ? known : single ? [single] : [];
if (single && !known.includes(single)) {
  process.stderr.write(`Unknown target ${single}.\n`);
  process.exit(1);
}
const jobs =
  targets.length > 0
    ? targets.map((target) => ({
        args: ['--target', target],
        outfile: join(root, 'dist', asset(target)),
      }))
    : [{ args: [], outfile: join(root, 'dist', 'pipes') }];
mkdirSync(join(root, 'dist'), { recursive: true });
for (const { args, outfile } of jobs) {
  const result = spawnSync(
    'bun',
    [
      'build',
      join(root, 'src/main.ts'),
      '--compile',
      ...args,
      '--define',
      `process.env.PIPES_VERSION=${JSON.stringify(version)}`,
      '--outfile',
      outfile,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
