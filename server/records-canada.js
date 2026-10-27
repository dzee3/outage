/*
 * Normalizers for utilities outside Alberta. Each takes the utility's own
 * response (as its public outage map receives it) and returns records in the
 * shape documented in records.js, or null when the response is not in the
 * expected format (so the source shows as failing rather than empty).
 */
import {
  closeRing,
  finish,
  geojsonPolygons,
  parseCount,
  plannedKind,
  text,
  validRing,
} from './records.js';
import { decodePolyline } from './polyline.js';
import { parseZoned, PROVINCE_ZONES, zonedToUtc } from './zones.js';

const ringFrom = (points) => {
  const ring = closeRing(points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
  return validRing(ring) ? ring : null;
};

/** Planned-vs-unplanned words used across utilities. */
const PLANNED_RE = /\b(planned|scheduled|maintenance)\b/i;

/** Classify a planned window; unplanned when not planned. */
function kindFor(isPlanned, startMs, endMs, nowMs) {
  if (!isPlanned) return 'unplanned';
  return plannedKind(startMs, endMs, nowMs);
}

// ------------------------------------------------------------ BC Hydro ----

/**
 * BC Hydro /power-outages/app/outages-map-data.json → records.
 * `polygon` is a flat [lon, lat, lon, lat, ...] list; times are epoch ms.
 */
export function normalizeBcHydro(items, nowMs) {
  if (!Array.isArray(items)) return null;
  const rows = [];
  for (const o of items) {
    if (!o || o.id == null) continue;
    if (o.dateOn && o.dateOn < nowMs) continue; // restored
    const flat = Array.isArray(o.polygon) ? o.polygon : [];
    const pts = [];
    for (let i = 0; i + 1 < flat.length; i += 2) pts.push([Number(flat[i]), Number(flat[i + 1])]);
    const ring = ringFrom(pts);
    const isPlanned = PLANNED_RE.test(`${o.cause || ''} ${o.crewStatusDescription || ''}`);
    const kind = kindFor(isPlanned, o.dateOff, o.crewEtr, nowMs);
    if (!kind) continue;
    const row = finish({
      stableId: `bchydro:${o.id}`,
      utility: 'bchydro',
      kind,
      customers: parseCount(o.numCustomersOut),
      status: text(o.crewStatusDescription),
      cause: text(o.cause),
      area: [text(o.municipality), text(o.area)].filter(Boolean).join(', ') || null,
      startMs: Number.isFinite(o.dateOff) ? o.dateOff : null,
      estRestoreMs: o.showEtr !== false && Number.isFinite(o.crewEtr) ? o.crewEtr : null,
      updatedMs: Number.isFinite(o.lastUpdated) ? o.lastUpdated : null,
      point: { lon: Number(o.longitude), lat: Number(o.latitude) },
      polygons: ring ? [[ring]] : [],
    });
    if (row) rows.push(row);
  }
  return rows;
}

// --------------------------------------- "Outages" XML (FortisBC, SL&P) ----

/** Pull <OMSCASES> blocks out of the UpdatePushpin XML into plain objects. */
export function parseOmsCases(xml) {
  if (typeof xml !== 'string' || !/<NewDataSet|<OMSCASES/i.test(xml)) return null;
  const decode = (s) =>
    s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .trim();
  const cases = [];
  for (const block of xml.matchAll(/<OMSCASES\b[^>]*>([\s\S]*?)<\/OMSCASES>/gi)) {
    const c = {};
    for (const m of block[1].matchAll(/<([A-Z_0-9]+)\b[^>]*>([\s\S]*?)<\/\1>/gi)) c[m[1].toUpperCase()] = decode(m[2]);
    cases.push(c);
  }
  return cases;
}

/** COORDLIST: whatever the separators, pair up numbers and tell lon from lat. */
function coordList(value) {
  const nums = String(value || '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const [a, b] = [nums[i], nums[i + 1]];
    pts.push(a < 0 && b > 0 ? [a, b] : [b, a]); // Canada: lon < 0 < lat
  }
  return pts;
}

/**
 * FortisBC and Saskatoon Light & Power run the same "Outages" web app:
 * POST /Outages/Home/UpdatePushpin → XML with one <OMSCASES> per case.
 */
export function normalizeOmsCases(xml, { utility, zone, nowMs }) {
  const cases = parseOmsCases(xml);
  if (!cases) return null;
  const bySerial = new Map();
  for (const c of cases) {
    const id = c.SERIAL || `${c.AVGLAT},${c.AVGLONG}`;
    if (!bySerial.has(id)) bySerial.set(id, []);
    bySerial.get(id).push(c);
  }
  const rows = [];
  for (const [id, group] of bySerial) {
    const c = group[0];
    const planned = /^(1|y|yes|true|p)$/i.test(c.PLANNED || '') || PLANNED_RE.test(c.TYPE || '');
    const startMs = parseZoned(c.OUTTIME, zone);
    const estMs = parseZoned(c.RESTORETIM, zone);
    const kind = kindFor(planned, startMs, estMs, nowMs);
    if (!kind) continue;
    const polygons = [];
    for (const g of group) {
      const ring = ringFrom(coordList(g.COORDLIST));
      if (ring) polygons.push([ring]);
    }
    const row = finish({
      stableId: `${utility}:${id}`,
      utility,
      kind,
      customers: parseCount(c.CURCUST) ?? parseCount(c.INITCUST),
      status: text(c.WORKSTAT) || text(c.JOBSTAT) || text(c.CASESTAT),
      cause: text(c.DESC_CAUSE),
      area: text(c.DESC),
      startMs,
      estRestoreMs: estMs,
      estRestoreText: estMs ? null : text(c.RESTRANGE),
      point: { lon: Number(c.AVGLONG), lat: Number(c.AVGLAT) },
      polygons,
    });
    if (row) rows.push(row);
  }
  return rows;
}

// ----------------------------------------------------------- SaskPower ----

/** KML from GetOutageKmlFile → Map(regionId → {name, style, polygons}). */
export function parseSaskPowerKml(kml) {
  if (typeof kml !== 'string' || !/<kml/i.test(kml)) return null;
  const regions = new Map();
  for (const folder of kml.matchAll(/<Folder>\s*<name>([^<]*)<\/name>([\s\S]*?)<\/Folder>/gi)) {
    const id = folder[1].trim();
    for (const pm of folder[2].matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/gi)) {
      const name = /<name>([^<]*)<\/name>/i.exec(pm[1])?.[1]?.trim() || '';
      const style = /<styleUrl>#?([^<]*)<\/styleUrl>/i.exec(pm[1])?.[1]?.trim() || '';
      const polygons = [];
      for (const c of pm[1].matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/gi)) {
        const pts = c[1]
          .trim()
          .split(/\s+/)
          .map((t) => t.split(',').map(Number))
          .map(([x, y]) => [x, y]);
        const ring = ringFrom(pts);
        if (ring) polygons.push([ring]);
      }
      const prior = regions.get(id);
      if (prior) prior.polygons.push(...polygons);
      else regions.set(id, { name, style, polygons });
    }
  }
  return regions;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Read the window out of a SaskPower planned-outage message, e.g.
 * "A planned outage is scheduled on 10/28 from 2:00pm to 4:00pm affecting …".
 * Multi-day notices ("on 10/27 and 10/28 from …") take the first day.
 */
