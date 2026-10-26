# wildduck-mcp

A small remote MCP connection service for Wildduck, built with Hono, the official MCP SDK and an ordinary buffered AWS Lambda Function URL. This phase implements OAuth and account connection. The only tools are `get_profile`, `whoami`, `get_connection_status` and `get_service_info`; mail reading, modification, drafting and sending are not implemented.

## Account connection

Clients discover OAuth using the `/mcp` bearer challenge and the authorization-server and protected-resource metadata endpoints. Authorization uses an exact client/redirect/resource binding, S256 PKCE, password login, any required TOTP challenge, and explicit account/permissions consent. A native client's HTTP loopback redirect may vary its port only. The callback includes `iss` and the original `state`. There is no OpenID Connect, `openid` scope, ID token, password grant or client-credentials grant.

Passkey-only accounts fail closed with a webmail instruction. Existing webmail passkeys belong to their existing relying-party origins and cannot be used by the Lambda origin. Accounts requiring a password change or MFA enrollment must complete it in webmail. Passwords and TOTP codes exist only in the current request and are never retained. Pending MFA and newly authenticated credentials are encrypted in a short-lived Secure/HttpOnly/SameSite=Lax browser cookie with a fixed ten-minute deadline. Every browser POST requires an origin check, synchronizer CSRF token and the bound OAuth request digest. Public request fields appear in forms; credentials do not. No third-party assets or scripts are loaded.

The registered client name is presentation metadata, not proof of ownership. Consent also displays the redirect hostname and, for a client metadata document, its hostname. `mail:send` requires a separate explicit checkbox. Scopes are `profile`, `mail:read`, `mail:modify`, `mail:draft`, `mail:send`; default scope is `profile mail:read`. These permissions reserve future tool capabilities and do not make mail tools available today. Refresh tokens are issued with connection consent without an OIDC `offline_access` scope.

Dynamic client registration at `/register` supports public (`none`) and confidential (`client_secret_basic` or `client_secret_post`) clients. Registrations are stateless authenticated IDs; anonymous registration does not write DynamoDB. HTTPS client metadata document IDs are fetched with the maintained `@better-auth/cimd` transport, public-IP DNS pinning and TLS identity checks, no redirects, a five-KiB cap and bounded deadlines/cache. Supported public metadata documents explicitly negotiate `none`; unsupported private-key methods cannot silently downgrade. Duplicate form/query fields and mixed credential methods are rejected.

Access tokens last five minutes. Grants and connections have a maximum lifetime of 180 days. Refresh tokens rotate atomically; an identical retry within ten seconds returns the same encrypted response. After that fixed grace window an authenticated old-token replay revokes that client's grant. Revocation at `/revoke` invalidates its access and refresh tokens. A backend outage returns `503 temporarily_unavailable` and preserves grants; a definitively expired backend session requires human reconnection. Upstream sessions may expire after 14 inactive days or 180 total days, so the OAuth lifetime is an upper bound rather than a guarantee. There is no background keepalive or password reauthentication. Reauthorize through the client's normal connection UI with the same account to replace that account's canonical backend connection; other client grants use the same account connection, but clients may require explicit reconnection after `invalid_grant`.

The backend adapter always uses the connected user's explicit `X-Access-Token` for session checks and user operations. Only the two login/MFA bootstrap paths omit it, using the separately approved backend proxy fallback. Browser cancellation attempts upstream logout; upstream revocation is best effort. This repository changes no backend code or configuration.

## Local validation

