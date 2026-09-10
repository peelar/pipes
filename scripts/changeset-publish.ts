#!/usr/bin/env bun
// Publishes a pipes release by tagging v<version> from packages/pipes/package.json.
// Runs as the changesets `publish` step: after a Release PR merges, the version is
// bumped and this pushes the matching tag, which triggers release.yml to build
// binaries and create the GitHub Release. Idempotent: ordinary pushes with no new
// version find the tag already on the remote and do nothing.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const run = (args: Array<string>, allowFailure = false): string => {
  const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure) {
    process.stderr.write(
      `${result.stderr || result.stdout || `command failed: ${args.join(' ')}`}\n`,
    );
    process.exit(result.status ?? 1);
  }
  return (result.stdout ?? '').trim();
};

const root = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'packages/pipes/package.json'), 'utf8')) as {
  version: string;
};
const tag = `v${version}`;

const remoteTags = run(['git', 'ls-remote', '--tags', 'origin', tag], true);
if (remoteTags.includes(`refs/tags/${tag}`)) {
  process.stdout.write(`Tag ${tag} already exists; nothing to release.\n`);
  process.exit(0);
}
run([
  'git',
  '-c',
  'user.name=github-actions[bot]',
  '-c',
  'user.email=41898282+github-actions[bot]@users.noreply.github.com',
  'tag',
  tag,
]);
run(['git', 'push', 'origin', tag]);
process.stdout.write(`Pushed ${tag}; the release workflow takes it from here.\n`);
