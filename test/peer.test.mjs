import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMonitor } from '../server/monitor.js';
import { createStore } from '../server/store.js';
import { createPeer, createEditQueue, applyOp, keyMatches } from '../server/peer.js';
import { combineWan } from '../server/wan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'od-peer-'));
const ROW = { stableId: 'u1:1', kind: 'unplanned', utility: 'u1', province: 'AB', area: 'Airdrie', customers: 40, point: { lat: 51.29, lon: -114.01 }, polygons: [] };
const quiet = { warn() {}, info() {}, error() {} };

/** One instance's moving parts, with a utility feed that can be made to fail. */
function instance(name, role, clock) {
  let failing = false;
  const store = createStore(tmp(), { now: () => clock.t });
  const sources = [{ id: 'u1', name: 'Utility One', province: 'AB', region: '', map: '', feeds: [{ id: 'live', ttl: 0, load: async () => { if (failing) throw new Error('HTTP 403'); return [ROW]; } }] }];
  const monitor = createMonitor({ sources, store, provinces: { type: 'FeatureCollection', features: [] }, coverage: { AB: {} }, now: () => clock.t, log: quiet });
  const isp = { exportFeeds: () => [], exportSiteChecks: () => ({}), importPeer() {}, borrowedHave: () => ({}) };
  const wan = { exportResults: () => ({}), importPeer() {} };
  const queue = createEditQueue(tmp());
  const peer = createPeer({ config: { instanceName: name, sites: role }, store, queue, monitor, ispStatus: isp, wan, now: () => clock.t, log: quiet });
  return { store, monitor, peer, queue, fail: (v) => (failing = v) };
}

test('feeds: borrowed only while ours fails, labelled, never passed back', async () => {
  const clock = { t: Date.parse('2026-11-01T12:00:00Z') };
  const ab = instance('Alberta office', 'owner', clock);
  const ns = instance('Nova Scotia', 'mirror', clock);
  ns.fail(true);
  await ab.monitor.tick();
  await ns.monitor.tick();
  assert.equal(ns.monitor.snapshot().sources[0].status, 'down');
  // One exchange, whichever side starts it.
  ns.peer.absorb(ab.peer.payload());
  ab.peer.absorb(ns.peer.payload());
  const s = ns.monitor.reassess().sources[0];
  assert.deepEqual([s.status, s.via, s.ownError], ['ok', 'Alberta office', 'HTTP 403']);
  assert.equal(ns.monitor.snapshot().rows.length, 1);
  // Nova Scotia has nothing of its own to hand back: no echo.
  assert.deepEqual(ns.monitor.exportFeeds(), []);
  // Unchanged feeds aren't sent again.
  assert.deepEqual(ab.peer.payload().feeds, []);
  // Ours recovers: back to our own copy.
  ns.fail(false);
  clock.t += 1000;
  await ns.monitor.tick();
  assert.equal(ns.monitor.snapshot().sources[0].via, null);
  // A healthy local feed never takes the peer's copy.
  assert.equal(ab.monitor.reassess().sources[0].via, null);
});

test('feeds: a stale borrowed copy is dropped; clocks out of step are corrected', async () => {
  const clock = { t: Date.parse('2026-11-01T12:00:00Z') };
  const ab = instance('Alberta office', 'owner', clock);
  const ns = instance('Nova Scotia', 'mirror', clock);
  ns.fail(true);
  await ab.monitor.tick();
  const body = ab.peer.payload();
  // The peer's clock runs 10 minutes fast: its times are shifted onto ours.
  body.sentAt += 600_000;
  body.feeds[0].fetchedAt += 600_000;
  ns.peer.absorb(body);
  await ns.monitor.tick();
  assert.equal(ns.monitor.snapshot().sources[0].lastSuccessAt, clock.t);
  clock.t += 31 * 60_000;
  assert.equal(ns.monitor.reassess().sources[0].status, 'down');
  assert.throws(() => ns.peer.absorb({ ...body, protocol: 99 }), /different Outage Desk version/);
});

