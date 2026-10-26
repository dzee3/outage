/**
 * Power-outage records: one shape for every utility feed.
 *
 * Pure functions shared by the server provider (which normalizes each
 * utility's own format) and the client layer (which only reads the result).
 * No Cesium, no i18n, no network.
 *
 * A record:
 *   stableId        'atco:2850118'
 *   utility         'atco' | 'fortis' | 'enmax' | 'epcor'
 *   kind            'unplanned' | 'planned-active' | 'planned-upcoming'
 *   customers       number | null      (null when the utility gives none)
 *   customersText   string | null      (the utility's own rounding, e.g. "< 10")
 *   status, cause, area                strings as the utility sent them
 *   startMs, estRestoreMs, updatedMs   epoch ms | null
 *   estRestoreText  string | null      ("TBD" and similar)
 *   point           {lon, lat}         always present
 *   polygons        [[ring, ...holes], ...] of [lon, lat] (may be empty)
 */

export const OUTAGE_KINDS = Object.freeze([
  'unplanned',
  'planned-active',
  'planned-upcoming',
]);

/** Planned work further out than this is left to the utility's own page. */
export const UPCOMING_WINDOW_MS = 7 * 24 * 3600_000;

const text = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};
const finite = (value) => (Number.isFinite(value) ? value : null);

/** Parse a count that may arrive as a number or a numeric string. */
export function parseCount(value) {
  if (Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value === 'string' && /^\s*\d[\d,]*\s*$/.test(value))
    return Number(value.replace(/[,\s]/g, ''));
  return null;
}

/**
 * Alberta moved to permanent daylight time (UTC-6) from the March 2026
 * spring-forward (IANA tzdata 2026e). Many runtimes ship older tzdata — the
 * pinned Docker Node image among them — and would still apply MST (UTC-7)
 * in winter, putting every ENMAX time an hour off. So the rule is fixed here
 * instead of trusting the host's zone database.
 */
const PERMANENT_MDT_FROM = Date.UTC(2026, 2, 8, 9); // 2026-03-08 02:00 MST
const MDT = -6 * 3600_000;
const MST = -7 * 3600_000;

/** Second Sunday of March / first Sunday of November, 2am local. */
function legacyAlbertaOffset(utcMs) {
  const year = new Date(utcMs).getUTCFullYear();
  const nthSunday = (month, n) => {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + 7 * (n - 1);
  };
  const dstStart = Date.UTC(year, 2, nthSunday(2, 2), 9); // 02:00 MST
  const dstEnd = Date.UTC(year, 10, nthSunday(10, 1), 8); // 02:00 MDT
  return utcMs >= dstStart && utcMs < dstEnd ? MDT : MST;
}

/** Offset (ms) of Alberta time from UTC at a given instant. */
export function albertaOffsetMs(utcMs) {
  return utcMs >= PERMANENT_MDT_FROM ? MDT : legacyAlbertaOffset(utcMs);
}

/**
 * Parse a timestamp. Numbers are epoch ms. Strings with a zone (Z, ±hh:mm)
 * are absolute; zone-less ISO-like strings are Alberta wall-clock time, which
 * is what ENMAX sends ("2026-10-26T09:00:00").
 * @returns {number|null}
 */
export function parseAlbertaTime(value) {
  if (Number.isFinite(value)) return value > 0 ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const s = value.trim();
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    return s.length === 10 ? n * 1000 : n;
  }
  if (/(Z|[+-]\d\d:?\d\d)$/i.test(s)) {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
  }
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(
      s,
    );
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  // Two passes settle the offset across a DST boundary.
  let guess = wall - albertaOffsetMs(wall);
  guess = wall - albertaOffsetMs(guess);
  return guess;
}

function validRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  return ring.every(
    (p) =>
      Array.isArray(p) &&
      Number.isFinite(p[0]) &&
      Number.isFinite(p[1]) &&
      Math.abs(p[0]) <= 180 &&
      Math.abs(p[1]) <= 90,
  );
}

function closeRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return ring;
  const [a, b] = [ring[0], ring[ring.length - 1]];
  return a[0] === b[0] && a[1] === b[1] ? ring : [...ring, a];
}

