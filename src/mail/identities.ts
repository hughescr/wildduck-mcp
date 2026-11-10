import { toUnicode } from 'nodemailer/lib/punycode';
import { isEmailValid } from '@hapi/address';

const emailOptions = { tlds: false } as unknown as Parameters<typeof isEmailValid>[1];
function parts(address: string): { local: string; domain: string } | undefined {
    if (address.includes('*') || !isEmailValid(address, emailOptions)) { return undefined; }
    const at = address.lastIndexOf('@');
    const local = address.slice(0, at).normalize('NFC').toLowerCase();
    // Quoted local parts and domain literals are valid SMTP syntax, but their
    // routing semantics are not part of this policy. Do not infer ownership.
    if (local.includes('"') || address[at + 1] === '[') { return undefined; }
    // Match WildDuck normalizeDomain(), not URL/UTS46 host normalization, which
    // folds additional Unicode spellings that the mail resolver keeps distinct.
    let domain = address.slice(at + 1).toLowerCase().trim();
    if (/xn--/u.test(domain)) {
        try { domain = toUnicode(domain).normalize('NFC').toLowerCase().trim(); } catch { /* WildDuck retains malformed punycode unchanged. */ }
    }
    return domain ? { local, domain } : undefined;
}
/** Bounded account-owned identities, with WildDuck's asymmetric candidate and
 * registered-address keys. Never strip labels from registered aliases: owning
 * alice.smith does not establish ownership of alice.tag. */
export function ownedIdentityMatcher(ownedAddresses: readonly string[], dotAsPlus: boolean, primaryAddress?: string): (candidate: string) => string | undefined {
    const primary = primaryAddress === undefined ? undefined : parts(primaryAddress);
    const registered = new Map<string, string>();
    for (const address of ownedAddresses) {
        const value = parts(address); if (!value) { continue; }
        const key = `${value.local.replace(/\./gu, '')}@${value.domain}`;
        registered.set(key, registered.get(key) ?? address);
    }
    return candidate => {
        const value = parts(candidate); if (!value) { return undefined; }
        // WildDuck explicitly accepts its configured primary sender before
        // resolving labels. This exception does not extend to dotted aliases.
        if (primary && value.local === primary.local && value.domain === primary.domain) { return primaryAddress; }
        const local = value.local.replace(dotAsPlus ? /[.+].*$/u : /\+.*$/u, '').replace(/\./gu, '');
        return local ? registered.get(`${local}@${value.domain}`) : undefined;
    };
}
