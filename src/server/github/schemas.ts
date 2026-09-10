import { Schema } from 'effect';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '../../config';
import { Brief, Title } from '../../protocol/pipes';

export const GitHubIssue = Schema.Struct({
  assignees: Schema.Array(Schema.Struct({ id: Schema.Int })),
  body: Schema.NullOr(Brief),
  id: Schema.Int,
  number: Schema.Int,
  pull_request: Schema.optionalKey(Schema.Unknown),
  state: Schema.Literals(['open', 'closed']),
  title: Title,
});

export const eligible = (
  issue: typeof GitHubIssue.Type,
  policy: NonNullable<Config['github']>,
  userId: number,
) =>
  issue.pull_request === undefined &&
  ((policy.state ?? 'open') === 'all' || issue.state === (policy.state ?? 'open')) &&
  (policy.assigned_to_me === false || issue.assignees.some((user) => user.id === userId));

export const validSignature = (body: string, signature: string | null, secret: string) => {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
};

export const WebhookPayload = Schema.Struct({
  issue: Schema.Struct({ number: Schema.Int }),
  repository: Schema.Struct({
    full_name: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  }),
});

export const DeviceAuthorization = Schema.Struct({
  device_code: Schema.NonEmptyString,
  interval: Schema.Int,
  user_code: Schema.NonEmptyString,
  verification_uri: Schema.NonEmptyString,
});

export const OAuthToken = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.optionalKey(Schema.Int),
  refresh_token: Schema.optionalKey(Schema.NonEmptyString),
});

export const OAuthError = Schema.Struct({
  error: Schema.NonEmptyString,
  error_description: Schema.optionalKey(Schema.String),
});

export const SavedCredential = Schema.Struct({
  accessToken: Schema.NonEmptyString,
  expiresAt: Schema.optionalKey(Schema.Int),
  refreshToken: Schema.optionalKey(Schema.NonEmptyString),
});
