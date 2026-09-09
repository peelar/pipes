import { expect, test } from 'bun:test';
import { nextExecutionState, taskActions } from './execution-state';

test('task actions and execution transitions distinguish cancellation from interruption', () => {
  expect(taskActions(undefined)).toEqual({
    cancel: false,
    discard: true,
    jumpIn: false,
    start: true,
  });
  expect(taskActions({ status: 'running' })).toEqual({
    cancel: true,
    discard: true,
    jumpIn: true,
    start: false,
  });
  expect(nextExecutionState('running', 'cancel')).toBe('cancelling');
  expect(taskActions({ status: 'cancelling' })).toEqual({
    cancel: false,
    discard: true,
    jumpIn: false,
    start: false,
  });
  expect(nextExecutionState('cancelling', 'stopped')).toBe('cancelled');
  expect(nextExecutionState('cancelled', 'start')).toBeUndefined();
  expect(nextExecutionState('running', 'start')).toBeUndefined();
  expect(nextExecutionState('awaiting_acceptance', 'cancel')).toBeUndefined();
  expect(nextExecutionState('interrupted', 'start')).toBe('queued');
  expect(nextExecutionState('running', 'jumpIn')).toBe('human_owned');
  expect(taskActions({ handoffToken: 'owned', status: 'human_owned' })).toEqual({
    cancel: false,
    discard: false,
    jumpIn: false,
    start: false,
  });
  expect(taskActions({ status: 'human_owned' })).toEqual({
    cancel: false,
    discard: true,
    jumpIn: true,
    start: true,
  });
});
