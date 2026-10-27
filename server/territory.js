import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pointInPolygons, polygonsOf } from './geo.js';
import { readDbf, readShpPolygons, ringArea, ringsToMultiPolygon, unzip } from './shapefile.js';
import { ldcDisplayName, ldcId, PROVINCE_DEFAULT, UTILITIES, utilityById } from './utilities.js';
import { USER_AGENT } from './http.js';

/*
 * Which utility supplies a point. In order of trust:
 *   1. a published service-area boundary that contains it
 *      (Ontario's OEB distributor map, FortisBC, Saskatoon L&P,
 *       Newfoundland Power)
 *   2. a municipal utility, matched on the address's city
 *   3. the province's main distributor (Alberta: ATCO or FortisAlberta,
 *      which publish no boundary, so that one is labelled a best guess)
 * The answer always comes with the province's other utilities so the
 * technician can correct it.
 *
 * Boundary files are downloaded by the server on first start and refreshed
 * weekly, cached in DATA_DIR/territory/.
 */

const REFRESH_MS = 7 * 24 * 3600_000;
const RETRY_MS = 3600_000;

const ONTARIO_PACKAGE = 'https://data.ontario.ca/api/3/action/package_show?id=ontario-ldc-boundaries-map';
const ONTARIO_FALLBACK_ZIP =
  'https://data.ontario.ca/dataset/ca5c6df5-ca15-4005-be33-c75fcf9bc7e8/resource/42cb3659-8d6a-4a77-b0e5-a9c32736169f/download/energy_ldc_service_boundaries_20240930.zip';

/** "polygon, color=…" header lines, then "lon,lat" lines (FortisBC, SL&P maps). */
export function parseServiceAreaText(textBody) {
  const polygons = [];
  let ring = null;
  for (const raw of String(textBody || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^polygon/i.test(line)) {
      if (ring?.length >= 4) polygons.push([ring]);
      ring = [];
      continue;
    }
    const m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (m && ring) ring.push([Number(m[1]), Number(m[2])]);
  }
  if (ring?.length >= 4) polygons.push([ring]);
  for (const [r] of polygons) {
    const [a, b] = [r[0], r[r.length - 1]];
    if (a[0] !== b[0] || a[1] !== b[1]) r.push(a);
  }
  return polygons;
}

/** Ontario OEB LDC boundary ZIP → features [{id, name, polygons}]. */
export function parseOntarioLdcZip(buf) {
  const files = unzip(buf);
  const pick = (ext) => [...files.entries()].find(([n]) => n.toLowerCase().endsWith(ext))?.[1];
  const shp = pick('.shp');
  const dbf = pick('.dbf');
  if (!shp || !dbf) throw new Error('LDC zip has no .shp/.dbf');
  const prj = pick('.prj')?.toString('utf8') || '';
  if (prj && !/GCS_WGS_1984|GCS_North_American_1983|WGS 84|NAD83/i.test(prj)) throw new Error('LDC boundaries are not in latitude/longitude');
  const shapes = readShpPolygons(shp);
  const records = readDbf(dbf);
  const features = [];
  shapes.forEach((rings, i) => {
    const name = records[i]?.LDC || records[i]?.EDName;
    if (!name || !rings.length) return;
    const polygons = ringsToMultiPolygon(rings, 0.0004);
    if (polygons.length) features.push({ id: ldcId(name), name: ldcDisplayName(name), polygons });
  });
  return features;
}

const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^(city|town|village|municipality|district) of\s+/, '')
    .trim();

/** Alberta has no published ATCO/Fortis boundary: a rough split, flagged as a guess. */
function albertaGuess({ lat, lon }) {
  if (lat >= 55) return 'atco';
  if (lon > -112.6 && lat >= 51.3) return 'atco'; // east-central: Vegreville, Wainwright, Drumheller, Hanna
  return 'fortis';
}

