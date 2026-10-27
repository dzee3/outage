/*
 * Addresses ⇄ map points, via OpenStreetMap's Nominatim. Its usage policy
 * asks for at most one request a second, an identifying User-Agent, caching,
 * and attribution (shown in the add-client panel). Adding client sites is
 * occasional, so a small queue and cache are plenty.
 */

const SEARCH = 'https://nominatim.openstreetmap.org/search';
const REVERSE = 'https://nominatim.openstreetmap.org/reverse';
const CACHE_MAX = 500;

const PROVINCE_FROM_ISO = {
  'CA-AB': 'AB', 'CA-BC': 'BC', 'CA-MB': 'MB', 'CA-NB': 'NB', 'CA-NL': 'NL', 'CA-NS': 'NS',
  'CA-NT': 'NT', 'CA-NU': 'NU', 'CA-ON': 'ON', 'CA-PE': 'PE', 'CA-QC': 'QC', 'CA-SK': 'SK', 'CA-YT': 'YT',
};

/** Nominatim result → the fields the dashboard uses. */
export function placeFrom(r) {
  const a = r?.address || {};
  const city = a.city || a.town || a.village || a.municipality || a.hamlet || a.county || null;
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const short = [street || a.neighbourhood || a.suburb || null, city, PROVINCE_FROM_ISO[a['ISO3166-2-lvl4']] || a.state || null, a.postcode || null]
    .filter(Boolean)
    .join(', ');
  return {
    label: short || r?.display_name || '',
    full: r?.display_name || '',
    lat: Number(r?.lat),
    lon: Number(r?.lon),
    city,
    area: a.neighbourhood || a.suburb || a.quarter || a.city_district || null,
    province: PROVINCE_FROM_ISO[a['ISO3166-2-lvl4']] || null,
    precise: Boolean(a.house_number),
    // What the point stands for: a building, a road, a town… Anything but a
    // building is approximate, and two clients in one town would share it.
    kind: a.house_number ? 'address' : r?.addresstype || r?.type || 'place',
  };
}

const POSTCODE = /\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/gi;

/**
 * Drop what Nominatim can't match: unit numbers ("#4", "Suite 102",
 * "102-541 Kingsview Way") stop it finding the building at all.
 */
export function cleanAddress(q) {
  return String(q || '')
    .replace(/#\s*[\w-]+/g, ' ')
    .replace(/\b(?:unit|suite|ste|apt|apartment|bay|room|rm|floor|fl)\.?\s*#?\s*[\w-]+\b/gi, ' ')
    .replace(/^\s*[a-z]?\d+[a-z]?\s*-\s*(?=\d)/i, '')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,+/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '');
}

/** The original query, then simpler versions to try when it doesn't find the building. */
export function queryVariants(q) {
  const cleaned = cleanAddress(q);
  const noPostcode = cleaned.replace(POSTCODE, ' ').replace(/\s+,/g, ',').replace(/,\s*,+/g, ',').replace(/\s{2,}/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '');
  return [...new Set([q, cleaned, noPostcode].filter((v) => v.length >= 3))];
}

export function createGeocoder({ request, minIntervalMs = 1100 }) {
  const cache = new Map();
  let chain = Promise.resolve();
  let last = 0;
  const throttled = (fn) => {
    const run = chain.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };
  // The cache wraps whole lookups; each request inside is throttled on its own.
  const cached = async (key, fn) => {
    if (cache.has(key)) return cache.get(key);
    const value = await fn();
    cache.set(key, value);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return value;
  };
  return {
    /**
     * Free-text address → up to 5 Canadian matches. When the address as typed
     * doesn't find a building, simpler versions (no unit, no postal code) are
     * tried, so a suite number doesn't leave the client pinned to the town.
     */
    search(q) {
      const query = String(q || '').trim().slice(0, 200);
      if (query.length < 3) return Promise.resolve([]);
      return cached(`s:${query.toLowerCase()}`, async () => {
        let fallback = [];
        for (const variant of queryVariants(query)) {
          const list = await throttled(() =>
            request(
              `${SEARCH}?${new URLSearchParams({ q: variant, format: 'jsonv2', countrycodes: 'ca', addressdetails: '1', limit: '5' })}`,
              { headers: { 'Accept-Language': 'en' } },
            ),
          );
          const places = (Array.isArray(list) ? list : []).map(placeFrom).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
          if (places.some((p) => p.precise)) return places;
          if (!fallback.length) fallback = places;
        }
        return fallback;
      });
    },
    /** Map point → nearest address (null when none). */
    reverse(lat, lon) {
      const key = `r:${lat.toFixed(5)},${lon.toFixed(5)}`;
      return cached(key, async () => {
        const r = await throttled(() => request(
          `${REVERSE}?${new URLSearchParams({ lat: String(lat), lon: String(lon), format: 'jsonv2', addressdetails: '1', zoom: '18' })}`,
          { headers: { 'Accept-Language': 'en' } },
        ));
        return r && !r.error ? placeFrom(r) : null;
      });
    },
  };
}
