import { createCliRenderer, type TextareaRenderable } from '@opentui/core';
import { createRoot, useKeyboard } from '@opentui/react';
import { Effect, ManagedRuntime, Stream } from 'effect';
import { useEffect, useRef, useState } from 'react';
import { Client, type Connection } from '../client/connection';
import { Snapshot } from '../protocol/pipes';
import { InitializeRepository, RepositoryPicker, useSuggestedRoot } from './repository-picker';

type Runtime = ReturnType<typeof makeRuntime>;
const makeRuntime = (connection: Connection) => ManagedRuntime.make(Client.layer(connection));
const empty = new Snapshot({ repositories: [], tasks: [], transitions: [] });

function paneFocused(mode: string, pane: string, target: string, modal: string | undefined) {
  return mode === 'queue' && pane === target && !modal;
}

export function App({
  onQuit,
  runtime,
  startDirectory = process.cwd(),
}: {
  onQuit: () => void;
  runtime: Runtime;
  startDirectory?: string;
}) {
  const [snapshot, setSnapshot] = useState(empty);
  const [selected, setSelected] = useState(0);
  const [pane, setPane] = useState<'queue' | 'task'>('queue');
  const [repositoryIndex, setRepositoryIndex] = useState(0);
  const [mode, setMode] = useState<'queue' | 'register' | 'title' | 'brief'>('queue');
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const brief = useRef<TextareaRenderable>(null);
  const task = snapshot.tasks[selected];
  const repository = snapshot.repositories[repositoryIndex];
  const [suggestedRoot, dismissSuggestion] = useSuggestedRoot(
    startDirectory,
    snapshot.repositories,
    connected,
    mode === 'queue',
  );

  useEffect(() => {
    const controller = new AbortController();
    void runtime
      .runPromise(
        Effect.gen(function* () {
          const client = yield* Client;
          yield* client.watch().pipe(
            Stream.runForEach((next) =>
              Effect.sync(() => {
                setSnapshot(next);
                setConnected(true);
              }),
            ),
          );
        }),
        { signal: controller.signal },
      )
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setConnected(false);
          setError(`Connection lost. Reopen pipes to reconnect. ${String(error)}`);
        }
      });
    return () => controller.abort();
  }, [runtime]);

  const save = (operation: Effect.Effect<unknown, unknown, Client>) => {
    setBusy(true);
    setError('');
    void runtime
      .runPromise(
        Effect.gen(function* () {
          yield* operation;
          const client = yield* Client;
          return yield* client.snapshot();
        }),
      )
      .then((next) => {
        setSnapshot(next);
        setMode('queue');
      })
      .catch((error: unknown) => setError(String(error)))
      .finally(() => setBusy(false));
  };

  useKeyboard((key) => {
    if (suggestedRoot) {
      return;
    }
    if (key.name === 'escape' && !busy) {
      setMode('queue');
      setError('');
    }
    if (mode === 'queue') {
      if (key.name === 'q') {
        onQuit();
      } else if (key.name === 'r') {
        setMode('register');
      } else if (key.name === 'n' && repository) {
        setTitle('');
        setMode('title');
      } else if (key.name === 'tab' && snapshot.repositories.length > 0) {
        setRepositoryIndex((index) => (index + 1) % snapshot.repositories.length);
      } else if (key.name === 'left' || key.name === 'right') {
        setPane(key.name === 'left' ? 'queue' : 'task');
      }
    }
  });

  useKeyboard((key) => {
    if (mode === 'brief' && key.ctrl && key.name === 's' && repository && !busy) {
      const body = brief.current?.plainText ?? '';
      save(
        Effect.flatMap(Client, (client) =>
          client.submit({ brief: body, repositoryId: repository.id, title }),
        ),
      );
    }
  });

  return (
    <box flexDirection="column" gap={1} height="100%" padding={1}>
      <box flexDirection="row" flexShrink={0} justifyContent="space-between">
        <text fg="#82aaff">𝚙𝚒𝚙𝚎𝚜</text>
        <text fg={connected ? '#a6e3a1' : '#f9e2af'}>
          {connected ? '● connected' : '○ disconnected'} · {snapshot.tasks.length} tasks
        </text>
      </box>
      <box flexDirection="row" flexGrow={1} gap={1} minHeight={0}>
        <box border flexDirection="column" padding={1} title="Queue" width="33%">
          {snapshot.tasks.length ? (
            <select
              flexGrow={1}
              focused={paneFocused(mode, pane, 'queue', suggestedRoot)}
              onChange={(index) => setSelected(index)}
              options={snapshot.tasks.map((item) => ({
                description: `${item.status} · ${snapshot.repositories.find((repo) => repo.id === item.repositoryId)?.name ?? ''}`,
                name: item.title,
              }))}
              selectedIndex={selected}
              showScrollIndicator
            />
          ) : (
            <text>
              No tasks yet.{'\n\n'}
              {repository
                ? 'Press n to submit your first task.'
                : 'Press r to register a Git repository.'}
            </text>
          )}
        </box>
        <box border flexDirection="column" flexGrow={1} padding={1} title="Task">
          {task ? (
            <scrollbox
              flexGrow={1}
              focused={paneFocused(mode, pane, 'task', suggestedRoot)}
              key={task.id}
            >
              <text fg="#82aaff">
                <b>{task.title}</b>
              </text>
              <text>
                {task.status} ·{' '}
                {snapshot.repositories.find((repo) => repo.id === task.repositoryId)?.name}
                {'\n'}
                {task.id}
                {'\n\n'}
              </text>
              <text>
                {task.brief || 'No brief supplied.'}
                {'\n\n'}
              </text>
              <text fg="#a6adc8">History</text>
              {snapshot.transitions
                .filter((event) => event.taskId === task.id)
                .map((event) => (
                  <text key={event.id}>
                    {event.createdAt} · {event.kind}
                  </text>
                ))}
              <text fg="#a6adc8">{'\n'}Agent execution is not connected yet.</text>
            </scrollbox>
          ) : (
            <text>Select a task to read its brief and history.</text>
          )}
        </box>
      </box>
      {mode === 'register' && (
        <RepositoryPicker
          busy={busy}
          onRegister={(path) => save(Effect.flatMap(Client, (client) => client.register({ path })))}
          startDirectory={startDirectory}
        />
      )}
      {mode === 'title' && (
        <box
          border
          padding={1}
          title={`New task in ${repository?.name} · Enter continues · Esc cancels`}
        >
          <input
            flexGrow={1}
            focused
            maxLength={240}
            onSubmit={(value) => {
              if (typeof value === 'string' && value.trim()) {
                setTitle(value.trim());
                setMode('brief');
              }
            }}
            placeholder="Requested outcome"
          />
        </box>
      )}
      {mode === 'brief' && (
        <box border height={8} padding={1} title="Markdown brief · Ctrl+S submits · Esc cancels">
          <textarea
            flexGrow={1}
            focused={!busy}
            placeholder="Describe the work and what success looks like…"
            ref={brief}
          />
        </box>
      )}
      {error && <text fg="#f38ba8">{error}</text>}
      <text fg="#a6adc8">
        {busy
          ? 'Saving…'
          : `↑↓ scroll  ←→ pane  n new  r register  Tab repo [${repository?.name ?? 'none'}]  q detach`}
      </text>
      {suggestedRoot && (
        <InitializeRepository
          busy={busy}
          error={error}
          onConfirm={() =>
            save(Effect.flatMap(Client, (client) => client.register({ path: suggestedRoot })))
          }
          onDecline={dismissSuggestion}
          path={suggestedRoot}
        />
      )}
    </box>
  );
}

export async function launch(connection: Connection) {
  const runtime = makeRuntime(connection);
  const { promise: closed, resolve: finish } = Promise.withResolvers<void>();
  const renderer = await createCliRenderer({ exitOnCtrlC: true, onDestroy: () => finish() });
  const root = createRoot(renderer);
  try {
    root.render(<App onQuit={() => renderer.destroy()} runtime={runtime} />);
    await closed;
  } finally {
    root.unmount();
    renderer.destroy();
    await runtime.dispose();
  }
}
