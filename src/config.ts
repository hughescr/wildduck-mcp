export interface Config { readonly dotAsPlus?: boolean; readonly stripReplySuffix?: boolean; readonly downloadBucketName?: string; readonly publicBaseUrl?: string; readonly credentialTableName?: string; readonly authKeyringParameter?: string }
function flag(env: Record<string, string | undefined>, name: string, fallback: boolean): boolean {
    const value = env[name];
    if (value === undefined) { return fallback; }
    if (value !== 'true' && value !== 'false') { throw new Error(`${name} must be true or false`); }
    return value === 'true';
}
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
    const raw = env['PUBLIC_BASE_URL'];
    const dotAsPlus = flag(env, 'WILDDUCK_DOT_AS_PLUS', false);
    const stripReplySuffix = flag(env, 'WILDDUCK_STRIP_REPLY_SUFFIX', true);
    let publicBaseUrl: string | undefined;
    if (raw) {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') { throw new Error('PUBLIC_BASE_URL must be an HTTPS origin'); }
        publicBaseUrl = url.origin;
    }
    return { dotAsPlus, stripReplySuffix, ...(env['DOWNLOAD_BUCKET_NAME'] ? { downloadBucketName: env['DOWNLOAD_BUCKET_NAME'] } : {}), ...(publicBaseUrl ? { publicBaseUrl } : {}), ...(env['CREDENTIAL_TABLE_NAME'] ? { credentialTableName: env['CREDENTIAL_TABLE_NAME'] } : {}), ...(env['AUTH_KEYRING_PARAMETER'] ? { authKeyringParameter: env['AUTH_KEYRING_PARAMETER'] } : {}) };
}
