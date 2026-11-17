import type { Config } from '../config';
import type { MailService } from '../mail/contracts';
import { createS3AttachmentDownloadStager } from '../mail/downloads';
import { createMailBackend } from '../mail/backend';
import { DynamoMailOperationStore } from '../mail/dynamo-store';
import { createMailService } from '../mail/service';
import { DynamoAttachmentUploadStore } from '../mail/upload-store';
import { createS3AttachmentUploadStager } from '../mail/uploads';
import { WildduckClient, WildduckSessionValidator } from '../wildduck';
import { AuthCrypto, digest } from './crypto';
import { AuthEngine } from './engine';
import { ClientRegistry } from './clients';
import { DynamoAtomicStore } from './dynamo-store';
import { SsmKeyringProvider } from './keyring-provider';
import type { AtomicStore } from './contracts';
export interface AuthRuntime { issuer: string; crypto: AuthCrypto; engine: AuthEngine; clients: ClientRegistry; store: AtomicStore; wildduck: Pick<WildduckClient, 'beginLogin' | 'completeTotp' | 'validateCredentials' | 'logout'>; mail: MailService }
export type RuntimeProvider = () => Promise<AuthRuntime | undefined>;
/** The mail service on the shared state table. The download bucket also holds the staged uploads (prefix uploads/v1/); without it
 * neither downloads nor uploads are wired and those tools fail closed. The backend (reads staged bytes) and the service (creates
 * the records and links) share ONE upload store and ONE stager. `build` lets tests observe the wiring. */
export function createMail(config: Config, tableName: string, build: { backend: typeof createMailBackend; service: typeof createMailService } = { backend: createMailBackend, service: createMailService }): MailService {
    const bucketName = config.downloadBucketName;
    const uploads = bucketName ? { store: new DynamoAttachmentUploadStore({ tableName }), stager: createS3AttachmentUploadStager({ bucketName }) } : undefined;
    const backend = build.backend({ ...(config.dotAsPlus === undefined ? {} : { dotAsPlus: config.dotAsPlus }), ...(config.stripReplySuffix === undefined ? {} : { stripReplySuffix: config.stripReplySuffix }), ...(bucketName ? { downloadStager: createS3AttachmentDownloadStager({ bucketName }) } : {}), ...(uploads ? { uploadStore: uploads.store, uploadStager: uploads.stager } : {}) });
    return build.service({ reader: backend, writer: backend, operations: new DynamoMailOperationStore({ tableName }), ...(uploads ? { uploads } : {}) });
}
/** Refresh the keyring cache on every request; never pin retired keys in a singleton engine. */
export function createRuntimeProvider(config: Config): RuntimeProvider {
    if (!config.publicBaseUrl || !config.credentialTableName || !config.authKeyringParameter) { return async () => undefined; }
    const issuer = config.publicBaseUrl;
    const tableName = config.credentialTableName;
    const provider = new SsmKeyringProvider({ parameterName: config.authKeyringParameter });
    const store = new DynamoAtomicStore({ tableName });
    const wildduck = new WildduckClient({ issuer });
    let active: { fingerprint: string; runtime: AuthRuntime } | undefined;
    return async () => {
        const keyring = await provider.getKeyring();
        const fingerprint = digest(JSON.stringify([keyring.activeKeyId, Object.entries(keyring.keys).map(([id, key]) => [id, Buffer.from(key).toString('base64')])]));
        if (!active || active.fingerprint !== fingerprint) {
            const crypto = new AuthCrypto(keyring);
            active = { fingerprint, runtime: { issuer, crypto, store, wildduck, mail: createMail(config, tableName), clients: new ClientRegistry({ crypto }), engine: new AuthEngine(store, crypto, new WildduckSessionValidator(wildduck, crypto), { issuer, refreshRetrySeconds: 10 }) } };
        }
        return active.runtime;
    };
}
