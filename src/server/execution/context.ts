import type { Context, Fiber, Scope, Semaphore } from 'effect';
import type { Environment } from '../environment';
import type { Run } from '../../protocol/pipes';
import type { Store } from '../store';

export interface ExecutionContext {
  activeRuns: Map<string, () => Run>;
  cancellations: Set<string>;
  directory: string;
  environment: Environment['Service'];
  runContext: Context.Context<never>;
  scope: Scope.Scope;
  slots: Semaphore.Semaphore;
  starting: Semaphore.Semaphore;
  store: Store['Service'];
  workers: Map<string, Fiber.Fiber<void, never>>;
}
