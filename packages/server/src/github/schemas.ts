import { Schema } from 'effect';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '@pipes/protocol';
import { Brief, Title } from '@pipes/protocol';

export const GitHubIssue = Schema.Struct({
  assignees: Schema.Array(Schema.Struct({ id: Schema.Int })),
  body: Schema.NullOr(Brief),
  id: Schema.Int,
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  number: Schema.Int,
  pull_request: Schema.optionalKey(Schema.Unknown),
  state: Schema.Literals(['open', 'closed']),
  title: Title,
});

type Policy = NonNullable<Config['github']>;
type When = Pick<Policy, 'assigned_to_me' | 'exclude_labels' | 'labels' | 'state'>;

const names = (issue: typeof GitHubIssue.Type) =>
  issue.labels.map((label) => label.name.toLowerCase());

export const matches = (issue: typeof GitHubIssue.Type, when: When, userId: number) =>
  issue.pull_request === undefined &&
  ((when.state ?? 'open') === 'all' || issue.state === (when.state ?? 'open')) &&
  (when.assigned_to_me === false || issue.assignees.some((user) => user.id === userId)) &&
  (when.labels ?? []).every((wanted) => names(issue).includes(wanted.toLowerCase())) &&
  !(when.exclude_labels ?? []).some((skipped) => names(issue).includes(skipped.toLowerCase()));

export const eligible = (issue: typeof GitHubIssue.Type, policy: Policy, userId: number) =>
  matches(issue, policy, userId);

/**
 * First matching route wins; its workflow may be absent, which admits the
 * issue to the inbox without a preassigned workflow. When no route matches,
 * the top-level policy acts as the catch-all filter and fallback workflow.
 * Returns `false` when the issue is not eligible for intake.
 */
export const routeWorkflow = (
  issue: typeof GitHubIssue.Type,
  policy: Policy,
  userId: number,
): string | undefined | false => {
  for (const route of policy.routes ?? []) {
    if (
      matches(
        issue,
        {
          assigned_to_me: route.assigned_to_me ?? policy.assigned_to_me,
          exclude_labels: [...(policy.exclude_labels ?? []), ...(route.exclude_labels ?? [])],
          labels: route.labels ?? policy.labels,
          state: route.state ?? policy.state,
        },
        userId,
      )
    ) {
      return route.workflow ?? policy.workflow;
    }
  }
  if (!matches(issue, policy, userId)) {
    return false;
  }
  return policy.workflow;
};

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