/** GeoJSON Polygon/MultiPolygon → array of polygons; [] when absent or bad. */
export function geojsonPolygons(geometry) {
  if (!geometry || typeof geometry !== 'object') return [];
  let polygons;
  if (geometry.type === 'Polygon') polygons = [geometry.coordinates];
  else if (geometry.type === 'MultiPolygon') polygons = geometry.coordinates;
  else return [];
  if (!Array.isArray(polygons)) return [];
  const out = [];
  for (const rings of polygons) {
    if (!Array.isArray(rings) || !rings.length) continue;
    const closed = rings.map(closeRing);
    if (closed.every(validRing)) out.push(closed);
  }
  return out;
}

/** Vertex mean of the largest outer ring — good enough for a pin. */
export function polygonsAnchor(polygons) {
  let best = null;
  for (const rings of polygons || []) {
    if (!best || rings[0].length > best.length) best = rings[0];
  }
  if (!best) return null;
  const pts = best.slice(0, -1);
  const lon = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const lat = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  return { lon, lat };
}

const validPoint = (p) =>
  p &&
  Number.isFinite(p.lon) &&
  Number.isFinite(p.lat) &&
  Math.abs(p.lon) <= 180 &&
  Math.abs(p.lat) <= 90 &&
  !(p.lon === 0 && p.lat === 0);

/** Classify planned work against the clock; null when it is over or too far out. */
export function plannedKind(startMs, endMs, nowMs) {
  if (Number.isFinite(endMs) && endMs < nowMs) return null;
  if (!Number.isFinite(startMs)) return 'planned-upcoming';
  if (startMs <= nowMs) return 'planned-active';
  if (startMs - nowMs > UPCOMING_WINDOW_MS) return null;
  return 'planned-upcoming';
}

/** Finish a record: fill the point from polygons, drop it if unlocatable. */
function finish(record) {
  const point = validPoint(record.point)
    ? record.point
    : polygonsAnchor(record.polygons);
  if (!validPoint(point)) return null;
  return {
    stableId: record.stableId,
    utility: record.utility,
    kind: record.kind,
    customers: record.customers ?? null,
    customersText: record.customersText ?? null,
    status: record.status ?? null,
    cause: record.cause ?? null,
    area: record.area ?? null,
    startMs: record.startMs ?? null,
    estRestoreMs: record.estRestoreMs ?? null,
    estRestoreText: record.estRestoreText ?? null,
    updatedMs: record.updatedMs ?? null,
    point,
    polygons: record.polygons || [],
  };
}

// ---------------------------------------------------------------- ATCO ----

/** Decode one Firestore REST `Value` into plain JS. */
export function firestoreValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return Boolean(v.booleanValue);
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('geoPointValue' in v)
    return {
      lat: Number(v.geoPointValue.latitude ?? 0),
      lon: Number(v.geoPointValue.longitude ?? 0),
    };
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(firestoreValue);
  if ('mapValue' in v) return firestoreFields(v.mapValue.fields || {});
  return null;
}

/** Decode a Firestore REST `fields` map. */
export function firestoreFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {}))
    out[key] = firestoreValue(value);
  return out;
}

/** ATCO stores outage areas as an array of GeoPoints. */
function atcoPolygons(boundary) {
  if (!Array.isArray(boundary)) return [];
  const ring = closeRing(
    boundary
      .filter((p) => p && Number.isFinite(p.lon) && Number.isFinite(p.lat))
      .map((p) => [p.lon, p.lat]),
  );
  return validRing(ring) ? [[ring]] : [];
}

const docId = (doc) =>
  typeof doc?.name === 'string' ? doc.name.split('/').pop() : null;

/**
 * ATCO `ActiveOutages` documents (Firestore REST shape) → records.
 * Everything in this collection is a current outage; ATCO marks its own
 * maintenance with OUTAGE_TYPE_DESC "Planned Outage".
 */
