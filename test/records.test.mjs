import test from 'node:test';
import assert from 'node:assert/strict';
import {
  albertaOffsetMs,
  parseAlbertaTime,
  normalizeAtcoActive,
  normalizeAtcoPlanned,
  normalizeFortis,
  normalizeEnmax,
  normalizeEpcor,
  plannedKind,
  summarize,
} from '../server/records.js';

// Shapes below mirror payloads captured from each utility's live map feed
// on 2026-10-26 (trimmed; staff names and internal comments omitted).

const NOW = Date.parse('2026-10-26T13:05:00Z'); // 07:05 MDT

const geo = (lat, lon) => ({ geoPointValue: { latitude: lat, longitude: lon } });
const circle = (lat, lon, r = 0.002, n = 12) => ({
  arrayValue: {
    values: Array.from({ length: n }, (_, i) =>
      geo(
        lat + r * Math.sin((2 * Math.PI * i) / n),
        lon + r * Math.cos((2 * Math.PI * i) / n),
      ),
    ),
  },
});

test('Alberta wall-clock strings: permanent UTC-6 from March 2026', () => {
  // Before the change: MST in January, MDT in summer.
  assert.equal(
    parseAlbertaTime('2025-01-15T09:00:00'),
    Date.parse('2025-01-15T16:00:00Z'),
  );
  assert.equal(
    parseAlbertaTime('2025-07-15T09:00:00'),
    Date.parse('2025-07-15T15:00:00Z'),
  );
  // After it: UTC-6 all year, including winter, whatever tzdata the host has.
  assert.equal(
    parseAlbertaTime('2026-10-26T09:00:00'),
    Date.parse('2026-10-26T15:00:00Z'),
  );
  assert.equal(
    parseAlbertaTime('2026-12-01T09:00:00'),
    Date.parse('2026-12-01T15:00:00Z'),
  );
  assert.equal(albertaOffsetMs(Date.parse('2027-01-15T12:00:00Z')), -6 * 3600_000);
  assert.equal(
    parseAlbertaTime('2026-10-27T14:00:00Z'),
    Date.parse('2026-10-27T14:00:00Z'),
  );
  assert.equal(parseAlbertaTime(1792493991000), 1792493991000);
  assert.equal(parseAlbertaTime('TBD'), null);
  assert.equal(parseAlbertaTime(''), null);
});

test('the fixed rule agrees with current IANA tzdata where the host has it', () => {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Edmonton',
    timeZoneName: 'shortOffset',
  });
  // Only meaningful on a runtime with tzdata 2026e or newer.
  const hostWinter = fmt.format(new Date('2026-12-15T12:00:00Z'));
  if (!/GMT-6/.test(hostWinter)) return;
  for (const iso of [
    '2025-01-15T12:00:00Z',
    '2025-07-15T12:00:00Z',
    '2026-12-15T12:00:00Z',
    '2027-07-15T12:00:00Z',
  ]) {
    const hours = Number(/GMT([+-]\d+)/.exec(fmt.format(new Date(iso)))[1]);
    assert.equal(albertaOffsetMs(Date.parse(iso)), hours * 3600_000, iso);
  }
});

test('ATCO active outages keep polygons, counts and the utility rounding', () => {
  const rows = normalizeAtcoActive([
    {
      name: 'projects/x/databases/(default)/documents/ActiveOutages/2850118',
      fields: {
        NUM_CUST: { integerValue: '13' },
        NUM_CUST_FMT: { stringValue: '13' },
        AFFECTED_AREA: { stringValue: 'Jasper' },
        EVENT_STATUS_DESCRIPTION: { stringValue: 'Assigned to Crew' },
        OUTAGE_TYPE_DESC: { stringValue: 'Unplanned Trouble Call' },
        CAUSE_CODE: { stringValue: 'Assessment Underway' },
        EST_REP_TIME_FMT: { stringValue: 'TBD' },
        EST_REP_TIME: { nullValue: null },
        UPDATE_DTS: { integerValue: '1792493991000' },
        CENTROID_GPS: geo(52.881, -118.0808),
        boundary: circle(52.881, -118.0808),
      },
    },
    {
      name: '.../ActiveOutages/2850173',
      fields: {
        NUM_CUST: { integerValue: '1' },
        NUM_CUST_FMT: { stringValue: '< 10' },
        AFFECTED_AREA: { stringValue: 'Mildred Lake' },
        OUTAGE_TYPE_DESC: { stringValue: 'Planned Outage' },
        CENTROID_GPS: geo(57.0399, -111.5606),
      },
    },
    { name: '.../ActiveOutages/bad', fields: {} }, // unlocatable → dropped
  ]);
  assert.equal(rows.length, 2);
  const [jasper, mildred] = rows;
  assert.equal(jasper.stableId, 'atco:2850118');
  assert.equal(jasper.kind, 'unplanned');
  assert.equal(jasper.customers, 13);
  assert.equal(jasper.estRestoreText, 'TBD');
  assert.equal(jasper.updatedMs, 1792493991000);
  assert.equal(jasper.polygons.length, 1);
  const ring = jasper.polygons[0][0];
  assert.deepEqual(ring[0], ring[ring.length - 1], 'ring is closed');
  assert.equal(mildred.kind, 'planned-active');
  assert.equal(mildred.customersText, '< 10');
  assert.deepEqual(mildred.polygons, []);
  assert.deepEqual(summarize(rows), {
    outages: 1,
    customersOut: 14,
    plannedActive: 1,
    upcoming: 0,
  });
});