export function saskPowerWindow(message, nowMs) {
  const s = String(message || '');
  const date = /\bon\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i.exec(s);
  const time = /from\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s+to\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i.exec(s);
  if (!date) return null;
  const nowYear = new Date(nowMs).getUTCFullYear();
  let year = date[3] ? Number(date[3].length === 2 ? `20${date[3]}` : date[3]) : nowYear;
  const month = Number(date[1]);
  const day = Number(date[2]);
  const h24 = (h, ap) => (Number(h) % 12) + (ap.toLowerCase() === 'p' ? 12 : 0);
  const zone = PROVINCE_ZONES.SK;
  const at = (y, hh, mm) => zonedToUtc(zone, y, month, day, hh, mm);
  let start = time ? at(year, h24(time[1], time[3]), Number(time[2] || 0)) : at(year, 0, 0);
  // A December notice read in January belongs to last year, and vice versa.
  if (!date[3] && start - nowMs > 180 * 86400_000) year -= 1;
  if (!date[3] && nowMs - start > 180 * 86400_000) year += 1;
  start = time ? at(year, h24(time[1], time[3]), Number(time[2] || 0)) : at(year, 0, 0);
  const end = time ? at(year, h24(time[4], time[6]), Number(time[5] || 0)) : at(year, 23, 59);
  return { start, end };
}

/**
 * SaskPower GetOutageJsonFile ({Outages: [...]}) + KML regions → records.
 * SaskPower reports outages per service region (no customer counts).
 */