export function createTerritory({ dataDir, requestRaw, requestJson, now = () => Date.now(), log = console }) {
  const dir = path.join(dataDir, 'territory');
  mkdirSync(dir, { recursive: true });
  /** id → {id, name, province, polygons, from} */
  const layers = new Map();
  const status = {};
  let refreshing = null;

  const cacheFile = (key) => path.join(dir, `${key}.json`);
  function loadCached(key) {
    try {
      if (!existsSync(cacheFile(key))) return null;
      return JSON.parse(readFileSync(cacheFile(key), 'utf8'));
    } catch {
      return null;
    }
  }
  function install(key, features, at) {
    for (const [id, layer] of layers) if (layer.from === key) layers.delete(id);
    for (const f of features) {
      const existing = layers.get(f.id);
      if (existing) {
        existing.polygons.push(...f.polygons);
        existing.area = undefined;
      }
      else layers.set(f.id, { ...f, from: key });
    }
    status[key] = { ok: true, features: features.length, updatedAt: at };
  }

  const datasets = {
    ontario: async () => {
      let zipUrl = ONTARIO_FALLBACK_ZIP;
      try {
        const pkg = await requestJson(ONTARIO_PACKAGE);
        const res = (pkg?.result?.resources || []).find((r) => /\.zip$/i.test(r.url || '') || /zip/i.test(r.format || ''));
        if (res?.url) zipUrl = res.url;
      } catch {
        /* the known file URL still works */
      }
      const r = await fetch(zipUrl, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`Ontario LDC download HTTP ${r.status}`);
      return parseOntarioLdcZip(Buffer.from(await r.arrayBuffer())).map((f) => ({ ...f, province: 'ON' }));
    },
    fortisbc: async () => {
      const r = await requestRaw('https://outages.fortisbc.com/Outages/Content/Configuration/service_area.txt');
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const polygons = parseServiceAreaText(r.text);
      if (!polygons.length) throw new Error('no polygons');
      return [{ id: 'fortisbc', name: 'FortisBC', province: 'BC', polygons }];
    },
    slp: async () => {
      const r = await requestRaw('https://outages.saskatoon.ca/Outages/Content/Configuration/service_area.txt');
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const polygons = parseServiceAreaText(r.text);
      if (!polygons.length) throw new Error('no polygons');
      return [{ id: 'slp', name: 'Saskatoon Light & Power', province: 'SK', polygons }];
    },
    nfpower: async () => {
      const fc = await requestJson(
        'https://services1.arcgis.com/X4jBywOcHsB7HKqU/arcgis/rest/services/Public_Outage_Map_Prod/FeatureServer/3/query?' +
          new URLSearchParams({ where: '1=1', outFields: 'Title', returnGeometry: 'true', outSR: '4326', maxAllowableOffset: '0.002', f: 'geojson' }),
      );
      const polygons = (fc?.features || []).flatMap((f) => polygonsOf(f.geometry));
      if (!polygons.length) throw new Error('no polygons');
      return [{ id: 'nfpower', name: 'Newfoundland Power', province: 'NL', polygons }];
    },
  };

  // Start from whatever was cached last time.
  for (const key of Object.keys(datasets)) {
    const cached = loadCached(key);
    if (cached?.features) install(key, cached.features, cached.updatedAt);
  }

  async function refresh(force = false) {
    refreshing ??= (async () => {
      for (const [key, load] of Object.entries(datasets)) {
        const s = status[key];
        const due = force || !s?.updatedAt || now() - s.updatedAt > REFRESH_MS;
        const retry = !s?.ok && (!s?.triedAt || now() - s.triedAt > RETRY_MS);
        if (!due && !retry) continue;
        try {
          const features = await load();
          const at = now();
          writeFileSync(cacheFile(key), JSON.stringify({ updatedAt: at, features }));
          install(key, features, at);
        } catch (error) {
          status[key] = { ...(status[key] || {}), ok: Boolean(status[key]?.features), triedAt: now(), error: String(error.message || error).slice(0, 200) };
          log.warn?.(`[territory] ${key}: ${error.message}`);
        }
      }
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /** Utilities a technician can choose from for a province. */
  function options(province) {
    const list = UTILITIES.filter((u) => u.province === province).map((u) => ({ id: u.id, name: u.name, monitored: Boolean(u.source) }));
    if (province === 'ON')
      for (const l of layers.values())
        if (l.province === 'ON' && !list.some((u) => u.id === l.id)) list.push({ id: l.id, name: l.name, monitored: Boolean(utilityById(l.id)?.source) });
    return list.sort((a, b) => Number(b.monitored) - Number(a.monitored) || a.name.localeCompare(b.name));
  }

  /**
   * @param {{lat: number, lon: number, province: string|null, city?: string}} where
   * @returns {{id, name, monitored, source, confidence: 'boundary'|'city'|'province'|'guess'|'none', options}}
   */
  function lookup({ lat, lon, province, city }) {
    const point = { lat, lon };
    const answer = (id, confidence, name) => {
      const u = utilityById(id);
      const layer = layers.get(id);
      return {
        id,
        name: name || u?.name || layer?.name || id,
        monitored: Boolean(u?.source),
        source: u?.source || null,
        confidence,
        options: province ? options(province) : [],
      };
    };
    if (!province) return { id: null, name: null, monitored: false, source: null, confidence: 'none', options: [] };
    // Smallest containing boundary wins (Saskatoon L&P inside SaskPower's province, etc.).
    let best = null;
    for (const l of layers.values()) {
      if (l.province !== province) continue;
      if (!pointInPolygons(point, l.polygons)) continue;
      l.area ??= l.polygons.reduce((a, p) => a + Math.abs(ringArea(p[0])), 0);
      const size = l.area;
      if (!best || size < best.size) best = { id: l.id, name: l.name, size };
    }
    if (best) return answer(best.id, 'boundary', best.name);
    const c = fold(city);
    if (c) {
      const municipal = UTILITIES.find((u) => u.province === province && u.cities?.some((x) => fold(x) === c));
      if (municipal) return answer(municipal.id, 'city');
    }
    if (province === 'AB') return answer(albertaGuess(point), 'guess');
    if (province === 'NL') return answer('nlhydro', layers.has('nfpower') ? 'province' : 'guess');
    if (PROVINCE_DEFAULT[province]) return answer(PROVINCE_DEFAULT[province], province === 'ON' && !layers.size ? 'guess' : 'province');
    return { id: null, name: null, monitored: false, source: null, confidence: 'none', options: options(province) };
  }

  /** Boundaries for the map overlay. */
  function geojson() {
    return {
      type: 'FeatureCollection',
      features: [...layers.values()].map((l) => ({
        type: 'Feature',
        properties: { id: l.id, name: l.name, province: l.province, monitored: Boolean(utilityById(l.id)?.source) },
        geometry: { type: 'MultiPolygon', coordinates: l.polygons },
      })),
    };
  }

  return { refresh, lookup, options, geojson, status: () => ({ ...status }) };
}
