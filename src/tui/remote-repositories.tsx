import { useRenderer } from '@opentui/react';
import { Effect, type ManagedRuntime } from 'effect';
import { useEffect, useState } from 'react';
import { Client } from '../client/connection';

export function RemoteRepositories({
  onSelect,
  runtime,
}: {
  onSelect: (repository: string, login: string) => void;
  runtime: ManagedRuntime.ManagedRuntime<Client, never>;
}) {
  const renderer = useRenderer();
  const [result, setResult] = useState<{ login: string; repositories: ReadonlyArray<string> }>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [authenticating, setAuthenticating] = useState(false);

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
    renderer.suspend();
    try {
      const code = await Bun.spawn(
        ['gh', 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'],
        // Avoid gh's Enter prompt blocking detection of browser approval.
        { stderr: 'inherit', stdin: 'ignore', stdout: 'inherit' },
      ).exited;
      if (code !== 0) {
        throw new Error('GitHub sign-in did not complete. Retry when ready.');
      }
      reload();
    } catch (error) {
      setError(`Cannot sign in with gh. Check that GitHub CLI is installed. ${String(error)}`);
    } finally {
      renderer.resume();
      setAuthenticating(false);
    }
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
              void login();
            } else {
              reload();
            }
          }}
          options={[
            {
              description: 'Continue with GitHub CLI browser authentication',
              name: 'Sign in to GitHub',
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
            }
          }}
          options={result.repositories.map((name) => ({
            description: 'Clone into Pipes’ managed directory',
            name,
          }))}
          showScrollIndicator
        />
      ) : (
        <text>No repositories accessible to this GitHub account.</text>
      )}
    </box>
  );
}
