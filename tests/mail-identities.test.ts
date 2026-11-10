import { expect, test } from 'bun:test';
import { ownedIdentityMatcher } from '../src/mail/identities';
import { loadConfig } from '../src/config';

test('tag routing is an explicit administrator policy and invalid settings fail closed', () => {
    expect(loadConfig({}).addressTagPolicy).toBe('exact');
    for (const policy of ['exact', 'plus', 'dot-plus'] as const) { expect(loadConfig({ WILDDUCK_ADDRESS_TAG_POLICY: policy }).addressTagPolicy).toBe(policy); }
    expect(() => loadConfig({ WILDDUCK_ADDRESS_TAG_POLICY: 'dots-anywhere' })).toThrow();
});
test('exact ownership is case insensitive but does not guess plus or dot tags', () => {
    const match = ownedIdentityMatcher(['craig@rungie.com', 'real.alias@example.com'], 'exact');
    expect(match('CRAIG@RUNGIE.COM')).toBe('craig@rungie.com');
    expect(match('real.alias@example.com')).toBe('real.alias@example.com');
    for (const address of ['craig+tag@rungie.com', 'craig.tag@rungie.com', 'realalias@example.com', 'craig@elsewhere.com']) { expect(match(address)).toBeUndefined(); }
});
test('configured tag resolution matches registered lookup keys without stripping aliases', () => {
    const dot = ownedIdentityMatcher(['craig@rungie.com', 'alice.smith@example.com', '*@wild.example'], 'dot-plus');
    for (const address of ['craig+tag@rungie.com', 'CRAIG.Tag@RUNGIE.COM', 'craig.tag+more@rungie.com']) { expect(dot(address)).toBe('craig@rungie.com'); }
    expect(dot('alicesmith.tag@example.com')).toBe('alice.smith@example.com');
    for (const address of ['alice.tag@example.com', 'alice.smith@example.com', 'craig.tag@elsewhere.com', 'anything@wild.example', 'craig@rungie.com.evil.test', 'craig.tag@rungie.com\r\nX: bad', '"craig.tag"@rungie.com']) { expect(dot(address)).toBeUndefined(); }
    const plus = ownedIdentityMatcher(['alice.smith@example.com'], 'plus');
    expect(plus('alice.smith+tag@example.com')).toBe('alice.smith@example.com');
    expect(plus('alice.tag@example.com')).toBeUndefined();
});
test('ownership keys normalize Unicode and IDN domains without crossing domains', () => {
    const match = ownedIdentityMatcher(['café@bücher.example'], 'dot-plus');
    expect(match('cafe\u0301.tag@xn--bcher-kva.example')).toBe('café@bücher.example');
    expect(match('café.tag@bucher.example')).toBeUndefined();
});
