# GitHub intake setup

In the TUI, press **[c] connect**. Selecting a local repository offers to attach
intake from its GitHub remotes, or continue with **Local only**. Already connected
repositories can be selected again to attach intake.

For another GitHub repository, press **[g] GitHub** in the picker and enter
`owner/repo`, an HTTPS URL, or an SSH URL. Confirming clones it under
`<pipes data directory>/repositories/owner/repo`. Only connect repositories you
trust: pipes loads executable TypeScript configuration from the checkout.
Existing managed clones are reused, not fetched or reset.

pipes identifies your GitHub account, then asks which configured workflow should
receive issues. If none exists, the UI offers the Codex/starter workflow setup.
Confirming creates `.pipes/github.ts` and imports matching issues. Existing
configuration and policy are preserved. Edit policy in code to change it.

Authentication uses the pipes GitHub App's device flow. The connection UI first
opens GitHub's installation screen, where you choose the account and repositories,
then guides you through sign-in. Use **Manage GitHub access** in the repository
picker to change those grants later.

## Manual configuration

Add `github` to your repository's existing `.pipes/config.ts` export:

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

Register the local checkout with `pipes register /path/to/repository`. Intake runs
on registration, server startup, and every minute while the server is running.
After changing configuration, or to sync immediately, use
`pipes github --repo <registered-repository-id>`.
`pipes list --json` includes repository IDs, task source links, and workflow routes.
The command reports matching observations, including already imported issues.

Polling requires no public endpoint. For faster optional webhook delivery, set
`PIPES_GITHUB_WEBHOOK_SECRET` in the server environment and restart pipes. The
webhook listener binds to `127.0.0.1:9419`; optionally change
the port with `PIPES_GITHUB_PORT`. Expose that listener through your own HTTPS tunnel
or reverse proxy. In the target GitHub repository's webhook settings, configure:

- Payload URL: your public endpoint with path `/github`.
- Content type: `application/json`.
- Secret: the same value as `PIPES_GITHUB_WEBHOOK_SECRET`.
- Events: Issues.

Expose only the webhook listener, not the privileged RPC listener. Deliveries use
[GitHub's signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
Failed webhook intake returns an error; retry the delivery or let polling catch up.

Tasks appear in the existing queue and start only when requested explicitly.
