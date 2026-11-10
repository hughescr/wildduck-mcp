import { domainToUnicode } from 'node:url';
import { isEmailValid } from '@hapi/address';

/** Administrator assertion about the configured WildDuck address resolver. */
export type AddressTagPolicy = 'exact' | 'plus' | 'dot-plus';
const emailOptions = { tlds: false } as unknown as Parameters<typeof isEmailValid>[1];
export function validAddressTagPolicy(value: unknown): value is AddressTagPolicy { return value === 'exact' || value === 'plus' || value === 'dot-plus'; }
function parts(address: string): { local: string; domain: string } | undefined {
    if (address.includes('*') || !isEmailValid(address, emailOptions)) { return undefined; }
    const at = address.lastIndexOf('@');
    const local = address.slice(0, at).normalize('NFC').toLowerCase();
    // Quoted local parts and domain literals are valid SMTP syntax, but their
    // routing semantics are not part of this policy. Do not infer ownership.
    if (local.includes('"') || address[at + 1] === '[') { return undefined; }
    const domain = domainToUnicode(address.slice(at + 1)).normalize('NFC').toLowerCase();
    return domain ? { local, domain } : undefined;
}
/** Bounded account-owned identities, with WildDuck's asymmetric candidate and
 * registered-address keys. Never strip labels from registered aliases: owning
 * alice.smith does not establish ownership of alice.tag. */
export function ownedIdentityMatcher(ownedAddresses: readonly string[], policy: AddressTagPolicy): (candidate: string) => string | undefined {
    const registered = new Map<string, string>();
    for (const address of ownedAddresses) {
        const value = parts(address); if (!value) { continue; }
        const key = `${policy === 'exact' ? value.local : value.local.replace(/\./gu, '')}@${value.domain}`;
        registered.set(key, registered.get(key) ?? address);
    }
    return candidate => {
        const value = parts(candidate); if (!value) { return undefined; }
        const local = policy === 'exact' ? value.local : value.local.replace(policy === 'plus' ? /\+.*$/u : /[.+].*$/u, '').replace(/\./gu, '');
        return local ? registered.get(`${local}@${value.domain}`) : undefined;
    };
}