export function normalizeSaskPower(json, regions, nowMs) {
  if (!Array.isArray(json?.Outages) || !(regions instanceof Map)) return null;
  const rows = [];
  for (const o of json.Outages) {
    if (o?.OutageId == null) continue;
    const region = regions.get(String(o.RegionId));
    const alerts = Array.isArray(o.Alerts) ? o.Alerts : [];
    const message = text(alerts[0]?.Message);
    const isPlanned = /^planned$/i.test(o.Planned || '');
    let startMs = null;
    let endMs = null;
    if (isPlanned) {
      const w = saskPowerWindow(message, nowMs);
      if (w) [startMs, endMs] = [w.start, w.end];
    } else if (alerts.length) {
      // "Oct 26 19:18" (year omitted) on the oldest alert ≈ when it was reported.
      const first = alerts[alerts.length - 1]?.CreateDate || alerts[0]?.CreateDate;
      const m = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(first || '');
      if (m && MONTHS[m[1].toLowerCase()]) {
        const y = new Date(nowMs).getUTCFullYear();
        startMs = zonedToUtc(PROVINCE_ZONES.SK, y, MONTHS[m[1].toLowerCase()], +m[2], +m[3], +m[4]);
        if (startMs - nowMs > 86400_000) startMs = zonedToUtc(PROVINCE_ZONES.SK, y - 1, MONTHS[m[1].toLowerCase()], +m[2], +m[3], +m[4]);
      }
    }
    const kind = isPlanned ? (startMs ? plannedKind(startMs, endMs, nowMs) : 'planned-upcoming') : 'unplanned';
    if (!kind) continue;
    const row = finish({
      stableId: `saskpower:${o.OutageId}`,
      utility: 'saskpower',
      kind,
      customers: null,
      status: message,
      cause: isPlanned ? 'Planned work' : null,
      area: text(o.Region) || region?.name || null,
      startMs,
      estRestoreMs: endMs,
      point: null,
      polygons: region?.polygons || [],
    });
    if (row) rows.push(row);
  }
  return rows;
}

// --------------------------------- SEW portals (Manitoba Hydro, NL Hydro) ----

/**
 * SEW "OuterOutage" data: Table1 = outages, Table = polygon vertices keyed
 * by Outageid. Times (OutagedateDB) are the utility's local wall clock, which
 * is what its own map displays.
 */
export function normalizeSew(data, { utility, zone, nowMs }) {
  const list = Array.isArray(data) ? data : data?.Table1;
  if (!Array.isArray(list)) return null;
  const vertices = new Map();
  for (const v of Array.isArray(data?.Table) ? data.Table : []) {
    if (!vertices.has(v.Outageid)) vertices.set(v.Outageid, []);
    vertices.get(v.Outageid).push([Number(v.Longitude), Number(v.Latitude)]);
  }
  const rows = [];
  for (const o of list) {
    const id = o?.UtilityOutageId ?? o?.Outageid;
    if (id == null) continue;
    const isPlanned = /planned/i.test(`${o.Title || ''} ${o.OutageReportInfo || ''}`);
    const startMs = parseZoned(o.OutagedateDB ?? o.Outagedate, zone);
    const endMs = parseZoned(o.RestorationdateDB ?? o.Restorationdate, zone);
    const kind = kindFor(isPlanned, startMs, endMs, nowMs);
    if (!kind) continue;
    const ring = ringFrom(vertices.get(o.Outageid) || []);
    const row = finish({
      stableId: `${utility}:${id}`,
      utility,
      kind,
      customers: parseCount(o.CustomerAffected),
      customersText: text(o.CustomerAffectedText),
      status: text(o.STATUS),
      cause: text(o.OutageReportInfo) || (isPlanned ? 'Planned work' : null),
      area: text(o.CityName) || text(o.Area && !/^[\d.]+$/.test(o.Area) ? o.Area : null),
      startMs,
      estRestoreMs: endMs,
      point: { lon: Number(o.OutageLongitude), lat: Number(o.OutageLatitude) },
      polygons: ring ? [[ring]] : [],
    });
    if (row) rows.push(row);
  }
  return rows;
}

// ----------------------------------------------------------------- Kubra ----

