import { expect, test } from 'bun:test';
import { CodexSettings } from '../protocol/pipes';
import { transitionSetup } from './codex-setup';

test('setup guards pending actions and recovers through retry before creation', () => {
  const settings = new CodexSettings({
    adapter: 'test',
    configurationExists: false,
    model: 'small',
    models: [],
    reasoning: 'low',
    reasoningOptions: [],
    skillInstalled: false,
  });
  let state: Parameters<typeof transitionSetup>[0] = { phase: 'connection', status: 'checking' };
  const key = (key: string) => transitionSetup(state, { key, type: 'key' });
  for (const name of ['return', 'c', 'v', 'b', 'r']) {
    expect(key(name)).toBe(state);
  }
  state = transitionSetup(state, { settings, type: 'connected' });
  expect(key('c')).toBe(state);
  expect(key('b')).toBe(state);
  state = key('i');
  expect(state.status).toBe('installing');
  state = transitionSetup(state, { type: 'installed' });
  expect(state.status).toBe('connected');
  expect('settings' in state && state.settings.skillInstalled).toBe(true);
  state = key('return');
  expect(key('b')).toEqual({ phase: 'connection', status: 'checking' });
  expect(key('c')).toBe(state);
  state = key('return');
  expect(state.status).toBe('creating');
  expect(key('v')).toBe(state);
  state = transitionSetup(state, { error: 'Already exists', type: 'failed' });
  expect(key('c')).toBe(state);
  expect(key('v').status).toBe('validating');
  state = key('r');
  expect(state).toEqual({ phase: 'workflow', status: 'checking' });
  state = transitionSetup(state, { settings, type: 'connected' });
  expect(state.status).toBe('workflow');
  state = key('v');
  state = transitionSetup(state, { summary: 'Valid', type: 'done' });
  expect(state).toEqual({ status: 'done', summary: 'Valid' });
  for (const name of ['return', 'c', 'v', 'b', 'r']) {
    expect(key(name)).toBe(state);
  }
});

test('setup offers validation without creation for an existing configuration', () => {
  const settings = new CodexSettings({
    adapter: 'test',
    configurationExists: true,
    model: 'small',
    models: [],
    reasoning: 'low',
    reasoningOptions: [],
    skillInstalled: true,
  });
  let state: Parameters<typeof transitionSetup>[0] = { phase: 'connection', status: 'checking' };
  state = transitionSetup(state, { settings, type: 'connected' });
  state = transitionSetup(state, { key: 'return', type: 'key' });
  expect(transitionSetup(state, { key: 'c', type: 'key' })).toBe(state);
  expect(transitionSetup(state, { key: 'v', type: 'key' }).status).toBe('validating');
  expect(transitionSetup(state, { key: 'return', type: 'key' }).status).toBe('validating');
});
