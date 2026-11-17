import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client, type GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { remainingRequestTimeMs } from '../request-budget';
import { ATTACHMENT_UPLOAD_KEY_PREFIX, MailError, type AttachmentUploadRecord, type AttachmentUploadStager, type PresignedAttachmentUpload } from './contracts';
import { MAX_UPLOAD_BYTES, UPLOAD_TTL_SECONDS, uploadIdSchema } from './schemas';

export const UPLOAD_READ_TIMEOUT_MS = 30_000;
/** A client needs time to start a transfer of up to 18 MiB; a link that dies sooner is useless, so
 * refuse (temporarily_unavailable) rather than hand one out. Only reachable when the signing
 * credentials are about to expire, because a fresh record lives UPLOAD_TTL_SECONDS. */
export const MIN_UPLOAD_PRESIGN_SECONDS = 30;
const CHECKSUM_HEADER = 'x-amz-checksum-sha256';
/** Exactly the headers a client can supply: host and content-length come from the HTTP client, the
 * checksum from the result's headers. Anything else signed would make the URL unusable. */
const SIGNED_HEADERS = ['content-length', 'host', CHECKSUM_HEADER].join(';');
interface Options {
    readonly bucketName: string;
    readonly client?: S3Client;
    readonly presign?: typeof getSignedUrl;
    /** Shorter budgets support callers and deterministic failure tests. */
    readonly timeoutMs?: number;
    /** Epoch milliseconds; injectable for deterministic expiry tests. */
    readonly now?: () => number;
}
function status(error: unknown): number | undefined {
    if (!error || typeof error !== 'object' || !('$metadata' in error)) { return undefined; }
    const metadata = error.$metadata;
    if (!metadata || typeof metadata !== 'object' || !('httpStatusCode' in metadata)) { return undefined; }
    return typeof metadata.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
}
const isMissing = (error: unknown): boolean => status(error) === 404 || error instanceof Error && error.name === 'NoSuchKey';
/** Records come from our own store, so a malformed one is a server-side defect: fail closed. */
function validRecord(record: AttachmentUploadRecord): void {
    if (typeof record.uploadId !== 'string' || !uploadIdSchema.safeParse(record.uploadId).success || record.objectKey !== ATTACHMENT_UPLOAD_KEY_PREFIX + record.uploadId ||
        !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 1 || record.sizeBytes > MAX_UPLOAD_BYTES ||
        typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(record.sha256) || !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 1) { throw new MailError('invalid_input'); }
}
const base64Digest = (hex: string): string => Buffer.from(hex, 'hex').toString('base64');
/** The signed URL is only safe to hand out if S3 itself enforces size and checksum. The SDK hoists
 * x-amz-checksum-sha256 into the query string by default, and S3 then IGNORES it (wrong bytes are
 * stored with 200); unhoistableHeaders keeps it a signed header. Verify the result rather than
 * trust the option, so an SDK upgrade that changes this fails closed instead of silently
 * unenforcing. */
function enforcesSizeAndChecksum(url: string): boolean {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return false; }
    if (parsed.protocol !== 'https:') { return false; }
    for (const name of parsed.searchParams.keys()) { if (name.toLowerCase() === CHECKSUM_HEADER) { return false; } }
    const signed = parsed.searchParams.get('X-Amz-SignedHeaders');
    return signed !== null && signed.toLowerCase().split(';').sort().join(';') === SIGNED_HEADERS;
}
/** Staged objects are private, reached only through bearer URLs minted here (never log or persist
 * them) and read back only by the server. No ServerSideEncryption is requested: in a presigned PUT
 * it would become a signed header the client must send, so the bucket's default AES256 applies.
 * ContentType/ACL/metadata/tagging are left unset for the same reason. */
