import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAlectra,
  normalizeBcHydro,
  normalizeKubraItem,
  normalizeMaritime,
  normalizeNbPower,
  normalizeNfPower,
  normalizeOmsCases,
  normalizeSaskPower,
  normalizeSew,
  parseSaskPowerKml,
  saskPowerWindow,
} from '../server/records-canada.js';
import { parseZoned, zonedToUtc } from '../server/zones.js';
import { decodePolyline } from '../server/polyline.js';
import { crawlTiles, quadkey, quadkeysFor, tileXY } from '../server/sources/kubra.js';

const NOW = Date.UTC(2026, 9, 27, 2, 0); // 2026-10-26 evening in Canada

test('zones: wall clock in a zone, US dates, offsets', () => {
  // Winnipeg is CDT (UTC-5) on Oct 28.
  assert.equal(parseZoned('2026-10-28T17:00:00', 'America/Winnipeg'), Date.UTC(2026, 9, 28, 22));
  assert.equal(parseZoned('10/28/2026 5:00 PM', 'America/Winnipeg'), Date.UTC(2026, 9, 28, 22));
  assert.equal(parseZoned('10/28/2026 17:00 PM', 'America/Winnipeg'), Date.UTC(2026, 9, 28, 22));
  // Regina never changes clocks: UTC-6.
  assert.equal(zonedToUtc('America/Regina', 2026, 7, 1, 12), Date.UTC(2026, 6, 1, 18));
  assert.equal(parseZoned('2026-10-26T20:40:27-0300', 'America/Halifax'), Date.UTC(2026, 9, 26, 23, 40, 27));
  assert.equal(parseZoned(1793065253000, 'America/Halifax'), 1793065253000);
  assert.equal(parseZoned('', 'America/Halifax'), null);
});

test('polyline decodes Kubra points', () => {
  const [p] = decodePolyline('_~tuGnvp{J');
  assert.ok(p[0] < -60 && p[0] > -67, `lon ${p[0]}`);
  assert.ok(p[1] > 43 && p[1] < 47.5, `lat ${p[1]}`);
});

test('BC Hydro rows', () => {
  const rows = normalizeBcHydro(
    [
      {
        id: 2842514, municipality: 'Surrey', area: '5900 block 182A ST', cause: 'Under investigation',
        numCustomersOut: 1, crewStatusDescription: 'Crew on-site', crewEta: 1793059500000,
        dateOff: 1793055420000, dateOn: null, lastUpdated: 1793061905000, regionName: 'Lower Mainland',
        crewEtr: null, showEtr: false, latitude: 49.109895, longitude: -122.717209,
        polygon: [-122.717215, 49.108997, -122.716948, 49.109014, -122.716691, 49.109064, -122.717215, 49.108997],
      },
      { id: 1, dateOn: NOW - 1000, latitude: 49, longitude: -123 },
    ],
    NOW,
  );
  assert.equal(rows.length, 1);
  const [r] = rows;
  assert.equal(r.stableId, 'bchydro:2842514');
  assert.equal(r.kind, 'unplanned');
  assert.equal(r.customers, 1);
  assert.equal(r.area, 'Surrey, 5900 block 182A ST');
  assert.equal(r.polygons.length, 1);
  assert.equal(normalizeBcHydro({}, NOW), null);
});

test('FortisBC / SL&P XML', () => {
  assert.deepEqual(normalizeOmsCases('<NewDataSet />', { utility: 'fortisbc', zone: 'America/Vancouver', nowMs: NOW }), []);
  const xml = `<NewDataSet><OMSCASES><SERIAL>8812</SERIAL><AVGLONG>-119.49</AVGLONG><AVGLAT>49.88</AVGLAT>
    <PLANNED>0</PLANNED><DESC>Rutland &amp; area</DESC><OUTTIME>2026-10-26 17:05:00</OUTTIME><CURCUST>412</CURCUST>
    <DESC_CAUSE>Tree contact</DESC_CAUSE><WORKSTAT>Crew assigned</WORKSTAT>
    <COORDLIST>-119.5,49.87;-119.48,49.87;-119.48,49.89;-119.5,49.89</COORDLIST></OMSCASES></NewDataSet>`;
  const [r] = normalizeOmsCases(xml, { utility: 'fortisbc', zone: 'America/Vancouver', nowMs: NOW });
  assert.equal(r.stableId, 'fortisbc:8812');
  assert.equal(r.customers, 412);
  assert.equal(r.area, 'Rutland & area');
  assert.equal(r.startMs, Date.UTC(2026, 9, 27, 0, 5));
  assert.equal(r.polygons.length, 1);
  assert.equal(normalizeOmsCases('nope', { utility: 'x', zone: 'America/Vancouver', nowMs: NOW }), null);
});

