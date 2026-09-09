import { useKeyboard } from '@opentui/react';
import { Effect, type ManagedRuntime } from 'effect';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Client } from '../client/connection';
import { type GitHubConnection, type Repository } from '../protocol/pipes';
import { CodexSetup } from './codex-setup';
import { RemoteRepositories } from './remote-repositories';
import { RepositoryPicker } from './repository-picker';

export function RepositoryConnection({
  initialPath,
  onClose,
  onConnected,
  repositories = [],
  runtime,
  startDirectory,
}: {
  initialPath?: string;
  onClose: () => void;
  onConnected: (repository: Repository) => void;
  repositories?: ReadonlyArray<Repository>;
  runtime: ManagedRuntime.ManagedRuntime<Client, never>;
  startDirectory: string;
}) {
  const [phase, setPhase] = useState<
    'browse' | 'remote' | 'offer' | 'checking' | 'workflow' | 'setup'
  >('browse');
  const [path, setPath] = useState(initialPath ?? '');
  const [remote, setRemote] = useState('');
  const [info, setInfo] = useState<typeof GitHubConnection.Type>();
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(Boolean(initialPath));
  const [error, setError] = useState('');
  const pending = useRef(false);
  const started = useRef(false);

  function run<A>(operation: Effect.Effect<A, unknown, Client>, done: (value: A) => void) {
    if (pending.current) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setError('');
    void runtime
      .runPromise(operation)
      .then(done)
      .catch((error: unknown) => {
        setError(String(error));
        setPhase((current) => (current === 'checking' ? 'workflow' : current));
      })
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  }

  const register = (selected: string) =>
    run(
      Effect.flatMap(Client, (client) => client.register({ path: selected })),
      onConnected,
    );

  function inspect(selected: string, target?: string) {
    setPath(selected);
    setPhase(target ? 'workflow' : 'offer');
    run(
      Effect.gen(function* () {
        const client = yield* Client;
        const details = yield* client.githubInspect({ path: selected });
        const registered =
          !target && !details.remotes.length && !details.policy
            ? yield* client.register({ path: selected })
            : undefined;
        return { details, registered };
      }),
      ({ details, registered }) => {
        setInfo(details);
        if (target) {
          setRemote(target);
        } else if (registered) {
          onConnected(registered);
        }
      },
    );
  }

  const inspectInitial = useEffectEvent(inspect);
  useEffect(() => {
    if (initialPath && !started.current) {
      started.current = true;
      inspectInitial(initialPath);
    }
  }, [initialPath]);

  useKeyboard((key) => {
    if (!pending.current && key.name === 'tab' && ['browse', 'remote'].includes(phase)) {
      key.preventDefault();
      setPhase(phase === 'browse' ? 'remote' : 'browse');
    }
    if (phase !== 'setup' && !pending.current && key.name === 'escape') {
      onClose();
    }
  });

  function choose(target: string) {
    setPhase('checking');
    setRemote(target);
    run(
      Effect.flatMap(Client, (client) => client.githubIdentity()),
      (login) => {
        setAccount(login);
        setPhase('workflow');
      },
    );
  }

  if (phase === 'setup') {
    return (
      <CodexSetup
        onClose={() => setPhase('workflow')}
        onReady={() => inspect(path, remote)}
        path={path}
        runtime={runtime}
      />
    );
  }

  return (
    <box
      backgroundColor="#1e1e2e"
      border
      flexDirection="column"
      gap={1}
      padding={1}
      title="Connect repository"
    >
      <ConnectionTabs phase={phase} />
      {busy || phase === 'checking' ? (
        <text fg="#f9e2af">Connecting…</text>
      ) : phase === 'browse' ? (
        <RepositoryPicker
          busy={busy}
          onGitHub={() => setPhase('remote')}
          onRegister={(selected) => inspect(selected)}
          repositories={repositories}
          startDirectory={startDirectory}
        />
      ) : phase === 'remote' ? (
        <RemoteRepositories
          onSelect={(target, login) => {
            setRemote(target);
            setAccount(login);
            run(
              Effect.gen(function* () {
                const client = yield* Client;
                const cloned = yield* client.githubClone({ repository: target });
                const details = yield* client.githubInspect({ path: cloned });
                return { cloned, details };
              }),
              ({ cloned, details }) => {
                setPath(cloned);
                setInfo(details);
                setPhase('workflow');
              },
            );
          }}
          runtime={runtime}
        />
      ) : phase === 'offer' ? (
        <>
          <text>{path}</text>
          <text>Attach GitHub issue intake for this repository’s remote?</text>
          <select
            focused={!busy}
            height={6}
            onSelect={(index) => {
              const target = (info?.policy ? [info.policy.repository] : (info?.remotes ?? []))[
                index
              ];
              if (target) {
                choose(target);
              } else {
                register(path);
              }
            }}
            options={[
              ...(info?.policy ? [info.policy.repository] : (info?.remotes ?? [])).map((name) => ({
                description: 'Attach GitHub intake',
                name,
              })),
              { description: 'Connect without adding GitHub intake', name: 'Local only' },
            ]}
          />
        </>
      ) : (
        <>
          <text fg="#82aaff">{remote}</text>
          <text fg="#a6adc8">{path}</text>
          <text>
            {account
              ? `Connected to GitHub as @${account}`
              : 'Verify your GitHub account before attaching intake.'}
          </text>
          <text>{policySummary(info)}</text>
          {!account ? (
            <select
              focused={!busy}
              height={2}
              onSelect={() => choose(remote)}
              options={[
                {
                  description: 'Uses GH_TOKEN / GITHUB_TOKEN or your existing gh login',
                  name: 'Check GitHub connection',
                },
              ]}
            />
          ) : !info?.workflows.length ? (
            <select
              focused={!busy}
              height={2}
              onSelect={() => setPhase('setup')}
              options={[
                {
                  description: 'Connect Codex and create the starter configuration',
                  name: 'Set up a workflow',
                },
              ]}
            />
          ) : (
            <>
              <text>
                {info.policy
                  ? 'Keep existing policy and import matching issues.'
                  : 'Choose a workflow. [Enter] creates .pipes/github.ts and imports matching issues.'}
              </text>
              <select
                focused={!busy}
                height={5}
                onSelect={(index) => {
                  const workflow = (info.policy ? [info.policy.workflow] : info.workflows)[index];
                  if (workflow) {
                    run(
                      Effect.flatMap(Client, (client) =>
                        client.githubAttach({ path, repository: remote, workflow }),
                      ),
                      onConnected,
                    );
                  }
                }}
                options={(info.policy ? [info.policy.workflow] : info.workflows).map((name) => ({
                  description: 'Attach intake',
                  name,
                }))}
              />
            </>
          )}
          <text fg="#a6adc8">
            Continuous delivery needs a webhook; this imports currently matching issues.
          </text>
        </>
      )}
      {error && <text fg="#f38ba8">{error}</text>}
      <text fg="#a6adc8">[Esc] close</text>
    </box>
  );
}

function policySummary(info: typeof GitHubConnection.Type | undefined) {
  return info?.policy
    ? `Existing code policy: ${info.policy.state ?? 'open'} issues · ${info.policy.assigned_to_me === false ? 'any assignee' : 'assigned to you'}`
    : 'Default: open issues assigned to you. Policy stays in code.';
}

function ConnectionTabs({ phase }: { phase: string }) {
  return phase === 'browse' || phase === 'remote' ? (
    <text fg="#82aaff">
      {phase === 'browse' ? '[Local]   Remote' : 'Local   [Remote]'} · [Tab] switch
    </text>
  ) : null;
}
