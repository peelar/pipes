import { PipesError } from '../protocol/pipes';

export const failure = (error: unknown) =>
  error instanceof PipesError ? error : new PipesError({ message: String(error) });
