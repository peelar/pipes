import { Logger } from 'effect';

export const ObservabilityLayer = Logger.layer([
  Logger.withConsoleError(Logger.formatJson),
  Logger.tracerLogger,
]);
