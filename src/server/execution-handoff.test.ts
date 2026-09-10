import { expect, test } from 'bun:test';
import { BunServices } from '@effect/platform-bun';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootHarness, harnessGit } from '../../test/execution-harness';
import { resumeArguments } from './environment';
import { Store } from './store';

test('interactive handoff claims steps, records outcomes, and survives restarts', async () => {
  const harness = await bootHarness();
  const { call, configure, directory, submit, waitForRun } = harness;
  try {
    configure('execute-wait');
    rmSync(join(directory, 'release'), { force: true });
    const stoppingTask = await submit();
    const stopping = await call((client) => client.start({ taskId: stoppingTask.id }));
    await waitForRun(stopping.id, (run) => !!run.attempts[0]?.sessionId);
    await expect(call((client) => client.jumpIn({ taskId: stoppingTask.id }))).rejects.toThrow(
      'Custom ACP',
    );
    await call((client) => client.stop({ taskId: stoppingTask.id }));
    const stopped = await waitForRun(stopping.id, (run) => run.status === 'interrupted');
    expect(stopped.revision).toBeTruthy();
    expect(() => process.kill(Number(readFileSync(join(directory, 'pid'), 'utf8')), 0)).toThrow();
    // Seed a resumable bundled session after the fixture worker has demonstrably stopped.
    const handoffStorage = ManagedRuntime.make(
      Store.layer(join(directory, 'pipes.sqlite')).pipe(Layer.provide(BunServices.layer)),
    );
    try {
      await handoffStorage.runPromise(
        Effect.flatMap(Store, (store) =>
          store.saveRun({
            ...stopped,
            configuration: {
              workflows: {
                work: {
                  steps: stopped.configuration.workflows.work!.steps.map((step) => ({
                    ...step,
                    agent: { model: 'large', provider: 'codex', reasoning: 'high' },
                  })),
                },
              },
            },
            workerStopped: false,
          }),
        ),
      );
    } finally {
      await handoffStorage.dispose();
    }
    await expect(call((client) => client.jumpIn({ taskId: stoppingTask.id }))).rejects.toThrow(
      'Cannot confirm',
    );
    const claims = await Promise.allSettled([
      call((client) => client.jumpIn({ confirmedStopped: true, taskId: stoppingTask.id })),
      call((client) => client.jumpIn({ confirmedStopped: true, taskId: stoppingTask.id })),
    ]);
    expect(
      claims.filter((claim) => claim.status === 'fulfilled'),
      JSON.stringify(claims),
    ).toHaveLength(1);
    const owned = (await call((client) => client.snapshot())).runs!.find(
      (run) => run.id === stopping.id,
    )!;
    expect(owned.status).toBe('human_owned');
    expect(owned.attempts.at(-1)?.sessionId).toBe(stopped.attempts.at(-1)?.sessionId);
    expect(owned.attempts).toHaveLength(2);
    expect(owned.handoffToken).toBeTruthy();
    const args = resumeArguments(owned, 'http://127.0.0.1:1234/mcp');
    expect(args.slice(1, 5)).toEqual([
      'resume',
      owned.attempts.at(-1)!.sessionId!,
      '--cd',
      owned.workspace,
    ]);
    const nativeHelp = Bun.spawn([process.execPath, args[0]!, 'resume', '--help'], {
      stderr: 'pipe',
      stdout: 'pipe',
    });
    expect(await new Response(nativeHelp.stdout).text()).toContain('codex resume');
    expect(await nativeHelp.exited).toBe(0);
    await expect(call((client) => client.start({ taskId: stoppingTask.id }))).rejects.toThrow(
      'already has a run',
    );
    await expect(
      call((client) =>
        client.handoffClose({ successful: true, taskId: stoppingTask.id, token: 'stale' }),
      ),
    ).rejects.toThrow('ownership');
    writeFileSync(join(owned.workspace, 'human-change.txt'), 'interactive edit');
    await call((client) =>
      client.handoffReport({
        result: { status: 'completed', summary: 'Human reviewed changes.' },
        taskId: stoppingTask.id,
        token: owned.handoffToken!,
      }),
    );
    await expect(
      call((client) =>
        client.handoffReport({
          result: { status: 'completed', summary: 'Duplicate' },
          taskId: stoppingTask.id,
          token: owned.handoffToken!,
        }),
      ),
    ).rejects.toThrow('already reported');
    await call((client) =>
      client.handoffClose({
        successful: true,
        taskId: stoppingTask.id,
        token: owned.handoffToken!,
      }),
    );
    const held = (await call((client) => client.snapshot())).runs!.find(
      (run) => run.id === stopping.id,
    )!;
    expect(held.status).toBe('human_owned');
    expect(held.handoffToken).toBeUndefined();
    expect(held.attempts.at(-1)?.status).toBe('completed');
    expect(await harnessGit(held.workspace, 'status', '--porcelain')).toBe('');
    expect(held.revision).not.toBe(stopped.revision);
    const reopened = await call((client) => client.jumpIn({ taskId: stoppingTask.id }));
    expect(reopened.handoffToken).not.toBe(owned.handoffToken);
    await call((client) =>
      client.handoffClose({
        successful: false,
        taskId: stoppingTask.id,
        token: reopened.handoffToken!,
      }),
    );
    expect(
      (await call((client) => client.snapshot()))
        .runs!.find((run) => run.id === stopping.id)!
        .attempts.at(-1)?.status,
    ).toBe('interrupted');
    // A completed run plus a held handoff must both survive a server restart.
    configure('execute-wait');
    writeFileSync(join(directory, 'release'), '');
    const completedTask = await submit();
    const completedRun = await call((client) => client.start({ taskId: completedTask.id }));
    const completed = await waitForRun(
      completedRun.id,
      (run) => run.status === 'awaiting_acceptance',
    );
    expect(completed.attempts.map((attempt) => attempt.status)).toEqual(['completed', 'completed']);
    const lockedHandoff = await call((client) => client.jumpIn({ taskId: stoppingTask.id }));
    await harness.shutdown();
    const storage = ManagedRuntime.make(
      Store.layer(join(directory, 'pipes.sqlite')).pipe(Layer.provide(BunServices.layer)),
    );
    try {
      await storage.runPromise(
        Effect.flatMap(Store, (store) =>
          store.saveRun({
            ...completed,
            attempts: [
              { ...completed.attempts[0]!, status: 'completed' },
              { ...completed.attempts[1]!, status: 'running' },
            ],
            status: 'running',
          }),
        ),
      );
    } finally {
      await storage.dispose();
    }
    const callsBeforeRestart = readFileSync(join(directory, 'calls.jsonl'), 'utf8');
    await harness.reboot();
    const recovered = await waitForRun(completed.id, (run) => run.status === 'interrupted');
    const recoveredHandoff = (await call((client) => client.snapshot())).runs!.find(
      (run) => run.id === stopping.id,
    )!;
    expect(recoveredHandoff.status).toBe('human_owned');
    expect(recoveredHandoff.handoffToken).toBe(lockedHandoff.handoffToken);
    await expect(call((client) => client.jumpIn({ taskId: stoppingTask.id }))).rejects.toThrow(
      'already has an interactive session',
    );
    await call((client) =>
      client.handoffClose({
        successful: false,
        taskId: stoppingTask.id,
        token: lockedHandoff.handoffToken!,
      }),
    );
    expect(recovered.attempts.map((attempt) => attempt.status)).toEqual([
      'completed',
      'interrupted',
    ]);
    expect(readFileSync(join(directory, 'calls.jsonl'), 'utf8')).toBe(callsBeforeRestart);
    writeFileSync(join(directory, 'release'), '');
    const restarted = await call((client) => client.start({ taskId: completed.taskId }));
    expect(restarted.id).toBe(completed.id);
    expect(restarted.configuration).toEqual(completed.configuration);
    expect(restarted.workspace).toBe(completed.workspace);
    const resumed = await waitForRun(
      completed.id,
      (run) => !['queued', 'running'].includes(run.status),
    );
    expect(resumed.status).toBe('awaiting_acceptance');
    expect(resumed.attempts.map((attempt) => attempt.status)).toEqual([
      'completed',
      'interrupted',
      'completed',
    ]);
  } finally {
    await harness.dispose();
  }
}, 30_000);
