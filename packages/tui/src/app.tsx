import { type TextareaRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { Effect, ManagedRuntime, Stream } from 'effect';
import { useEffect, useRef, useState } from 'react';
import {
  Client,
  PipesError,
  taskActions,
  type Repository,
  type Run,
  Snapshot,
  type Task,
} from '@pipes/protocol';
import { ConnectRepository, useSuggestedRoot } from './repository-picker';
import { ChoiceList } from './choice-list';
import { RepositoryConnection } from './repository-connection';
import { Onboarding, readOnboarding } from './onboarding';
import { CodexSetup } from './codex-setup';
import { Conversation } from './conversation';
import { ConfirmationAlert, type DestructiveAction } from './confirmation-alert';

export type Runtime = ManagedRuntime.ManagedRuntime<Client, never>;
const empty = new Snapshot({ repositories: [], tasks: [], transitions: [] });

function paneFocused(mode: string, pane: string, target: string, modal: unknown) {
  return taskViewActive(mode, modal) && pane === target;
}

function taskViewActive(mode: string, modal: unknown) {
  return mode === 'queue' && !modal;
}

function taskActionShortcuts(run: Run | undefined) {
  const actions = taskActions(run);
  return [
    actions.start && (run?.status === 'human_owned' ? '[s] return control' : '[s] start'),
    actions.discard && '[d] discard',
    actions.cancel && '[x] cancel',
    actions.jumpIn && '[j] jump in',
  ]
    .filter(Boolean)
    .join('  ');
}

export function taskShortcuts(run: Run | undefined) {
  return [taskActionShortcuts(run), run && '[v] view conversation'].filter(Boolean).join('  ');
}

function shortcuts(busy: boolean, task: Task | undefined, run: Run | undefined) {
  return busy ? 'Working…' : task ? taskActionShortcuts(run) : '';
}

function viewShortcut(busy: boolean, run: Run | undefined) {
  return busy || !run ? '' : '[v] view conversation';
}

function emptyQueue(repository: string | undefined) {
  return `No tasks yet.\n\n${repository ? 'Press [n] to submit your first task.' : 'Press [m] to manage repository connections.'}`;
}

function runMainAction(key: string, quit: () => void, manage: () => void) {
  ({ m: manage, q: quit })[key as 'm' | 'q']?.();
}

function initialOnboarding(directory: string | undefined) {
  return directory && !readOnboarding(directory).complete ? directory : undefined;
}

function connectionStatus(connected: boolean, tasks: number) {
  return {
    color: connected ? '#a6e3a1' : '#f9e2af',
    text: `${connected ? '● connected' : '○ disconnected'} · ${tasks} tasks`,
  };
}

function useTemporaryMessage(message: string, setMessage: (message: string) => void) {
  useEffect(() => {
    if (!message) {
      return;
    }
    const timeout = setTimeout(() => setMessage(''), 5000);
    return () => clearTimeout(timeout);
  }, [message, setMessage]);
}

function Manage({
  onClose,
  open,
  repositories,
  repositoryPath,
  runtime,
  startDirectory,
}: {
  onClose: () => void;
  open: boolean;
  repositories: ReadonlyArray<Repository>;
  repositoryPath: string;
  runtime: Runtime;
  startDirectory: string;
}) {
  const [tab, setTab] = useState<'connections' | 'agent'>('connections');

  useKeyboard((key) => {
    if (!open) {
      return;
    } else if (key.name === 'escape') {
      onClose();
    } else if (key.name === 'tab') {
      key.preventDefault();
      setTab((current) => (current === 'connections' ? 'agent' : 'connections'));
    }
  });

  if (!open) {
    return null;
  }

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
        bottomTitle="[Tab] switch · [Esc] close"
        flexDirection="column"
        gap={1}
        height="70%"
        padding={1}
        title="Manage"
        width="70%"
      >
        <text>
          <span
            bg={tab === 'connections' ? '#82aaff' : '#1e1e2e'}
            fg={tab === 'connections' ? '#1e1e2e' : '#a6adc8'}
          >
            {' Connections '}
          </span>
          <span
            bg={tab === 'agent' ? '#82aaff' : '#1e1e2e'}
            fg={tab === 'agent' ? '#1e1e2e' : '#a6adc8'}
          >
            {' Agent '}
          </span>
        </text>
        {tab === 'connections' ? (
          <box border borderColor="#82aaff" flexDirection="column" width="100%">
            <RepositoryConnection
              embedded
              onClose={onClose}
              onConnected={onClose}
              repositories={repositories}
              runtime={runtime}
              startDirectory={startDirectory}
            />
          </box>
        ) : (
          <CodexSetup embedded onClose={onClose} path={repositoryPath} runtime={runtime} />
        )}
      </box>
    </box>
  );
}

