import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { PAGE_STYLE, PAGE_STYLE_SOURCE } from '../src/auth/page-style';
import { WildduckError, type WildduckErrorCode } from '../src/wildduck';
import { page, post, setup } from './auth-http.test';

type Env = ReturnType<typeof setup>;
/** Opens the sign-in page, then submits it so the next page (TOTP or consent) or an error page comes back. */
async function signIn(env: Env) {
    const start = await env.app.request(`/authorize?${env.params}`);
    const login = page(start, await start.text()); login.fields.set('username', 'user'); login.fields.set('password', 'password');
    return post(env.app, '/auth/login', login.fields, login.cookie);
}
async function failing(code: WildduckErrorCode) {
    const env = setup(); env.runtime.wildduck.beginLogin = async () => { throw new WildduckError(code); };
    return signIn(env);
}
/** One HTML response of every page kind the browser flow can serve. */
async function pages(): Promise<Record<string, Response>> {
    const send = setup(); send.params.set('scope', 'profile mail:read mail:send'); const first = setup();
    return {
        'sign-in': await first.app.request(`/authorize?${first.params}`),
        totp: await signIn(setup(true)),
        consent: await signIn(setup()),
        'consent with mail:send': await signIn(send),
        'error 400': await failing('authentication_failed'),
        'error 503': await failing('temporary'),
    };
}

test('the style source is the SHA-256 of the exact style text', () => {
    expect(PAGE_STYLE_SOURCE).toBe(`'sha256-${createHash('sha256').update(PAGE_STYLE, 'utf8').digest('base64')}'`);
});
test('every page kind carries exactly one style block that the CSP allows by hash and nothing broader', async () => {
    const all = await pages(); expect(Object.keys(all)).toHaveLength(6);
    expect(all['error 400']?.status).toBe(400); expect(all['error 503']?.status).toBe(503);
    for (const [kind, response] of Object.entries(all)) {
        const html = await response.text();
        expect(response.headers.get('content-type'), kind).toContain('text/html');
        const blocks = [...html.matchAll(/<style>([^]*?)<\/style>/g)];
        expect(blocks, kind).toHaveLength(1); expect(html.match(/<style/g), kind).toHaveLength(1);
        const recomputed = `'sha256-${createHash('sha256').update(blocks[0]?.[1] ?? '', 'utf8').digest('base64')}'`;
        const csp = response.headers.get('content-security-policy') ?? '';
        const formAction = ['error 400', 'error 503'].includes(kind) ? "form-action 'self'" : "form-action 'self' http://127.0.0.1:5678";
        expect(csp, kind).toBe(`default-src 'none'; style-src ${recomputed}; ${formAction}; frame-ancestors 'none'; base-uri 'none'`);
        expect(csp, kind).toContain(`style-src ${recomputed};`);
        expect(csp, kind).not.toMatch(/unsafe|nonce|script-src|img-src|font-src|connect-src/);
        expect(response.headers.get('referrer-policy'), kind).toBe('same-origin');
    }
});
test('no page has a style attribute, script, external reference or url() resource', async () => {
    for (const [kind, response] of Object.entries(await pages())) {
        const html = await response.text();
        expect(html.replace(/<style>[^]*?<\/style>/, ''), kind).not.toMatch(/\sstyle\s*=/i);
        expect(html, kind).not.toMatch(/<script|<link|<img|<iframe|<object|<embed|<svg|<base|<a[\s>]|\ssrc\s*=|\shref\s*=|javascript:|\son[a-z]+\s*=/i);
        // Hidden OAuth parameters legitimately hold URLs as values; nothing else may name one.
        expect(html.replace(/ value="[^"]*"/g, ''), kind).not.toMatch(/https?:\/\/|\/\/[a-z]/i);
        expect(html, kind).not.toMatch(/url\(|@import|@font-face/i);
    }
});
test('every page kind is the same brand shell with the shared heading structure', async () => {
    for (const [kind, response] of Object.entries(await pages())) {
        const html = await response.text();
        expect(html, kind).toMatch(/^<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>[^<]+ · wildduck-mcp<\/title><style>/);
        expect(html, kind).toContain('<header><div class="brand">wildduck-mcp</div><h1>');
    }
});
test('every form puts the primary button first and Cancel second, and keeps its submit attributes', async () => {
    const all = await pages();
    const expected: Record<string, [string, string]> = {
        'sign-in': ['<button class="primary">Sign in</button>', '/auth/login'], totp: ['<button class="primary">Verify</button>', '/auth/mfa'],
        consent: ['<button class="primary" name="decision" value="allow">Allow connection</button>', '/auth/consent'], 'consent with mail:send': ['<button class="primary" name="decision" value="allow">Allow connection</button>', '/auth/consent'],
    };
    for (const [kind, [primary, action]] of Object.entries(expected)) {
        const html = await (all[kind] ?? new Response()).clone().text();
        expect(html, kind).toContain(`<form method="post" action="${action}">`);
        expect(html, kind).toContain(`<div class="actions">${primary}<button class="secondary" name="decision" value="cancel" formnovalidate>Cancel</button></div></form>`);
        expect(html.match(/<button/g), kind).toHaveLength(2);
        // The TOTP step is a bare form; the others open with the request panel naming the redirect destination.
        expect(html.includes('<div class="request">'), kind).toBe(kind !== 'totp'); expect(html.includes('Redirect destination · <span class="host">127.0.0.1</span>'), kind).toBe(kind !== 'totp');
    }
    const signIn = await (all['sign-in'] ?? new Response()).clone().text();
    expect(signIn).toContain('<label class="field">Username <input name="username" autocomplete="username" required maxlength="254"></label>');
    expect(signIn).toContain('<label class="field">Password <input type="password" name="password" autocomplete="current-password" required maxlength="256"></label>');
    expect(signIn).toContain('<p class="help">TOTP authenticator codes are supported.');
    expect(await (all.totp ?? new Response()).text()).toContain('<label class="field">Authenticator code <input name="totp" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" required></label>');
});
test('consent lists one permission row per scope and only mail:send adds the required checkbox', async () => {
    const plain = await (await pages()).consent?.text() ?? ''; const sending = await (await pages())['consent with mail:send']?.text() ?? '';
    expect(plain).toContain('<section class="permissions"><h2>Requested permissions</h2><div class="rows"><ul>');
    expect(plain).toContain('<li class="permission"><span>Read your mail<small>mail:read</small></span></li>');
    expect(plain.match(/<li class="permission">/g)).toHaveLength(2); expect(plain).not.toContain('type="checkbox"');
    expect(plain).toContain('<p class="help">Keep this connection for up to 180 days.');
    expect(sending.match(/<li class="permission">/g)).toHaveLength(3);
    expect(sending).toContain('<label class="permission"><input type="checkbox" name="allow_send" value="yes" required><span>Allow sending mail</span></label>');
    expect(sending.match(/type="checkbox"/g)).toHaveLength(1);
});
test('error pages are a terminal section that echoes only a fixed message', async () => {
    const all = await pages();
    for (const [kind, heading] of [['error 400', 'Sign-in could not continue'], ['error 503', 'Temporary failure · 503']] as const) {
        const html = await (all[kind] ?? new Response()).text();
        expect(html, kind).toContain(`<section class="terminal" aria-labelledby="result"><h2 id="result">${heading}</h2><p>`);
        expect(html, kind).toContain('<h1>Connection not completed</h1>');
        expect(html, kind).not.toMatch(/<form|<input|<button/);
    }
});