/** Kubra storm-centre tile item (v2 or legacy) → record, or null. */
export function normalizeKubraItem(item, { utility, planned = false, nowMs, zone }) {
  const d = item?.desc || {};
  if (d.cluster) return null;
  const p = item?.geom?.p?.[0];
  const pts = decodePolyline(p);
  const point = pts.length ? { lon: pts[0][0], lat: pts[0][1] } : null;
  const polygons = [];
  for (const a of item?.geom?.a || []) {
    const ring = ringFrom(decodePolyline(a));
    if (ring) polygons.push([ring]);
  }
  const lang = (v) => (v && typeof v === 'object' ? v['EN-US'] ?? v.orig ?? null : v);
  const startMs = parseZoned(d.start_time ?? d.start, zone);
  const estMs = parseZoned(d.etr, zone);
  const kind = kindFor(planned || PLANNED_RE.test(String(lang(d.cause) || '')), startMs, estMs, nowMs);
  if (!kind) return null;
  const val = d.cust_a?.val;
  const masked = d.cust_a?.masked || (Number.isFinite(d.cust_a?.mask) && val != null && val < d.cust_a.mask);
  const id = d.inc_id || d.id || p || item.id;
  return finish({
    stableId: `${utility}${planned ? '-planned' : ''}:${id}`,
    utility,
    kind,
    customers: parseCount(val),
    customersText: masked ? `< ${d.cust_a.mask ?? val + 1}` : null,
    status: text(lang(d.crew_status)),
    cause: text(lang(d.cause)),
    area: text(lang(d.comments)),
    startMs,
    estRestoreMs: estMs,
    point,
    polygons,
  });
}

// ------------------------------------------------------------- ArcGIS ----

const gj = (fc) => (Array.isArray(fc?.features) ? fc.features : null);
const attrsOf = (f) => f?.properties || f?.attributes || {};
const pointOf = (f) =>
  f?.geometry?.type === 'Point'
    ? { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }
    : null;

/** Midpoint-ish vertex of a (Multi)LineString, for a pin. */
function lineAnchor(geometry) {
  const lines =
    geometry?.type === 'LineString'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiLineString'
        ? geometry.coordinates
        : [];
  const all = lines.flat();
  if (!all.length) return null;
  const mid = all[Math.floor(all.length / 2)];
  return { lon: mid[0], lat: mid[1] };
}

/**
 * NB Power PublicOutageFC: transformer points (layer 7) and outage hulls
 * (layer 8), both keyed by Incident_ID. One record per incident.
 */
