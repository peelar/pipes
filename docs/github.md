# GitHub intake setup

In the TUI, press **[c] connect**. Selecting a local repository offers to attach
intake from its GitHub remotes, or continue with **Local only**. Already connected
repositories can be selected again to attach intake.

For another GitHub repository, press **[g] GitHub** in the picker and enter
`owner/repo`, an HTTPS URL, or an SSH URL. Confirming clones it under
`<Pipes data directory>/repositories/owner/repo`. Only connect repositories you
trust: Pipes loads executable TypeScript configuration from the checkout.
Existing managed clones are reused, not fetched or reset.

Pipes identifies your GitHub account, then asks which configured workflow should
receive issues. If none exists, the UI offers the Codex/starter workflow setup.
Confirming creates `.pipes/github.ts` and imports matching issues. Existing
configuration and policy are preserved. Edit policy in code to change it.

Authentication uses `GH_TOKEN` or `GITHUB_TOKEN` from the server environment,
falling back to an existing `gh auth login` session when the GitHub CLI is available.
An authentication failure can be retried in the connection UI.

## Manual configuration

Add `github` to your repository's existing `.pipes/pipes.ts` export:

```ts
github: {
  repository: 'owner/repository',
  workflow: 'plan-implement-review', // Must name an existing workflow.
  assigned_to_me: true,
  state: 'open',
},
```

The last two fields are optional and show the defaults. Set `assigned_to_me: false`
to remove the assignment restriction; `state` accepts `open`, `closed`, or `all`.
With inline configuration only, omit `github` to disable intake for that local repository.

Alternatively, export that policy as the default from `.pipes/github.ts`, as the
UI does. Define policy in only one of these files. To disable intake, remove the
policy from whichever file supplies it.

Provide a personal GitHub token in `GH_TOKEN` or `GITHUB_TOKEN` in the server's
environment (or use the existing GitHub CLI login). The token must identify your user and have read access to issues in
the target repository. Keep it out of repository configuration.

Register the local checkout with `pipes register /path/to/repository`. Intake runs
on registration and server startup. After changing configuration, or to catch up
without restarting, use `pipes github --repo <registered-repository-id>`.
`pipes list --json` includes repository IDs, task source links, and workflow routes.
The command reports matching observations, including already imported issues.

For continuous intake, set `PIPES_GITHUB_WEBHOOK_SECRET` in the server environment
and restart it. The webhook listener binds to `127.0.0.1:9419`; optionally change
the port with `PIPES_GITHUB_PORT`. Expose that listener through your own HTTPS tunnel
or reverse proxy. In the target GitHub repository's webhook settings, configure:

- Payload URL: your public endpoint with path `/github`.
- Content type: `application/json`.
- Secret: the same value as `PIPES_GITHUB_WEBHOOK_SECRET`.
- Events: Issues.

Expose only the webhook listener, not the privileged RPC listener. Deliveries use
[GitHub's signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
Failed intake returns an error; retry the delivery or run the intake command to
catch up. Server startup also catches up on currently eligible issues.

Tasks appear in the existing queue. Agent execution is not connected yet.
