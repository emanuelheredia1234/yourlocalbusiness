import { afterAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyLegal, legalHtml, serveLegal, PRIVACY_URL, TERMS_URL, LEGAL_UPDATED, OPERATOR_EMAIL, OPERATOR_NAME } from './legal.mjs';

function response() {
  return {
    status: 0,
    headers: {},
    body: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

function ask(method, pathname) {
  const res = response();
  const handled = serveLegal({ method }, res, new URL(pathname, 'https://yourlocalbusiness.replit.app'));
  const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body ?? '');
  return { handled, res, text };
}

describe('legal documents', () => {
  it('serves full policy text at /privacy and /terms, not the app shell', () => {
    const privacy = ask('GET', '/privacy');
    const terms = ask('GET', '/terms');
    expect(privacy.handled).toBe(true);
    expect(privacy.res.status).toBe(200);
    expect(privacy.res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(String(privacy.res.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(privacy.res.headers['set-cookie']).toBeUndefined();
    for (const page of [privacy, terms]) {
      expect(page.text).not.toContain('id="root"');
      expect(page.text).not.toContain('/src/main.tsx');
      expect(page.text).toContain(LEGAL_UPDATED);
      expect(page.text).toContain(OPERATOR_NAME);
      expect(page.text).toContain(OPERATOR_EMAIL);
      expect(page.text).toContain('Your Local Business');
      expect(page.text).not.toMatch(/\bLLC\b|\bEIN\b|\bDPO\b|Suite \d|Street\b/);
    }
    expect(privacy.text).toContain('<h1>Privacy Policy</h1>');
    expect(privacy.text).toContain(PRIVACY_URL);
    expect(privacy.text).toContain('not for children under 13');
    expect(privacy.text).toContain('We do not store full card numbers.');
    expect(privacy.text).toContain('gmail.send');
    expect(privacy.text).toContain('Supabase');
    expect(privacy.text).toContain('Replit');
    expect(privacy.text).toContain('Stripe');
    expect(privacy.text).toContain('TONVI TECH SL');
    expect(privacy.text).toContain('Disconnecting deletes the tokens');
    expect(terms.text).toContain('<h1>Terms of Service</h1>');
    expect(terms.text).toContain(TERMS_URL);
    expect(terms.text).toContain('Do not send spam');
    expect(terms.text).toContain('as is');
    expect(terms.text).toContain('State of Washington');
    expect(terms.text).toContain('Gmail');
  });

  it('redirects the long aliases and trailing slashes to the canonical paths', () => {
    expect(classifyLegal('/privacy')).toEqual({ doc: 'privacy' });
    expect(classifyLegal('/terms')).toEqual({ doc: 'terms' });
    expect(classifyLegal('/login')).toBeNull();
    for (const [from, to] of [
      ['/privacy-policy', '/privacy'],
      ['/terms-of-service', '/terms'],
      ['/privacy/', '/privacy'],
      ['/terms/', '/terms'],
      ['/privacy-policy/', '/privacy'],
      ['/terms-of-service/', '/terms'],
    ]) {
      const res = ask('GET', from);
      expect(res.res.status, from).toBe(301);
      expect(res.res.headers.location, from).toBe(to);
      expect(res.text).toBe('');
    }
  });

  it('answers HEAD without a body and refuses other methods', () => {
    const head = ask('HEAD', '/privacy');
    expect(head.res.status).toBe(200);
    expect(head.body).toBeUndefined();
    expect(head.res.headers['content-length']).toBe(Buffer.byteLength(legalHtml('privacy')));
    const post = ask('POST', '/terms');
    expect(post.res.status).toBe(405);
    expect(post.res.headers.allow).toBe('GET, HEAD');
  });
});

const here = path.dirname(fileURLToPath(import.meta.url));

describe('the published server', () => {
  let child;
  let port;
  let output = '';

  afterAll(async () => {
    if (!child) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  });

  it('returns the policy from the app server, while the shell is still the app', async () => {
    port = await new Promise((resolve) => {
      const probe = http.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address();
        probe.close(() => resolve(free));
      });
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-legal-'));
    child = spawn(process.execPath, [path.join(here, 'ai-server.mjs')], {
      env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server didn’t start: ${output}`)), 15_000);
      const check = () => (output.includes('Yourlocalbusiness server on') ? (clearTimeout(timer), resolve()) : setTimeout(check, 25));
      check();
    });

    const get = (pathname) =>
      new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: pathname, headers: { host: 'yourlocalbusiness.replit.app' } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        }).on('error', reject);
      });

    const privacy = await get('/privacy');
    expect(privacy.status).toBe(200);
    expect(privacy.headers['content-type']).toMatch(/text\/html/);
    expect(privacy.text).toContain('<h1>Privacy Policy</h1>');
    expect(privacy.text).toContain('We do not store full card numbers.');
    expect(privacy.text).not.toContain('id="root"');
    const terms = await get('/terms');
    expect(terms.text).toContain('<h1>Terms of Service</h1>');
    expect(terms.text).toContain('State of Washington');
    const alias = await get('/privacy-policy');
    expect(alias.status).toBe(301);
    expect(alias.headers.location).toBe('/privacy');
    const termsAlias = await get('/terms-of-service');
    expect(termsAlias.status).toBe(301);
    expect(termsAlias.headers.location).toBe('/terms');
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});
