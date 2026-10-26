export interface Config {
    readonly publicBaseUrl?: string;
    readonly credentialTableName?: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
    const publicBaseUrl = env['PUBLIC_BASE_URL'];
    if (publicBaseUrl !== undefined) {
        const url = new URL(publicBaseUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
            throw new Error('PUBLIC_BASE_URL must be an HTTPS origin without credentials, query, or fragment');
        }
    }
    return {
        ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
        ...(env['CREDENTIAL_TABLE_NAME'] === undefined ? {} : { credentialTableName: env['CREDENTIAL_TABLE_NAME'] }),
    };
}