function selectedRun(snapshot: Snapshot, selected: number) {
  return snapshot.runs?.findLast((run) => run.taskId === snapshot.tasks[selected]?.id);
}

export const statusVisuals = {
  awaiting_acceptance: { color: '#f9e2af', icon: '!', label: 'awaiting acceptance' },
  blocked: { color: '#f9e2af', icon: '!', label: 'blocked' },
  cancelled: { color: '#a6adc8', icon: '—', label: 'cancelled' },
  cancelling: { color: '#f9e2af', icon: 'Ⅱ', label: 'stopping' },
  completed: { color: '#a6e3a1', icon: '✓', label: 'completed' },
  failed: { color: '#f38ba8', icon: '×', label: 'failed' },
  human_owned: { color: '#f9e2af', icon: 'Ⅱ', label: 'human-owned' },
  interrupted: { color: '#f9e2af', icon: 'Ⅱ', label: 'interrupted' },
  queued: { color: '#a6adc8', icon: '○', label: 'queued' },
  running: { color: '#82aaff', icon: '⠋', label: 'running' },
  waiting: { color: '#a6adc8', icon: '○', label: 'waiting' },
} as const;

function useRunningIcon(running: boolean) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setInterval(() => setFrame((frame) => (frame + 1) % 10), 80);
    return () => clearInterval(timer);
  }, [running]);
  return '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[frame]!;
}

export function StatusText({
  name,
  status,
}: {
  name?: string;
  status: keyof typeof statusVisuals;
}) {
  const frame = useRunningIcon(status === 'running');
  const visual = statusVisuals[status];
  return (
    <text fg={visual.color}>
      {status === 'running' ? frame : visual.icon} {name ? `${name} · ` : ''}
      {visual.label}
    </text>
  );
}

export function workflowProgress(run: Pick<Run, 'attempts' | 'configuration' | 'workflow'>) {
  return run.configuration.workflows[run.workflow]?.steps.map((step) => {
    const status = run.attempts.findLast((attempt) => attempt.step === step.name)?.status;
    return { name: step.name, status: status ?? ('waiting' as const) };
  });
}