test('client list: owner pushes it, mirror edits queue and come back applied, last change wins', () => {
  const clock = { t: Date.parse('2026-11-01T12:00:00Z') };
  const ab = instance('Alberta office', 'owner', clock);
  const ns = instance('Nova Scotia', 'mirror', clock);
  const a = ab.store.addSite({ name: 'Marex', lat: 51.26, lon: -113.997, isp: 'Rogers' });
  ns.store.addSite({ name: 'Old home list entry', lat: 44.6, lon: -63.6 });
  // First exchange: the mirror reports its version, the owner sends its list.
  // Home's own client joins the shared list rather than being lost.
  ab.peer.absorb(ns.peer.payload());
  ns.peer.absorb(ab.peer.payload());
  assert.deepEqual(ns.store.listSites().map((s) => s.name).sort(), ['Marex', 'Old home list entry']);
  ab.peer.absorb(ns.peer.payload());
  ns.peer.absorb(ab.peer.payload());
  assert.deepEqual(ab.store.listSites().map((s) => s.name).sort(), ['Marex', 'Old home list entry']);
  assert.equal(ns.queue.list().length, 0);
  ab.store.removeSite(ab.store.listSites().find((s) => s.name === 'Old home list entry').id);
  ab.peer.absorb(ns.peer.payload());
  ns.peer.absorb(ab.peer.payload());
  assert.deepEqual(ns.store.listSites().map((s) => s.id), [a.id], 'later syncs follow the office');
  // Edits at home: applied there at once and queued.
  const id = 'a3c8d1e2-0f4b-4c5d-8e9f-0a1b2c3d4e5f';
  ns.store.addSite({ name: 'New clinic', lat: 53.5, lon: -113.5 }, { id });
  ns.queue.push({ kind: 'add', siteId: id, input: { name: 'New clinic', lat: 53.5, lon: -113.5 } });
  ns.store.updateSite(a.id, { isp: 'Telus' });
  ns.queue.push({ kind: 'update', siteId: a.id, input: { isp: 'Telus' } });
  // Meanwhile the office changed the same client: home's later change wins.
  ab.store.updateSite(a.id, { isp: 'Shaw' });
  ab.peer.absorb(ns.peer.payload()); // owner applies the queue
  assert.equal(ab.store.getSite(id).name, 'New clinic');
  assert.equal(ab.store.getSite(a.id).isp, 'Telus');
  assert.ok(ab.store.recentEvents(5).some((e) => e.type === 'peer-edit' && e.from === 'Nova Scotia' && /New clinic/.test(e.what)));
  ns.peer.absorb(ab.peer.payload()); // mirror: queue cleared, owner's list taken
  assert.equal(ns.queue.list().length, 0);
  assert.equal(ns.store.sitesVersion(), ab.store.sitesVersion());
  // Applying the same edits again (a lost reply) changes nothing.
  const before = ab.store.sitesVersion();
  ab.peer.absorb({ ...ns.peer.payload(), edits: [] });
  assert.equal(ab.store.sitesVersion(), before);
  // An edit to a client the office has since removed is skipped and logged.
  ns.queue.push({ kind: 'update', siteId: '00000000-0000-4000-8000-000000000000', input: { name: 'x' } });
  ab.peer.absorb(ns.peer.payload());
  assert.ok(ab.store.recentEvents(5).some((e) => e.type === 'peer-edit-skipped'));
});

test('edit queue survives a restart; applyOp handles every kind', () => {
  const dir = tmp();
  const q = createEditQueue(dir);
  q.push({ kind: 'remove', siteId: 'x' });
  q.setBase('v1');
  const again = createEditQueue(dir);
  assert.equal(again.list().length, 1);
  assert.equal(again.baseVersion(), 'v1');
  const store = createStore(tmp());
  assert.match(applyOp(store, { kind: 'import', csv: 'name,lat,lon\nA,51,-114\nB,52,-113\n', mode: 'append' }), /imported 2/);
  assert.equal(applyOp(store, { kind: 'remove', siteId: 'nope' }), null);
  assert.ok(keyMatches('k'.repeat(32), 'k'.repeat(32)));
  assert.ok(!keyMatches('k'.repeat(31), 'k'.repeat(32)));
  assert.ok(!keyMatches(undefined, 'k'));
});

