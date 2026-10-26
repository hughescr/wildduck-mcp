# Authentication foundation

This phase supplies an internal engine; production routes remain closed until integration and review. The issuer is one configured HTTPS origin and its resource is exactly `${issuer}/mcp`.

`src/auth/contracts.ts` is the shared interface. Backend adapters implement `BackendSessionValidator.validate(Connection)` and return valid, expired, or temporary. They must use only the account-bound credential, never the nginx fallback. Browser integration supplies an already authenticated `Connection` and validated `ClientIdentity`; it must obtain explicit consent before issuing a code. Account IDs are immutable. Reconnect replaces credentials only for the same account with a conditional credential generation change. No passwords are persisted.

The store provides strongly consistent reads and atomic revision-conditioned multi-record writes. Revision null means absent. Unknown transaction outcomes throw temporary unavailability; they do not mean a condition conflict. All records have `expiresAt` for eventual TTL cleanup; every use separately enforces expiry. Keys are service-namespaced and no anonymous interaction or registration records are required.

Codes last two minutes and require S256 PKCE, exact registered redirect, client, resource and scope bindings. Exchange atomically consumes the code and creates a grant while checking the upstream connection generation. Tokens use authenticated routing envelopes so invalid random tokens fail before reads. Only hashes of refresh secrets persist. Canonical grant revocation invalidates every access and refresh token. No access request updates last-seen timestamps.

Refresh rotation is a single conditional transition. Optional ten-second delivery retry policy stores the identical encrypted response, accessible only using the immediately previous valid refresh secret, identical authenticated client, resource and effective scope set. It never mints another generation. Replay outside this interval revokes only that authenticated client's grant family. Wrong-client and random-token attempts never mutate grants. Expired receipt ciphertext can remain until a subsequent transition or DynamoDB TTL cleanup; its authorization window is checked independently.

Backend expired sessions conditionally mark only the observed credential generation reconnect_required. Temporary backend errors do not consume codes, rotate tokens, or revoke grants. A valid MCP credential can report a reconnect-required connection; future mail operations must require active credentials.

Encryption uses Node crypto AES-256-GCM with fresh nonces, versioned key IDs, purpose-separated HKDF keys and explicit connection/account/schema AAD. Deployment must inject a real versioned keyring; there is no production fallback. Old keys remain readable during a deliberate rotation period.
