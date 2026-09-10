import { Effect, Schema } from 'effect';
import type { GitHubContext } from './context';
import { receive } from './intake';
import { requestError } from './auth';
import { validSignature, WebhookPayload } from './schemas';

export const webhook = async (ctx: GitHubContext, request: Request) => {
  const secret = process.env.PIPES_GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return new Response('GitHub webhook is not configured', { status: 503 });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  const body = await request.text();
  if (!validSignature(body, request.headers.get('x-hub-signature-256'), secret)) {
    return new Response('Forbidden', { status: 403 });
  }
  if (request.headers.get('x-github-event') !== 'issues') {
    return new Response('OK');
  }
  const payload = await Effect.runPromise(
    Schema.decodeEffect(Schema.fromJsonString(WebhookPayload))(body).pipe(
      Effect.mapError(requestError),
    ),
  ).catch(() => undefined);
  if (!payload) {
    return new Response('Intake failed; retry delivery', { status: 503 });
  }
  return Effect.runPromiseWith(ctx.runContext)(
    receive(ctx, {
      fullName: payload.repository.full_name,
      issueNumber: payload.issue.number,
    }).pipe(
      Effect.as(new Response('OK')),
      Effect.catch((error) =>
        Effect.logError(error.message).pipe(
          Effect.as(new Response('Intake failed; retry delivery', { status: 503 })),
        ),
      ),
    ),
  );
};