test('SaskPower JSON + KML', () => {
  const kml = `<?xml version="1.0"?><kml xmlns="http://earth.google.com/kml/2.1"><Document>
    <Folder><name>294</name><Placemark><name>Regina City - Parliament Place</name><styleUrl>#unplanned-outage</styleUrl>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>-104.65,50.41,0 -104.62,50.41,0 -104.62,50.43,0 -104.65,50.43,0 -104.65,50.41,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Folder>
    <Folder><name>7</name><Placemark><name>Assiniboia - Mankota</name><styleUrl>#planned-outage</styleUrl>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>-107.1,49.0,0 -107.0,49.0,0 -107.0,49.2,0 -107.1,49.2,0 -107.1,49.0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Folder>
    </Document></kml>`;
  const regions = parseSaskPowerKml(kml);
  assert.equal(regions.size, 2);
  const json = {
    Outages: [
      { OutageId: 30351, RegionId: 294, Region: 'Regina City - Parliament Place', Planned: 'Unplanned', Alerts: [{ CreateDate: 'Oct 26 19:18', Message: 'Crews have been dispatched.' }] },
      { OutageId: 30348, RegionId: 7, Region: 'Assiniboia - Mankota', Planned: 'Planned', Alerts: [{ CreateDate: 'Oct 26 09:13', Message: 'A planned outage is scheduled on 10/28 from 2:00pm to 4:00pm affecting customers south of Mankota to US border.' }] },
    ],
  };
  const rows = normalizeSaskPower(json, regions, NOW);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'unplanned');
  assert.equal(rows[0].polygons.length, 1);
  assert.equal(rows[0].startMs, Date.UTC(2026, 9, 27, 1, 18)); // 19:18 CST
  assert.equal(rows[1].kind, 'planned-upcoming');
  assert.equal(rows[1].startMs, Date.UTC(2026, 9, 28, 20)); // 2 pm CST
  assert.equal(rows[1].estRestoreMs, Date.UTC(2026, 9, 28, 22));
  const w = saskPowerWindow('A planned outage is scheduled on 10/27 and 10/28 from 9:00am to 1:00pm affecting customers', NOW);
  assert.equal(w.start, Date.UTC(2026, 9, 27, 15));
});

test('Manitoba Hydro / SEW portal', () => {
  const data = {
    Table: [
      { Outageid: 24, Latitude: 49.85, Longitude: -97.35 },
      { Outageid: 24, Latitude: 49.86, Longitude: -97.34 },
      { Outageid: 24, Latitude: 49.86, Longitude: -97.36 },
    ],
    Table1: [
      { UtilityOutageId: '954910-1', Outageid: 24, OutageLatitude: 49.856, OutageLongitude: -97.353, Title: 'Planned', Area: '204317.5', OutageReportInfo: 'Planned outage', OutagedateDB: '2026-10-28T17:00:00', RestorationdateDB: '2026-10-28T21:00:00', CustomerAffected: null, CustomerAffectedText: 'Less than 5' },
      { UtilityOutageId: '955000-1', Outageid: 40, OutageLatitude: 49.9, OutageLongitude: -97.1, Title: 'Current', OutageReportInfo: null, OutagedateDB: '2026-10-26T19:30:00', RestorationdateDB: null, CustomerAffected: '230', CustomerAffectedText: '230' },
    ],
  };
  const rows = normalizeSew(data, { utility: 'mbhydro', zone: 'America/Winnipeg', nowMs: NOW });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'planned-upcoming');
  assert.equal(rows[0].customersText, 'Less than 5');
  assert.equal(rows[0].polygons.length, 1);
  assert.equal(rows[1].kind, 'unplanned');
  assert.equal(rows[1].customers, 230);
  assert.equal(rows[1].area, null, 'numeric Area (square metres) is not a place name');
  assert.equal(normalizeSew({ nope: 1 }, { utility: 'x', zone: 'America/Winnipeg', nowMs: NOW }), null);
});