Use Node.js 26, Bun 1.4.4 or newer, `zip`, and git-flow:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run validate
bun run dev
```

The local server binds `127.0.0.1:3000`; `PORT` changes the port. With auth configuration absent, `/healthz` reports the package version, `/readyz` and `/mcp` return 503, and no AWS request is made. Configuration is not a credential bypass. `bun run validate` runs Bun's TypeScript checker, Oxlint, tests, bundling and a real Node 26 Lambda-event smoke test. HTTP tests inject a typed test runtime with the real engine/crypto/store contracts and exercise password/TOTP consent, CSRF, redirects, code exchange, refresh and request-scoped MCP identity; production never installs a test verifier.

## Runtime and storage

`PUBLIC_BASE_URL` is a required canonical HTTPS origin for a usable service. Never derive the issuer from Host or forwarded headers. `CREDENTIAL_TABLE_NAME` selects the durable state table; `AUTH_KEYRING_PARAMETER` contains only the exact SSM parameter name `/wildduck-mcp/prod/auth-keyring`. No backend credentials or encryption-key values belong in environment variables, CloudFormation, GitHub or source control.

Provision the keyring separately as an SSM **Standard SecureString** under the AWS-managed `aws/ssm` key. Its JSON shape is `{"activeKeyId":"v1","keys":{"v1":"<canonical base64 encoding of 32 random bytes>"}}`, at most four KiB. Use an administrator's approved secret-injection workflow: generate key bytes in memory, send the value through stdin/API request data, and avoid command arguments, files and logs. CloudFormation does not create this SecureString. The runtime can only `ssm:GetParameter` that exact ARN; the CI deployment role cannot read or write its value. No customer-managed KMS key or paid key-management service is added.

Keyring loading is lazy, bounded and cached for at most five minutes. Concurrent loads coalesce; an expired cache fails closed when SSM is unavailable. Each request consults the provider and rebuilds crypto/client services when key material changes. Add a new key and change `activeKeyId` to rotate. Retain old keys while encrypted records, issued tokens and stateless client IDs/secrets depend on them; client registration IDs and secrets do not have an automatic expiration. Removing old keys deliberately invalidates their dependents.

DynamoDB Standard remains provisioned at **exactly 1 RCU and 1 WCU**, with no secondary indexes or autoscaling. The table is retained on deletion/replacement. Its `pk`/`sk` keys use the `wildduck-mcp#` namespace, enforced by runtime IAM. `expiresAt` TTL is eventual cleanup; validity is checked synchronously. Strong reads, conditional transactions, bounded throttling retries and AWS transaction idempotency implement atomic codes and refresh rotation. Concurrent bursts can still throttle this deliberately tiny table. Backend credentials and retry receipts are encrypted with AES-GCM, purpose-separated keys and account/generation-bound authenticated context. Mail remains in Wildduck.

Lambda uses Node 26 preview, ARM64, 1024 MB, a 30-second request timeout and 14-day logs. Preview availability in the intended region is an accepted deployment constraint. Health is liveness; `/readyz` checks configured key availability. Neither is proof of a real account login or successful client interoperability. MCP uses the official stateless JSON transport and passes verified request identity through `authInfo` into tool context. Profile IDs are the stable opaque backend account ID.

## Deployment and rollback

Main and develop pushes and their pull requests validate and build. The main-only deployment job uses short-lived GitHub OIDC credentials and deploys the exact verified artifact. Bootstrap IAM is administered separately; CI cannot edit IAM. Trust pins the immutable owner/repository IDs and main branch. No long-lived AWS access key is stored in GitHub.

An administrator can create/update the bootstrap stack using `infra/bootstrap.yml` and `CAPABILITY_NAMED_IAM` in the intended region. It expects the existing `GitHubOIDCProvider-Arn` export. Inspect its outputs and configure repository variables `AWS_DEPLOY_ROLE_ARN`, `AWS_DEPLOYMENT_BUCKET_NAME`, and `AWS_EXECUTION_ROLE_ARN`. Provision the SecureString separately, then set `AUTH_KEYRING_PARAMETER=/wildduck-mcp/prod/auth-keyring` and `PUBLIC_BASE_URL` to the known Function URL HTTPS origin. Set `SERVERLESS_ACCESS_KEY` as a repository secret through the normal secret UI/stdin, and `DEPLOY_ENABLED=true` last.

The issuer comes from the repository variable, avoiding a cyclic CloudFormation Function URL/environment reference. Local `bun run package` uses empty auth settings and explicit infrastructure placeholders without real keys or AWS access. `bun run deploy` refuses missing settings and unexpected parameter names. For an authorized deployment, validate first and inject the same settings using normal credential tooling. Never deploy placeholders directly with raw Serverless commands.

Live deployment verification checks the package version, ready key loading, unauthenticated MCP 401 challenge and discovery issuer. It does not log in a real account. Real-account connection/reconnection and Claude, ChatGPT, Codex, Dot and Duet interoperability remain acceptance checks to perform after reviewed provisioning/deployment. A valid OAuth grant does not override a host's action-approval policies.

Published Lambda versions and the previous artifact permit operator rollback. Restore the previous reviewed release/configuration and verify health/version, discovery and readiness; do not use `serverless remove` as rollback. Retain encryption keys required by surviving records and clients. The retained table and versioned artifact bucket outlive stack deletion. No custom domain, CloudFront, new KMS key, index or autoscaling resource is added.

## Branches and releases

`develop` is the default development branch and `main` is the deployed branch. Tags are bare package versions. Initialize with `bun run gitflow:init`. From clean develop, `bun pm version patch --no-git-tag-version` (or npm equivalent) invokes the postversion workflow: update lockfile, validate, commit, finish a Gitflow release and merge main back into develop. Nothing pushes automatically. Inspect status before recovering any failed release. `bun run test:release` exercises the release path in a disposable local repository.

Release 0.1.2 was the deployed scaffold baseline. This auth implementation still requires reviewed key provisioning, IAM/bootstrap configuration and release deployment; source changes alone do not change the live service. Future phases add bounded mail tools and uncertain-send handling after OAuth acceptance.
