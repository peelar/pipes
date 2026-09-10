import type { Context } from 'effect';
import type { HttpClient } from 'effect/unstable/http';
import type { ChildProcessSpawner } from 'effect/unstable/process';
import type { Store } from '../store';

export interface GitHubContext {
  client: HttpClient.HttpClient;
  clientId: string;
  credentialFile: string;
  runContext: Context.Context<never>;
  spawner: ChildProcessSpawner.ChildProcessSpawner['Service'];
  store: Store['Service'];
}
