import test from 'node:test';
import assert from 'node:assert/strict';
import { ispStatusFor, matchNotice, parseKmlNotices, parseRogers, parseSaskTel, parseTelus, providerKey } from '../server/isp-status.js';

const NOW = Date.UTC(2026, 9, 27, 4, 0); // Oct 26, 10 pm MT

const ROGERS_AB = `<html><body><div>Region: Alberta region</div>
<div><p><b class="text-bold">Service Interruption |</b> Some customers near McLeod &amp; York in Edmonton</p><p><b>Impacted services:</b>&nbsp;<span>Internet, TV, Home Phone </span></p><p><b>Cause:</b> Technical</p><p><b>Current status:</b>&nbsp;Technical teams are investigating (updated 12:55 p.m. MT)</p></div>
<div><p><b>Service Interruption |</b> Some customers near Downtown in Calgary</p><p><b>Impacted services:</b> Internet</p><p><b>Current status:</b>&nbsp;Service restored (updated 2:37 p.m. MT)</p></div>
<h2>Planned Maintenance</h2>
<div><p><b>Planned maintenance |</b> Oct 27 - Lethbridge (Southgate, Victoria Park, Anderson Industrial Park)</p><p><b>Impacted services:&nbsp;</b><span>Internet, TV, Home Phone </span>(including 911 calls)</p><p><b>Expected Start:</b>&nbsp;Oct 27 - 12:00 a.m. MT</p><p><b>Cause:</b> Network Upgrades</p><p><b>Current status:&nbsp;</b>This interruption is expected to last approximately six (6) hours. Service will be restored automatically when the maintenance is complete.</p></div>
<div><p><b>Planned maintenance |</b> Oct 20 - Calgary (Downtown)</p><p><b>Impacted services:</b> Internet</p><p><b>Expected Start:</b> Oct 20 - 12:00 a.m. MT</p><p><b>Current status:</b> This interruption is expected to last approximately five (5) hours.</p></div>
<div>Learn more</div></body></html>`;

test('Rogers / Shaw notices: open ones only, with city, areas and window', () => {
  const n = parseRogers(ROGERS_AB, 'AB', NOW);
  assert.equal(n.length, 2);
  const [edm, leth] = n;
  assert.equal(edm.kind, 'outage');
  assert.equal(edm.city, 'Edmonton');
  assert.deepEqual(edm.areas, ['McLeod', 'York']);
  assert.equal(leth.kind, 'planned');
  assert.equal(leth.city, 'Lethbridge');
  assert.deepEqual(leth.areas, ['Southgate', 'Victoria Park', 'Anderson Industrial Park']);
  assert.equal(leth.startMs, Date.UTC(2026, 9, 27, 6)); // midnight MT
  assert.equal(leth.endMs, Date.UTC(2026, 9, 27, 12));
  assert.equal(parseRogers('<html>nothing</html>', 'AB', NOW), null);
});

test('Rogers matching: neighbourhood = area hit, same city elsewhere = nearby', () => {
  const [edm] = parseRogers(ROGERS_AB, 'AB', NOW);
  assert.equal(matchNotice(edm, { lat: 53.6, lon: -113.4, city: 'Edmonton', area: 'York' }), 'area');
  assert.equal(matchNotice(edm, { lat: 53.5, lon: -113.5, city: 'Edmonton', area: 'Oliver' }), 'city');
  assert.equal(matchNotice({ ...edm, areaPoints: [{ lat: 53.6, lon: -113.43 }] }, { lat: 53.605, lon: -113.43, city: 'Edmonton' }), 'area');
  assert.equal(matchNotice(edm, { lat: 51, lon: -114, city: 'Calgary' }), null);
  const s = ispStatusFor({ isp: 'Shaw', lat: 53.6, lon: -113.4, city: 'Edmonton', area: 'York' }, parseRogers(ROGERS_AB, 'AB', NOW), { rogers: { status: 'ok' } });
  assert.equal(s.provider, 'rogers');
  assert.equal(s.state, 'out');
});

const TELUS = {
  outages: [
    {
      _id: 'ok1', impactedAreaText: 'Okotoks, Alberta', isResolved: false, isCompleted: false, startTime: '2026-10-15T09:07+00:00',
      estimatedRepairDate: '2026-10-30', impactedServices: ['Internet', 'Optik TV'], cause: { cause: 'Cable theft' }, province: 'AB',
      outageCenter: { lon: -113.964, lat: 50.7228 }, activatePolygon: true, outageAreaRadius: 1,
      polygonInfo: JSON.stringify({ center: { lat: 50.7228, lng: -113.964 }, coords: [[50.724, -113.964], [50.7228, -113.962], [53.5392, -113.492]], length: 0.002, height: 0.0012 }),
    },
    { _id: 'ph', impactedAreaText: 'Kinuso, Alberta', isResolved: false, impactedServices: ['Home Phone'], province: 'AB', outageCenter: { lon: -115.3, lat: 55.3 } },
    { _id: 'cal', impactedAreaText: 'Calgary, Alberta', isResolved: false, impactedServices: ['Internet'], province: 'AB', outageCenter: { lon: -114.071, lat: 51.04473 }, outageAreaRadius: 1 },
  ],
  regionalOutages: [],
  plannedOutages: [{ _id: 'pl', impactedAreaText: 'Planned network maintenance for multiple locations in Alberta', isResolved: false, startTime: '2026-10-27T03:01-04:00', estimatedRepairDate: '2026-10-27', impactedServices: ['Internet'], province: 'AB', outageCenter: { lon: -113.954, lat: 51.0912 }, polygonInfo: JSON.stringify({ coords: [[51.0696, -114.018]], length: 0.002, height: 0.0012 }) }],
  plannedRegionalOutages: [],
};