test('connection check from two sites: down only when both lose it', () => {
  const t = Date.parse('2026-11-01T12:00:00Z');
  const up = { state: 'up', since: t - 1e6, lastCheckAt: t - 1000, rttMs: 30, method: 'ping' };
  const down = { state: 'down', since: t - 60_000, lastCheckAt: t - 1000, rttMs: null, method: 'ping' };
  const o = { selfName: 'Alberta office', nowMs: t };
  assert.equal(combineWan(down, { ...up, via: 'Nova Scotia' }, o).state, 'split');
  assert.deepEqual(['down', 'up'].map((k) => combineWan(down, { ...up, via: 'Nova Scotia' }, o)[k]), ['Alberta office', 'Nova Scotia']);
  assert.equal(combineWan(down, { ...down, via: 'Nova Scotia' }, o).state, 'down');
  assert.deepEqual(combineWan(up, { ...up, via: 'Nova Scotia' }, o).sites, ['Alberta office', 'Nova Scotia']);
  // A peer result older than 5 minutes is ignored.
  assert.equal(combineWan(down, { ...up, via: 'Nova Scotia', lastCheckAt: t - 6 * 60_000 }, o).state, 'down');
  // Only the peer checks it.
  assert.equal(combineWan(null, { ...up, via: 'Nova Scotia' }, o).state, 'up');
});

// ------------------------------------------------- two real servers ----

const KEY = 'test-peer-key-0123456789abcdef0123456789';
let nextPort = 18600 + Math.floor(Math.random() * 300);

function server(env) {
  const port = env.PORT ? Number(env.PORT) : nextPort++;
  const dataDir = env.DATA_DIR || tmp();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, DEMO: '1', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir, PEER_SYNC_SECONDS: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  return {
    port, base, dataDir, child, log: () => out,
    async ready() {
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(`${base}/healthz`)).ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`server did not start:\n${out}`);
    },
    stop: () => new Promise((r) => { if (child.exitCode !== null || child.signalCode) return r(); child.once('exit', r); child.kill('SIGTERM'); }),
    get: (p, headers = {}) => fetch(base + p, { headers }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })),
    send: (method, p, body) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  };
}
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 150));
  }
}
const ids = async (s) => (await s.get('/api/sites')).body.sites.map((x) => x.id).sort().join();

