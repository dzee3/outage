import test from 'node:test';
import assert from 'node:assert/strict';
import { provinceCodeFor, summarizeIoda } from '../server/sources/ioda.js';

test('IODA region names map to province codes', () => {
  assert.equal(provinceCodeFor('Québec'), 'QC');
  assert.equal(provinceCodeFor('Yukon Territory'), 'YT');
  assert.equal(provinceCodeFor('Newfoundland and Labrador'), 'NL');
  assert.equal(provinceCodeFor('Northwest Territories'), 'NT');
  assert.equal(provinceCodeFor('Texas'), null);
});

test('only events reaching "now" make a province active', () => {
  const nowS = 1_800_000_000;
  const codes = new Map([
    ['4401', 'AB'],
    ['4402', 'MB'],
  ]);
  const { provinces, recent } = summarizeIoda(
    [
      { entity: { code: '4401' }, from: nowS - 3600, until: nowS - 300, score: 120, datasource: 'bgp' },
      { entity: { code: '4402' }, from: nowS - 8 * 3600, until: nowS - 6 * 3600, score: 60, datasource: 'ping-slash24' },
      { entity: { code: '9999' }, from: nowS - 60, until: nowS, score: 1, datasource: 'bgp' },
    ],
    codes,
    nowS,
  );
  assert.equal(provinces.AB.active, true);
  assert.deepEqual(provinces.AB.signals, ['bgp']);
  assert.equal(provinces.AB.since, (nowS - 3600) * 1000);
  assert.equal(provinces.MB.active, false, 'ended six hours ago');
  assert.equal(recent.length, 2, 'unknown entities ignored');
  assert.equal(summarizeIoda(null, codes, nowS).recent.length, 0);
});

import { summarizeIoda as sumIoda, summarizeNetworks as sumNets, MAX_OUTAGE_S } from '../server/sources/ioda.js';
test('days-long "ongoing" BGP events are routing changes, not alerts', () => {
  const nowS = 1793072793;
  const codes = new Map([['1', 'NT'], ['2', 'ON']]);
  const r = sumIoda([
    { entity: { code: '1' }, from: nowS - 12 * 86400, until: nowS, score: 88735, datasource: 'bgp' },
    { entity: { code: '2' }, from: nowS - 3600, until: nowS, score: 50, datasource: 'ping-slash24' },
  ], codes, nowS);
  assert.equal(r.provinces.NT.active, false);
  assert.equal(r.provinces.NT.longRunning, true);
  assert.equal(r.provinces.ON.active, true);
  const nets = sumNets([{ entity: { code: '11814' }, from: nowS - MAX_OUTAGE_S - 60, until: nowS, datasource: 'bgp' }], new Map([['11814', 'Distributel']]), nowS);
  assert.equal(nets[11814].active, false);
});
