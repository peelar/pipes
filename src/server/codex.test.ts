import { expect, test } from 'bun:test';
import { BunServices } from '@effect/platform-bun';
import { Effect } from 'effect';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeCodexFixture } from '../../test/codex-fixture';
import { decodeConfig } from '../config';
import { checkCodexConfig, probeCodex, setupCodex } from './codex';

test('Codex probes negotiate settings, reject failures, clean up, and safely create a starter', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pipes-acp-test-'));
  const fixture = writeCodexFixture(directory);
  const record = join(directory, 'calls.jsonl');
  const command = (mode = 'ok') => [process.execPath, fixture, mode];
  const probe = (mode = 'ok', settings = {}) =>
    Effect.runPromise(
      probeCodex({ command: command(mode), path: directory, ...settings }).pipe(
        Effect.provide(BunServices.layer),
      ),
    );
  const stopped = () =>
    expect(() => process.kill(Number(readFileSync(join(directory, 'pid'), 'utf8')), 0)).toThrow();
  const initial = await probe();
  expect(initial.configurationExists).toBe(false);
  expect(initial.models.map((item) => item.value)).toEqual(['small', 'large']);
  expect(initial.reasoningOptions.map((item) => item.value)).toEqual(['low']);
  stopped();
  const selected = await probe('ok', { model: 'large', reasoning: 'high' });
  expect(selected.model).toBe('large');
  expect(selected.reasoning).toBe('high');
  const calls = readFileSync(record, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(calls.map((call) => call.method)).toEqual([
    'initialize',
    'session/new',
    'initialize',
    'session/new',
    'session/set_config_option',
    'session/set_config_option',
  ]);
  expect(calls[0].params.clientCapabilities.terminal).toBe(false);
  expect(calls[0].params.clientCapabilities.fs.writeTextFile).toBe(false);
  expect(calls[1].params.mcpServers).toEqual([]);
  expect(calls[4].params.value).toBe('large');
  expect(calls[5].params.value).toBe('high');
  for (const [mode, settings, message] of [
    ['ok', { model: 'unknown' }, 'Unsupported model'],
    ['ok', { model: 'small', reasoning: 'high' }, 'Unsupported reasoning_effort'],
    ['ignore', { model: 'large' }, 'did not apply'],
    ['auth', {}, 'pipes agent login'],
    ['version', {}, 'Unsupported ACP protocol'],
    ['missing-options', {}, 'does not advertise model'],
    ['malformed', {}, 'Codex connection failed'],
    ['crash', {}, 'Codex connection failed'],
  ] as const) {
    await expect(probe(mode, settings)).rejects.toThrow(message);
    stopped();
  }
  await expect(
    Effect.runPromise(
      probeCodex({ command: [join(directory, 'missing')], path: directory }).pipe(
        Effect.provide(BunServices.layer),
      ),
    ),
  ).rejects.toThrow('Check the repository directory and any custom command');
  await expect(
    Effect.runPromise(
      probeCodex({ command: command('hang'), path: directory }).pipe(
        Effect.timeout('300 millis'),
        Effect.provide(BunServices.layer),
      ),
    ),
  ).rejects.toThrow();
  stopped();
  expect(
    await Bun.spawn(['git', 'init', directory], { stderr: 'ignore', stdout: 'ignore' }).exited,
  ).toBe(0);
  const input = {
    agent: { command: command(), model: 'large', provider: 'codex' as const, reasoning: 'high' },
    path: directory,
  };
  const filename = await Effect.runPromise(
    setupCodex(input).pipe(Effect.provide(BunServices.layer)),
  );
  const original = readFileSync(filename, 'utf8');
  const configuration = await import(pathToFileURL(filename).href);
  const decoded = await Effect.runPromise(decodeConfig(configuration.default));
  expect(decoded.workflows['plan-implement-review']?.steps.map((step) => step.agent)).toEqual([
    input.agent,
    input.agent,
    input.agent,
  ]);
  await expect(
    Effect.runPromise(setupCodex(input).pipe(Effect.provide(BunServices.layer))),
  ).rejects.toThrow('never overwritten');
  expect(readFileSync(filename, 'utf8')).toBe(original);
  const check = () =>
    Effect.runPromise(checkCodexConfig(directory).pipe(Effect.provide(BunServices.layer)));
  expect(await check()).toContain('Validated workflows: plan-implement-review');
  expect(readFileSync(filename, 'utf8')).toBe(original);
  writeFileSync(filename, original.replaceAll('"high"', '"unsupported"'));
  await expect(check()).rejects.toThrow('Unsupported reasoning_effort');
  writeFileSync(filename, 'export default { workflows: {} };');
  await expect(check()).rejects.toThrow('Configuration check failed');
  writeFileSync(filename, original);
  expect(await check()).toContain('Validated workflows: plan-implement-review');
}, 15_000);

test('bundled adapter and Codex run without global executables', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      Bun.resolveSync('@agentclientprotocol/codex-acp', process.cwd()),
      'cli',
      'login',
      '--help',
    ],
    {
      env: { ...process.env, CODEX_PATH: '', PATH: '' },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
  expect(stdout).toContain('Manage login');
});
