import { expect, test } from 'bun:test';
import { Effect } from 'effect';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeConfig } from './config';

// Configuration compatibility contract (see docs/design.md): user-owned
// `.pipes/*.ts` files are never rewritten, so every historical shape must
// keep decoding into the current Config. These fixtures are immutable: a
// schema change adds a fixture, it never edits an old one. If a change makes
// a fixture fail, the change is breaking and needs a deprecation path, not a
// fixture edit.

const step = {
  agent: { model: 'gpt-5.6-sol', provider: 'codex', reasoning: 'low' },
  name: 'plan',
  prompt: 'Read the task and repository. Write an actionable implementation plan.',
};
const workflows = { 'plan-implement-review': { steps: [step] } };

test('v1 GitHub policy without routes keeps working and gains no defaults', async () => {
  const decoded = await Effect.runPromise(
    decodeConfig({
      github: {
        assigned_to_me: true,
        repository: 'owner/repo',
        state: 'open',
        workflow: 'plan-implement-review',
      },
      workflows,
    }),
  );
  expect(decoded.github).toEqual({
    assigned_to_me: true,
    repository: 'owner/repo',
    state: 'open',
    workflow: 'plan-implement-review',
  });
});

test('minimal v1 GitHub policy with only repository and workflow keeps working', async () => {
  const decoded = await Effect.runPromise(
    decodeConfig({
      github: { repository: 'owner/repo', workflow: 'plan-implement-review' },
      workflows,
    }),
  );
  expect(decoded.github).toEqual({
    repository: 'owner/repo',
    workflow: 'plan-implement-review',
  });
});

test('v2 GitHub policy with routes and inbox fallback decodes', async () => {
  const decoded = await Effect.runPromise(
    decodeConfig({
      github: {
        repository: 'owner/repo',
        routes: [
          { labels: ['bug'], workflow: 'fix' },
          { assigned_to_me: false, labels: ['proposal'] },
        ],
      },
      workflows: { ...workflows, fix: workflows['plan-implement-review'] },
    }),
  );
  expect(decoded.github).toEqual({
    repository: 'owner/repo',
    routes: [
      { labels: ['bug'], workflow: 'fix' },
      { assigned_to_me: false, labels: ['proposal'] },
    ],
  });
});

test('stored run snapshots embed Config, so they ride the same additive guarantee', async () => {
  // A run persisted before routes existed must still decode today.
  const decoded = await Effect.runPromise(
    decodeConfig({
      github: { repository: 'owner/repo', workflow: 'plan-implement-review' },
      workflows,
    }),
  );
  expect(decoded.github?.routes).toBeUndefined();
  expect(decoded.github?.workflow).toBe('plan-implement-review');
});

test('decodeConfig is the only Config decoder outside its own module', async () => {
  // Normalization lives in one place. Decoding the Config schema directly
  // bypasses it, so flag new direct uses. Type-level references
  // (`Effect<Config>`, `typeof Config.Type`) are fine; only decoder calls
  // that take the Config schema are violations.
  const root = join(import.meta.dirname, '..', '..', '..');
  const direct = new RegExp(
    String.raw`decode\w*\(\s*(?:Schema\.fromJsonString\(Config\)|Config\b)`,
  );
  const violations: Array<string> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        path !== join(root, 'packages/protocol/src/config.ts')
      ) {
        const lines = (await readFile(path, 'utf8')).split('\n');
        lines.forEach((line, index) => {
          if (direct.test(line)) {
            violations.push(`${path}:${index + 1}`);
          }
        });
      }
    }
  };
  await walk(join(root, 'packages'));
  expect(violations).toEqual([]);
});
