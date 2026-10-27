import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanAddress, createGeocoder, queryVariants } from '../server/geocode.js';

test('unit numbers are dropped before geocoding', () => {
  assert.equal(cleanAddress('541 Kingsview Way SE #102, Airdrie, AB T4A 0C9'), '541 Kingsview Way SE, Airdrie, AB T4A 0C9');
  assert.equal(cleanAddress('108 Edmonton Trail NE #4, Airdrie, AB T4B 1S1'), '108 Edmonton Trail NE, Airdrie, AB T4B 1S1');
  assert.equal(cleanAddress('Suite 200, 10 Main St, Calgary'), '10 Main St, Calgary');
  assert.equal(cleanAddress('102-541 Kingsview Way SE, Airdrie'), '541 Kingsview Way SE, Airdrie');
  assert.equal(cleanAddress('Jasper, AB'), 'Jasper, AB');
});

test('variants: as typed, without unit, without postal code', () => {
  assert.deepEqual(queryVariants('541 Kingsview Way SE #102, Airdrie, AB T4A 0C9'), [
    '541 Kingsview Way SE #102, Airdrie, AB T4A 0C9',
    '541 Kingsview Way SE, Airdrie, AB T4A 0C9',
    '541 Kingsview Way SE, Airdrie, AB',
  ]);
  assert.deepEqual(queryVariants('Airdrie, AB'), ['Airdrie, AB']);
});

const town = { lat: '51.2917', lon: '-114.0144', addresstype: 'city', address: { city: 'Airdrie', 'ISO3166-2-lvl4': 'CA-AB' } };
const building = { lat: '51.2701', lon: '-113.9902', addresstype: 'building', address: { house_number: '541', road: 'Kingsview Way SE', city: 'Airdrie', 'ISO3166-2-lvl4': 'CA-AB' } };

test('search falls back to simpler queries until it finds the building', async () => {
  const asked = [];
  const geocoder = createGeocoder({
    minIntervalMs: 0,
    request: async (url) => {
      const q = new URL(url).searchParams.get('q');
      asked.push(q);
      return q.includes('#') ? [town] : [building];
    },
  });
  const [hit] = await geocoder.search('541 Kingsview Way SE #102, Airdrie, AB T4A 0C9');
  assert.equal(asked.length, 2);
  assert.equal(hit.precise, true);
  assert.equal(hit.kind, 'address');
  assert.equal(hit.lat, 51.2701);
});

test('search keeps the approximate match, marked, when nothing better exists', async () => {
  const geocoder = createGeocoder({ minIntervalMs: 0, request: async () => [town] });
  const [hit] = await geocoder.search('1 Nowhere Rd #9, Airdrie, AB T4A 0C9');
  assert.equal(hit.precise, false);
  assert.equal(hit.kind, 'city');
});
