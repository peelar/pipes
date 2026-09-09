import { Schema } from 'effect';

export const ExecutionStatus = Schema.Literals([
  'queued',
  'running',
  'cancelling',
  'cancelled',
  'interrupted',
  'blocked',
  'failed',
  'awaiting_acceptance',
  'human_owned',
]);
export type ExecutionStatus = typeof ExecutionStatus.Type;

export const executionTransitions = {
  awaiting_acceptance: { fail: 'failed' },
  blocked: { fail: 'failed', jumpIn: 'human_owned' },
  cancelled: { start: 'queued' },
  cancelling: { fail: 'failed', interrupt: 'interrupted', stopped: 'cancelled' },
  failed: { fail: 'failed', jumpIn: 'human_owned' },
  human_owned: { jumpIn: 'human_owned', start: 'queued' },
  interrupted: { fail: 'failed', jumpIn: 'human_owned', start: 'queued' },
  queued: {
    begin: 'running',
    cancel: 'cancelling',
    fail: 'failed',
    interrupt: 'interrupted',
  },
  running: {
    block: 'blocked',
    cancel: 'cancelling',
    complete: 'awaiting_acceptance',
    fail: 'failed',
    interrupt: 'interrupted',
    jumpIn: 'human_owned',
  },
} as const satisfies Record<ExecutionStatus, Partial<Record<string, ExecutionStatus>>>;

export type ExecutionEvent = {
  [S in ExecutionStatus]: keyof (typeof executionTransitions)[S];
}[ExecutionStatus];

export function nextExecutionState(state: ExecutionStatus, event: ExecutionEvent) {
  const transitions: Partial<Record<ExecutionEvent, ExecutionStatus>> = executionTransitions[state];
  return transitions[event];
}

export function taskActions(run: { handoffToken?: string; status: ExecutionStatus } | undefined) {
  return {
    cancel: !!run && nextExecutionState(run.status, 'cancel') !== undefined,
    discard: !run?.handoffToken,
    jumpIn: !!run && !run.handoffToken && nextExecutionState(run.status, 'jumpIn') !== undefined,
    start: !run || (!run.handoffToken && nextExecutionState(run.status, 'start') !== undefined),
  };
}
