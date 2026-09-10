import { Effect, Schema } from 'effect';
import { HttpBody, HttpClientResponse } from 'effect/unstable/http';
import { readFile, writeFile } from 'node:fs/promises';
import { PipesError } from '../../protocol/pipes';
import type { GitHubContext } from './context';
import { DeviceAuthorization, OAuthError, OAuthToken, SavedCredential } from './schemas';

export const requestError = (error?: unknown) =>
  Schema.is(PipesError)(error)
    ? error
    : new PipesError({
        message:
          'GitHub intake failed. Check the token, repository access, and intake configuration.',
      });

export const oauth = Effect.fn('GitHub.oauth')(function* (
  ctx: GitHubContext,
  path: 'device/code' | 'oauth/access_token',
  params: Record<string, string>,
) {
  return yield* ctx.client
    .post(`https://github.com/login/${path}`, {
      body: HttpBody.urlParams(params),
      headers: { Accept: 'application/json' },
    })
    .pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Unknown)),
      Effect.timeout('30 seconds'),
      Effect.mapError(requestError),
    );
});

export const saveCredential = Effect.fn('GitHub.saveCredential')(function* (
  ctx: GitHubContext,
  token: typeof OAuthToken.Type,
) {
  // ponytail: a mode-0600 file is the cross-platform baseline; move it to an OS
  // credential store when Pipes adopts one that works on both macOS and Linux.
  yield* Effect.tryPromise({
    catch: requestError,
    try: () =>
      writeFile(
        ctx.credentialFile,
        JSON.stringify({
          accessToken: token.access_token,
          ...(token.expires_in ? { expiresAt: Date.now() + token.expires_in * 1000 } : {}),
          ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
        }),
        { mode: 0o600 },
      ),
  });
  return token.access_token;
});

export const credential = Effect.fn('GitHub.credential')(function* (ctx: GitHubContext) {
  const saved = yield* Effect.tryPromise({
    catch: () =>
      new PipesError({
        message: 'Sign in to GitHub through pipes.',
      }),
    try: () => readFile(ctx.credentialFile, 'utf8'),
  }).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(SavedCredential))),
    Effect.mapError(requestError),
  );
  if (!saved.expiresAt || saved.expiresAt > Date.now() + 60_000) {
    return saved.accessToken;
  }
  if (!saved.refreshToken) {
    return yield* new PipesError({
      message: 'Your GitHub sign-in expired. Sign in again.',
    });
  }
  const refreshed = yield* oauth(ctx, 'oauth/access_token', {
    client_id: ctx.clientId,
    grant_type: 'refresh_token',
    refresh_token: saved.refreshToken,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Union([OAuthToken, OAuthError]))),
    Effect.mapError(requestError),
  );
  if ('error' in refreshed) {
    return yield* new PipesError({
      message: refreshed.error_description ?? 'Your GitHub sign-in could not be refreshed.',
    });
  }
  return yield* saveCredential(ctx, refreshed);
});

export const get = Effect.fn('GitHub.get')(function* (ctx: GitHubContext, path: string) {
  const token = yield* credential(ctx);
  return yield* ctx.client
    .get(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    .pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Unknown)),
      Effect.timeout('30 seconds'),
      Effect.mapError(requestError),
    );
});

export const identity = Effect.fn('GitHub.identity')(function* (ctx: GitHubContext) {
  return yield* get(ctx, '/user').pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Int, login: Schema.NonEmptyString })),
    ),
    Effect.mapError(requestError),
  );
});

export const loginStart = Effect.fn('GitHub.loginStart')(function* (ctx: GitHubContext) {
  const result = yield* oauth(ctx, 'device/code', { client_id: ctx.clientId }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(DeviceAuthorization)),
    Effect.mapError(requestError),
  );
  return {
    deviceCode: result.device_code,
    interval: result.interval,
    userCode: result.user_code,
    verificationUri: result.verification_uri,
  };
});

export const loginComplete = Effect.fn('GitHub.loginComplete')(function* (
  ctx: GitHubContext,
  input: { deviceCode: string; interval: number },
) {
  let interval = Math.max(input.interval, 1);
  for (;;) {
    yield* Effect.sleep(`${interval} seconds`);
    const result = yield* oauth(ctx, 'oauth/access_token', {
      client_id: ctx.clientId,
      device_code: input.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Union([OAuthToken, OAuthError]))),
      Effect.mapError(requestError),
    );
    if ('access_token' in result) {
      yield* saveCredential(ctx, result);
      return yield* identity(ctx).pipe(Effect.map((user) => user.login));
    }
    if (result.error === 'authorization_pending') {
      continue;
    }
    if (result.error === 'slow_down') {
      interval += 5;
      continue;
    }
    return yield* new PipesError({
      message: result.error_description ?? 'GitHub sign-in did not complete.',
    });
  }
});
