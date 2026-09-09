import { useKeyboard } from '@opentui/react';
import { Effect, type ManagedRuntime } from 'effect';
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react';
import { Client } from '../client/connection';
import { type GitHubConnection, type GitHubLogin, type Repository } from '../protocol/pipes';
import { CodexSetup } from './codex-setup';
import { installationUrl, openBrowser, RemoteRepositories } from './remote-repositories';
import { RepositoryPicker } from './repository-picker';

type Phase =
  | 'browse'
  | 'remote'
  | 'offer'
  | 'checking'
  | 'install'
  | 'login'
  | 'workflow'
  | 'setup';

function connectionTitle(embedded: boolean) {
  return embedded ? undefined : 'Connect repository';
}

function ConnectionError({ error }: { error: string }) {
  return error ? <text fg="#f38ba8">{error}</text> : null;
}

function repositoriesFor(info: typeof GitHubConnection.Type | undefined) {
  return info?.policy ? [info.policy.repository] : (info?.remotes ?? []);
}

function workflowsFor(info: typeof GitHubConnection.Type | undefined) {
  return info?.policy ? [info.policy.workflow] : (info?.workflows ?? []);
}

function useConnectionKeyboard(
  phase: Phase,
  pending: RefObject<boolean>,
  onClose: () => void,
  setPhase: (phase: Phase) => void,
) {
  useKeyboard((key) => {
    if (!pending.current && phase === 'remote' && key.name === 'b') {
      key.preventDefault();
      setPhase('browse');
    }
    if (phase !== 'setup' && !pending.current && key.name === 'escape') {
      onClose();
    }
  });
}

export function RepositoryConnection({
  embedded = false,
  initialPath,
  onClose,
  onConnected,
  repositories = [],
  runtime,
  startDirectory,
}: {
  embedded?: boolean;
  initialPath?: string;
  onClose: () => void;
  onConnected: (repository: Repository) => void;
  repositories?: ReadonlyArray<Repository>;
  runtime: ManagedRuntime.ManagedRuntime<Client, never>;
  startDirectory: string;
}) {
  const [phase, setPhase] = useState<Phase>('browse');
  const [path, setPath] = useState(initialPath ?? '');
  const [remote, setRemote] = useState('');
  const [info, setInfo] = useState<typeof GitHubConnection.Type>();
  const [account, setAccount] = useState('');
  const [authorization, setAuthorization] = useState<typeof GitHubLogin.Type>();
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

  useConnectionKeyboard(phase, pending, onClose, setPhase);

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

  async function login() {
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const flow = await runtime.runPromise(
        Effect.flatMap(Client, (client) => client.githubLoginStart()),
      );
      setAuthorization(flow);
      setBusy(false);
      setPhase('login');
      openBrowser(flow.verificationUri);
      const login = await runtime.runPromise(
        Effect.flatMap(Client, (client) =>
          client.githubLoginComplete({ deviceCode: flow.deviceCode, interval: flow.interval }),
        ),
      );
      setAccount(login);
    } catch (error) {
      setError(String(error));
    } finally {
      setAuthorization(undefined);
      setPhase('workflow');
      pending.current = false;
      setBusy(false);
    }
  }

  function install() {
    setPhase('install');
    openBrowser(installationUrl);
  }

  if (phase === 'setup') {
    return (
      <CodexSetup
        embedded={embedded}
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
      border={!embedded}
      bottomTitle={connectionHints(phase, embedded)}
      flexDirection="column"
      gap={1}
      padding={1}
      title={connectionTitle(embedded)}
    >
      {phase === 'install' ? (
        <box flexDirection="column" gap={1}>
          <text>Choose the GitHub account and repositories Pipes may access.</text>
          <text>{installationUrl}</text>
          <select
            focused
            height={2}
            onSelect={() => void login()}
            options={[{ description: 'Continue after choosing access in GitHub', name: 'Done' }]}
          />
        </box>
      ) : phase === 'login' && authorization ? (
        <box flexDirection="column" gap={1}>
          <text>Enter this code at {authorization.verificationUri}</text>
          <text fg="#89b4fa">{authorization.userCode}</text>
          <text fg="#f9e2af">Waiting for GitHub approval…</text>
        </box>
      ) : busy || phase === 'checking' ? (
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
        <>
          <text fg="#a6adc8">GitHub repositories · [b] back</text>
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
        </>
      ) : phase === 'offer' ? (
        <>
          <text>{path}</text>
          <text>Attach GitHub issue intake for this repository’s remote?</text>
          <select
            focused={!busy}
            height={6}
            onSelect={(index) => {
              const target = repositoriesFor(info)[index];
              if (target) {
                choose(target);
              } else {
                register(path);
              }
            }}
            options={[
              ...repositoriesFor(info).map((name) => ({
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
              onSelect={install}
              options={[
                {
                  description: 'Signs in through the Pipes GitHub App',
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
                  const workflow = workflowsFor(info)[index];
                  if (workflow) {
                    run(
                      Effect.flatMap(Client, (client) =>
                        client.githubAttach({ path, repository: remote, workflow }),
                      ),
                      onConnected,
                    );
                  }
                }}
                options={workflowsFor(info).map((name) => ({
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
      <ConnectionError error={error} />
    </box>
  );
}

function connectionHints(phase: string, embedded: boolean) {
  if (embedded) {
    return;
  }
  return phase === 'remote'
    ? '[Enter] select · [b] back · [Esc] close'
    : '[Enter] select · [Esc] close';
}

function policySummary(info: typeof GitHubConnection.Type | undefined) {
  return info?.policy
    ? `Existing code policy: ${info.policy.state ?? 'open'} issues · ${info.policy.assigned_to_me === false ? 'any assignee' : 'assigned to you'}`
    : 'Default: open issues assigned to you. Policy stays in code.';
}