export function TaskDetails({
  active,
  repository,
  run,
  snapshot,
  task,
}: {
  active: boolean;
  repository: string | undefined;
  run: Run | undefined;
  snapshot: Snapshot;
  task: Task;
}) {
  const [requestExpanded, setRequestExpanded] = useState(false);
  const [descriptionClipped, setDescriptionClipped] = useState(false);
  useKeyboard((key) => {
    if (!active) {
      return;
    }
    if (key.name === 'b') {
      setRequestExpanded((expanded) => !expanded);
    }
  });
  const summaries = [
    ...new Set(
      run?.attempts
        .toReversed()
        .map((attempt) => attempt.result?.summary)
        .filter((summary) => summary && summary !== run?.summary),
    ),
  ];
  const events = [
    ...snapshot.transitions.filter((event) => event.taskId === task.id),
    ...(snapshot.runs ?? [])
      .filter((item) => item.taskId === task.id)
      .map((item) => ({ createdAt: item.createdAt, id: item.id, kind: 'Run started' })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <box flexDirection="column" gap={1}>
      <box border={['bottom']} borderColor="#585b70" flexDirection="row" gap={2} paddingBottom={1}>
        <box flexDirection="column" width="55%">
          <text fg="#82aaff">
            <b>{task.title}</b>
          </text>
          <text fg="#a6adc8">{repository}</text>
          <StatusText status={task.status} />
          {run?.summary && <text>{run.summary}</text>}
        </box>
        <box
          border={['left']}
          borderColor="#585b70"
          flexDirection="column"
          flexGrow={1}
          paddingLeft={1}
        >
          <text>{run?.workflow ?? task.workflow ?? 'pipes'}</text>
          {run ? (
            workflowProgress(run)?.map((step) => (
              <StatusText key={step.name} name={step.name} status={step.status} />
            ))
          ) : (
            <text fg="#a6adc8">[s] start workflow</text>
          )}
        </box>
      </box>
      <box flexDirection="column">
        <text>Activity · newest first</text>
        {summaries.map((summary) => (
          <text key={summary}>{summary}</text>
        ))}
        {events.slice(0, 5).map((event) => (
          <text fg="#a6adc8" key={event.id}>
            {event.createdAt} · {event.kind}
          </text>
        ))}
      </box>
      <box flexDirection="column">
        <text>Description · [b] {requestExpanded ? 'collapse' : 'expand'}</text>
        <box maxHeight={requestExpanded ? undefined : 3} overflow="hidden">
          <box
            flexShrink={0}
            onSizeChange={function () {
              setDescriptionClipped(this.height > 3);
            }}
          >
            <text wrapMode="word">{task.brief || 'No brief supplied.'}</text>
          </box>
        </box>
        {!requestExpanded && descriptionClipped && <text>...</text>}
      </box>
    </box>
  );
}

export function App({
  onboardingDirectory,
  onJumpIn,
  onQuit,
  runtime,
  startDirectory = process.cwd(),
}: {
  onboardingDirectory?: string;
  onJumpIn: (taskId: string) => Promise<void>;
  onQuit: () => void;
  runtime: Runtime;
  startDirectory?: string;
}) {
  const [snapshot, setSnapshot] = useState(empty);
  const runningIcon = useRunningIcon(snapshot.tasks.some((task) => task.status === 'running'));
  const [selected, setSelected] = useState(0);
  const [pane, setPane] = useState<'queue' | 'task'>('queue');
  const [repositoryIndex, setRepositoryIndex] = useState(0);
  const [mode, setMode] = useState<'queue' | 'register' | 'title' | 'brief' | 'conversation'>(
    'queue',
  );
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manage, setManage] = useState(false);
  const [confirmation, setConfirmation] = useState<DestructiveAction>();
  const [connectionPath, setConnectionPath] = useState<string>();
  const [onboarding, setOnboarding] = useState(() => initialOnboarding(onboardingDirectory));
  const brief = useRef<TextareaRenderable>(null);
  const task = snapshot.tasks[selected];
  const repository = snapshot.repositories[repositoryIndex];
  const run = selectedRun(snapshot, selected);
  const status = connectionStatus(connected, snapshot.tasks.length);
  const [suggestedRoot, dismissSuggestion] = useSuggestedRoot(
    startDirectory,
    snapshot.repositories,
    connected,
    mode === 'queue' && !manage && !onboarding,
  );
  const modal = [onboarding, suggestedRoot, manage, confirmation].find(Boolean);

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
                setSelected((index) => Math.min(index, Math.max(next.tasks.length - 1, 0)));
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

  useTemporaryMessage(success, setSuccess);

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
        setSelected((index) => Math.min(index, Math.max(next.tasks.length - 1, 0)));
        setMode('queue');
      })
      .catch((error: unknown) => setError(String(error)))
      .finally(() => setBusy(false));
  };

  useKeyboard((key) => {
    if (!taskViewActive(mode, modal) || !task || busy) {
      return;
    }
    const actions = taskActions(run);
    if (key.name === 's' && actions.start) {
      save(Effect.flatMap(Client, (client) => client.start({ taskId: task.id })));
    } else if (key.name === 'x' && actions.cancel) {
      setConfirmation({
        action: 'Cancel task',
        message: 'This stops its active work. The workspace and evidence are preserved.',
        run: () => save(Effect.flatMap(Client, (client) => client.cancel({ taskId: task.id }))),
      });
    } else if (key.name === 'j' && actions.jumpIn) {
      save(
        Effect.tryPromise({
          catch: (error) => new PipesError({ message: String(error) }),
          try: () => onJumpIn(task.id),
        }),
      );
    } else if (key.name === 'v' && run) {
      setMode('conversation');
    } else if (key.name === 'd' && actions.discard) {
      setConfirmation({
        action: 'Discard task',
        message: 'This removes the task from the queue while preserving its stored history.',
        run: () => save(Effect.flatMap(Client, (client) => client.discard({ taskId: task.id }))),
      });
    }
  });

  useKeyboard((key) => {
    if (busy || modal || mode === 'register' || mode === 'conversation') {
      return;
    }
    if (key.name === 'escape' && !busy) {
      setMode('queue');
      setError('');
    }
    if (mode === 'queue') {
      runMainAction(key.name, onQuit, () => setManage(true));
      if (key.name === 'n' && repository) {
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
        <text fg={status.color}>{status.text}</text>
      </box>
      <box flexDirection="row" flexGrow={1} gap={1} minHeight={0}>
        <box border flexDirection="column" padding={1} title="Queue" width="33%">
          {snapshot.tasks.length ? (
            <ChoiceList
              focused={paneFocused(mode, pane, 'queue', modal)}
              maxVisible={12}
              onChange={(index) => setSelected(index)}
              options={snapshot.tasks.map((item) => ({
                detail: `${statusVisuals[item.status].label} · ${item.sourceId?.split(':', 1)[0] ?? 'manual'}`,
                id: item.id,
                name: `${item.status === 'running' ? runningIcon : statusVisuals[item.status].icon} ${item.title}`,
              }))}
              selectedIndex={selected}
            />
          ) : (
            <text flexGrow={1}>{emptyQueue(repository?.name)}</text>
          )}
          <box border={['top']} borderColor="#585b70" flexShrink={0} paddingTop={1} width="100%">
            <text fg="#a6adc8">[n] new</text>
          </box>
        </box>
        <box border flexDirection="column" flexGrow={1} padding={1} title="Task">
          {task ? (
            <scrollbox
              flexGrow={1}
              focused={paneFocused(mode, pane, 'task', modal)}
              key={task.id}
              minHeight={0}
            >
              <TaskDetails
                active={taskViewActive(mode, modal)}
                repository={
                  snapshot.repositories.find((repo) => repo.id === task.repositoryId)?.name
                }
                run={run}
                snapshot={snapshot}
                task={task}
              />
            </scrollbox>
          ) : (
            <text flexGrow={1}>Select a task to track its progress.</text>
          )}
          <box
            border={['top']}
            borderColor="#585b70"
            flexDirection="row"
            flexShrink={0}
            justifyContent="space-between"
            paddingTop={1}
            width="100%"
          >
            <text fg="#a6adc8">{shortcuts(busy, task, run)}</text>
            <text fg="#a6adc8">{viewShortcut(busy, run)}</text>
          </box>
        </box>
      </box>
      {mode === 'register' && (
        <RepositoryConnection
          initialPath={connectionPath}
          onClose={() => {
            setConnectionPath(undefined);
            setMode('queue');
          }}
          onConnected={() => {
            setConnectionPath(undefined);
            setMode('queue');
          }}
          repositories={snapshot.repositories}
          runtime={runtime}
          startDirectory={startDirectory}
        />
      )}
      {mode === 'title' && (
        <box
          border
          padding={1}
          title={`New task in ${repository?.name} · [Enter] continues · [Esc] cancels`}
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
        <box
          border
          height={8}
          padding={1}
          title="Markdown brief · [Ctrl+S] submits · [Esc] cancels"
        >
          <textarea
            flexGrow={1}
            focused={!busy}
            placeholder="Describe the work and what success looks like…"
            ref={brief}
          />
        </box>
      )}
      {success && <text fg="#a6e3a1">✓ Setup complete · {success}</text>}
      {error && <text fg="#f38ba8">{error}</text>}
      <box border={['top']} borderColor="#585b70" flexShrink={0} paddingTop={1} width="100%">
        <text fg="#a6adc8">[m] manage [q] quit</text>
      </box>
      <ConfirmationAlert
        destructiveAction={confirmation}
        onClose={() => setConfirmation(undefined)}
      />
      {mode === 'conversation' && task && (
        <Conversation
          onClose={() => setMode('queue')}
          runtime={runtime}
          taskId={task.id}
          title={task.title}
        />
      )}
      {suggestedRoot && (
        <ConnectRepository
          busy={busy}
          error={error}
          onConfirm={() => {
            setConnectionPath(suggestedRoot);
            dismissSuggestion();
            setMode('register');
          }}
          onDecline={dismissSuggestion}
          path={suggestedRoot}
        />
      )}
      <Manage
        onClose={() => setManage(false)}
        open={manage}
        repositories={snapshot.repositories}
        repositoryPath={repository?.path ?? startDirectory}
        runtime={runtime}
        startDirectory={startDirectory}
      />
      {onboarding && (
        <Onboarding
          directory={onboarding}
          onClose={(path, summary) => {
            if (summary) {
              setSuccess(summary);
            }
            setRepositoryIndex(
              Math.max(
                0,
                snapshot.repositories.findIndex((repository) => repository.path === path),
              ),
            );
            dismissSuggestion();
            setOnboarding(undefined);
          }}
          runtime={runtime}
          startDirectory={startDirectory}
        />
      )}
    </box>
  );
}
