import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore, parseCsv, sitesFromCsv, sitesToCsv, validateSite } from '../server/store.js';

test('CSV: quotes, header aliases, row errors, round trip', () => {
  assert.deepEqual(parseCsv('a,"b, c","d ""e"""\r\n1,2,3'), [
    ['a', 'b, c', 'd "e"'],
    ['1', '2', '3'],
  ]);
  const { sites, errors } = sitesFromCsv(
    '﻿Client Name,Latitude,Longitude,Address,radius_km\n' +
      'Acme Calgary,51.05,-114.07,"100 1 St SW, Calgary",5\n' +
      'Broken,abc,-114\n',
  );
  assert.equal(sites.length, 1);
  assert.equal(sites[0].address, '100 1 St SW, Calgary');
  assert.equal(sites[0].radiusKm, 5);
  assert.match(errors[0], /Row 3: Latitude/);
  const again = sitesFromCsv(sitesToCsv(sites)).sites;
  assert.deepEqual(again, sites);
  assert.match(sitesFromCsv('name,x\n').errors[0], /header row and at least one site|name, lat and lon/);
});

test('validateSite rejects bad input with readable messages', () => {
  assert.throws(() => validateSite({ name: '', lat: 1, lon: 1 }), /name/);
  assert.throws(() => validateSite({ name: 'a', lat: 95, lon: 1 }), /Latitude/);
  assert.throws(() => validateSite({ name: 'a', lat: 1, lon: 1, radiusKm: 500 }), /radius/);
});

test('store persists sites and trims old history on restart', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'outage-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = 1_800_000_000_000;
  const s1 = createStore(dir, { now: () => clock });
  const site = s1.addSite({ name: 'HQ', lat: 51, lon: -114 });
  s1.addHistory({ t: clock - 8 * 24 * 3600_000, customersOut: 1 });
  s1.addHistory({ t: clock, customersOut: 2 });
  s1.addEvents([{ t: clock, type: 'outage-started' }]);
  assert.equal(s1.updateSite(site.id, { name: 'Head office' }).name, 'Head office');
  const s2 = createStore(dir, { now: () => clock });
  assert.equal(s2.listSites()[0].name, 'Head office');
  assert.equal(s2.historySince(0).length, 1, 'week-old point dropped');
  assert.equal(s2.recentEvents().length, 1);
  assert.equal(s2.removeSite(site.id), true);
  assert.equal(s2.removeSite(site.id), false);
});
