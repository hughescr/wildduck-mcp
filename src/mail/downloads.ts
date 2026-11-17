import { createHash } from 'node:crypto';
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, UploadPartCommand, type HeadObjectCommandOutput } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { remainingRequestTimeMs } from '../request-budget';
import { MailError, type AttachmentMetadata } from './contracts';
import { MAX_MESSAGE_BYTES } from './mime';

/** An attachment download (get_attachment_download). */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** A whole message source (get_message_source_download): as large as the largest message this server composes. */
export const MAX_SOURCE_DOWNLOAD_BYTES = MAX_MESSAGE_BYTES;
export const DOWNLOAD_TIMEOUT_MS = 30_000;
/** get_message_source_download's whole operation (fetch up to 25 MiB from WildDuck, then stage it),
 * always within the request's remaining time. 25 MiB at the transport's stall floor of 1 MiB/s plus its
 * 10 s base is about 36 s; the upload to S3 in the same region normally takes a few seconds more. Its
 * 2 s epilogue and the 60 s Lambda leave about 13 s for authentication and the response. */
export const SOURCE_DOWNLOAD_TIMEOUT_MS = 45_000;
export const DOWNLOAD_URL_TTL_SECONDS = 300;
const PART_BYTES = 5 * 1024 * 1024;
const MIME_TYPE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
export interface AttachmentDownloadBody {
    readonly body: ReadableStream<Uint8Array>;
    /** Validated decoded Content-Length, never an approximate metadata size. */
    readonly expectedSize?: number;
}
/** What the stager uses of a file's metadata: its response headers and any exact size. */
export type DownloadMetadata = Pick<AttachmentMetadata, 'filename' | 'contentType' | 'size' | 'sizeIsApproximate'>;
/** An attachment: streamed from WildDuck only after a cache miss and uploaded in 5 MiB multipart parts,
 * at most MAX_DOWNLOAD_BYTES. */
export interface AttachmentDownloadSource {
    /** Server-derived SHA-256 of authenticated account, mailbox/UID, attachment ID and immutable
     * upstream attachment hash. Never supplied by a tool caller. */
    readonly cacheIdentity: string;
    readonly metadata: DownloadMetadata;
    /** Called only after a cache miss, with the same whole-stage deadline. */
    open(signal: AbortSignal): Promise<AttachmentDownloadBody>;
}
/** A whole message source, already read and hashed, at most MAX_SOURCE_DOWNLOAD_BYTES. A miss uploads it with one
 * conditional PutObject carrying its SHA-256, which S3 checks against the body before storing the object and keeps
 * as the object's full-object checksum. Every object served, new or cached, must report that stored checksum equal
 * to sha256, so the hash the caller returns is bound by S3 to the bytes the link serves. */
