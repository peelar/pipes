// Baked in at release build time with `bun build --define`.
export const version = process.env.PIPES_VERSION ?? '0.0.1-dev';

// Test PR: no functional change.
