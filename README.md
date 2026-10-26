# wildduck-mcp

A small remote MCP service for Wildduck mail accounts. TypeScript and Bun tooling build a self-contained JavaScript artifact that runs on Node.js 26 in an ordinary, on-demand AWS Lambda with a Function URL.

**This is a scaffold, not a working email connector yet.** `/healthz` reports the build version. `/readyz` and `/mcp` return `503` because production OAuth and mailbox tools are not implemented. Supplied bearer tokens or Wildduck API headers do not bypass this boundary. OAuth discovery is deliberately absent until a complete authorization flow exists. The official MCP SDK transport has a service-information tool exercised through an injected verifier in tests; the production handler never installs that test verifier.

## Local development

Install Node.js 26, Bun 1.4.4 or newer, `zip`, and git-flow. The deployment uses the Node 26 preview runtime, an accepted tradeoff for this noncritical service; AWS preview availability must be verified in the deployment Region.

```sh
bun install --frozen-lockfile --ignore-scripts
bun check
bun run lint
bun test
bun run build
bun run smoke
bun run dev
```

The local server binds only to `127.0.0.1:3000`. `PORT` optionally changes the port. No credentials are required for scaffold checks. `bun run validate` runs typechecking, lint, tests, bundling, and the Node 26 Lambda-event smoke test using the same commands CI uses.

`bun check` is Bun's built-in TypeScript checker; there is no same-name package script and no separate TypeScript compiler dependency. Oxlint approximates supported correctness, TypeScript, import, Node, and Unicorn rules from `@hughescr/eslint-config-default`. Custom ESLint plugins, typed ESLint rules, and stylistic coverage are intentionally not reproduced.

## Architecture and boundaries

- `src/app.ts`: Hono routes and an authentication integration seam. Production authentication fails closed.
- `src/handler.ts`: buffered Function URL adapter. Every HTTP request completes independently; no persistent SSE connection, sticky session, or always-running server is required.
- `src/mcp.ts`: official MCP SDK, stateless JSON responses, one server/transport per authenticated request.
- `src/config.ts`: optional public-origin validation; it never loads backend credentials from environment variables.
- `serverless.yml`: ordinary Lambda, `nodejs26.x`, ARM64, 1024 MB, 30-second request limit, 14-day logs, and a DynamoDB table.
- `infra/bootstrap.yml`: separate artifact bucket, fixed runtime role, and main-only GitHub OIDC deployment role. CI cannot modify IAM roles.

The database is **DynamoDB Standard, provisioned at exactly 1 RCU and 1 WCU**, with no indexes or autoscaling. It is retained on stack deletion or replacement. The key attributes are `pk` and `sk`; this service reserves partition keys beginning `wildduck-mcp#`. Other future consumers could reserve their own prefixes without a shared credential-platform abstraction. Runtime IAM permissions enforce this service's prefix. `expiresAt` is a Unix-seconds TTL attribute for eventual cleanup, not an authorization check: the application must reject expired records immediately. Bounded throttling retries and atomic authorization-code consumption/refresh rotation belong to the credential-store implementation, which has not been added yet. Even five users can make simultaneous requests, so one capacity unit does not guarantee an unthrottled authentication burst.

The table enables server-side encryption. Application encryption of upstream credentials, key management, OAuth grants and token hashing are **future work**; no real credentials are stored by the scaffold. Mail remains in Wildduck.

The backend will be fixed to the configured Wildduck API origin and use account-bound credentials, with read/modify/draft/send permissions enforced in this service. The backend adapter must explicitly send the user's token in `X-Access-Token` and refuse requests without it; the existing nginx fallback must never be used accidentally for mail operations. No Wildduck server code or configuration is changed here.

## Branches and releases

