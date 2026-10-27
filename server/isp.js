import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/*
 * Internet providers at a point, from ISED's National Broadband Map (the
 * federal government's public map of where each provider says it offers
 * service, in ~25 km² hexagons). The map's own point lookup is used and
 * cached: provider footprints change a few times a year, not by the minute.
 */

const HEX_API = 'https://ised-isde.canada.ca/app/scr/sittibc/web/api/hexagon';
export const NBM_PAGE = 'https://ised-isde.canada.ca/app/scr/sittibc/web/bbmap?lang=eng#!/map';
const CACHE_TTL_MS = 30 * 24 * 3600_000;
const AREA_SAMPLES = 16;

/** ISED technology codes (from the map's own labels). */
export const TECH = Object.freeze({
  1: 'DSL',
  2: 'Cable',
  5: 'Fixed wireless',
  7: 'Satellite',
  8: 'Mobile',
  10: 'Fibre',
  11: 'Transport',
  12: 'Fibre transport',
  13: 'Microwave transport',
  14: 'Satellite transport',
  15: 'Cable transport',
});
const RETAIL = new Set([1, 2, 5, 7, 8, 10]);
const WIRED_RANK = { 10: 0, 2: 1, 1: 2, 5: 3, 7: 4, 8: 5 };

/*
 * Provider name → autonomous system numbers, for IODA's per-network signals.
 * Names as the National Broadband Map spells them; matched case-insensitively
 * on the start of the name.
 */
export const ISP_ASNS = Object.freeze([
  { match: /^bell mts/i, name: 'Bell MTS', asns: [7122] },
  { match: /^bell aliant/i, name: 'Bell Aliant', asns: [855] },
  { match: /^bell\b/i, name: 'Bell', asns: [577] },
  { match: /^rogers\b/i, name: 'Rogers', asns: [812] },
  { match: /^shaw\b/i, name: 'Shaw (Rogers)', asns: [6327] },
  { match: /^telus\b/i, name: 'Telus', asns: [852] },
  { match: /^sasktel\b/i, name: 'SaskTel', asns: [803] },
  { match: /^eastlink\b/i, name: 'Eastlink', asns: [11260] },
  { match: /^cogeco\b/i, name: 'Cogeco', asns: [7992] },
  { match: /^(xplore|xplornet)\b/i, name: 'Xplore', asns: [22995] },
  { match: /^teksavvy\b/i, name: 'TekSavvy', asns: [5645] },
  { match: /^distributel\b/i, name: 'Distributel', asns: [11814] },
  { match: /^(starlink|spacex)\b/i, name: 'Starlink', asns: [14593] },
]);

export function asnsFor(ispName) {
  const hit = ISP_ASNS.find((x) => x.match.test(String(ispName || '').trim()));
  return hit ? { name: hit.name, asns: hit.asns } : null;
}

/** Every ASN the dashboard watches (the big ones, plus any a site names). */
export function watchedAsns(sites = []) {
  const set = new Map();
  for (const x of ISP_ASNS) for (const a of x.asns) set.set(a, x.name);
  for (const s of sites) {
    const hit = asnsFor(s.isp);
    if (hit) for (const a of hit.asns) set.set(a, hit.name);
  }
  return set;
}

