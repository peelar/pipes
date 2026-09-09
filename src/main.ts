#!/usr/bin/env bun
// Single entrypoint for the distributable binary (`bun build src/main.ts --compile`).
// Development still runs `src/cli.ts`, `src/server.ts`, and `src/dev.ts` directly;
// only releases compile this file. Each mode lazy-loads its own module so the
// helper modes (`__server`, `__codex-acp`) stay lean.
export {};
const mode = process.argv[2];
if (mode === '__server') {
  const { Effect } = await import('effect');
  const { BunRuntime, BunServices } = await import('@effect/platform-bun');
  const { ObservabilityLayer } = await import('./observability');
  const { settings } = await import('./client/connection');
  const { serve } = await import('./server');
  serve(settings()).pipe(
    Effect.scoped,
    Effect.provide([BunServices.layer, ObservabilityLayer]),
    BunRuntime.runMain,
  );
} else if (mode === '__codex-acp') {
  // The bundled ACP adapter speaks over stdio using the caller's pipes.
  // CODEX_PATH is set by the spawner so the adapter uses the system Codex engine.
  process.argv = [process.execPath, 'codex-acp', ...process.argv.slice(3)];
  await import('@agentclientprotocol/codex-acp');
} else {
  await import('./cli');
}
