import { useKeyboard } from '@opentui/react';
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { useEffect, useState } from 'react';

const exec = promisify(execFile);

export function useSuggestedRoot(
  directory: string,
  repositories: ReadonlyArray<{ path: string }>,
  connected: boolean,
  visible: boolean,
) {
  const [root, setRoot] = useState<string>();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    let active = true;
    void gitRoot(directory).then((value) => {
      if (active) {
        setRoot(value);
      }
    });
    return () => {
      active = false;
    };
  }, [directory]);
  const suggested =
    connected && visible && !dismissed && root && !repositories.some((repo) => repo.path === root)
      ? root
      : undefined;
  return [suggested, () => setDismissed(true)] as const;
}

export function ConnectRepository({
  busy,
  error,
  onConfirm,
  onDecline,
  path,
}: {
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onDecline: () => void;
  path: string;
}) {
  useKeyboard((key) => {
    if (busy) {
      return;
    }
    if (key.name === 'y') {
      onConfirm();
    } else if (key.name === 'n' || key.name === 'escape') {
      onDecline();
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
        maxWidth={80}
        padding={1}
        title="Connect repository"
        width="90%"
      >
        <text fg="#82aaff">Do you want to connect this repository in Pipes?</text>
        <text>{path}</text>
        <text>This connects the repository locally. No repository files are changed.</text>
        <select
          focused={!busy}
          height={4}
          onSelect={(index) => {
            if (!busy) {
              if (index === 0) {
                onConfirm();
              } else {
                onDecline();
              }
            }
          }}
          options={[
            { description: 'Connect this repository in Pipes', name: 'Yes, connect' },
            { description: 'Continue without connecting', name: 'No, not now' },
          ]}
        />
        <text>
          {busy ? 'Connecting…' : '[↑↓] choose · [Enter] confirm · [y] yes · [n] / [Esc] not now'}
        </text>
        {error && <text fg="#f38ba8">{error}</text>}
      </box>
    </box>
  );
}

export async function gitRoot(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git', ['-C', path, 'rev-parse', '--show-toplevel'], {
      timeout: 3000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function expandPath(path: string, base: string) {
  return resolve(
    base,
    path === '~' ? homedir() : path.startsWith('~/') ? homedir() + path.slice(1) : path,
  );
}

export async function directories(path: string) {
  const entries = await readdir(path, { withFileTypes: true });
  const folders: Array<string> = [];
  for (const entry of entries) {
    if (entry.name === '.git') {
      continue;
    }
    if (
      entry.isDirectory() ||
      (entry.isSymbolicLink() &&
        (await stat(resolve(path, entry.name)).then(
          (info) => info.isDirectory(),
          () => false,
        )))
    ) {
      folders.push(entry.name);
    }
  }
  return folders.sort((a, b) => a.localeCompare(b));
}

export async function completePath(value: string, base: string) {
  const path = expandPath(value, base);
  const parent = value.endsWith(sep) || value === '~' || value === '' ? path : dirname(path);
  const prefix = parent === path ? '' : basename(path);
  const matches = (await directories(parent)).filter((name) => name.startsWith(prefix));
  if (!matches.length) {
    return { message: 'No matching directories.', value };
  }
  let common = matches[0]!;
  for (const match of matches) {
    while (!match.startsWith(common)) {
      common = common.slice(0, -1);
    }
  }
  return {
    message: matches.length === 1 ? '' : matches.join('  '),
    value: resolve(parent, common) + (matches.length === 1 ? sep : ''),
  };
}

export function RepositoryPicker({
  busy,
  onGitHub,
  onRegister,
  repositories = [],
  startDirectory,
}: {
  busy: boolean;
  onGitHub?: () => void;
  onRegister: (path: string) => void;
  repositories?: ReadonlyArray<{ name: string; path: string }>;
  startDirectory: string;
}) {
  const [directory, setDirectory] = useState(startDirectory);
  const [listing, setListing] = useState<{ folders: Array<string>; path: string; root?: string }>();
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState('');
  const [message, setMessage] = useState('');
  const ready = listing?.path === directory;

  useEffect(() => {
    let active = true;
    void Promise.all([directories(directory), gitRoot(directory)])
      .then(([folders, root]) => {
        if (active) {
          setListing({ folders, path: directory, root });
          setMessage('');
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setMessage(String(error));
        }
      });
    return () => {
      active = false;
    };
  }, [directory]);

  useKeyboard((key) => {
    if (busy) {
      return;
    }
    if (editing) {
      if ((key.name === 'tab' && !onGitHub) || (key.ctrl && key.name === 'e')) {
        key.preventDefault();
        void completePath(path, directory)
          .then((result) => {
            setPath(result.value);
            setMessage(result.message);
          })
          .catch((error: unknown) => setMessage(String(error)));
      }
    } else if (key.name === 'g' && onGitHub) {
      onGitHub();
    } else if (key.name === 'p') {
      setPath('');
      setEditing(true);
    } else if (key.name === 'left') {
      setDirectory(dirname(directory));
    }
  });

  const options = [
    ...(ready &&
    listing.root &&
    (onGitHub || !repositories.some((repository) => repository.path === listing.root))
      ? [
          {
            action: 'register' as const,
            description: listing.root,
            name: 'Connect this repository',
            value: listing.root,
          },
        ]
      : []),
    {
      action: 'browse' as const,
      description: 'Parent directory',
      name: '..',
      value: dirname(directory),
    },
    ...(ready
      ? listing.folders.map((name) => ({
          action: 'browse' as const,
          description: '',
          name: `${name}/`,
          value: resolve(directory, name),
        }))
      : []),
    ...repositories.map((repository) => ({
      action: 'browse' as const,
      description: repository.path,
      name: `Connected: ${repository.name}`,
      value: repository.path,
    })),
  ];

  return (
    <box
      border
      flexDirection="column"
      flexShrink={0}
      height={12}
      padding={1}
      title={`Connect · [Enter] selects · [←] parent · [p] path · [Esc] cancels`}
    >
      <text>{directory}</text>
      <text fg="#a6e3a1">
        {ready
          ? listing.root
            ? `Git repository: ${listing.root}`
            : 'Not a Git repository'
          : 'Reading directory…'}
      </text>
      {editing ? (
        <input
          focused={!busy}
          onInput={setPath}
          onSubmit={(value) => {
            if (!busy && typeof value === 'string') {
              setDirectory(expandPath(value, directory));
              setEditing(false);
            }
          }}
          placeholder="Path (relative to displayed directory) · [Ctrl+e] completes · [Enter] opens"
          value={path}
        />
      ) : ready ? (
        <select
          flexGrow={1}
          focused={!busy}
          key={`${directory}:${ready}`}
          onSelect={(index) => {
            const option = options[index];
            if (!option || busy) {
              return;
            }
            if (option.action === 'register') {
              onRegister(option.value);
            } else {
              setDirectory(option.value);
            }
          }}
          options={options}
          showScrollIndicator
        />
      ) : null}
      {message && <text fg="#f9e2af">{message}</text>}
    </box>
  );
}
