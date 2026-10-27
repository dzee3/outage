import { normalizeKubraItem } from '../records-canada.js';

/*
 * Kubra "Storm Center" outage maps (Hydro One, Toronto Hydro, Hydro Ottawa,
 * Nova Scotia Power and many others) publish outages as quadkey map tiles.
 * Clustered tiles are expanded one zoom level at a time until each outage
 * appears on its own, the way the map does when you zoom in.
 */

const MAX_TILES_PER_POLL = 400;
const CONCURRENCY = 6;
const CRAWL_MAX_ZOOM = 14;

/** Slippy-map tile x/y for a lon/lat at zoom z. */
export function tileXY(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
}

export function quadkey(x, y, z) {
  let q = '';
  for (let i = z; i > 0; i--) {
    let d = 0;
    const m = 1 << (i - 1);
    if (x & m) d += 1;
    if (y & m) d += 2;
    q += d;
  }
  return q;
}

/** Quadkeys covering [south, west, north, east] at zoom z. */
export function quadkeysFor([s, w, n, e], z) {
  const [x0, y0] = tileXY(w, n, z);
  const [x1, y1] = tileXY(e, s, z);
  const out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(quadkey(x, y, z));
  return out;
}

/**
 * Breadth-first crawl: fetch tiles, keep non-cluster items, expand clusters.
 * @param {(qk: string) => Promise<object|null>} fetchTile null for "no tile"
 */
export async function crawlTiles(startKeys, fetchTile, maxZoom = CRAWL_MAX_ZOOM) {
  const items = new Map();
  let queue = [...new Set(startKeys)];
  let fetched = 0;
  let truncated = false;
  while (queue.length) {
    const batch = queue.splice(0, CONCURRENCY);
    const results = await Promise.all(batch.map(async (qk) => [qk, await fetchTile(qk)]));
    fetched += batch.length;
    for (const [qk, tile] of results) {
      for (const item of tile?.file_data || []) {
        if (item?.desc?.cluster) {
          if (qk.length < maxZoom) for (const d of '0123') queue.push(qk + d);
          continue;
        }
        const key = item?.geom?.p?.[0] || item?.id;
        if (key && !items.has(key)) items.set(key, item);
      }
    }
    if (fetched >= MAX_TILES_PER_POLL && queue.length) {
      truncated = true;
      break;
    }
    queue = [...new Set(queue)];
  }
  return { items: [...items.values()], fetched, truncated };
}

const missing = (error) => error?.status === 404 || error?.status === 403;

/** Find cluster layers in a v2 configuration: [{id, name}]. */
function clusterLayers(cfg) {
  const out = [];
  JSON.stringify(cfg, (k, v) => {
    if (v && typeof v === 'object' && v.type === 'CLUSTER_LAYER_V2' && v.id) out.push({ id: v.id, name: String(v.layerName || '') });
    return v;
  });
  return out;
}

/**
 * Current Kubra (kubra.io) storm centre.
 * @returns {{live: () => Promise<rows>, planned: () => Promise<rows>|null}}
 */
export function kubraV2({ request, now, utility, stormcenter, view, zone }) {
  const base = `https://kubra.io/stormcenter/api/v1/stormcenters/${stormcenter}/views/${view}/`;
  let cfg = null;
  let cfgFor = null;
  async function setup() {
    const state = await request(`${base}currentState?preview=false`);
    if (!state?.data) throw new Error('Kubra currentState has no data paths');
    const dep = state.stormcenterDeploymentId;
    if (!cfg || cfgFor !== dep) {
      cfg = await request(`${base}configuration/${dep}?preview=false`);
      cfgFor = dep;
    }
    const map = cfg?.config?.map || {};
    const [a, b, c, d] = map.allowedBBox || [];
    const bbox = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
    if (!bbox.every(Number.isFinite)) throw new Error('Kubra configuration has no map bounds');
    const layers = clusterLayers(cfg);
    return {
      state,
      bbox,
      minZoom: Math.max(4, Math.min(10, Number(map.minZoom) || 6)),
      unplannedLayer: layers.find((l) => !/planned/i.test(l.name))?.id || 'cluster-1',
      plannedLayer: layers.find((l) => /planned/i.test(l.name))?.id || null,
    };
  }
  async function crawl(template, layer, planned) {
    const s = await setup();
    const tpl = planned ? s.state.data.planned_outage_data : s.state.data.cluster_interval_generation_data;
    const layerId = planned ? s.plannedLayer : s.unplannedLayer;
    if (!tpl || !layerId) return [];
    const fetchTile = async (qk) => {
      const qkh = qk.slice(-3).split('').reverse().join('');
      try {
        return await request(`https://kubra.io/${tpl.replace('{qkh}', qkh)}/public/${layerId}/${qk}.json`);
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    };
    const { items } = await crawlTiles(quadkeysFor(s.bbox, s.minZoom), fetchTile);
    const nowMs = now();
    return items.map((item) => normalizeKubraItem(item, { utility, planned, nowMs, zone })).filter(Boolean);
  }
  return {
    live: () => crawl(null, null, false),
    planned: () => crawl(null, null, true),
  };
}

/**
 * Older iFactor/Kubra StormCenter deployments hosted on the utility's own
 * domain (e.g. outagemap.nspower.ca).
 */
export function kubraLegacy({ request, now, utility, host, bbox, minZoom = 6, zone }) {
  return async () => {
    const meta = await request(`${host}/resources/data/external/interval_generation_data/metadata.json`);
    if (!meta?.directory) throw new Error('StormCenter metadata has no directory');
    const dir = `${host}/resources/data/external/interval_generation_data/${meta.directory}`;
    const fetchTile = async (qk) => {
      try {
        return await request(`${dir}/outages/${qk}.json`);
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    };
    const { items } = await crawlTiles(quadkeysFor(bbox, minZoom), fetchTile);
    const nowMs = now();
    return items.map((item) => normalizeKubraItem(item, { utility, nowMs, zone })).filter(Boolean);
  };
}
