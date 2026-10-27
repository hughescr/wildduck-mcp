import { createHash } from 'node:crypto';
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectCommand, HeadObjectCommand, S3Client, UploadPartCommand, type HeadObjectCommandOutput } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { remainingRequestTimeMs } from '../request-budget';
import { MailError, type AttachmentMetadata } from './contracts';

export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 30_000;
export const DOWNLOAD_URL_TTL_SECONDS = 300;
const PART_BYTES = 5 * 1024 * 1024;
const MIME_TYPE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
export interface AttachmentDownloadBody {
    readonly body: ReadableStream<Uint8Array>;
    /** Validated decoded Content-Length, never an approximate metadata size. */
    readonly expectedSize?: number;
}
export interface AttachmentDownloadSource {
    /** Server-derived SHA-256 of authenticated account, mailbox/UID, attachment ID
     * and immutable upstream attachment hash. Never supplied by a tool caller. */
    readonly cacheIdentity: string;
    readonly metadata: AttachmentMetadata;
    /** Called only after a cache miss, with the same whole-stage deadline. */
    open(signal: AbortSignal): Promise<AttachmentDownloadBody>;
}
export interface StagedAttachmentDownload { readonly url: string; readonly expiresAt: string; readonly size: number }
export interface AttachmentDownloadStager { stage(source: AttachmentDownloadSource, signal?: AbortSignal): Promise<StagedAttachmentDownload> }
interface Options {
    readonly bucketName: string;
    readonly client?: S3Client;
    readonly presign?: typeof getSignedUrl;
    /** Shorter budgets support callers and deterministic failure tests. */
    readonly timeoutMs?: number;
}
/** Force download, remove header/path syntax, and retain a bounded UTF-8 filename. */
export function attachmentDisposition(filename: string | null): string {
    // eslint-disable-next-line no-control-regex -- Remove untrusted attachment header control bytes.
    const safe = (filename ?? 'attachment').normalize('NFC').replace(/[\u0000-\u001f\u007f/\\]/gu, '_').slice(0, 180) || 'attachment';
    const ascii = safe.replace(/[^A-Za-z0-9 ._-]/gu, '_');
    const encoded = encodeURIComponent(safe.replace(/[\uD800-\uDFFF]/gu, '_')).replace(/['()*]/gu, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
const sha256 = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function exactSize(value: number | undefined): void {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) { throw new MailError('invalid_input'); }
    if (value !== undefined && value > MAX_DOWNLOAD_BYTES) { throw new MailError('too_large'); }
}
function status(error: unknown): number | undefined {
    if (!error || typeof error !== 'object' || !('$metadata' in error)) { return undefined; }
    const metadata = error.$metadata;
    if (!metadata || typeof metadata !== 'object' || !('httpStatusCode' in metadata)) { return undefined; }
    return typeof metadata.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
}
function expirationTime(header: string | undefined): number | undefined {
    if (header === undefined) { return undefined; }
    const expiry = /^expiry-date="([^"]+)",\s*rule-id="[^"]*"$/u.exec(header)?.[1];
    const time = expiry === undefined ? NaN : Date.parse(expiry);
    if (!Number.isFinite(time)) { throw new MailError('verification_failed'); }
    return time;
}
/** The stable opaque key contains no account, filename or other public identity.
 * Cache hits only HEAD and sign: they never rewrite the object or extend lifecycle.
 * URLs are reusable bearer credentials until expiry; never log or persist them. */
export function createS3AttachmentDownloadStager(options: Options): AttachmentDownloadStager {
    const { bucketName } = options;
    if (!bucketName || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucketName)) { throw new MailError('invalid_input'); }
    const timeout = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > DOWNLOAD_TIMEOUT_MS) { throw new MailError('invalid_input'); }
    const client = options.client ?? new S3Client({}); const presign = options.presign ?? getSignedUrl;
    return {
        async stage(source, externalSignal) {
            const { metadata, cacheIdentity } = source;
            const contentType = MIME_TYPE.test(metadata.contentType) ? metadata.contentType : 'application/octet-stream';
            const contentDisposition = attachmentDisposition(metadata.filename);
            const metadataSize = metadata.sizeIsApproximate ? undefined : metadata.size ?? undefined;
            const descriptor = sha256(['wildduck-mcp/download-descriptor/v1', contentType, contentDisposition, metadataSize ?? null]);
            const binding = sha256(['wildduck-mcp/attachment-cache/v1', cacheIdentity, descriptor]);
            const key = `downloads/v1/${binding}`;
            const controller = new AbortController(); const signal = controller.signal;
            const remaining = remainingRequestTimeMs();
            const budget = Math.max(0, Math.min(timeout, remaining === undefined ? Infinity : remaining - 2_000));
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
            let uploadId: string | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
            const abort = () => { controller.abort(); void reader?.cancel().catch(() => {}); };
            const check = () => { if (signal.aborted) { throw new MailError('upstream_timeout'); } };
            externalSignal?.addEventListener('abort', abort, { once: true });
            if (externalSignal?.aborted || budget === 0) { abort(); }
            const abortUpload = async () => {
                if (!uploadId) { return; }
                const ownUploadId = uploadId; uploadId = undefined;
                const cleanupSignal = AbortSignal.timeout(1_000);
                let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([
                        client.send(new AbortMultipartUploadCommand({ Bucket: bucketName, Key: key, UploadId: ownUploadId }), { abortSignal: cleanupSignal }).catch(() => {}),
                        new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 1_000); }),
                    ]);
                } finally { if (cleanupTimer !== undefined) { clearTimeout(cleanupTimer); } }
            };
            const head = async (): Promise<HeadObjectCommandOutput | undefined> => {
                check(); let result: HeadObjectCommandOutput;
                try { result = await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }), { abortSignal: signal }); }
                catch (error) { check(); if (status(error) === 404) { return undefined; } throw error; }
                check();
                const size = result.ContentLength;
                if (size === undefined || !Number.isSafeInteger(size) || size < 0 || size > MAX_DOWNLOAD_BYTES ||
                    metadataSize !== undefined && size !== metadataSize || result.Metadata?.['binding'] !== binding || result.Metadata?.['descriptor'] !== descriptor ||
                    result.ContentType !== contentType || result.ContentDisposition !== contentDisposition || result.CacheControl !== 'private, no-store' ||
                    result.ServerSideEncryption !== 'AES256' || !result.ETag || result.StorageClass !== undefined && result.StorageClass !== 'STANDARD') { throw new MailError('verification_failed'); }
                expirationTime(result.Expiration);
                return result;
            };
            const sign = async (object: HeadObjectCommandOutput): Promise<StagedAttachmentDownload> => {
                const credentials = await client.config.credentials(); check();
                const now = Date.now(); const objectExpiry = expirationTime(object.Expiration);
                const roleLifetime = credentials.expiration ? Math.floor((credentials.expiration.getTime() - now) / 1000) - 5 : DOWNLOAD_URL_TTL_SECONDS;
                const objectLifetime = objectExpiry === undefined ? DOWNLOAD_URL_TTL_SECONDS : Math.floor((objectExpiry - now) / 1000) - 5;
                const expiresIn = Math.min(DOWNLOAD_URL_TTL_SECONDS, roleLifetime, objectLifetime);
                if (!Number.isSafeInteger(expiresIn) || expiresIn < 1) { throw new MailError('temporarily_unavailable'); }
                const url = await presign(client, new GetObjectCommand({ Bucket: bucketName, Key: key }), { expiresIn, signingDate: new Date(now) });
                check();
                return { url, expiresAt: new Date(now + expiresIn * 1000).toISOString(), size: object.ContentLength as number };
            };
            const operation = async (): Promise<StagedAttachmentDownload> => {
                check(); if (!/^[a-f0-9]{64}$/u.test(cacheIdentity)) { throw new MailError('invalid_input'); } exactSize(metadataSize);
                const cached = await head(); if (cached) { return sign(cached); }
                const opened = await source.open(signal); reader = opened.body.getReader(); check();
                exactSize(opened.expectedSize);
                if (opened.expectedSize !== undefined && metadataSize !== undefined && opened.expectedSize !== metadataSize) { throw new MailError('verification_failed'); }
                const expectedSize = opened.expectedSize ?? metadataSize;
                const created = await client.send(new CreateMultipartUploadCommand({ Bucket: bucketName, Key: key,
                    ContentType: contentType, ContentDisposition: contentDisposition, CacheControl: 'private, no-store', ServerSideEncryption: 'AES256',
                    Metadata: { binding, descriptor } }), { abortSignal: signal });
                uploadId = created.UploadId; check(); if (!uploadId) { throw new MailError('temporarily_unavailable'); }
                const parts: { ETag: string; PartNumber: number }[] = [];
                let chunks: Uint8Array[] = []; let partSize = 0; let size = 0;
                const upload = async () => {
                    check();
                    const result = await client.send(new UploadPartCommand({ Bucket: bucketName, Key: key, UploadId: uploadId, PartNumber: parts.length + 1, Body: Buffer.concat(chunks, partSize) }), { abortSignal: signal });
                    check(); if (!result.ETag) { throw new MailError('temporarily_unavailable'); }
                    parts.push({ ETag: result.ETag, PartNumber: parts.length + 1 }); chunks = []; partSize = 0;
                };
                while (true) {
                    check(); const next = await reader.read(); check(); if (next.done) { break; }
                    if (!(next.value instanceof Uint8Array)) { throw new MailError('temporarily_unavailable'); }
                    size += next.value.byteLength;
                    if (size > MAX_DOWNLOAD_BYTES) { throw new MailError('too_large'); }
                    if (expectedSize !== undefined && size > expectedSize) { throw new MailError('verification_failed'); }
                    for (let offset = 0; offset < next.value.byteLength;) {
                        const length = Math.min(PART_BYTES - partSize, next.value.byteLength - offset);
                        chunks.push(next.value.subarray(offset, offset + length)); partSize += length; offset += length;
                        if (partSize === PART_BYTES) { await upload(); }
                    }
                }
                if (expectedSize !== undefined && size !== expectedSize) { throw new MailError('verification_failed'); }
                if (partSize > 0 || parts.length === 0) { await upload(); } check();
                try {
                    await client.send(new CompleteMultipartUploadCommand({ Bucket: bucketName, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts }, IfNoneMatch: '*' }), { abortSignal: signal });
                    uploadId = undefined;
                } catch (error) {
                    check(); if (status(error) !== 412) { throw error; }
                    // Another request won. Abort only our multipart upload: deleting
                    // a deterministic key could erase its completed object.
                    await abortUpload();
                }
                check(); const completed = await head();
                if (!completed || completed.ContentLength !== size) { throw new MailError('verification_failed'); }
                return sign(completed);
            };
            try {
                return await Promise.race([operation(), new Promise<never>((_, reject) => {
                    signal.addEventListener('abort', () => reject(new MailError('upstream_timeout')), { once: true });
                    if (signal.aborted) { reject(new MailError('upstream_timeout')); return; }
                    timer = setTimeout(() => { abort(); reject(new MailError('upstream_timeout')); }, budget);
                })]);
            } catch (error) {
                abort(); await abortUpload();
                // A completed object is an intentional reusable cache entry, even
                // if signing fails. Never delete the shared key on an error.
                if (error instanceof MailError) { throw error; }
                throw new MailError('temporarily_unavailable');
            } finally {
                if (timer !== undefined) { clearTimeout(timer); }
                externalSignal?.removeEventListener('abort', abort); reader?.releaseLock();
            }
        },
    };
}
