export interface Config { readonly downloadBucketName?: string; readonly publicBaseUrl?: string; readonly credentialTableName?: string; readonly authKeyringParameter?: string }
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
    const raw = env['PUBLIC_BASE_URL'];
    let publicBaseUrl: string | undefined;
    if (raw) {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') { throw new Error('PUBLIC_BASE_URL must be an HTTPS origin'); }
        publicBaseUrl = url.origin;
    }
    return { ...(env['DOWNLOAD_BUCKET_NAME'] ? { downloadBucketName: env['DOWNLOAD_BUCKET_NAME'] } : {}), ...(publicBaseUrl ? { publicBaseUrl } : {}), ...(env['CREDENTIAL_TABLE_NAME'] ? { credentialTableName: env['CREDENTIAL_TABLE_NAME'] } : {}), ...(env['AUTH_KEYRING_PARAMETER'] ? { authKeyringParameter: env['AUTH_KEYRING_PARAMETER'] } : {}) };
}
