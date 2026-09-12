import { expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootHarness } from '../../../test/execution-harness';

test('routing steps select one branch and reject malformed route reports', async () => {
  const harness = await bootHarness();
  const { call, configureSteps, submit, waitForRun } = harness;
  try {
    configureSteps('route-left', [
      {
        name: 'classify',
        prompt: 'Is this a UI change or a deeper change?',
        routes: {
          left: [{ name: 'polish' }, { name: 'publish' }],
          right: [{ name: 'rearchitect' }],
        },
      },
    ]);
    const task = await submit();
    const started = await call((client) => client.start({ taskId: task.id }));
    const routed = await waitForRun(started.id, (run) => run.status === 'awaiting_acceptance');
    expect(routed.attempts.map((attempt) => [attempt.step, attempt.status])).toEqual([
      ['classify', 'completed'],
      ['polish', 'completed'],
      ['publish', 'completed'],
    ]);
    expect(routed.attempts[0]!.result?.output).toBe('left');
    expect(routed.attempts.some((attempt) => attempt.step === 'rearchitect')).toBe(false);
    expect(readFileSync(routed.attempts[1]!.transcript, 'utf8')).toContain('classify → left');

    for (const [mode, message] of [
      ['route-no-output', 'must report exactly one output'],
      ['route-wrong-output', 'output must be one of'],
      ['route-stray-output', 'does not accept an output'],
    ] as const) {
      configureSteps(mode, [
        {
          name: 'classify',
          prompt: 'Classify the change.',
          routes: { left: [{ name: 'polish' }], right: [] },
        },
      ]);
      const rejected = await submit();
      const run = await call((client) => client.start({ taskId: rejected.id }));
      await waitForRun(run.id, (current) => current.status === 'failed');
      expect(readFileSync(join(harness.directory, 'tool-errors.txt'), 'utf8')).toContain(message);
    }
  } finally {
    await harness.dispose();
  }
}, 30_000);

test('server owns execution across client disconnects, validates outcomes, and checkpoints', async () => {
  const harness = await bootHarness();
  const { call, configure, directory, repository, submit, waitForRun } = harness;
  try {
    configure('execute-wait');
    const task = await submit();
    const run = await call((client) => client.start({ taskId: task.id }));
    await waitForRun(run.id, (run) => !!run.attempts[0]?.sessionId);
    await expect(harness.runSecondServer()).rejects.toThrow('Cannot listen');
    expect(
      (await call((client) => client.snapshot())).runs?.find((current) => current.id === run.id)
        ?.status,
    ).toBe('running');
    await expect(call((client) => client.start({ taskId: task.id }))).rejects.toThrow(
      'already has a run',
    );
    await harness.reconnect();
    // The requesting client is gone while the worker remains alive.
    expect(() =>
      process.kill(Number(readFileSync(join(directory, 'pid'), 'utf8')), 0),
    ).not.toThrow();
    configure('execute-missing');
    writeFileSync(join(directory, 'release'), '');
    const completed = await waitForRun(run.id, (run) => run.status === 'awaiting_acceptance');
    expect(completed.attempts.map((attempt) => attempt.status)).toEqual(['completed', 'completed']);
    expect(completed.brief).toBe('Captured request');
    expect(completed.revision).toBeTruthy();
    expect(existsSync(completed.workspace)).toBe(false);
    expect(existsSync(join(repository, 'agent-change.txt'))).toBe(false);
    expect(readFileSync(completed.attempts[1]!.transcript, 'utf8')).toContain('Fixture result');
    expect(() => process.kill(Number(readFileSync(join(directory, 'pid'), 'utf8')), 0)).toThrow();
    for (const [mode, status] of [
      ['execute-missing', 'failed'],
      ['execute-crash', 'failed'],
      ['execute-blocked', 'blocked'],
    ] as const) {
      configure(mode);
      const task = await submit();
      const started = await call((client) => client.start({ taskId: task.id }));
      const finished = await waitForRun(started.id, (run) => run.status === status);
      expect(finished.attempts).toHaveLength(1);
      expect(finished.revision).toBeTruthy();
    }
    configure('execute-wait');
    rmSync(join(directory, 'release'));
    const stoppingTask = await submit();
    const stopping = await call((client) => client.start({ taskId: stoppingTask.id }));
    await waitForRun(stopping.id, (run) => !!run.attempts[0]?.sessionId);
    await call((client) => client.stop({ taskId: stoppingTask.id }));
    const stopped = await waitForRun(stopping.id, (run) => run.status === 'interrupted');
    expect(stopped.revision).toBeTruthy();
    expect(() => process.kill(Number(readFileSync(join(directory, 'pid'), 'utf8')), 0)).toThrow();
    const cancellingTask = await submit();
    const cancelling = await call((client) => client.start({ taskId: cancellingTask.id }));
    await waitForRun(cancelling.id, (run) => !!run.attempts[0]?.sessionId);
    const beforeInspection = (await call((client) => client.snapshot())).runs?.find(
      (run) => run.id === cancelling.id,
    );
    expect(await call((client) => client.conversation({ taskId: cancellingTask.id }))).toContain(
      'Captured request',
    );
    expect(
      (await call((client) => client.snapshot())).runs?.find((run) => run.id === cancelling.id),
    ).toEqual(beforeInspection);
    await call((client) => client.cancel({ taskId: cancellingTask.id }));
    const cancelled = await waitForRun(cancelling.id, (run) => run.status === 'cancelled');
    expect(cancelled.revision).toBeTruthy();
    expect(cancelled.attempts).toHaveLength(1);
    expect(cancelled.attempts[0]?.status).toBe('interrupted');
    expect(() => process.kill(Number(readFileSync(join(directory, 'pid'), 'utf8')), 0)).toThrow();
    configure('execute-missing');
    const restartedCancellation = await call((client) =>
      client.start({ taskId: cancellingTask.id }),
    );
    expect(restartedCancellation.id).not.toBe(cancelling.id);
    expect(restartedCancellation.workspace).not.toBe(cancelling.workspace);
    expect(restartedCancellation.attempts).toHaveLength(0);
    await waitForRun(restartedCancellation.id, (run) => run.status === 'failed');
    expect(
      (await call((client) => client.snapshot())).runs?.filter(
        (run) => run.taskId === cancellingTask.id,
      ),
    ).toHaveLength(2);
    await expect(call((client) => client.cancel({ taskId: cancellingTask.id }))).rejects.toThrow(
      'Only ongoing',
    );
    configure('execute-report-wait');
    const reportedTask = await submit();
    const reportedRun = await call((client) => client.start({ taskId: reportedTask.id }));
    await waitForRun(reportedRun.id, (run) => !!run.attempts[0]?.result);
    await call((client) => client.cancel({ taskId: reportedTask.id }));
    const cancelledReport = await waitForRun(reportedRun.id, (run) => run.status === 'cancelled');
    expect(cancelledReport.attempts).toHaveLength(1);
    expect(cancelledReport.attempts[0]?.result?.status).toBe('completed');
    expect(cancelledReport.attempts[0]?.status).toBe('interrupted');
    configure('execute-missing', [process.execPath, '-e', 'process.exit(2)']);
    const setupTask = await submit();
    const setup = await call((client) => client.start({ taskId: setupTask.id }));
    const failedSetup = await waitForRun(setup.id, (run) => run.status === 'failed');
    expect(failedSetup.attempts).toHaveLength(0);
    expect(failedSetup.summary).toContain('Repository setup failed');
  } finally {
    await harness.dispose();
  }
}, 30_000);