export function normalizeAtcoActive(documents) {
  if (!Array.isArray(documents)) return null;
  const rows = [];
  for (const doc of documents) {
    const id = docId(doc);
    if (!id) continue;
    const f = firestoreFields(doc.fields);
    // "Planned Outage" vs "Unplanned Trouble Call": match the word, not the substring.
    const planned = /^\s*planned\b/i.test(f.OUTAGE_TYPE_DESC || '');
    const est = parseAlbertaTime(f.EST_REP_TIME);
    const row = finish({
      stableId: `atco:${id}`,
      utility: 'atco',
      kind: planned ? 'planned-active' : 'unplanned',
      customers: parseCount(f.NUM_CUST),
      customersText: text(f.NUM_CUST_FMT),
      status: text(f.EVENT_STATUS_DESCRIPTION),
      cause: text(f.CAUSE_CODE),
      area: text(f.AFFECTED_AREA),
      startMs: parseAlbertaTime(f.OFF_DTS),
      estRestoreMs: est,
      estRestoreText: est ? null : text(f.EST_REP_TIME_FMT),
      updatedMs: parseAlbertaTime(f.UPDATE_DTS),
      point: f.CENTROID_GPS || null,
      polygons: atcoPolygons(f.boundary),
    });
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * ATCO `PlanOutages` documents → records for work underway now or within
 * the upcoming window. Internal comments and staff names are never copied.
 */
export function normalizeAtcoPlanned(documents, nowMs) {
  if (!Array.isArray(documents)) return null;
  const rows = [];
  for (const doc of documents) {
    const id = docId(doc);
    if (!id) continue;
    const f = firestoreFields(doc.fields);
    const startMs = parseAlbertaTime(f.STARTDATE);
    const endMs = parseAlbertaTime(f.ENDDATE);
    const kind = plannedKind(startMs, endMs, nowMs);
    if (!kind) continue;
    const row = finish({
      stableId: `atco-planned:${id}`,
      utility: 'atco',
      kind,
      customers: parseCount(f.CUST_CNT ?? f.NUMCUST),
      customersText: text(f.NUMCUST_FMT),
      status: text(f.STATUS),
      cause: text(f.DESCOFWORK) || 'Planned work',
      area: text(f.AFFECTED_AREA) || text(f.SERVICEPOINT),
      startMs,
      estRestoreMs: endMs,
      updatedMs: parseAlbertaTime(f.LASTUPDATEDBYDATE),
      point: f.CENTROID_GPS || null,
      polygons: atcoPolygons(f.boundary),
    });
    if (row) rows.push(row);
  }
  return rows;
}

// -------------------------------------------------------------- Fortis ----

/** Index a Fortis FeatureCollection by its outage Number. */
function byNumber(collection) {
  const map = new Map();
  for (const feature of collection?.features || []) {
    const number = feature?.properties?.Number;
    if (number == null || number === '') continue;
    const key = String(number);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(feature);
  }
  return map;
}

/**
 * FortisAlberta markers + areas FeatureCollections → records.
 * @param {object} markers  /outages[/planned]/markers response
 * @param {object} areas    /outages[/planned]/areas response
 * @param {{planned: boolean, nowMs: number}} options
 */
export function normalizeFortis(markers, areas, { planned, nowMs }) {
  if (!Array.isArray(markers?.features) || !Array.isArray(areas?.features))
    return null;
  const markerIndex = byNumber(markers);
  const areaIndex = byNumber(areas);
  const numbers = new Set([...markerIndex.keys(), ...areaIndex.keys()]);
  const rows = [];
  for (const number of numbers) {
    const features = [
      ...(markerIndex.get(number) || []),
      ...(areaIndex.get(number) || []),
    ];
    const p = features[0].properties || {};
    const polygons = (areaIndex.get(number) || []).flatMap((f) =>
      geojsonPolygons(f.geometry),
    );
    const markerGeom = (markerIndex.get(number) || [])[0]?.geometry;
    const point =
      p.MarkerCoordinate &&
      Number.isFinite(p.MarkerCoordinate.Longitude) &&
      Number.isFinite(p.MarkerCoordinate.Latitude)
        ? {
            lon: p.MarkerCoordinate.Longitude,
            lat: p.MarkerCoordinate.Latitude,
          }
        : markerGeom?.type === 'Point'
          ? { lon: markerGeom.coordinates[0], lat: markerGeom.coordinates[1] }
          : null;

    let kind = 'unplanned';
    let startMs = parseAlbertaTime(p.OutageStart);
    let estRestoreMs = parseAlbertaTime(p.EstimatedRestore);
    if (planned || p.IsPlanned === 1 || p.IsPlanned === true) {
      // Pick the window that is running now, else the next one.
      const windows = (Array.isArray(p.Schedule) ? p.Schedule : [])
        .map((w) => ({
          start: parseAlbertaTime(w?.Start),
          end: parseAlbertaTime(w?.End),
        }))
        .filter((w) => Number.isFinite(w.start))
        .sort((a, b) => a.start - b.start);
      const current = windows.find(
        (w) => w.start <= nowMs && (!Number.isFinite(w.end) || w.end >= nowMs),
      );
      const next = windows.find((w) => w.start > nowMs);
      const chosen = current || next || null;
      if (chosen) {
        startMs = chosen.start;
        estRestoreMs = chosen.end;
        kind = plannedKind(chosen.start, chosen.end, nowMs);
      } else {
        // No schedule: an active-feed planned outage is happening now.
        kind = planned
          ? plannedKind(startMs, estRestoreMs, nowMs)
          : 'planned-active';
      }
      if (!kind) continue;
    }
    const row = finish({
      stableId: `fortis${planned ? '-planned' : ''}:${number}`,
      utility: 'fortis',
      kind,
      customers: parseCount(p.CustomersAffected),
      status: text(p.Status),
      cause: text(p.Reason),
      startMs,
      estRestoreMs,
      point,
      polygons,
    });
    if (row) rows.push(row);
  }
  return rows;
}

// --------------------------------------------------------------- ENMAX ----

/**
 * ENMAX /api/outage rows → records, using the same rules as ENMAX's map:
 *   state "closed"                  → resolved, dropped
 *   open + Unplanned (not isPlanned) → active outage
 *   open + Planned, or isPlanned     → planned work
 * One deliberate difference: ENMAX's map stops listing planned work once it
 * starts; here it shows as "planned-active" until its end time.
 */
export function normalizeEnmax(items, nowMs) {
  if (!Array.isArray(items)) return null;
  const rows = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const state = String(item.state || '').toLowerCase();
    if (state !== 'open') continue;
    const type = String(item.outageType || '').toLowerCase();
    const isPlanned = type === 'planned' || item.isPlanned === true;
    const startMs = parseAlbertaTime(item.outageStart);
    const estRestoreMs = parseAlbertaTime(item.estimatedRestoration);
    let kind = 'unplanned';
    if (isPlanned) {
      kind = plannedKind(startMs, estRestoreMs, nowMs);
      if (!kind) continue;
    }
    const id = item.incidentID ?? item.incidentName;
    if (id == null || id === '') continue;
    const row = finish({
      stableId: `enmax:${id}`,
      utility: 'enmax',
      kind,
      customers: parseCount(item.customersAffected),
      status: text(item.status),
      cause: text(item.outageCause),
      area: text(item.areasAffected),
      startMs,
      estRestoreMs,
      updatedMs: parseAlbertaTime(item.requestDate),
      point: { lon: Number(item.longitude), lat: Number(item.latitude) },
      polygons: [],
    });
    if (row) rows.push(row);
  }
  return rows;
}

// --------------------------------------------------------------- EPCOR ----

/** EPCOR ArcGIS GeoJSON (layer ocps_prod_av) → records; all are unplanned. */
export function normalizeEpcor(collection) {
  if (!Array.isArray(collection?.features)) return null;
  const rows = [];
  for (const feature of collection.features) {
    const p = feature?.properties || {};
    const id = p.GlobalID || p.id || p.OBJECTID || feature.id;
    if (id == null || id === '') continue;
    const est = parseAlbertaTime(p.estresto);
    const streets = text(p.affstree);
    const hoods = text(p.nbhoods);
    const row = finish({
      stableId: `epcor:${id}`,
      utility: 'epcor',
      kind: 'unplanned',
      customers: parseCount(p.affcusts),
      customersText: parseCount(p.affcusts) == null ? text(p.affcusts) : null,
      cause: text(p.cause),
      area: [hoods, streets].filter(Boolean).join(' · ') || null,
      startMs: parseAlbertaTime(p.faulted),
      estRestoreMs: est,
      estRestoreText: est ? null : text(p.estresto),
      polygons: geojsonPolygons(feature.geometry),
    });
    if (row) rows.push(row);
  }
  return rows;
}

// ------------------------------------------------------------- summary ----

/** Customers out per kind, for headlines and the office board. */
export function summarize(rows) {
  const out = {
    outages: 0,
    customersOut: 0,
    plannedActive: 0,
    upcoming: 0,
  };
  for (const row of rows || []) {
    if (row.kind === 'planned-upcoming') {
      out.upcoming += 1;
      continue;
    }
    if (row.kind === 'planned-active') out.plannedActive += 1;
    else out.outages += 1;
    out.customersOut += finite(row.customers) ?? 0;
  }
  return out;
}
