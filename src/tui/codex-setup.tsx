import { RGBA, SyntaxStyle } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { Effect, type ManagedRuntime } from 'effect';
import { useEffect, useEffectEvent, useReducer } from 'react';
import { Client } from '../client/connection';
import { type CodexSettings } from '../protocol/pipes';

const syntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: RGBA.fromHex('#cdd6f4') },
  keyword: { fg: RGBA.fromHex('#cba6f7') },
  property: { fg: RGBA.fromHex('#89b4fa') },
  punctuation: { fg: RGBA.fromHex('#a6adc8') },
  string: { fg: RGBA.fromHex('#a6e3a1') },
});

type Phase = 'connection' | 'workflow';
type SetupState =
  | { phase: Phase; status: 'checking' }
  | { settings: CodexSettings; status: 'connected' | 'workflow' }
  | { settings: CodexSettings; status: 'creating' }
  | { status: 'validating' }
  | { error: string; phase: Phase; status: 'failed' }
  | { status: 'done'; summary: string };
type SetupEvent =
  | { key: string; type: 'key' }
  | { settings: CodexSettings; type: 'connected' }
  | { error: string; type: 'failed' }
  | { summary: string; type: 'done' };

function setupPhase(state: SetupState): Phase {
  return 'phase' in state ? state.phase : state.status === 'connected' ? 'connection' : 'workflow';
}

const canCreate = (state: SetupState): state is { settings: CodexSettings; status: 'workflow' } =>
  state.status === 'workflow' && !state.settings.configurationExists;

export function transitionSetup(state: SetupState, event: SetupEvent): SetupState {
  const phase = setupPhase(state);
  const pending = ['checking', 'creating', 'validating'].includes(state.status);
  switch (event.type) {
    case 'connected':
      return state.status === 'checking'
        ? { settings: event.settings, status: phase === 'connection' ? 'connected' : 'workflow' }
        : state;
    case 'failed':
      return pending ? { error: event.error, phase, status: 'failed' } : state;
    case 'done':
      return ['creating', 'validating'].includes(state.status)
        ? { status: 'done', summary: event.summary }
        : state;
    case 'key':
      if (pending || state.status === 'done') {
        return state;
      }
      switch (event.key) {
        case 'return':
          return state.status === 'connected'
            ? { ...state, status: 'workflow' }
            : canCreate(state)
              ? { ...state, status: 'creating' }
              : state.status === 'workflow'
                ? { status: 'validating' }
                : state;
        case 'r':
          return { phase, status: 'checking' };
        case 'b':
          return phase === 'workflow' ? { phase: 'connection', status: 'checking' } : state;
        case 'v':
          return phase === 'workflow' ? { status: 'validating' } : state;
        default:
          return state;
      }
  }
}

