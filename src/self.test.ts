import { expect, test } from 'bun:test';
import { selfCommand } from './self';

test('selfCommand re-invokes this installation with the requested args', () => {
  const { args, executable } = selfCommand(['config', 'some/path']);
  expect(executable).toBe(process.execPath);
  expect(args.slice(-2)).toEqual(['config', 'some/path']);
});