export function normalizeNbPower(points, hulls) {
  const pts = gj(points);
  const hs = gj(hulls);
  if (!pts || !hs) return null;
  const incidents = new Map();
  const get = (id) => {
    if (!incidents.has(id)) incidents.set(id, { points: [], polygons: [], cust: 0, hullCust: 0, t: null });
    return incidents.get(id);
  };
  for (const f of pts) {
    const a = attrsOf(f);
    if (a.Incident_ID == null) continue;
    const inc = get(a.Incident_ID);
    const p = pointOf(f);
    if (p) inc.points.push(p);
    inc.cust += parseCount(a.CustEff) ?? 0;
    const t = Number(a.DateTimeStamp);
    if (Number.isFinite(t) && (inc.t == null || t < inc.t)) inc.t = t;
  }
  for (const f of hs) {
    const a = attrsOf(f);
    if (a.Incident_ID == null) continue;
    const inc = get(a.Incident_ID);
    inc.polygons.push(...geojsonPolygons(f.geometry));
    inc.hullCust = Math.max(inc.hullCust, parseCount(a.CustEff) ?? 0);
  }
  const rows = [];
  for (const [id, inc] of incidents) {
    const p = inc.points[0] || null;
    const row = finish({
      stableId: `nbpower:${id}`,
      utility: 'nbpower',
      kind: 'unplanned',
      customers: Math.max(inc.cust, inc.hullCust) || null,
      startMs: inc.t,
      point: p,
      polygons: inc.polygons,
    });
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Maritime Electric PublicOutageRT LINES layer: one feature per de-energized
 * line section, several per outage_id. The largest section count stands for
 * the outage (sections overlap: an upstream section includes downstream ones).
 */
export function normalizeMaritime(lines, nowMs) {
  const fs = gj(lines);
  if (!fs) return null;
  const jobs = new Map();
  for (const f of fs) {
    const a = attrsOf(f);
    const id = a.outage_id ?? a.OBJECTID;
    if (id == null) continue;
    const prior = jobs.get(id);
    if (!prior || (a.customers_out ?? 0) > (prior.a.customers_out ?? 0)) jobs.set(id, { a, f, pin: prior?.pin || lineAnchor(f.geometry) });
  }
  const rows = [];
  for (const [id, { a, f, pin }] of jobs) {
    const isPlanned = PLANNED_RE.test(`${a.outage_type || ''} ${a.public_job_cause_desc || ''}`);
    const est = Number.isFinite(a.calc_job_est_completion_date) ? a.calc_job_est_completion_date : Number(a.job_est_completion_date) || null;
    const kind = isPlanned ? plannedKind(null, est, nowMs) || 'planned-active' : 'unplanned';
    const row = finish({
      stableId: `maritime:${id}`,
      utility: 'maritime',
      kind: kind === 'planned-upcoming' ? 'planned-active' : kind,
      customers: parseCount(a.customers_out),
      status: text(a.public_crew_status_desc)?.replace(/\.$/, '') || null,
      cause: text(a.public_job_cause_desc)?.replace(/\.$/, '') || null,
      estRestoreMs: est,
      estRestoreText: est ? null : text(a.calc_job_est_completion_text),
      point: pin || lineAnchor(f.geometry),
      polygons: [],
    });
    if (row) rows.push(row);
  }
  return rows;
}

/** Newfoundland Power Public_Outage_Map_Prod layers 0 (unplanned) / 1 (planned). */
export function normalizeNfPower(collection, { planned, nowMs }) {
  const fs = gj(collection);
  if (!fs) return null;
  const zone = PROVINCE_ZONES.NL;
  const rows = [];
  for (const f of fs) {
    const a = attrsOf(f);
    const id = a.ID ?? a.OBJECTID;
    if (id == null) continue;
    const startMs = parseZoned(planned ? a.TIME_BEGIN : a.TIME_OUTAGE, zone);
    const endMs = parseZoned(planned ? a.TIME_END : a.TIME_RESTORED_EST, zone);
    const kind = kindFor(planned, startMs, endMs, nowMs);
    if (!kind) continue;
    const point = pointOf(f) || (Number.isFinite(a.X) && Number.isFinite(a.Y) && Math.abs(a.X) <= 180 ? { lon: a.X, lat: a.Y } : null);
    const row = finish({
      stableId: `nfpower${planned ? '-planned' : ''}:${id}`,
      utility: 'nfpower',
      kind,
      customers: parseCount(a.CUSTOMER_COUNT),
      status: text(a.CREW_STATUS),
      cause: text(a.CAUSE) || (planned ? 'Planned work' : null),
      area: text(a.NLP_ALERT_REMARKS) || text(a.REMARKS),
      startMs,
      estRestoreMs: endMs,
      point,
      polygons: [],
    });
    if (row) rows.push(row);
  }
  return rows;
}

/** Alectra DEV_Outage_Layers: Cases (layer 1) + Outage Areas (layer 2). */
export function normalizeAlectra(cases, areas, nowMs) {
  const cs = gj(cases);
  const as = gj(areas);
  if (!cs || !as) return null;
  const areaBy = new Map();
  for (const f of as) {
    const key = String(attrsOf(f).CaseIDOnMap ?? '');
    if (!key) continue;
    if (!areaBy.has(key)) areaBy.set(key, []);
    areaBy.get(key).push(...geojsonPolygons(f.geometry));
  }
  const rows = [];
  for (const f of cs) {
    const a = attrsOf(f);
    if (a.ShowOnMap === 0) continue;
    const id = a.CaseIDOnMap ?? a.OBJECTID;
    if (id == null) continue;
    const isPlanned = PLANNED_RE.test(a.OutageCausePublic || '');
    const startMs = Number.isFinite(a.OutageTime) ? a.OutageTime : null;
    const estMs = Number.isFinite(a.EstRestoreTime) ? a.EstRestoreTime : null;
    const kind = isPlanned ? 'planned-active' : 'unplanned';
    const row = finish({
      stableId: `alectra:${id}`,
      utility: 'alectra',
      kind,
      customers: parseCount(a.CURCUST) ?? parseCount(a.INITCUST),
      cause: text(a.OutageCausePublic),
      area: text(a.PUBLICMSG),
      startMs,
      estRestoreMs: estMs,
      point: pointOf(f),
      polygons: areaBy.get(String(id)) || [],
    });
    if (row && !(estMs && estMs < nowMs - 6 * 3600_000 && isPlanned)) rows.push(row);
  }
  return rows;
}
