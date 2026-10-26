/** Internal auth contracts. Times are Unix seconds; TTL never grants validity. */
export type ConnectionStatus = 'active' | 'reconnect_required' | 'revoked';
export interface Sealed { keyId: string; nonce: string; ciphertext: string; tag: string }
export interface BaseRecord { kind: string; id: string; revision: number; expiresAt: number }
export interface Connection extends BaseRecord {
    kind: 'connection'; accountId: string; credentialGeneration: number;
    status: ConnectionStatus; credentials: Sealed;
}
export interface UpstreamCredentials { accessToken: string; profile: { id: string; name?: string; email?: string }; issuedAt: number }
export interface Grant extends BaseRecord {
    kind: 'grant'; clientId: string; connectionId: string; accountId: string;
    resource: string; scopes: string[]; status: 'active' | 'revoked';
    credentialGeneration: number; tokenVersion: number; refreshGeneration: number; refreshHash: string;
    previousRefreshHash?: string; receiptUntil?: number; receipt?: Sealed;
    receiptBinding?: string;
}
export interface AuthorizationCode extends BaseRecord {
    kind: 'code'; clientId: string; connectionId: string; accountId: string;
    credentialGeneration: number; redirectUri: string; resource: string; scopes: string[];
    challenge: string; consumedGrantId?: string;
}
export type AuthRecord = Connection | Grant | AuthorizationCode;
export interface Condition { kind: AuthRecord['kind']; id: string; revision: number | null }
export interface AtomicWrite { conditions: Condition[]; puts: AuthRecord[]; operationId: string }
export interface AtomicStore {
    /** Must be strongly consistent. Implementations reject expired records at callers. */
    get(kind: AuthRecord['kind'], id: string): Promise<AuthRecord | undefined>;
    /** All conditions and writes commit together. false means a known condition conflict.
     * Each operationId binds the exact write payload; identical retries return the original success.
     * Adapters retry unknown outcomes with the SAME operationId and payload within the bounded deadline.
     * Exhausted unknown outcomes MUST throw TemporaryUnavailable, never claim a conflict.
     * DynamoDB ClientRequestToken deduplication lasts ten minutes; never retry beyond that window.
     * Every put must have its revision/absence condition; reject duplicate key operations. */
    transact(write: AtomicWrite): Promise<boolean>;
}
export interface ClientIdentity { clientId: string; redirectUris: readonly string[] }
export interface BackendSessionValidator {
    /** Implementations decrypt using connection AAD; no password or fallback token. */
    validate(connection: Connection): Promise<'valid' | 'expired' | 'temporary'>;
}
export interface TokenResponse { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string }
export interface AuthContext { grantId: string; accountId: string; connectionId: string; scopes: string[]; connectionStatus: ConnectionStatus }
export class OAuthError extends Error {
    constructor(public readonly error: 'invalid_grant' | 'invalid_request' | 'invalid_scope' | 'invalid_token' | 'temporarily_unavailable') { super(error); }
}
export class TemporaryUnavailable extends OAuthError { constructor() { super('temporarily_unavailable'); } }
