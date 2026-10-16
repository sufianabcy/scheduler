import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers.js';

describe('serving the web app', () => {
  let t, dir;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'planner-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Planner</title>');
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    writeFileSync(join(dir, 'manifest.webmanifest'), '{}');
    t = await startTestServer({ config: { webDir: dir } });
  });
  after(async () => {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('index.html is served at / and always rechecked', async () => {
    const res = await t.request('/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>Planner<\/title>/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  });

  test('built assets are cached for a year', async () => {
    const res = await t.request('/assets/index-abc123.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /immutable/);
  });

  test('the manifest has the right content type', async () => {
    const res = await t.request('/manifest.webmanifest');
    assert.equal(res.headers.get('content-type'), 'application/manifest+json; charset=utf-8');
  });

  test('the API still works next to the files', async () => {
    assert.equal((await t.request('/api/health')).status, 200);
  });
});
