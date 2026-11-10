import { expect, test } from 'bun:test';
import { ownedIdentityMatcher } from '../src/mail/identities';
import { loadConfig } from '../src/config';

test('dot routing and reply suffix stripping are independent flags with strict boolean settings', () => {
    expect(loadConfig({})).toMatchObject({ dotAsPlus: false, stripReplySuffix: true });
    for (const dotAsPlus of [false, true]) { for (const stripReplySuffix of [false, true]) {
        expect(loadConfig({ WILDDUCK_DOT_AS_PLUS: String(dotAsPlus), WILDDUCK_STRIP_REPLY_SUFFIX: String(stripReplySuffix) })).toMatchObject({ dotAsPlus, stripReplySuffix });
    } }
    for (const name of ['WILDDUCK_DOT_AS_PLUS', 'WILDDUCK_STRIP_REPLY_SUFFIX']) {
        for (const value of ['', 'yes', '1', 'TRUE']) { expect(() => loadConfig({ [name]: value })).toThrow(); }
    }
});
test('standard WildDuck ownership recognizes plus tags and dotted lookup keys without dot suffix stripping', () => {
    const match = ownedIdentityMatcher(['craig@rungie.com', 'real.alias@example.com'], false);
    expect(match('CRAIG@RUNGIE.COM')).toBe('craig@rungie.com');
    expect(match('real.alias@example.com')).toBe('real.alias@example.com');
    expect(match('craig+tag@rungie.com')).toBe('craig@rungie.com');
    expect(match('realalias@example.com')).toBe('real.alias@example.com');
    for (const address of ['craig.tag@rungie.com', 'craig@elsewhere.com']) { expect(match(address)).toBeUndefined(); }
});
test('configured tag resolution matches registered lookup keys without stripping aliases', () => {
    const dot = ownedIdentityMatcher(['craig@rungie.com', 'alice.smith@example.com', '*@wild.example'], true);
    for (const address of ['craig+tag@rungie.com', 'CRAIG.Tag@RUNGIE.COM', 'craig.tag+more@rungie.com']) { expect(dot(address)).toBe('craig@rungie.com'); }
    expect(dot('alicesmith.tag@example.com')).toBe('alice.smith@example.com');
    for (const address of ['alice.tag@example.com', 'alice.smith@example.com', 'craig.tag@elsewhere.com', 'anything@wild.example', 'craig@rungie.com.evil.test', 'craig.tag@rungie.com\r\nX: bad', '"craig.tag"@rungie.com']) { expect(dot(address)).toBeUndefined(); }
    const plus = ownedIdentityMatcher(['alice.smith@example.com'], false);
    expect(plus('alice.smith+tag@example.com')).toBe('alice.smith@example.com');
    expect(plus('alice.tag@example.com')).toBeUndefined();
});
test('ownership keys normalize Unicode and IDN domains without crossing domains', () => {
    const match = ownedIdentityMatcher(['café@bücher.example'], true);
    expect(match('cafe\u0301.tag@xn--bcher-kva.example')).toBe('café@bücher.example');
    expect(match('café.tag@bucher.example')).toBeUndefined();
    const ascii = ownedIdentityMatcher(['craig@rungie.com'], true);
    expect(ascii('craig.tag@ｒungie.com')).toBeUndefined();
    expect(ascii('craig.tag@rungie。com')).toBeUndefined();
});
test('configured primary is an exact normalized exception, without authorizing its label prefix', () => {
    const match = ownedIdentityMatcher(['alice.smith@example.com', 'other.alias@example.com'], true, 'alice.smith@example.com');
    expect(match('ALICE.SMITH@example.com')).toBe('alice.smith@example.com');
    expect(match('alice.tag@example.com')).toBeUndefined();
    expect(match('alice.smith+tag@example.com')).toBeUndefined();
    expect(match('other.alias@example.com')).toBeUndefined();
});
