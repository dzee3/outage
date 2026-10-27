import test from 'node:test';
import assert from 'node:assert/strict';
import { asnsFor, summarizeHexagon, watchedAsns } from '../server/isp.js';
import { summarizeNetworks } from '../server/sources/ioda.js';
import { siteImpact } from '../server/monitor.js';

const HEX = {
  hexid: 'BC49901195', hexLat: 49.899451, hexLon: -119.493551,
  hexKml: '<Polygon><outerBoundaryIs><LinearRing><coordinates>-119.533609,49.899261 -119.513516,49.87342 -119.473329,49.87342 -119.533609,49.899261 </coordinates></LinearRing></outerBoundaryIs></Polygon>',
  providers: [
    { name: 'Bell', url: 'https://www.bell.ca', providerType: 8, speedTypeDesc: '' },
    { name: 'Rogers', url: 'https://www.rogers.com/', providerType: 2, speedType: 5, speedTypeDesc: '50/10+ Mbps' },
    { name: 'Rogers', url: 'https://www.rogers.com/', providerType: 8, speedTypeDesc: '' },
    { name: 'Telus', url: 'https://www.telus.com/', providerType: 10, speedType: 5, speedTypeDesc: '50/10+ Mbps' },
    { name: 'Xplore', url: 'https://www.xplore.ca/', providerType: 7, speedType: 4, speedTypeDesc: '25/5+ Mbps' },
    { name: 'The Corporation of the City of Kelowna', providerType: 11, speedTypeDesc: '' },
  ],
};

test('broadband hexagon → providers merged and ranked', () => {
  const h = summarizeHexagon(HEX);
  assert.equal(h.hexid, 'BC49901195');
  assert.equal(h.polygon.length, 4);
  const names = h.providers.map((p) => p.name);
  assert.deepEqual(names.slice(0, 2), ['Telus', 'Rogers']); // fibre, then cable
  const rogers = h.providers.find((p) => p.name === 'Rogers');
  assert.deepEqual(rogers.techs, ['Cable', 'Mobile']);
  assert.equal(rogers.speed, '50/10+ Mbps');
  assert.equal(rogers.ioda, true);
  const city = h.providers.find((p) => /Kelowna/.test(p.name));
  assert.equal(city.retail, false);
  assert.equal(names[names.length - 1], city.name);
  assert.equal(summarizeHexagon({}), null);
});

test('ISP names map to IODA networks', () => {
  assert.deepEqual(asnsFor('Shaw').asns, [6327]);
  assert.deepEqual(asnsFor('Bell MTS').asns, [7122]);
  assert.deepEqual(asnsFor('bell').asns, [577]);
  assert.equal(asnsFor('Paragon Internet'), null);
  assert.ok(watchedAsns([{ isp: 'Telus' }]).has(852));
});

test('a client whose own network drops shows an internet alert', () => {
  const nowS = 1793060000;
  const networks = summarizeNetworks([{ entity: { code: '852' }, from: nowS - 1800, until: nowS, score: 9, datasource: 'bgp' }], watchedAsns([]), nowS);
  assert.equal(networks[852].active, true);
  assert.equal(networks[577].active, false);
  const site = { lat: 49.88, lon: -119.49, isp: 'Telus' };
  const provinces = { type: 'FeatureCollection', features: [] };
  const impact = siteImpact(site, [], { provinces, coverage: {}, internet: { provinces: {}, networks } });
  assert.equal(impact.status, 'internet');
  assert.equal(impact.network.name, 'Telus');
  const other = siteImpact({ ...site, isp: 'Rogers' }, [], { provinces, coverage: {}, internet: { provinces: {}, networks } });
  assert.equal(other.status, 'no-coverage');
});