test('Kubra items (v2 and legacy)', () => {
  const v2 = normalizeKubraItem(
    { id: '6-0', title: 'Area Outage', desc: { n_out: 1, cust_a: { val: 19, mask: 20 }, crew_status: { 'EN-US': 'Under Investigation' }, cluster: false, etr: '2026-10-27T04:15:00Z', cause: { 'EN-US': 'Pending Classification' }, start_time: null }, geom: { p: ['ea~zGrimkN'] } },
    { utility: 'hydroone', nowMs: NOW, zone: 'America/Toronto' },
  );
  assert.equal(v2.kind, 'unplanned');
  assert.equal(v2.customers, 19);
  assert.equal(v2.customersText, '< 20');
  assert.equal(v2.stableId, 'hydroone:ea~zGrimkN');
  assert.equal(v2.estRestoreMs, Date.UTC(2026, 9, 27, 4, 15));
  const legacy = normalizeKubraItem(
    { id: '4', title: 'Outage Information', desc: { cause: 'Cause Being Investigated', cluster: false, cust_a: { val: 5 }, start: '2026-10-18T08:49:55-0300', etr: '2026-11-27T15:00:00-0400' }, geom: { a: ['klpjGbbakKsAzB}HjBaq@aa@dEyIlw@rd@'], p: ['mlqjGdt`kK'] } },
    { utility: 'nspower', nowMs: NOW, zone: 'America/Halifax' },
  );
  assert.equal(legacy.customers, 5);
  assert.equal(legacy.polygons.length, 1);
  assert.equal(legacy.startMs, Date.UTC(2026, 9, 18, 11, 49, 55));
  assert.equal(normalizeKubraItem({ desc: { cluster: true } }, { utility: 'x', nowMs: NOW, zone: 'America/Toronto' }), null);
});

test('Kubra crawl expands clusters and dedupes', async () => {
  assert.equal(quadkey(...tileXY(-63.6, 44.6, 6), 6).length, 6);
  const keys = quadkeysFor([43.3, -66.6, 47.1, -59.6], 6);
  assert.ok(keys.length >= 1 && keys.length <= 6);
  const tiles = {
    a: { file_data: [{ desc: { cluster: true }, geom: { p: ['x'] } }, { desc: {}, geom: { p: ['one'] } }] },
    a0: { file_data: [{ desc: {}, geom: { p: ['two'] } }, { desc: {}, geom: { p: ['one'] } }] },
  };
  const { items, fetched } = await crawlTiles(['a'], async (qk) => tiles[qk] || null, 3);
  assert.deepEqual(items.map((i) => i.geom.p[0]).sort(), ['one', 'two']);
  assert.equal(fetched, 5);
});

test('NB Power incidents', () => {
  const pts = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { Incident_ID: 77, CustEff: 12, DateTimeStamp: 1793050000000 }, geometry: { type: 'Point', coordinates: [-66.6, 45.9] } },
    { type: 'Feature', properties: { Incident_ID: 77, CustEff: 8, DateTimeStamp: 1793040000000 }, geometry: { type: 'Point', coordinates: [-66.61, 45.91] } },
  ] };
  const hulls = { type: 'FeatureCollection', features: [] };
  const [r] = normalizeNbPower(pts, hulls);
  assert.equal(r.stableId, 'nbpower:77');
  assert.equal(r.customers, 20);
  assert.equal(r.startMs, 1793040000000);
  assert.equal(normalizeNbPower(null, hulls), null);
});

test('Maritime Electric line sections → one outage', () => {
  const line = (cust, len) => ({ type: 'Feature', properties: { outage_id: 171538, customers_out: cust, public_job_cause_desc: 'Pending.', public_crew_status_desc: 'Crew assigned.', job_est_completion_date: 1793065253000, calc_job_est_completion_date: 1793065253000, outage_type: 'JOB' }, geometry: { type: 'LineString', coordinates: [[-62.8, 46.16], [-62.79, 46.17 + len]] } });
  const rows = normalizeMaritime({ type: 'FeatureCollection', features: [line(31, 0), line(88, 0.01), line(3, 0)] }, NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].customers, 88);
  assert.equal(rows[0].status, 'Crew assigned');
  assert.equal(rows[0].cause, 'Pending');
});

test('Newfoundland Power and Alectra', () => {
  const np = normalizeNfPower({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { ID: 'NP1', TIME_OUTAGE: 1793050000000, CUSTOMER_COUNT: 140, CAUSE: 'Weather', TIME_RESTORED_EST: null, CREW_STATUS: 'Dispatched' }, geometry: { type: 'Point', coordinates: [-52.7, 47.56] } }] }, { planned: false, nowMs: NOW });
  assert.equal(np[0].customers, 140);
  assert.equal(np[0].kind, 'unplanned');
  const al = normalizeAlectra(
    { type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { CaseIDOnMap: 872006, ShowOnMap: 1, OutageTime: 1789639464000, CURCUST: 1, OutageCausePublic: 'Scheduled work being conducted in the area', EstRestoreTime: null }, geometry: { type: 'Point', coordinates: [-79.7, 43.7] } },
      { type: 'Feature', properties: { CaseIDOnMap: 9, ShowOnMap: 0, CURCUST: 5 }, geometry: { type: 'Point', coordinates: [-79.7, 43.7] } },
    ] },
    { type: 'FeatureCollection', features: [] },
    NOW,
  );
  assert.equal(al.length, 1);
  assert.equal(al[0].kind, 'planned-active');
});
