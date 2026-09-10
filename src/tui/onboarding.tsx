import { Schema, type ManagedRuntime } from 'effect';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { Client } from '../client/connection';
import { CodexSetup } from './codex-setup';
import { RepositoryConnection } from './repository-connection';

const Progress = Schema.Struct({
  complete: Schema.Boolean,
  path: Schema.optionalKey(Schema.String),
});

export function readOnboarding(directory: string) {
  try {
    return Schema.decodeSync(Schema.fromJsonString(Progress))(
      readFileSync(join(directory, 'onboarding.json'), 'utf8'),
    );
  } catch (error) {
    if (Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))(error)) {
      return { complete: false };
    }
    throw error;
  }
}

export function Onboarding({
  directory,
  onClose,
  runtime,
  startDirectory,
}: {
  directory: string;
  onClose: (path?: string, summary?: string) => void;
  runtime: ManagedRuntime.ManagedRuntime<Client, never>;
  startDirectory: string;
}) {
  const [state, setState] = useState<{ status: 'repository' } | { path: string; status: 'codex' }>(
    () => {
      const { path } = readOnboarding(directory);
      return path ? { path, status: 'codex' } : { status: 'repository' };
    },
  );
  const persist = (next: typeof Progress.Type) => {
    const filename = join(directory, 'onboarding.json');
    writeFileSync(`${filename}.tmp`, JSON.stringify(next), { mode: 0o600 });
    renameSync(`${filename}.tmp`, filename);
  };
  if (state.status === 'codex') {
    const { path } = state;
    return (
      <CodexSetup
        onClose={() => onClose(path)}
        onReady={(summary) => {
          persist({ complete: true, path });
          onClose(path, summary);
        }}
        path={path}
        runtime={runtime}
      />
    );
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
        flexDirection="column"
        gap={1}
        maxWidth={100}
        padding={1}
        title="Setup · 1/3 · Connect repository"
        width="95%"
      >
        <text>
          Welcome to pipes. Connect a Git repository, set up Codex, then configure a workflow.
        </text>
        <RepositoryConnection
          onClose={() => onClose()}
          onConnected={(repository) => {
            persist({ complete: false, path: repository.path });
            setState({ path: repository.path, status: 'codex' });
          }}
          runtime={runtime}
          startDirectory={startDirectory}
        />
        <text>[Esc] finish later · Setup resumes next launch</text>
      </box>
    </box>
  );
}
