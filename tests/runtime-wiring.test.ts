import { expect, test } from 'bun:test';
import { createMail } from '../src/auth/runtime';
import type { createMailBackend } from '../src/mail/backend';
import { DynamoAttachmentUploadStore } from '../src/mail/upload-store';

/** Records what the runtime hands to the backend and the service, without creating real ones. */
function wire(config: Parameters<typeof createMail>[0]) {
    const seen: { backend?: Parameters<typeof createMailBackend>[0]; service?: unknown } = {};
    const backend = {} as never; const mail = { marker: 'service' } as never;
    const result = createMail(config, 'wildduck-mcp-state', { backend: options => { seen.backend = options; return backend; }, service: dependencies => { seen.service = dependencies; return mail; } });
    return { result, seen, backend, mail };
}

test('with a bucket the runtime wires one upload store and one upload stager into both the backend and the service', () => {
    const { result, seen, backend, mail } = wire({ downloadBucketName: 'wildduck-mcp-prod-downloads' });
    expect(result).toBe(mail);
    const service = seen.service as { reader: unknown; writer: unknown; uploads?: { store: unknown; stager: { presign: unknown; readStaged: unknown } } };
    expect(service.reader).toBe(backend); expect(service.writer).toBe(backend);
    expect(seen.backend?.uploadStore).toBeInstanceOf(DynamoAttachmentUploadStore); expect(seen.backend?.uploadStager).toBeDefined(); expect(seen.backend?.downloadStager).toBeDefined();
    expect(service.uploads?.store).toBe(seen.backend?.uploadStore); expect(service.uploads?.stager).toBe(seen.backend?.uploadStager);
    expect(typeof service.uploads?.stager.presign).toBe('function'); expect(typeof service.uploads?.stager.readStaged).toBe('function');
});
test('without a bucket neither downloads nor uploads are wired, so those tools fail closed', () => {
    const { seen } = wire({});
    expect(seen.backend).not.toHaveProperty('uploadStore'); expect(seen.backend).not.toHaveProperty('uploadStager'); expect(seen.backend).not.toHaveProperty('downloadStager');
    expect(seen.service).not.toHaveProperty('uploads');
});