export function CodexSetup({
  onClose,
  onReady,
  path,
  runtime,
}: {
  onClose: () => void;
  onReady?: (summary: string) => void;
  path: string;
  runtime: ManagedRuntime.ManagedRuntime<Client, never>;
}) {
  const [state, dispatch] = useReducer(transitionSetup, {
    phase: 'connection',
    status: 'checking',
  });
  const phase = setupPhase(state);
  const busy = ['checking', 'creating', 'validating'].includes(state.status);
  const ready = useEffectEvent((summary: string) => onReady?.(summary));

  useEffect(() => {
    if (
      state.status !== 'checking' &&
      state.status !== 'creating' &&
      state.status !== 'validating'
    ) {
      return;
    }
    const controller = new AbortController();
    void runtime
      .runPromise(
        Effect.gen(function* () {
          const client = yield* Client;
          switch (state.status) {
            case 'validating':
              return yield* client.configCheck({ path });
            case 'creating':
              return yield* client.codexSetup({
                agent: {
                  model: state.settings.model,
                  provider: 'codex',
                  reasoning: state.settings.reasoning,
                },
                path,
              });
            case 'checking':
              return yield* client.codexProbe({ path });
          }
        }),
        { signal: controller.signal },
      )
      .then((result) => {
        if (controller.signal.aborted) {
          return;
        }
        if (typeof result === 'string') {
          const summary = state.status === 'validating' ? result : `Created ${result}`;
          ready(summary);
          dispatch({ summary, type: 'done' });
        } else {
          dispatch({ settings: result, type: 'connected' });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          dispatch({ error: String(error), type: 'failed' });
        }
      });
    return () => controller.abort();
  }, [state, path, runtime]);

  useKeyboard((key) => {
    if (key.name === 'escape') {
      onClose();
    } else {
      dispatch({ key: key.name, type: 'key' });
    }
  });

  return (
    <box
      alignItems="center"
      height="100%"
      justifyContent="center"
      left={0}
      position="absolute"
      top={0}
      width="100%"
      zIndex={10}
    >
      <box
        backgroundColor="#1e1e2e"
        border
        borderColor="#82aaff"
        flexDirection="column"
        gap={1}
        maxWidth={90}
        padding={1}
        title={setupTitle(phase, Boolean(onReady))}
        width="90%"
      >
        <text fg="#a6adc8">{path}</text>
        {busy ? (
          <text fg="#f9e2af">
            {state.status === 'validating'
              ? 'Validating configuration and its agent settings…'
              : state.status === 'creating'
                ? 'Verifying settings and creating starter…'
                : 'Checking Codex…'}
          </text>
        ) : state.status === 'failed' ? (
          <text fg="#f38ba8">{state.error}</text>
        ) : state.status === 'done' ? (
          <text fg="#a6e3a1">✓ {state.summary}</text>
        ) : state.status === 'workflow' ? (
          state.settings.configurationExists ? (
            <text>.pipes/pipes.ts already exists. Validate it to finish setup.</text>
          ) : (
            <>
              <text>We’ll create .pipes/pipes.ts with example pipes.</text>
              <text fg="#a6adc8">Preview · agent settings and prompts abbreviated</text>
              <diff
                addedBg="#20302b"
                addedContentBg="#20302b"
                addedSignColor="#a6e3a1"
                diff={`--- /dev/null
+++ b/.pipes/pipes.ts
@@ -0,0 +1,11 @@
+ export default {
+   workflows: {
+     'plan-implement-review': {
+       steps: [
+         { name: 'plan', agent: …, prompt: … },
+         { name: 'implement', agent: …, prompt: … },
+         { name: 'review', agent: …, prompt: … },
+       ],
+     },
+   },
+ };`}
                filetype="typescript"
                showLineNumbers={false}
                syntaxStyle={syntaxStyle}
                view="unified"
              />
            </>
          )
        ) : (
          <text fg="#a6e3a1">✓ Connected to Codex</text>
        )}
        <SetupShortcuts state={state} wizard={Boolean(onReady)} />
      </box>
    </box>
  );
}

function SetupShortcuts({ state, wizard }: { state: SetupState; wizard: boolean }) {
  const actions = ['return', 'v', 'b', 'r']
    .filter((key) => transitionSetup(state, { key, type: 'key' }) !== state)
    .map(
      (key) =>
        ({
          b: '[b] back',
          r: '[r] retry',
          return:
            state.status === 'workflow'
              ? canCreate(state)
                ? '[Enter] create'
                : '[Enter] validate'
              : '[Enter] continue',
          v: '[v] validate existing config',
        })[key],
    );
  return (
    <text fg="#a6adc8">
      {[...actions, `[Esc] ${wizard ? 'finish later' : 'close'}`].join(' · ')}
    </text>
  );
}

function setupTitle(phase: string, wizard: boolean) {
  if (phase === 'connection') {
    return wizard ? 'Setup · 2/3 · Connect Codex' : 'Connect Codex';
  }
  return wizard ? 'Setup · 3/3 · Configure workflow' : 'Configure workflow';
}
