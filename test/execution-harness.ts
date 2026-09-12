import { expect } from 'bun:test';
import { BunServices } from '@effect/platform-bun';
import { Effect, ManagedRuntime, Stream } from 'effect';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Run, type Task } from '@pipes/protocol';
import { serve } from '../src/server';
import { writeCodexFixture } from './codex-fixture';

export const harnessGit = async (cwd: string, ...args: Array<string>) => {
  const child = Bun.spawn(['git', '-C', cwd, ...args], { stderr: 'pipe', stdout: 'pipe' });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return output.trim();
};

export interface Harness {
  call: <A, E>(f: (client: Client['Service']) => Effect.Effect<A, E>) => Promise<A>;
  configure: (mode: string, setup?: Array<string>) => void;
  configureSteps: (mode: string, steps: Array<ConfigurableStep>, setup?: Array<string>) => void;
  connection: { directory: string; port: number; token: string; url: string };
  directory: string;
  dispose: () => Promise<void>;
  reboot: () => Promise<void>;
  reconnect: () => Promise<void>;
  registered: { id: string };
  repository: string;
  runSecondServer: () => Promise<unknown>;
  shutdown: () => Promise<void>;
  submit: () => Promise<Task>;
  waitForRun: (id: string, predicate: (run: Run) => boolean) => Promise<Run>;
}

export interface ConfigurableStep {
  name: string;
  prompt?: string;
  routes?: Record<string, Array<ConfigurableStep>>;
}

export const bootHarness = async (): Promise<Harness> => {
  const directory = mkdtempSync(join(tmpdir(), 'pipes-execution-'));
  const repository = join(directory, 'project');
  mkdirSync(join(repository, '.pipes'), { recursive: true });
  const fixture = writeCodexFixture(directory);
  await harnessGit(repository, 'init');
  await harnessGit(
    repository,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@localhost',
    'commit',
    '--allow-empty',
    '-m',
    'initial',
  );
  const reserve = Bun.serve({ fetch: () => new Response(), port: 0 });
  const port = reserve.port!;
  await reserve.stop(true);
  const connection = { directory, port, token: 'test', url: `http://127.0.0.1:${port}` };
  const serverRuntime = ManagedRuntime.make(BunServices.layer);
  const controller = new AbortController();
  let serving = serverRuntime
    .runPromise(serve(connection).pipe(Effect.scoped), { signal: controller.signal })
    .catch(() => {});
  const clients = { current: ManagedRuntime.make(Client.layer(connection)) };
  const call = <A, E>(f: (client: Client['Service']) => Effect.Effect<A, E>) =>
    clients.current.runPromise(Effect.flatMap(Client, f));
  interface BuiltStep {
    agent: { command: Array<string>; model: string; provider: string; reasoning: string };
    name: string;
    prompt: string;
    routes?: Record<string, Array<BuiltStep>>;
  }

  const configureSteps = (mode: string, steps: Array<ConfigurableStep>, setup?: Array<string>) => {
    const build = (list: Array<ConfigurableStep>): Array<BuiltStep> =>
      list.map(({ name, prompt, routes }) => ({
        agent: {
          command: [process.execPath, fixture, mode],
          model: 'large',
          provider: 'codex',
          reasoning: 'high',
        },
        name,
        prompt: prompt ?? `Do ${name}`,
        ...(routes
          ? {
              routes: Object.fromEntries(
                Object.entries(routes).map(([output, chain]) => [output, build(chain)]),
              ),
            }
          : {}),
      }));
    writeFileSync(
      join(repository, '.pipes/config.ts'),
      `export default ${JSON.stringify({ setup, workflows: { work: { steps: build(steps) } } })};`,
    );
  };
  const configure = (mode: string, setup?: Array<string>) =>
    configureSteps(
      mode,
      ['implement', 'review'].map((name) => ({ name })),
      setup,
    );
  const waitForRun = (id: string, predicate: (run: Run) => boolean) =>
    call((client) =>
      client.watch().pipe(
        Stream.map((snapshot) => snapshot.runs?.find((run) => run.id === id)),
        Stream.filter((run): run is Run => !!run && predicate(run)),
        Stream.take(1),
        Stream.runCollect,
        Effect.map((runs) => runs[0]!),
        Effect.timeout('8 seconds'),
      ),
    );
  const waitForHealth = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await fetch(`${connection.url}/health`, { headers: { Authorization: 'Bearer test' } })
          .then((response) => response.ok)
          .catch(() => false)
      ) {
        return;
      }
      await Bun.sleep(20);
    }
  };
  await waitForHealth();
  const registered = await call((client) => client.register({ path: repository }));
  const submit = () =>
    call((client) =>
      client.submit({
        brief: 'Captured request',
        repositoryId: registered.id,
        title: 'Execution test',
      }),
    );
  return {
    call,
    configure,
    configureSteps,
    connection,
    directory,
    dispose: async () => {
      controller.abort();
      await serving;
      await clients.current.dispose();
      await serverRuntime.dispose();
      rmSync(directory, { force: true, recursive: true });
    },
    reboot: async () => {
      serving = serverRuntime
        .runPromise(serve(connection).pipe(Effect.scoped), { signal: controller.signal })
        .catch(() => {});
      await waitForHealth();
    },
    reconnect: async () => {
      await clients.current.dispose();
      clients.current = ManagedRuntime.make(Client.layer(connection));
    },
    registered,
    repository,
    runSecondServer: () => serverRuntime.runPromise(serve(connection).pipe(Effect.scoped)),
    shutdown: async () => {
      await call((client) => client.shutdown());
      await serving;
    },
    submit,
    waitForRun,
  };
};