test('two servers: office pulls and pushes, home never connects, edits queue while the office is away', { timeout: 60_000 }, async () => {
  const home = server({ INSTANCE_NAME: 'Nova Scotia', SITES: 'mirror', PEER_KEY: KEY, TUNNEL_TOKEN: 'not-used-in-demo' });
  await home.ready();
  let office = server({ INSTANCE_NAME: 'Alberta office', SITES: 'owner', PEER_KEY: KEY, PEER_URL: home.base });
  await office.ready();
  try {
    // Home takes the office's list (demo sites with the office's ids).
    await until(async () => (await ids(home)) === (await ids(office)));
    const snap = (await home.get('/api/snapshot')).body;
    assert.equal(snap.peer.peerName, 'Alberta office');
    assert.equal(snap.peer.connected, true);
    assert.equal(snap.peer.calls, false, 'home never connects out');
    assert.equal((await office.get('/api/snapshot')).body.peer.peerName, 'Nova Scotia');
    assert.ok(existsSync(path.join(home.dataDir, 'sites.before-peer.json')), 'home kept a copy of its old list');

    // The sync endpoint: key required; through the tunnel nothing else answers.
    const bad = await fetch(`${home.base}/api/peer/sync`, { method: 'POST', headers: { 'X-Peer-Key': 'wrong' }, body: '{}' });
    assert.equal(bad.status, 403);
    assert.equal((await home.get('/', { 'cf-ray': 'abc' })).status, 404);
    assert.equal((await home.get('/api/snapshot', { 'cf-connecting-ip': '1.2.3.4' })).status, 404);
    assert.equal((await home.get('/api/snapshot')).status, 200, 'the local network still sees the dashboard');

    // An edit at home shows at once (pending), then lands at the office.
    const { site } = await home.send('POST', '/api/sites', { name: 'Halifax test client', lat: 44.65, lon: -63.58 });
    assert.ok((await home.get('/api/snapshot')).body.sites.find((s) => s.id === site.id).pending);
    await until(async () => (await office.get('/api/sites')).body.sites.some((s) => s.id === site.id));
    await until(async () => !(await home.get('/api/snapshot')).body.sites.find((s) => s.id === site.id)?.pending);

    // Office away: edits queue at home, survive a home restart, apply in order later.
    await office.stop();
    await home.send('PUT', `/api/sites/${site.id}`, { name: 'Halifax test client, renamed' });
    const second = (await home.send('POST', '/api/sites', { name: 'Queued while away', lat: 44.7, lon: -63.6 })).site;
    const q = JSON.parse(readFileSync(path.join(home.dataDir, 'peer-queue.json'), 'utf8'));
    assert.deepEqual(q.ops.map((o) => o.kind), ['update', 'add']);
    await home.stop();
    const home2 = server({ INSTANCE_NAME: 'Nova Scotia', SITES: 'mirror', PEER_KEY: KEY, DATA_DIR: home.dataDir, PORT: String(home.port) });
    Object.assign(home, home2);
    await home.ready();
    office = server({ INSTANCE_NAME: 'Alberta office', SITES: 'owner', PEER_KEY: KEY, PEER_URL: home.base, DATA_DIR: office.dataDir });
    await office.ready();
    await until(async () => {
      const list = (await office.get('/api/sites')).body.sites;
      return list.find((s) => s.id === site.id)?.name === 'Halifax test client, renamed' && list.some((s) => s.id === second.id);
    });
    await until(async () => JSON.parse(readFileSync(path.join(home.dataDir, 'peer-queue.json'), 'utf8')).ops.length === 0);
    await until(async () => (await ids(home)) === (await ids(office)));
  } catch (error) {
    console.log('--- office log ---\n' + office.log() + '\n--- home log ---\n' + home.log());
    throw error;
  } finally {
    await Promise.allSettled([office.stop(), home.stop()]);
  }
});

test('Telus refused at home is borrowed from the office, labelled with where it came from', async () => {
  const { createIspStatus } = await import('../server/isp-status.js');
  const t0 = Date.parse('2026-11-01T03:00:00Z');
  const telus = { outages: [{ _id: 'e1', impactedAreaText: 'Edmonton, Alberta', province: 'AB', impactedServices: ['Internet'], startTime: '2026-11-01T01:00+00:00', isResolved: false, outageCenter: { lat: 53.55, lon: -113.49 }, polygonInfo: JSON.stringify({ coords: [[53.55, -113.49]], length: 0.002, height: 0.0012 }) }], regionalOutages: [], plannedOutages: [], plannedRegionalOutages: [] };
  const make = (raw) => createIspStatus({ request: async () => ({}), requestText: async () => '', requestRaw: raw, geocoder: { search: async () => [] }, now: () => t0, log: quiet, provincesFor: () => [] });
  const office = make(async () => ({ status: 200, headers: new Map(), text: JSON.stringify(telus) }));
  const home = make(async () => ({ status: 403, headers: new Map([['server', 'cloudflare']]), text: 'denied' }));
  await office.refresh();
  await home.refresh();
  assert.equal(home.health().telus.status, 'down');
  home.importPeer({ feeds: office.exportFeeds() }, { from: 'Alberta office' });
  const h = home.health().telus;
  assert.deepEqual([h.status, h.via, h.notices], ['ok', 'Alberta office', 1]);
  assert.match(h.ownError, /HTTP 403/);
  assert.equal(home.notices().filter((n) => n.provider === 'telus').length, 1);
  // Home hands back none of it.
  assert.deepEqual(home.exportFeeds().map((f) => f.key).filter((k) => k === 'telus'), []);
});
