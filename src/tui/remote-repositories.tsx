import { Effect, type ManagedRuntime } from 'effect';
import { useEffect, useState } from 'react';
import { Client } from '../client/connection';
import { type GitHubLogin } from '../protocol/pipes';

export const installationUrl = 'https://github.com/apps/pipes-github/installations/new';

export function openBrowser(url: string) {
  try {
    Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', url]);
  } catch {
    // The UI keeps the URL visible when no browser opener is available.
  }
}

export function RemoteRepositories({
  onSelect,
  runtime,
}: {
  onSelect: (repository: string, login: string) => void;
  runtime: ManagedRuntime.ManagedRuntime<Client, never>;
}) {
  const [result, setResult] = useState<{ login: string; repositories: ReadonlyArray<string> }>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [authenticating, setAuthenticating] = useState(false);
  const [authorization, setAuthorization] = useState<typeof GitHubLogin.Type>();
  const [afterInstallation, setAfterInstallation] = useState<'login' | 'reload'>();

  useEffect(() => {
    const controller = new AbortController();
    void runtime
      .runPromise(
        Effect.flatMap(Client, (client) => client.githubRepositories()),
        { signal: controller.signal },
      )
      .then(setResult)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setError(String(error));
        }
      });
    return () => controller.abort();
  }, [runtime, attempt]);

  function reload() {
    setResult(undefined);
    setError('');
    setAttempt((value) => value + 1);
  }

  async function login() {
    setAuthenticating(true);
    setError('');
    try {
      const flow = await runtime.runPromise(
        Effect.flatMap(Client, (client) => client.githubLoginStart()),
      );
      setAuthorization(flow);
      openBrowser(flow.verificationUri);
      await runtime.runPromise(
        Effect.flatMap(Client, (client) =>
          client.githubLoginComplete({ deviceCode: flow.deviceCode, interval: flow.interval }),
        ),
      );
      setAuthorization(undefined);
      reload();
    } catch (error) {
      setAuthorization(undefined);
      setError(String(error));
    } finally {
      setAuthenticating(false);
    }
  }

  function install(next: 'login' | 'reload') {
    setAfterInstallation(next);
    openBrowser(installationUrl);
  }

  if (afterInstallation) {
    return (
      <box flexDirection="column" gap={1}>
        <text>Choose the GitHub account and repositories Pipes may access.</text>
        <text>{installationUrl}</text>
        <select
          focused
          height={4}
          onSelect={(index) => {
            if (index === 0) {
              const next = afterInstallation;
              setAfterInstallation(undefined);
              if (next === 'login') {
                void login();
              } else {
                reload();
              }
            } else {
              openBrowser(installationUrl);
            }
          }}
          options={[
            { description: 'Continue after choosing access in GitHub', name: 'Done' },
            { description: 'Open the GitHub installation page again', name: 'Open GitHub' },
          ]}
        />
      </box>
    );
  }

  if (authorization) {
    return (
      <box flexDirection="column" gap={1}>
        <text>Enter this code at {authorization.verificationUri}</text>
        <text fg="#89b4fa">{authorization.userCode}</text>
        <text fg="#f9e2af">Waiting for GitHub approval…</text>
      </box>
    );
  }

  if (error) {
    return (
      <box flexDirection="column">
        <text fg="#f38ba8">{error}</text>
        <select
          focused={!authenticating}
          height={4}
          onSelect={(index) => {
            if (index === 0) {
              install('login');
            } else {
              reload();
            }
          }}
          options={[
            {
              description: 'Choose account and repository access in GitHub',
              name: 'Connect GitHub',
            },
            { description: 'Check credentials and load repositories again', name: 'Retry' },
          ]}
        />
      </box>
    );
  }
  if (!result) {
    return <text fg="#f9e2af">Loading GitHub repositories…</text>;
  }
  return (
    <box flexDirection="column" gap={1}>
      <text fg="#a6e3a1">Connected to GitHub as @{result.login}</text>
      <text>Only connect repositories you trust: configuration is executable TypeScript.</text>
      {result.repositories.length ? (
        <select
          focused
          height={10}
          onSelect={(index) => {
            const repository = result.repositories[index];
            if (repository) {
              onSelect(repository, result.login);
            } else {
              install('reload');
            }
          }}
          options={[
            ...result.repositories.map((name) => ({
              description: 'Clone into Pipes’ managed directory',
              name,
            })),
            {
              description: 'Change account and repository access in GitHub',
              name: 'Manage GitHub access',
            },
          ]}
          showScrollIndicator
        />
      ) : (
        <select
          focused
          height={4}
          onSelect={(index) => (index === 0 ? install('reload') : reload())}
          options={[
            {
              description: 'Choose account and repository access in GitHub',
              name: 'Manage GitHub access',
            },
            { description: 'Load repositories again', name: 'Retry' },
          ]}
        />
      )}
    </box>
  );
}