export interface ChecksummedDownloadSource {
    /** Server-derived SHA-256 of account, mailbox/UID and the SHA-256 of the source bytes, under a domain
     * string of its own. Never supplied by a tool caller. */
    readonly cacheIdentity: string;
    /** The object's size is always bytes.length. */
    readonly metadata: Pick<DownloadMetadata, 'filename' | 'contentType'>;
    /** Sent as the request body as it is; never copied. */
    readonly bytes: Uint8Array;
    /** Lowercase hex SHA-256 of bytes. */
    readonly sha256: string;
}
export type DownloadSource = AttachmentDownloadSource | ChecksummedDownloadSource;
export interface StagedAttachmentDownload { readonly url: string; readonly expiresAt: string; readonly size: number }
export interface AttachmentDownloadStager { stage(source: DownloadSource, signal?: AbortSignal): Promise<StagedAttachmentDownload> }
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
function exactSize(value: number | undefined, limit: number): void {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) { throw new MailError('invalid_input'); }
    if (value !== undefined && value > limit) { throw new MailError('too_large'); }
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
/** The stable opaque key contains no account, filename or other public identity. Attachments and
 * message sources share the downloads/v1/ prefix; their cache identities hash different domain strings.
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
            const { metadata, cacheIdentity } = source; const checksummed = 'bytes' in source;
            const limit = checksummed ? MAX_SOURCE_DOWNLOAD_BYTES : MAX_DOWNLOAD_BYTES;
            const contentType = MIME_TYPE.test(metadata.contentType) ? metadata.contentType : 'application/octet-stream';
            const contentDisposition = attachmentDisposition(metadata.filename);
            const bytesValid = 'bytes' in source && source.bytes instanceof Uint8Array;
            const metadataSize = 'bytes' in source ? bytesValid ? source.bytes.byteLength : undefined : source.metadata.sizeIsApproximate ? undefined : source.metadata.size ?? undefined;
            /** S3's base64 form of the expected full-object SHA-256; undefined for an attachment or an invalid checksummed source. */
            const checksum = 'bytes' in source && bytesValid && typeof source.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(source.sha256) ? Buffer.from(source.sha256, 'hex').toString('base64') : undefined;
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
                try { result = await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key, ...(checksummed ? { ChecksumMode: 'ENABLED' } : {}) }), { abortSignal: signal }); }
                catch (error) { check(); if (status(error) === 404) { return undefined; } throw error; }
                check();
                const size = result.ContentLength;
                if (size === undefined || !Number.isSafeInteger(size) || size < 0 || size > limit ||
                    metadataSize !== undefined && size !== metadataSize || result.Metadata?.['binding'] !== binding || result.Metadata?.['descriptor'] !== descriptor ||
                    result.ContentType !== contentType || result.ContentDisposition !== contentDisposition || result.CacheControl !== 'private, no-store' ||
                    result.ServerSideEncryption !== 'AES256' || !result.ETag || result.StorageClass !== undefined && result.StorageClass !== 'STANDARD') { throw new MailError('verification_failed'); }
                // A checksummed object is served only if S3's own stored full-object SHA-256 of its body is the expected
                // one: a missing checksum, a composite (multipart checksum-of-checksums) or another value is refused.
                if (checksummed && (checksum === undefined || result.ChecksumSHA256 !== checksum || result.ChecksumType !== 'FULL_OBJECT')) { throw new MailError('verification_failed'); }
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
            /** A checksummed source: one PutObject, so S3's checksum is a full-object SHA-256 (a multipart upload's
             * SHA-256 can only be a composite). S3 rejects the body if it does not match ChecksumSHA256. */
            const put = async (bytes: Uint8Array): Promise<number> => {
                check();
                try {
                    await client.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: bytes, ChecksumSHA256: checksum, IfNoneMatch: '*',
                        ContentType: contentType, ContentDisposition: contentDisposition, CacheControl: 'private, no-store', ServerSideEncryption: 'AES256',
                        Metadata: { binding, descriptor } }), { abortSignal: signal });
                } catch (error) {
                    // 412: another request stored this key first. Its object is verified by HEAD exactly as a cache hit;
                    // it is never overwritten or deleted.
                    check(); if (status(error) !== 412) { throw error; }
                }
                return bytes.byteLength;
            };
            /** An attachment: streamed in bounded multipart parts while counting the actual bytes. */
            const multipart = async (opener: AttachmentDownloadSource): Promise<number> => {
                const opened = await opener.open(signal); reader = opened.body.getReader(); check();
                exactSize(opened.expectedSize, limit);
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
                    if (size > limit) { throw new MailError('too_large'); }
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
                return size;
            };
            const operation = async (): Promise<StagedAttachmentDownload> => {
                check(); if (!/^[a-f0-9]{64}$/u.test(cacheIdentity) || checksummed && checksum === undefined) { throw new MailError('invalid_input'); }
                exactSize(metadataSize, limit);
                const cached = await head(); if (cached) { return sign(cached); }
                const size = 'bytes' in source ? await put(source.bytes) : await multipart(source);
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
