import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanAddress, createGeocoder, parseAddress, placeFromPhoton, queryVariants } from '../server/geocode.js';

test('unit numbers are dropped before geocoding', () => {
  assert.equal(cleanAddress('541 Kingsview Way SE #102, Airdrie, AB T4A 0C9'), '541 Kingsview Way SE, Airdrie, AB T4A 0C9');
  assert.equal(cleanAddress('108 Edmonton Trail NE #4, Airdrie, AB T4B 1S1'), '108 Edmonton Trail NE, Airdrie, AB T4B 1S1');
  assert.equal(cleanAddress('Suite 200, 10 Main St, Calgary'), '10 Main St, Calgary');
  assert.equal(cleanAddress('102-541 Kingsview Way SE, Airdrie'), '541 Kingsview Way SE, Airdrie');
  assert.equal(cleanAddress('Jasper, AB'), 'Jasper, AB');
  assert.deepEqual(queryVariants('Airdrie, AB'), ['Airdrie, AB']);
});

test('an address pasted off a website is cut down to street, city, province and postal code', () => {
  const p = parseAddress('Marex Canada Limited\n541 Kingsview Way SE #102\nAirdrie, AB T4A 0C9\nCanada\nTel: (403) 555-1234\ninfo@marex.ca');
  assert.equal(p.street, '541 Kingsview Way SE');
  assert.equal(p.house, '541');
  assert.equal(p.city, 'Airdrie');
  assert.equal(p.province, 'AB');
  assert.equal(p.postcode, 'T4A 0C9');
  assert.equal(p.plain, '541 Kingsview Way SE, Airdrie, Alberta');
  assert.equal(p.postalOnly, false);
});

test('other address shapes', () => {
  assert.equal(parseAddress('Suite 300, 1015 4 St SW, Calgary, Alberta  T2R 1J4').street, '1015 4 St SW');
  assert.equal(parseAddress('102-541 Kingsview Way S.E., Airdrie AB').plain, '541 Kingsview Way SE, Airdrie, Alberta');
  assert.equal(parseAddress('12 Ontario St, Stratford ON N5A 3H1').city, 'Stratford');
  assert.equal(parseAddress('Marex Canada Airdrie').plain, 'Marex Canada Airdrie');
});

test('postal codes on their own, in any spacing or case', () => {
  for (const q of ['T4A 0C9', 't4a0c9', 'T4A-0C9']) {
    const p = parseAddress(q);
    assert.equal(p.postcode, 'T4A 0C9');
    assert.equal(p.postalOnly, true);
  }
  const fsa = parseAddress('t4a');
  assert.equal(fsa.fsa, 'T4A');
  assert.equal(fsa.postalOnly, true);
});

const building = (house, lat, lon) => ({
  lat: String(lat), lon: String(lon), addresstype: 'building',
  address: { house_number: house, road: 'Kingsview Way SE', city: 'Airdrie', postcode: 'T4A 0C9', 'ISO3166-2-lvl4': 'CA-AB' },
});
const town = { lat: '51.2917', lon: '-114.0144', addresstype: 'city', name: 'Airdrie', address: { city: 'Airdrie', 'ISO3166-2-lvl4': 'CA-AB' } };

/** A fake internet: each service answers from `routes`, and every URL asked is recorded. */
function fake(routes) {
  const asked = [];
  const request = async (url) => {
    const u = new URL(url);
    asked.push(u);
    const route = u.host.startsWith('photon') ? 'photon' : u.host.startsWith('geolocator') ? `nrcan:${u.searchParams.get('keys')}` : u.pathname.startsWith('/reverse') ? 'reverse' : u.searchParams.has('street') ? 'structured' : u.searchParams.has('postalcode') ? 'postalcode' : 'free';
    const answer = routes[route];
    return typeof answer === 'function' ? answer(u) : answer ?? [];
  };
  return { asked, geocoder: createGeocoder({ request, minIntervalMs: 0, log: null }) };
}

