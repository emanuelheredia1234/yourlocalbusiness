// The live homepage verification URL is answered by the app server itself, before the SPA shell.
import { afterAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOMEPAGE_VERIFICATION_FILE, verificationBody } from './sitemap.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BODY = verificationBody(HOMEPAGE_VERIFICATION_FILE);

describe('GET /google2598e017b2dc1e02.html on the app server', () => {
  let child;
  let port;
  let output = '';

  afterAll(async () => {
    if (!child) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  });

  it('returns the verification line, with no sign-in and no app shell', async () => {
    port = await new Promise((resolve) => {
      const probe = http.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address();
        probe.close(() => resolve(free));
      });
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-gsc-'));
    child = spawn(process.execPath, [path.join(here, '..', 'ai-server.mjs')], {
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

    const got = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `/${HOMEPAGE_VERIFICATION_FILE}`, headers: { host: 'yourlocalbusiness.replit.app' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, type: res.headers['content-type'], text: Buffer.concat(chunks).toString('utf8') }));
      }).on('error', reject);
    });

    expect(got.status).toBe(200);
    expect(got.location).toBeUndefined();
    expect(got.type).toMatch(/text\/html/);
    expect(got.text).toBe(BODY);
    expect(got.text).not.toContain('id="root"');
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});
