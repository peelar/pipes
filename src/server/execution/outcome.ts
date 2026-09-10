import type { Cause } from 'effect';
import { Cause as CauseModule } from 'effect';
import { transition } from './transitions';
import type { Run } from '@pipes/protocol';

export function applyFailureCause(run: Run, cause: Cause.Cause<unknown>, cancelled: boolean): Run {
  const interrupted = CauseModule.hasInterrupts(cause);
  return {
    ...run,
    attempts: run.attempts.map((attempt) =>
      attempt.status === 'running'
        ? { ...attempt, status: interrupted ? ('interrupted' as const) : ('failed' as const) }
        : attempt,
    ),
    status:
      cancelled && interrupted
        ? transition(run, 'cancel').status
        : transition(run, interrupted ? 'interrupt' : 'fail').status,
    summary: interrupted
      ? cancelled
        ? 'Execution cancelled. Workspace and evidence preserved.'
        : 'Worker stopped. Inspect the preserved workspace before continuing.'
      : CauseModule.pretty(cause),
  };
}