The public repository is [hughescr/wildduck-mcp](https://github.com/hughescr/wildduck-mcp), with `develop` as its default branch. `develop` is the development branch; `main` is the deployed release branch. The initial reviewed scaffold is tagged `0.1.0`. Tags use bare versions such as `0.1.1`, matching the existing Gitflow convention.

After cloning, initialize the local Gitflow settings once:

```sh
git switch develop
bun run gitflow:init
```

Start with a clean `develop`, then release with either command:

```sh
bun pm version patch --no-git-tag-version
# Or: npm version patch --no-git-tag-version
```

The `postversion` hook updates the Bun lockfile, validates, commits the version, runs `git flow release start` and `finish`, and returns to `develop` merged with `main`. It stops on errors and refuses unrelated working-tree changes. `--no-git-tag-version` is required for npm too: Gitflow owns the release commit/tag, so npm must not create its own first. Replace `patch` with `minor` or `major` as appropriate. A failed hook can leave the new version uncommitted or a release in progress; inspect `git status` and Gitflow's output before continuing. Nothing pushes automatically.

```sh
git push origin main develop --follow-tags
```

`bun run test:release` exercises this exact Bun/postversion/Gitflow path in a disposable local repository, checking the release tag, main version, develop ancestry and clean lockfile. It does not touch a remote.

## CI and deployment bootstrap

Pushes to `main` and `develop`, and pull requests targeting either, run the checks and build. A separate main-only job deploys the verified artifact with short-lived AWS OIDC credentials. `develop` and pull requests cannot assume the production deployment role. The local and CI artifact is `dist/function.zip`; it contains bundled JavaScript and its source map, with no runtime package installation.

**The AWS bootstrap infrastructure and GitHub deployment settings are configured.** Every successful main push deploys automatically through the main-only OIDC role. When deployed, the application remains a scaffold: health is available, while readiness and MCP reject access until OAuth and mailbox tools are implemented. The steps below document the one-time setup for recreating this deployment; a fresh clone does not require repeating them.

With administrator credentials for the intended account, bootstrap in `us-west-2`:

```sh
aws cloudformation deploy \
  --region us-west-2 \
  --stack-name wildduck-mcp-bootstrap \
  --template-file infra/bootstrap.yml \
  --capabilities CAPABILITY_NAMED_IAM
aws cloudformation describe-stacks \
  --region us-west-2 \
  --stack-name wildduck-mcp-bootstrap \
  --query 'Stacks[0].Outputs'
```

This expects the account's existing GitHub OIDC stack export `GitHubOIDCProvider-Arn`, following the existing site deployment pattern. It creates no new OIDC provider. This repository uses GitHub's immutable OIDC subject format: the bootstrap trust pins the owner/repository IDs and `refs/heads/main`, rather than accepting a renamed or recreated repository with the same slug. Inspect the current prefix with `gh api repos/hughescr/wildduck-mcp/actions/oidc/customization/sub` before recreating the bootstrap; a different repository requires a reviewed trust-policy update. Set these GitHub repository variables from the outputs:

| Variable | Bootstrap output |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | `GitHubDeployRoleArn` |
| `AWS_DEPLOYMENT_BUCKET_NAME` | `ArtifactBucketName` |
| `AWS_EXECUTION_ROLE_ARN` | `ExecutionRoleArn` |

Set the repository **secret** `SERVERLESS_ACCESS_KEY` using the normal GitHub secret UI or stdin; never put the value in a command argument or commit. For a newly bootstrapped deployment, set repository variable `DEPLOY_ENABLED=true` last, then push a release to main or dispatch the workflow on main. The scaffold will expose only health and fail-closed readiness/MCP endpoints until the OAuth implementation lands. The workflow performs live HTTP checks after deployment; it does not equate successful CloudFormation creation with a working application.

For a deliberate local deployment after bootstrap, export the bucket name, execution-role ARN, and Serverless access key using the normal credential-injection tooling, then:

```sh
bun run validate
bun run deploy
```

The deploy script refuses missing settings; packaging alone uses explicit unconfigured placeholders so local infrastructure validation needs no AWS credentials. Do not deploy with the raw Serverless command and placeholder defaults. `bun run package` validates the generated CloudFormation locally, without deploying. The bootstrap policy is scoped to this service's named resources. Release `0.1.2` was deployed successfully through the main-push CI workflow, including live version/readiness/MCP checks. Future CloudFormation resource changes still require reviewing the deployment role's handler permissions.

Changing IAM policies requires an administrator bootstrap-stack update. The retained table and versioned artifact bucket outlive stack deletion; deleting them is a separate administrative action. Published Lambda versions allow an operator to roll back; use the prior known-good artifact/release and verify the health/version after deployment. Do not use `serverless remove` as a rollback.

No custom hostname is selected yet. When one is needed, use Route 53, ACM and CloudFront as in the existing Serverless site projects; those resources and costs are intentionally absent from this scaffold.

## Next implementation phase

1. Implement browser login/MFA and OAuth discovery, PKCE, consent, client registration, refresh rotation and revocation.
2. Resolve durable mailbox-bound upstream credentials. Ordinary backend user sessions currently expire after 14 inactive days or 180 total days; this service's refresh token cannot renew a dead upstream session. Periodic human reconnection remains a fallback.
3. Add credential encryption and DynamoDB persistence with bounded retries under the fixed capacity budget.
4. Implement bounded read/search, draft and submit tools. Never automatically retry an uncertain send.
5. Test actual account connection/reconnection in Claude, ChatGPT/Codex and unattended-agent clients. A valid OAuth token does not override the host's action-approval policies.
