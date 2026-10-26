import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function startServer(t, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'outage-srv-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, DEMO: '1', DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return base;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

test('demo server: snapshot, page security headers, static safety', async (t) => {
  const base = await startServer(t);
  const snap = await (await fetch(`${base}/api/snapshot`)).json();
  assert.equal(snap.demo, true);
  assert.equal(snap.sources.length, 4);
  assert.ok(snap.totals.customersOut > 0);
  assert.equal(snap.internet.provinces.BC.active, true);
  assert.equal(snap.sites.find((s) => s.name.startsWith('Jasper')).impact.status, 'out');

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(`${base}/..%2fserver%2findex.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);

  const hist = await (await fetch(`${base}/api/history?hours=24`)).json();
  assert.ok(hist.points.length > 100, 'demo history seeded');
});

test('sites API: add, edit, import, export, delete', async (t) => {
  const base = await startServer(t);
  const post = (url, body, type = 'application/json') =>
    fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': type }, body });
  let res = await post('/api/sites', JSON.stringify({ name: 'Test', lat: 'x', lon: 1 }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Latitude/);
  res = await post('/api/sites', JSON.stringify({ name: 'Red Deer shop', lat: 52.27, lon: -113.81 }));
  assert.equal(res.status, 201);
  const { site } = await res.json();
  res = await fetch(`${base}/api/sites/${site.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: 'Back door code with office' }),
  });
  assert.equal((await res.json()).site.notes, 'Back door code with office');
  res = await post('/api/sites/import?mode=append', 'name,lat,lon\nLethbridge,49.69,-112.84\n', 'text/csv');
  assert.equal((await res.json()).imported, 1);
  const csv = await (await fetch(`${base}/api/sites/export.csv`)).text();
  assert.match(csv, /Red Deer shop/);
  assert.match(csv, /Lethbridge/);
  res = await fetch(`${base}/api/sites/${site.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const snap = await (await fetch(`${base}/api/snapshot`)).json();
  assert.ok(!snap.sites.some((s) => s.id === site.id));
});

test('EDIT_TOKEN protects site changes but not viewing', async (t) => {
  const base = await startServer(t, { EDIT_TOKEN: 'secret-code' });
  const body = JSON.stringify({ name: 'X', lat: 51, lon: -114 });
  let res = await fetch(`${base}/api/sites`, { method: 'POST', body });
  assert.equal(res.status, 403);
  res = await fetch(`${base}/api/sites`, {
    method: 'POST',
    body,
    headers: { 'X-Edit-Token': 'secret-code' },
  });
  assert.equal(res.status, 201);
  assert.equal((await fetch(`${base}/api/snapshot`)).status, 200);
  assert.equal((await (await fetch(`${base}/api/snapshot`)).json()).editProtected, true);
});