test('ATCO planned work: only current or next-7-day windows, no internal fields', () => {
  const doc = (id, start, end) => ({
    name: `.../PlanOutages/${id}`,
    fields: {
      STARTDATE: { integerValue: String(start) },
      ENDDATE: { integerValue: String(end) },
      CUST_CNT: { integerValue: '6' },
      NUMCUST_FMT: { stringValue: '< 10' },
      DESCOFWORK: { stringValue: 'Pole Changes' },
      AFFECTED_AREA: { stringValue: 'Forestburg' },
      STATUS: { stringValue: 'Communication Sent' },
      INTERNALCOMMENTS: { stringValue: 'crew lead name here' },
      EXTRATEXT3: { stringValue: 'Staff Name' },
      CENTROID_GPS: geo(52.62, -112.13),
    },
  });
  const h = 3600_000;
  const rows = normalizeAtcoPlanned(
    [
      doc('now', NOW - h, NOW + h),
      doc('soon', NOW + 24 * h, NOW + 26 * h),
      doc('far', NOW + 30 * 24 * h, NOW + 30 * 24 * h + h),
      doc('done', NOW - 5 * h, NOW - 2 * h),
    ],
    NOW,
  );
  assert.deepEqual(
    rows.map((r) => [r.stableId, r.kind]),
    [
      ['atco-planned:now', 'planned-active'],
      ['atco-planned:soon', 'planned-upcoming'],
    ],
  );
  assert.ok(!JSON.stringify(rows).includes('Staff Name'));
  assert.ok(!JSON.stringify(rows).includes('crew lead'));
});

test('FortisAlberta joins markers and areas by outage number', () => {
  const props = {
    CustomersAffected: 17,
    EstimatedRestore: null,
    IsPlanned: 1,
    MarkerCoordinate: { Latitude: 53.3629, Longitude: -112.659 },
    Number: '31075',
    OutageStart: null,
    Reason: 'Construction',
    Schedule: [{ Start: '2026-10-27T14:00:00Z', End: '2026-10-27T16:30:00Z' }],
    Status: null,
  };
  const poly = {
    type: 'Polygon',
    coordinates: [
      [
        [-112.66, 53.35],
        [-112.64, 53.35],
        [-112.64, 53.37],
        [-112.66, 53.35],
      ],
    ],
  };
  const planned = normalizeFortis(
    {
      features: [
        { properties: props, geometry: { type: 'Point', coordinates: [-112.659, 53.3629] } },
      ],
    },
    { features: [{ properties: props, geometry: poly }] },
    { planned: true, nowMs: NOW },
  );
  assert.equal(planned.length, 1);
  assert.equal(planned[0].stableId, 'fortis-planned:31075');
  assert.equal(planned[0].kind, 'planned-upcoming');
  assert.equal(planned[0].customers, 17);
  assert.equal(planned[0].startMs, Date.parse('2026-10-27T14:00:00Z'));
  assert.equal(planned[0].polygons.length, 1);

  const live = normalizeFortis(
    {
      features: [
        {
          properties: {
            ...props,
            MarkerCoordinate: { Latitude: 52.3, Longitude: -113.5 },
            IsPlanned: 0,
            Number: '9001',
            Schedule: null,
            Status: 'Crew assigned',
            Reason: 'Weather',
            OutageStart: '2026-10-26T06:10:00',
          },
          geometry: { type: 'Point', coordinates: [-113.5, 52.3] },
        },
      ],
    },
    { type: 'FeatureCollection', features: [] },
    { planned: false, nowMs: NOW },
  );
  assert.equal(live[0].kind, 'unplanned');
  assert.equal(live[0].startMs, Date.parse('2026-10-26T12:10:00Z'));

  // Today's real state: both live collections empty.
  assert.deepEqual(
    normalizeFortis(
      { type: 'FeatureCollection', features: [] },
      { type: 'FeatureCollection', features: [] },
      { planned: false, nowMs: NOW },
    ),
    [],
  );
  assert.equal(normalizeFortis(null, {}, { planned: false, nowMs: NOW }), null);
});

