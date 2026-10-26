import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMonitor, siteImpact, provinceOf, STALE_DROP_MS } from '../server/monitor.js';
import { createStore } from '../server/store.js';
import { albertaSources } from '../server/sources/alberta.js';

const provinces = JSON.parse(
  readFileSync(new URL('../web/data/provinces.geojson', import.meta.url), 'utf8'),
);
const coverage = { AB: { name: 'Alberta', sources: ['atco'], unmonitored: [] } };

const square = (lon, lat, d = 0.01) => [
  [
    [lon - d, lat - d],
    [lon + d, lat - d],
    [lon + d, lat + d],
    [lon - d, lat + d],
    [lon - d, lat - d],
  ],
];
const row = (over) => ({
  stableId: 'x:1',
  utility: 'atco',
  kind: 'unplanned',
  customers: 10,
  point: { lon: -113.5, lat: 53.5 },
  polygons: [],
  ...over,
});

test('provinceOf: interior points and harbour-front sites', () => {
  assert.equal(provinceOf({ lat: 51.05, lon: -114.07 }, provinces), 'AB'); // Calgary
  assert.equal(provinceOf({ lat: 49.888, lon: -119.496 }, provinces), 'BC'); // Kelowna
  assert.equal(provinceOf({ lat: 44.6488, lon: -63.5752 }, provinces), 'NS'); // Halifax waterfront
  assert.equal(provinceOf({ lat: 0, lon: 0 }, provinces), null);
});

test('siteImpact ranks inside > near > internet > planned > ok', () => {
  const site = { lat: 53.5, lon: -113.5, radiusKm: 3 };
  const ctx = { provinces, coverage, internet: { provinces: {} } };
  assert.equal(
    siteImpact(site, [row({ polygons: [square(-113.5, 53.5)] })], ctx).status,
    'out',
  );
  assert.equal(
    siteImpact(site, [row({ point: { lon: -113.47, lat: 53.5 } })], ctx).status,
    'near',
    '2 km from a pin-only outage',
  );
  assert.equal(
    siteImpact(site, [row({ point: { lon: -113.3, lat: 53.5 } })], ctx).status,
    'ok',
    '13 km away is outside the radius',
  );
  assert.equal(
    siteImpact(site, [row({ kind: 'planned-upcoming', polygons: [square(-113.5, 53.5)] })], ctx)
      .status,
    'planned',
  );
  assert.equal(
    siteImpact(site, [], { ...ctx, internet: { provinces: { AB: { active: true } } } }).status,
    'internet',
  );
  assert.equal(
    siteImpact({ lat: 49.888, lon: -119.496 }, [], ctx).status,
    'no-coverage',
    'BC has no power feed yet',
  );
});

function fakeSource(id, { fail = () => false, rows = () => [] } = {}) {
  return {
    id,
    name: id,
    province: 'AB',
    region: 'test',
    map: '#',
    feeds: [
      {
        id: 'live',
        ttl: 120_000,
        load: async () => {
          if (fail()) throw new Error('HTTP 403');
          return rows();
        },
      },
    ],
  };
}

test('monitor: stale after a failure, withdrawn after 30 minutes, events recorded', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'outage-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-26T15:00:00Z');
  const now = () => clock;
  let failing = false;
  let current = [row({ stableId: 'enmax:1', utility: 'enmax' })];
  const store = createStore(dir, { now });
  store.addSite({ name: 'Downtown', lat: 53.5, lon: -113.5 });
  const monitor = createMonitor({
    sources: [fakeSource('enmax', { fail: () => failing, rows: () => current })],
    store,
    provinces,
    coverage,
    now,
    log: { warn() {} },
  });

  let snap = await monitor.tick();
  assert.equal(snap.sources[0].status, 'ok');
  assert.equal(snap.sites[0].impact.status, 'near');

  failing = true;
  clock += 121_000;
  snap = await monitor.tick();
  assert.equal(snap.sources[0].status, 'stale');
  assert.equal(snap.rows.length, 1, 'last good data kept');

  clock += STALE_DROP_MS;
  snap = await monitor.tick();
  assert.equal(snap.sources[0].status, 'down');
  assert.equal(snap.rows.length, 0, 'never shown as current');
  assert.equal(snap.sites[0].impact.status, 'ok');

  failing = false;
  current = [];
  clock += 121_000;
  snap = await monitor.tick();
  const types = store.recentEvents().map((e) => e.type);
  assert.ok(types.includes('outage-ended'));
  assert.ok(types.includes('site-status'));
  assert.ok(store.historySince(0).length >= 1);
});

test('alberta sources: ATCO signs in once and reads Firestore with the token', async () => {
  const calls = [];
  const request = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('identitytoolkit'))
      return { idToken: 'tok', refreshToken: 'ref', expiresIn: '3600' };
    if (url.includes('/ActiveOutages')) {
      assert.equal(init.headers.Authorization, 'Bearer tok');
      return {
        documents: [
          {
            name: 'x/ActiveOutages/1',
            fields: {
              NUM_CUST: { integerValue: '18' },
              OUTAGE_TYPE_DESC: { stringValue: 'Unplanned Trouble Call' },
              CENTROID_GPS: { geoPointValue: { latitude: 56.7, longitude: -111.3 } },
            },
          },
        ],
      };
    }
    if (url.includes('/PlanOutages')) return { documents: [] };
    throw new Error(`unexpected ${url}`);
  };
  const [atco] = albertaSources({ request, now: () => Date.now() });
  const [live, planned] = await Promise.all(atco.feeds.map((f) => f.load()));
  assert.equal(live[0].kind, 'unplanned');
  assert.equal(live[0].province, 'AB');
  assert.deepEqual(planned, []);
  assert.equal(calls.filter((c) => c.url.includes('identitytoolkit')).length, 1);
});
