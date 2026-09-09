import { expect, test } from 'bun:test';
import { BunServices } from '@effect/platform-bun';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import example from '../../.pipes/pipes';
import { decodeConfig, githubRepository } from '../config';
import { GitHub, eligible, validSignature } from './github';
import { Store } from './store';

const issue = {
  assignees: [{ id: 7 }],
  body: 'Original request',
  id: 10,
  number: 1,
  state: 'open' as const,
  title: 'Fix this',
};
const policy = { repository: 'owner/repo', workflow: 'plan-implement-review' };
const git = async (...args: Array<string>) => {
  expect(await Bun.spawn(['git', ...args], { stderr: 'ignore', stdout: 'ignore' }).exited).toBe(0);
};

test('GitHub connection validates remotes, preserves config, imports, and reuses managed clones', async () => {
  for (const input of [
    'owner/repo',
    'https://github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
    'ssh://git@github.com/owner/repo',
  ]) {
    expect(githubRepository(input)).toBe('owner/repo');
  }
  for (const input of [
    '../repo',
    'owner/..',
    'https://evil.test/owner/repo',
    'https://github.com/owner/repo/issues',
    '-bad/repo',
    'owner/repo?token=secret',
  ]) {
    expect(() => githubRepository(input)).toThrow();
  }
  const directory = await mkdtemp(join(tmpdir(), 'pipes-github-connect-'));
  const source = join(directory, 'source');
  const oldToken = process.env.GH_TOKEN;
  const oldGitConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GH_TOKEN = 'test-only-token';
  process.env.GIT_CONFIG_GLOBAL = join(directory, 'gitconfig');
  const fetchMock = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : input);
    if (url.pathname === '/user') {
      return Response.json({ id: 7, login: 'me' });
    }
    return Response.json(url.pathname.endsWith('/issues') ? [issue] : { full_name: 'owner/repo' });
  }) as typeof fetch;
  const runtime = ManagedRuntime.make(
    GitHub.layer.pipe(
      Layer.provideMerge(Store.layer(join(directory, 'test.sqlite'))),
      Layer.provide(BunServices.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchMock)),
    ),
  );
  try {
    await mkdir(join(source, '.pipes'), { recursive: true });
    const original = `// Keep this comment and ordinary TypeScript.\nconst config = ${JSON.stringify(example)};\nexport default config;\n`;
    await writeFile(join(source, '.pipes/pipes.ts'), original);
    await writeFile(
      process.env.GIT_CONFIG_GLOBAL,
      `[url "file://${source}"]\n  insteadOf = https://github.com/owner/repo.git\n`,
    );
    await git('init', source);
    await git('-C', source, 'add', '.');
    await git(
      '-C',
      source,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'fixture',
    );
    await git('-C', source, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git');
    await git('-C', source, 'remote', 'add', 'other', 'https://gitlab.com/owner/repo.git');
    const github = await runtime.runPromise(GitHub);
    expect(await runtime.runPromise(github.identity)).toBe('me');
    expect(await runtime.runPromise(github.inspect(source))).toEqual({
      policy: undefined,
      remotes: ['owner/repo'],
      workflows: [policy.workflow],
    });
    const cloned = await runtime.runPromise(github.clone(policy.repository, directory));
    expect(cloned).toBe(join(directory, 'repositories/owner/repo'));
    expect(await readFile(join(cloned, '.pipes/pipes.ts'), 'utf8')).toBe(original);
    expect(await readFile(join(cloned, '.git/config'), 'utf8')).not.toContain('test-only-token');
    expect(await runtime.runPromise(github.clone(policy.repository, directory))).toBe(cloned);
    const repository = await runtime.runPromise(github.attach({ path: cloned, ...policy }));
    expect(await readFile(join(cloned, '.pipes/pipes.ts'), 'utf8')).toBe(original);
    const sidecar = await readFile(join(cloned, '.pipes/github.ts'), 'utf8');
    expect((await runtime.runPromise(github.inspect(cloned))).policy).toEqual(policy);
    expect((await runtime.runPromise(github.attach({ path: cloned, ...policy }))).id).toBe(
      repository.id,
    );
    await expect(
      runtime.runPromise(github.attach({ path: cloned, ...policy, workflow: 'missing' })),
    ).rejects.toThrow('Configure a workflow');
    await expect(
      runtime.runPromise(github.attach({ path: cloned, ...policy, repository: 'owner/another' })),
    ).rejects.toThrow('Existing GitHub policy differs');
    expect(await readFile(join(cloned, '.pipes/github.ts'), 'utf8')).toBe(sidecar);
    const snapshot = await runtime.runPromise(Effect.flatMap(Store, (store) => store.snapshot));
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.workflow).toBe(policy.workflow);
    await writeFile(
      join(cloned, '.pipes/pipes.ts'),
      `export default ${JSON.stringify({ ...example, github: policy })};`,
    );
    await expect(runtime.runPromise(github.inspect(cloned))).rejects.toThrow();
  } finally {
    await runtime.dispose();
    if (oldToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = oldToken;
    }
    if (oldGitConfig === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = oldGitConfig;
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 15_000);

test('GitHub policy defaults to open assigned issues and validates routing', () => {
  expect(eligible(issue, policy, 7)).toBe(true);
  expect(eligible(issue, policy, 8)).toBe(false);
  expect(eligible({ ...issue, state: 'closed' }, policy, 7)).toBe(false);
  expect(eligible({ ...issue, assignees: [] }, { ...policy, assigned_to_me: false }, 7)).toBe(true);
  expect(eligible({ ...issue, state: 'closed' }, { ...policy, state: 'all' }, 7)).toBe(true);
  expect(eligible(issue, { ...policy, state: 'closed' }, 7)).toBe(false);
  expect(
    eligible({ ...issue, pull_request: {} }, { ...policy, assigned_to_me: false, state: 'all' }, 7),
  ).toBe(false);
  for (const github of [
    { ...policy, workflow: 'missing' },
    { ...policy, state: 'typo' },
    { ...policy, assigned_to_me: 'yes' },
  ]) {
    expect(Effect.runSync(Effect.result(decodeConfig({ ...example, github })))._tag).toBe(
      'Failure',
    );
  }
});

test('GitHub import paginates, preserves snapshots across restart and verifies webhook deliveries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pipes-github-'));
  const oldToken = process.env.GH_TOKEN;
  const oldSecret = process.env.PIPES_GITHUB_WEBHOOK_SECRET;
  process.env.GH_TOKEN = 'test-token';
  process.env.PIPES_GITHUB_WEBHOOK_SECRET = 'test-secret';
  let current = { ...issue };
  const requests: Array<string> = [];
  const fetchMock = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : input);
    requests.push(url.pathname + url.search);
    if (url.pathname === '/user') {
      return Response.json({ id: 7, login: 'me' });
    }
    if (url.pathname.endsWith('/issues/1')) {
      return Response.json(current);
    }
    if (url.searchParams.get('page') === '1') {
      return Response.json(Array.from({ length: 100 }, () => current));
    }
    return Response.json([]);
  }) as typeof fetch;
  const makeRuntime = () =>
    ManagedRuntime.make(
      GitHub.layer.pipe(
        Layer.provideMerge(Store.layer(join(directory, 'test.sqlite'))),
        Layer.provide(BunServices.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchMock)),
      ),
    );
  let runtime = makeRuntime();
  try {
    await mkdir(join(directory, '.pipes'));
    await writeFile(
      join(directory, '.pipes/pipes.ts'),
      `export default ${JSON.stringify({ ...example, github: policy })};`,
    );
    expect(
      await Bun.spawn(['git', 'init', directory], { stderr: 'ignore', stdout: 'ignore' }).exited,
    ).toBe(0);
    const repository = await runtime.runPromise(
      Effect.flatMap(Store, (store) => store.register(directory)),
    );
    expect(
      await runtime.runPromise(Effect.flatMap(GitHub, (github) => github.intake(repository.id))),
    ).toBe(100);
    expect(requests[0]).toBe('/user');
    expect(requests.some((path) => path.includes('page=2'))).toBe(true);
    expect(requests[1]).toContain('state=open');
    expect(requests[1]).toContain('assignee=me');
    await runtime.dispose();
    runtime = makeRuntime();
    current = { ...issue, body: 'Changed request' };
    const github = await runtime.runPromise(GitHub);
    const body = JSON.stringify({ issue: { number: 1 }, repository: { full_name: 'owner/repo' } });
    const signature = `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`;
    expect(validSignature(body + ' ', signature, 'test-secret')).toBe(false);
    const delivery = (sig: string) =>
      github.webhook(
        new Request('http://localhost/github', {
          body,
          headers: { 'x-github-event': 'issues', 'x-hub-signature-256': sig },
          method: 'POST',
        }),
      );
    expect((await delivery('bad')).status).toBe(403);
    expect((await delivery(signature)).status).toBe(200);
    expect((await delivery(signature)).status).toBe(200);
    const snapshot = await runtime.runPromise(Effect.flatMap(Store, (store) => store.snapshot));
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.transitions).toHaveLength(1);
    expect(snapshot.tasks[0]?.brief).toBe('Original request');
    expect(snapshot.tasks[0]?.sourceUrl).toBe('https://github.com/owner/repo/issues/1');
    expect(snapshot.tasks[0]?.workflow).toBe(policy.workflow);
  } finally {
    await runtime.dispose();
    if (oldToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = oldToken;
    }
    if (oldSecret === undefined) {
      delete process.env.PIPES_GITHUB_WEBHOOK_SECRET;
    } else {
      process.env.PIPES_GITHUB_WEBHOOK_SECRET = oldSecret;
    }
    await rm(directory, { force: true, recursive: true });
  }
});