test('a pasted address finds the building with a structured search', async () => {
  const { asked, geocoder } = fake({ structured: [building('541', 51.2701, -113.9902)], photon: { features: [] } });
  const [hit] = await geocoder.search('Marex Canada Limited\n541 Kingsview Way SE #102\nAirdrie, AB T4A 0C9');
  assert.equal(hit.precise, true);
  assert.equal(hit.kind, 'address');
  assert.equal(hit.lat, 51.2701);
  const s = asked.find((u) => u.searchParams.has('street'));
  assert.equal(s.searchParams.get('street'), '541 Kingsview Way SE');
  assert.equal(s.searchParams.get('city'), 'Airdrie');
  assert.equal(s.searchParams.get('state'), 'Alberta');
});

test('the requested house number wins over a neighbour', async () => {
  const { geocoder } = fake({
    structured: [building('543', 51.2702, -113.9903)],
    photon: {
      features: [{ geometry: { coordinates: [-113.99, 51.27] }, properties: { housenumber: '541', street: 'Kingsview Way SE', city: 'Airdrie', state: 'Alberta', countrycode: 'CA', type: 'house' } }],
    },
  });
  const [first] = await geocoder.search('541 Kingsview Way SE, Airdrie, AB');
  assert.equal(first.houseNumber, '541');
});

test('when OSM has no house number, the national road network estimates one', async () => {
  const { geocoder } = fake({
    structured: [],
    free: [town],
    photon: { features: [] },
    'nrcan:locate': [{ key: 'locate', name: '541 Kingsview Way SE, Airdrie', province: 'Alberta', category: 'Street', lat: 51.27, lng: -113.99, tag: ['INTERPOLATED_POSITION'] }],
  });
  const [hit] = await geocoder.search('541 Kingsview Way SE, Airdrie, AB T4A 0C9');
  assert.equal(hit.kind, 'estimated');
  assert.equal(hit.precise, true);
});

test('a postal code alone suggests the nearest real address in it', async () => {
  const { geocoder } = fake({
    postalcode: [],
    'nrcan:fsa': [{ key: 'fsa', name: 'T4A', province: 'Alberta', category: 'PostalCode', lat: 51.28, lng: -113.98 }],
    reverse: building('600', 51.2801, -113.9799),
  });
  const results = await geocoder.search('T4A 0C9');
  assert.equal(results[0].kind, 'nearest');
  assert.match(results[0].label, /^Near T4A 0C9: 600 Kingsview Way SE/);
  assert.equal(results[1].kind, 'postal-area');
});

test('an exact postal code from OSM is used before the postal area', async () => {
  const { asked, geocoder } = fake({
    postalcode: [{ lat: '51.27', lon: '-113.99', addresstype: 'postcode', address: { postcode: 'T4A 0C9', city: 'Airdrie', 'ISO3166-2-lvl4': 'CA-AB' } }],
    reverse: building('541', 51.2701, -113.9902),
  });
  const results = await geocoder.search('t4a0c9');
  assert.equal(results[0].kind, 'nearest');
  assert.ok(results.some((r) => r.kind === 'postcode'));
  assert.ok(!asked.some((u) => u.host.startsWith('geolocator')));
});

test('a service being down does not break the search', async () => {
  const { geocoder } = fake({ photon: () => Promise.reject(new Error('down')), free: [town] });
  const [hit] = await geocoder.search('Airdrie');
  assert.equal(hit.city, 'Airdrie');
  assert.equal(hit.precise, false);
});

test('Photon results outside Canada are dropped; business names are kept in the label', () => {
  const p = placeFromPhoton({ geometry: { coordinates: [-113.99, 51.27] }, properties: { name: 'Marex Canada', osm_key: 'office', housenumber: '541', street: 'Kingsview Way SE', city: 'Airdrie', state: 'Alberta', postcode: 'T4A 0C9', countrycode: 'CA' } });
  assert.equal(p.label, 'Marex Canada, 541 Kingsview Way SE, Airdrie, AB, T4A 0C9');
  assert.equal(p.precise, true);
});
