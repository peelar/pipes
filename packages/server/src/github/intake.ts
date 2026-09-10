import { Effect, Schema } from 'effect';
import type { Config } from '@pipes/protocol';
import { PipesError, type Repository } from '@pipes/protocol';
import { get, identity, requestError } from './auth';
import type { GitHubContext } from './context';
import { policyFor } from './repos';
import { eligible, GitHubIssue } from './schemas';

export const admit = Effect.fn('GitHub.admit')(function* (
  ctx: GitHubContext,
  repository: Repository,
  policy: NonNullable<Config['github']>,
  userId: number,
  issue: typeof GitHubIssue.Type,
) {
  if (!eligible(issue, policy, userId)) {
    return 0;
  }
  yield* ctx.store.submit({
    brief: issue.body ?? '',
    repositoryId: repository.id,
    sourceId: `github:${issue.id}`,
    sourceUrl: `https://github.com/${policy.repository}/issues/${issue.number}`,
    title: issue.title,
    workflow: policy.workflow,
  });
  return 1;
});

export const intake = Effect.fn('GitHub.intake')(function* (
  ctx: GitHubContext,
  repositoryId: string,
) {
  const repository = (yield* ctx.store.snapshot).repositories.find(
    (entry) => entry.id === repositoryId,
  );
  if (!repository) {
    return yield* new PipesError({
      message: 'Register the repository before GitHub intake.',
    });
  }
  const policy = yield* policyFor(ctx, repository);
  if (!policy) {
    return 0;
  }
  const user = yield* identity(ctx);
  let matched = 0;
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({
      direction: 'asc',
      page: String(page),
      per_page: '100',
      sort: 'created',
      state: policy.state ?? 'open',
    });
    if (policy.assigned_to_me !== false) {
      query.set('assignee', user.login);
    }
    const issues = yield* get(ctx, `/repos/${policy.repository}/issues?${query}`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(GitHubIssue))),
      Effect.mapError(requestError),
    );
    for (const issue of issues) {
      matched += yield* admit(ctx, repository, policy, user.id, issue);
    }
    if (issues.length < 100) {
      return matched;
    }
  }
});

export const receive = Effect.fn('GitHub.receive')(function* (
  ctx: GitHubContext,
  body: { fullName: string; issueNumber: number },
) {
  for (const repository of (yield* ctx.store.snapshot).repositories) {
    const policy = yield* policyFor(ctx, repository);
    if (!policy || policy.repository.toLowerCase() !== body.fullName.toLowerCase()) {
      continue;
    }
    const user = yield* identity(ctx);
    // Fetch current state so delayed webhook deliveries cannot admit a now-ineligible issue.
    const issue = yield* get(ctx, `/repos/${policy.repository}/issues/${body.issueNumber}`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GitHubIssue)),
      Effect.mapError(requestError),
    );
    yield* admit(ctx, repository, policy, user.id, issue);
  }
});

export const startup = Effect.fn('GitHub.startup')(function* (ctx: GitHubContext) {
  yield* Effect.gen(function* () {
    for (const repository of (yield* ctx.store.snapshot).repositories) {
      yield* intake(ctx, repository.id).pipe(
        Effect.catch((error) => Effect.logError(error.message)),
      );
    }
  }).pipe(Effect.catch((error) => Effect.logError(error.message)));
});
