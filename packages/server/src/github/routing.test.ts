import { expect, test } from 'bun:test';
import { BunServices } from '@effect/platform-bun';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import example from '../../../../.pipes/config';
import { decodeConfig } from '@pipes/protocol';
import { GitHub, eligible, routeWorkflow } from '../github';
import { Store } from '../store';

const issue = {
  assignees: [{ id: 7 }],
  body: 'Original request',
  id: 10,
  labels: [],
  number: 1,
  state: 'open' as const,
  title: 'Fix this',
};
const policy = { repository: 'owner/repo', workflow: 'plan-implement-review' };

test('GitHub intake filters by labels and routes issues to workflows', () => {
  const labeled = (names: Array<string>) => ({
    ...issue,
    labels: names.map((name) => ({ name })),
  });
  const routed = {
    ...policy,
    routes: [{ labels: ['bug'], workflow: 'fix' }, { labels: ['proposal'] }],
  };
  const config = {
    ...example,
    github: routed,
    workflows: { ...example.workflows, fix: example.workflows['plan-implement-review']! },
  };
  expect(Effect.runSync(Effect.result(decodeConfig(config)))._tag).toBe('Success');
  for (const github of [
    { ...policy, labels: [] },
    { ...policy, routes: [{ labels: ['bug'], workflow: 'missing' }] },
    { ...policy, routes: [{ labels: ['bug'], typo: true, workflow: 'fix' }] },
  ]) {
    expect(Effect.runSync(Effect.result(decodeConfig({ ...example, github })))._tag).toBe(
      'Failure',
    );
  }
  // Label matching is case-insensitive; every required label must be present.
  expect(eligible(labeled(['Bug']), { ...policy, labels: ['bug'] }, 7)).toBe(true);
  expect(eligible(labeled(['bug', 'urgent']), { ...policy, labels: ['bug', 'urgent'] }, 7)).toBe(
    true,
  );
  expect(eligible(labeled(['bug']), { ...policy, labels: ['bug', 'urgent'] }, 7)).toBe(false);
  expect(eligible(labeled(['bug']), { ...policy, exclude_labels: ['dependencies'] }, 7)).toBe(true);
  expect(
    eligible(labeled(['Dependencies']), { ...policy, exclude_labels: ['dependencies'] }, 7),
  ).toBe(false);
  // First matching route wins; a route without a workflow falls back to the default.
  expect(routeWorkflow(labeled(['bug']), routed, 7)).toBe('fix');
  expect(routeWorkflow(labeled(['proposal']), routed, 7)).toBe(policy.workflow);
  expect(routeWorkflow(issue, routed, 7)).toBe(policy.workflow);
  // Without a default workflow, unmatched and workflow-less routes go to the inbox.
  const inbox = { ...routed, workflow: undefined };
  expect(routeWorkflow(labeled(['proposal']), inbox, 7)).toBe(undefined);
  expect(routeWorkflow(issue, inbox, 7)).toBe(undefined);
  // Ineligible issues are skipped even when routes exist.
  expect(routeWorkflow({ ...issue, assignees: [] }, routed, 7)).toBe(false);
  expect(routeWorkflow({ ...labeled(['bug']), assignees: [] }, routed, 7)).toBe(false);
  // Routes inherit the top-level assignee and state filters unless they override them.
  const open = {
    ...policy,
    routes: [{ labels: ['bug'], state: 'all' as const, workflow: 'fix' }],
  };
  expect(routeWorkflow({ ...labeled(['bug']), state: 'closed' }, open, 7)).toBe('fix');
  expect(routeWorkflow({ ...issue, state: 'closed' }, open, 7)).toBe(false);
});

test('GitHub intake routes labeled issues and broadens polling for open routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pipes-github-routing-'));
  await writeFile(
    join(directory, 'github-token.json'),
    JSON.stringify({ accessToken: 'test-token' }),
    { mode: 0o600 },
  );
  const bug = { ...issue, id: 11, labels: [{ name: 'bug' }], number: 11, title: 'Crash' };
  const proposal = {
    ...issue,
    assignees: [],
    id: 12,
    labels: [{ name: 'proposal' }],
    number: 12,
    title: 'Idea',
  };
  const requests: Array<string> = [];
  const fetchMock = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : input);
    requests.push(url.pathname + url.search);
    if (url.pathname === '/user') {
      return Response.json({ id: 7, login: 'me' });
    }
    if (url.pathname.endsWith('/issues')) {
      return Response.json(url.searchParams.get('page') === '1' ? [bug, proposal] : []);
    }
    return Response.json({ full_name: 'owner/repo' });
  }) as typeof fetch;
  const runtime = ManagedRuntime.make(
    GitHub.layer.pipe(
      Layer.provideMerge(Store.layer(join(directory, 'test.sqlite'))),
      Layer.provide(BunServices.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchMock)),
    ),
  );
  try {
    const fix = example.workflows['plan-implement-review']!;
    await mkdir(join(directory, '.pipes'));
    await writeFile(
      join(directory, '.pipes/config.ts'),
      `export default ${JSON.stringify({
        ...example,
        github: {
          repository: 'owner/repo',
          routes: [
            { labels: ['bug'], workflow: 'fix' },
            { assigned_to_me: false, labels: ['proposal'] },
          ],
          workflow: 'plan-implement-review',
        },
        workflows: { fix, 'plan-implement-review': fix },
      })};`,
    );
    expect(
      await Bun.spawn(['git', 'init', directory], { stderr: 'ignore', stdout: 'ignore' }).exited,
    ).toBe(0);
    const repository = await runtime.runPromise(
      Effect.flatMap(Store, (store) => store.register(directory)),
    );
    expect(
      await runtime.runPromise(Effect.flatMap(GitHub, (github) => github.intake(repository.id))),
    ).toBe(2);
    // One route accepts unassigned issues, so intake cannot narrow by assignee.
    expect(requests.some((path) => path.includes('assignee='))).toBe(false);
    const snapshot = await runtime.runPromise(Effect.flatMap(Store, (store) => store.snapshot));
    expect(snapshot.tasks).toHaveLength(2);
    expect(snapshot.tasks.find((task) => task.title === 'Crash')?.workflow).toBe('fix');
    expect(snapshot.tasks.find((task) => task.title === 'Idea')?.workflow).toBe(
      'plan-implement-review',
    );
  } finally {
    await runtime.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});
