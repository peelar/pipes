import { PipesError } from '@pipes/protocol';

export const failure = (error: unknown) =>
  error instanceof PipesError ? error : new PipesError({ message: String(error) });