/** One hexagon response → {hexid, center, polygon, providers[]} with providers merged by name. */
export function summarizeHexagon(h) {
  if (!h || !Array.isArray(h.providers)) return null;
  const byName = new Map();
  for (const p of h.providers) {
    const name = String(p?.name || '').trim();
    if (!name) continue;
    const t = Number(p.providerType);
    let entry = byName.get(name.toLowerCase());
    if (!entry) {
      entry = { name, url: typeof p.url === 'string' && /^https?:\/\//.test(p.url) ? p.url : null, techs: [], speed: null, retail: false, rank: 9 };
      byName.set(name.toLowerCase(), entry);
    }
    if (TECH[t] && !entry.techs.includes(TECH[t])) entry.techs.push(TECH[t]);
    if (RETAIL.has(t)) {
      entry.retail = true;
      entry.rank = Math.min(entry.rank, WIRED_RANK[t] ?? 8);
    }
    if (p.speedTypeDesc && (!entry.speed || Number(p.speedType) > entry.speedType)) {
      entry.speed = p.speedTypeDesc;
      entry.speedType = Number(p.speedType) || 0;
    }
  }
  const providers = [...byName.values()]
    .map(({ speedType, ...e }) => ({ ...e, ioda: Boolean(asnsFor(e.name)) }))
    .sort((a, b) => Number(b.retail) - Number(a.retail) || a.rank - b.rank || a.name.localeCompare(b.name));
  let polygon = null;
  const coords = /<coordinates>([^<]+)<\/coordinates>/.exec(h.hexKml || '')?.[1];
  if (coords) polygon = coords.trim().split(/\s+/).map((pair) => pair.split(',').slice(0, 2).map(Number));
  return {
    hexid: h.hexid || null,
    center: Number.isFinite(h.hexLat) ? { lat: h.hexLat, lon: h.hexLon } : null,
    polygon,
    providers,
  };
}

export function createIspLookup({ request, dataDir, now = () => Date.now(), log = console }) {
  const file = path.join(dataDir, 'isp-cache.json');
  /** "lat,lon" rounded to ~1 km → {at, hex} */
  let cache = {};
  try {
    if (existsSync(file)) cache = JSON.parse(readFileSync(file, 'utf8')) || {};
  } catch {
    cache = {};
  }
  let dirty = false;
  let saveTimer = null;
  const save = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!dirty) return;
      dirty = false;
      try {
        const keys = Object.keys(cache);
        if (keys.length > 20_000) for (const k of keys.slice(0, keys.length - 20_000)) delete cache[k];
        writeFileSync(file, JSON.stringify(cache));
      } catch (error) {
        log.warn?.(`[isp] cache not saved: ${error.message}`);
      }
    }, 5000);
    saveTimer.unref?.();
  };
  const keyOf = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

  async function at(lat, lon) {
    const key = keyOf(lat, lon);
    const hit = cache[key];
    if (hit && now() - hit.at < CACHE_TTL_MS) return hit.hex;
    const raw = await request(`${HEX_API}?${new URLSearchParams({ la: lat.toFixed(6), lo: lon.toFixed(6), lang: 'en' })}`, {
      headers: { Referer: NBM_PAGE },
    });
    const hex = summarizeHexagon(raw);
    if (!hex) throw new Error('Unexpected broadband map response');
    cache[key] = { at: now(), hex };
    dirty = true;
    save();
    return hex;
  }

  /**
   * Providers across a map view: samples a grid (cached) and merges.
   * @param {[number, number, number, number]} bbox west, south, east, north
   */
  async function area([w, s, e, n]) {
    const cols = 4;
    const rows = Math.ceil(AREA_SAMPLES / cols);
    const points = [];
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < rows; j++) points.push([s + ((j + 0.5) / rows) * (n - s), w + ((i + 0.5) / cols) * (e - w)]);
    const hexes = new Map();
    const errors = [];
    for (let k = 0; k < points.length; k += 4) {
      const batch = await Promise.allSettled(points.slice(k, k + 4).map(([la, lo]) => at(la, lo)));
      for (const r of batch) {
        if (r.status === 'fulfilled' && r.value?.hexid) hexes.set(r.value.hexid, r.value);
        else if (r.status === 'rejected') errors.push(r.reason?.message);
      }
    }
    const tally = new Map();
    for (const h of hexes.values())
      for (const p of h.providers) {
        if (!p.retail) continue;
        const t = tally.get(p.name) || { name: p.name, url: p.url, techs: new Set(), hexes: 0, ioda: p.ioda };
        t.hexes += 1;
        for (const x of p.techs) t.techs.add(x);
        tally.set(p.name, t);
      }
    const providers = [...tally.values()]
      .map((t) => ({ ...t, techs: [...t.techs] }))
      .sort((a, b) => b.hexes - a.hexes || a.name.localeCompare(b.name));
    return { sampled: hexes.size, providers, hexes: [...hexes.values()], error: !hexes.size && errors.length ? errors[0] : null };
  }

  return { at, area };
}
