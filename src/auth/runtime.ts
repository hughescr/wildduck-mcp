import type { Config } from '../config';
import { WildduckClient, WildduckSessionValidator } from '../wildduck';
import { AuthCrypto, digest } from './crypto';
import { AuthEngine } from './engine';
import { ClientRegistry } from './clients';
import { DynamoAtomicStore } from './dynamo-store';
import { SsmKeyringProvider } from './keyring-provider';
import type { AtomicStore } from './contracts';
export interface AuthRuntime { issuer: string; crypto: AuthCrypto; engine: AuthEngine; clients: ClientRegistry; store: AtomicStore; wildduck: Pick<WildduckClient, 'beginLogin' | 'completeTotp' | 'validateCredentials' | 'logout' | 'listInboxSubjects'> }
export type RuntimeProvider = () => Promise<AuthRuntime | undefined>;
/** Refresh the keyring cache on every request; never pin retired keys in a singleton engine. */
export function createRuntimeProvider(config: Config): RuntimeProvider {
    if (!config.publicBaseUrl || !config.credentialTableName || !config.authKeyringParameter) { return async () => undefined; }
    const issuer = config.publicBaseUrl;
    const provider = new SsmKeyringProvider({ parameterName: config.authKeyringParameter });
    const store = new DynamoAtomicStore({ tableName: config.credentialTableName });
    const wildduck = new WildduckClient({ issuer });
    let active: { fingerprint: string; runtime: AuthRuntime } | undefined;
    return async () => {
        const keyring = await provider.getKeyring();
        const fingerprint = digest(JSON.stringify([keyring.activeKeyId, Object.entries(keyring.keys).map(([id, key]) => [id, Buffer.from(key).toString('base64')])]));
        if (!active || active.fingerprint !== fingerprint) {
            const crypto = new AuthCrypto(keyring);
            active = { fingerprint, runtime: { issuer, crypto, store, wildduck, clients: new ClientRegistry({ crypto }), engine: new AuthEngine(store, crypto, new WildduckSessionValidator(wildduck, crypto), { issuer, refreshRetrySeconds: 10 }) } };
        }
        return active.runtime;
    };
}