export function createS3AttachmentUploadStager(options: Options): AttachmentUploadStager {
    const { bucketName } = options;
    if (!bucketName || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucketName)) { throw new MailError('invalid_input'); }
    const timeout = options.timeoutMs ?? UPLOAD_READ_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > UPLOAD_READ_TIMEOUT_MS) { throw new MailError('invalid_input'); }
    const client = options.client ?? new S3Client({}); const presign = options.presign ?? getSignedUrl; const clock = options.now ?? Date.now;
    return {
        async presign(record): Promise<PresignedAttachmentUpload> {
            validRecord(record);
            try {
                const credentials = await client.config.credentials(); const now = clock();
                const recordLifetime = Math.floor(record.expiresAt - now / 1000);
                const roleLifetime = credentials.expiration ? Math.floor((credentials.expiration.getTime() - now) / 1000) - 5 : UPLOAD_TTL_SECONDS;
                const expiresIn = Math.min(UPLOAD_TTL_SECONDS, recordLifetime, roleLifetime);
                if (!Number.isSafeInteger(expiresIn) || expiresIn < MIN_UPLOAD_PRESIGN_SECONDS) { throw new MailError('temporarily_unavailable'); }
                const checksum = base64Digest(record.sha256);
                const url = await presign(client, new PutObjectCommand({ Bucket: bucketName, Key: record.objectKey, ContentLength: record.sizeBytes, ChecksumSHA256: checksum }),
                    { expiresIn, signingDate: new Date(now), unhoistableHeaders: new Set([CHECKSUM_HEADER]) });
                if (!enforcesSizeAndChecksum(url)) { throw new MailError('temporarily_unavailable'); }
                return { method: 'PUT', headers: { [CHECKSUM_HEADER]: checksum }, url, expiresAt: new Date(now + expiresIn * 1000).toISOString() };
            } catch (error) {
                if (error instanceof MailError) { throw error; }
                throw new MailError('temporarily_unavailable');
            }
        },
        async readStaged(record, { maxBytes, signal: externalSignal }) {
            validRecord(record);
            if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) { throw new MailError('invalid_input'); }
            if (record.sizeBytes > maxBytes) { throw new MailError('too_large'); }
            const controller = new AbortController(); const signal = controller.signal;
            const remaining = remainingRequestTimeMs();
            const budget = Math.max(0, Math.min(timeout, remaining === undefined ? Infinity : remaining - 2_000));
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
            const abort = () => { controller.abort(); void reader?.cancel().catch(() => {}); };
            const check = () => { if (signal.aborted) { throw new MailError('upstream_timeout'); } };
            externalSignal.addEventListener('abort', abort, { once: true });
            if (externalSignal.aborted || budget === 0) { abort(); }
            const operation = async (): Promise<Uint8Array> => {
                check(); let object: GetObjectCommandOutput;
                try { object = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: record.objectKey, ChecksumMode: 'ENABLED' }), { abortSignal: signal }); }
                catch (error) { check(); if (isMissing(error)) { throw new MailError('not_found'); } throw error; }
                // Take the stream first so every later failure path can cancel it.
                if (object.Body) { reader = object.Body.transformToWebStream().getReader(); }
                check();
                if (!reader) { throw new MailError('temporarily_unavailable'); }
                // The object was written under a signed size and checksum, so a different length
                // or stored checksum means it is not what the record pins; refuse before reading.
                if (object.ContentLength !== undefined && object.ContentLength !== record.sizeBytes) { throw new MailError('verification_failed'); }
                if (object.ChecksumSHA256 !== undefined && object.ChecksumSHA256 !== base64Digest(record.sha256)) { throw new MailError('verification_failed'); }
                // Fill one preallocated buffer: chunk collection plus concat would peak at twice
                // the (up to 18 MiB) message on a 1024 MB Lambda.
                const bytes = new Uint8Array(record.sizeBytes); const hash = createHash('sha256'); let size = 0;
                while (true) {
                    check(); const next = await reader.read(); check(); if (next.done) { break; }
                    if (!(next.value instanceof Uint8Array)) { throw new MailError('temporarily_unavailable'); }
                    if (size + next.value.byteLength > record.sizeBytes) { throw new MailError('verification_failed'); }
                    bytes.set(next.value, size); size += next.value.byteLength; hash.update(next.value);
                }
                if (size !== record.sizeBytes || hash.digest('hex') !== record.sha256) { throw new MailError('verification_failed'); }
                return bytes;
            };
            try {
                return await Promise.race([operation(), new Promise<never>((_, reject) => {
                    signal.addEventListener('abort', () => reject(new MailError('upstream_timeout')), { once: true });
                    if (signal.aborted) { reject(new MailError('upstream_timeout')); return; }
                    timer = setTimeout(() => { abort(); reject(new MailError('upstream_timeout')); }, budget);
                })]);
            } catch (error) {
                if (error instanceof MailError) { throw error; }
                throw new MailError('temporarily_unavailable');
            } finally {
                if (timer !== undefined) { clearTimeout(timer); }
                externalSignal.removeEventListener('abort', abort);
                // Release the connection on success and on every failure path.
                void reader?.cancel().catch(() => {});
            }
        },
    };
}