test("ENMAX follows its own map's tab rules", () => {
  const base = {
    areasAffected: null,
    customersAffected: 12,
    latitude: 51.0375,
    longitude: -113.976,
    reasonCode: 0,
    status: null,
    requestDate: '2026-10-23T11:43:00.027',
  };
  const rows = normalizeEnmax(
    [
      // Active tab: open + Unplanned
      {
        ...base,
        incidentID: '212b29d8',
        incidentName: '0755',
        outageType: 'Unplanned',
        isPlanned: false,
        state: 'open',
        status: 'Power Restored',
        customersAffected: 1,
        areasAffected: 'Sage Hill, Nolan Hill',
        outageStart: '2026-10-23T09:43:52',
        estimatedRestoration: '2026-10-24T17:00:00',
      },
      // Resolved tab: closed → dropped
      { ...base, incidentID: 'closed1', outageType: 'Unplanned', state: 'closed' },
      // Unplanned but flagged isPlanned → planned work, ended → dropped
      {
        ...base,
        incidentID: 'pole',
        outageType: 'Unplanned',
        isPlanned: true,
        state: 'open',
        outageStart: '2026-10-25T09:00:47',
        estimatedRestoration: '2026-10-25T12:00:00',
      },
      // Planned, underway right now (07:00–09:00 MDT)
      {
        ...base,
        incidentID: '39852',
        outageType: 'Planned',
        state: 'open',
        customersAffected: 108,
        outageStart: '2026-10-26T07:00:00',
        estimatedRestoration: '2026-10-26T09:00:00',
      },
      // Planned tomorrow
      {
        ...base,
        incidentID: '39741',
        outageType: 'Planned',
        state: 'open',
        customersAffected: 3,
        outageStart: '2026-10-27T08:30:00',
        estimatedRestoration: '2026-10-27T14:30:00',
      },
    ],
    NOW,
  );
  assert.deepEqual(
    rows.map((r) => [r.stableId, r.kind, r.customers]),
    [
      ['enmax:212b29d8', 'unplanned', 1],
      ['enmax:39852', 'planned-active', 108],
      ['enmax:39741', 'planned-upcoming', 3],
    ],
  );
  assert.equal(rows[0].status, 'Power Restored');
  assert.equal(rows[0].area, 'Sage Hill, Nolan Hill');
  assert.deepEqual(rows[0].point, { lon: -113.976, lat: 51.0375 });
});

test('EPCOR neighbourhood polygons; string customer counts parse', () => {
  const rows = normalizeEpcor({
    type: 'FeatureCollection',
    features: [
      {
        properties: {
          GlobalID: '{ABC}',
          affcusts: '45,536',
          cause: 'Under investigation',
          nbhoods: 'Allard, Ambleside',
          affstree: 'Ellerslie Rd SW',
          faulted: '2026-10-26T06:15:00',
          estresto: '9:30 PM',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-113.6, 53.4],
              [-113.5, 53.4],
              [-113.5, 53.45],
              [-113.6, 53.4],
            ],
          ],
        },
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].customers, 45536);
  assert.equal(rows[0].estRestoreText, '9:30 PM');
  assert.equal(rows[0].area, 'Allard, Ambleside · Ellerslie Rd SW');
  assert.ok(rows[0].point.lat > 53.39 && rows[0].point.lat < 53.46);
  assert.deepEqual(normalizeEpcor({ type: 'FeatureCollection', features: [] }), []);
});

test('plannedKind windows', () => {
  const h = 3600_000;
  assert.equal(plannedKind(NOW - h, NOW + h, NOW), 'planned-active');
  assert.equal(plannedKind(NOW + h, NOW + 2 * h, NOW), 'planned-upcoming');
  assert.equal(plannedKind(NOW - 2 * h, NOW - h, NOW), null);
  assert.equal(plannedKind(NOW + 8 * 24 * h, null, NOW), null);
});