test('Telus: every service kept, drawn as circles, only Internet ones alert', () => {
  const n = parseTelus(TELUS, NOW);
  assert.deepEqual(n.map((x) => x.id), ['telus:ok1', 'telus:ph', 'telus:cal', 'telus:pl']);
  const [ok, ph, cal] = n;
  assert.equal(ph.internet, false, 'Home Phone only');
  assert.equal(ok.internet, true);
  // Two Okotoks cells form one circle; the stray Edmonton cell becomes its own.
  assert.equal(ok.circles.length, 2);
  assert.equal(matchNotice(ok, { lat: 50.7245, lon: -113.963 }), 'area');
  assert.equal(matchNotice(ok, { lat: 50.70, lon: -113.99, city: 'Okotoks' }), 'city');
  assert.equal(matchNotice(cal, { lat: 51.045, lon: -114.07 }), 'area');
  const s = ispStatusFor({ isp: 'Telus', lat: 51.0697, lon: -114.0175 }, n, { telus: { status: 'ok' } });
  assert.equal(s.state, 'planned'); // starts 3 am ET, after NOW
  const phone = ispStatusFor({ isp: 'Telus', lat: 55.3, lon: -115.3 }, n, { telus: { status: 'ok' } });
  assert.equal(phone.state, 'nearby', 'a phone-only notice at the address is shown but does not alert');
  assert.equal(parseTelus({}, NOW), null);
  const qc = parseTelus({ outages: [{ _id: 'q', province: 'QC', impactedServices: ['Mobile - Data'], outageCenter: { lat: 46.8, lon: -71.2 } }] }, NOW);
  assert.equal(qc.length, 0, 'Quebec is not covered');
});

test('Telus multi-community notice: one circle per cluster of cells', () => {
  const coords = [[50.67, -120.33], [50.671, -120.331], [51.0, -121.0], [51.002, -121.001]];
  const [n] = parseTelus({ outages: [{ _id: 'bc', impactedAreaText: 'Failure of multiple wireline services', province: 'BC', impactedServices: ['Internet'], outageAreaRadius: 5, outageCenter: { lat: 51.38, lon: -121.2 }, polygonInfo: JSON.stringify({ coords, length: 0.002, height: 0.0012 }) }] }, NOW);
  assert.equal(n.circles.length, 2);
  assert.ok(n.circles.every((c) => c.km >= 5));
  assert.equal(matchNotice(n, { lat: 50.68, lon: -120.34 }), 'area');
});

test('TekSavvy KML and SaskTel page', () => {
  const kml = `<kml><Document><Placemark><name>Outage - Hamilton</name><description><![CDATA[Cable plant issue<br>ETA 6pm]]></description><Point><coordinates>-79.87,43.25,0</coordinates></Point></Placemark>
  <Placemark><name>Maintenance window</name><Polygon><outerBoundaryIs><LinearRing><coordinates>-79.5,43.6,0 -79.4,43.6,0 -79.4,43.7,0 -79.5,43.6,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`;
  const n = parseKmlNotices(kml, 'teksavvy', 'x');
  assert.equal(n.length, 2);
  assert.equal(n[0].kind, 'outage');
  assert.equal(n[0].detail, 'Cable plant issue ETA 6pm');
  assert.equal(n[1].kind, 'planned');
  assert.equal(matchNotice(n[0], { lat: 43.26, lon: -79.87 }), 'area');
  assert.deepEqual(parseSaskTel('<h2>Latest Outage Updates</h2><p>There are currently no outages.</p><p>Report an outage</p>'), []);
  const sk = parseSaskTel('<h2>Latest Outage Updates</h2><p>Internet service outage affecting customers in Moose Jaw and area.</p><p>Report an outage</p>');
  assert.equal(matchNotice(sk[0], { lat: 50.4, lon: -105.5, city: 'Moose Jaw' }), 'city');
});

test('provider names map to outage pages', () => {
  assert.equal(providerKey('Shaw'), 'rogers');
  assert.equal(providerKey('Rogers'), 'rogers');
  assert.equal(providerKey('Telus'), 'telus');
  assert.equal(providerKey('Bell MTS'), 'bell');
  assert.equal(providerKey('Paragon Internet'), null);
  const bell = ispStatusFor({ isp: 'Bell', lat: 45, lon: -75 }, [], {});
  assert.equal(bell.supported, false);
  assert.match(bell.note, /CAPTCHA/);
});
