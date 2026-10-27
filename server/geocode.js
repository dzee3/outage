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
    province: PROVINCE_FROM_ISO[a['ISO3166-2-lvl4']] || null,
    precise: Boolean(a.house_number),
  };
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
  const cached = async (key, fn) => {
    if (cache.has(key)) return cache.get(key);
    const value = await throttled(fn);
    cache.set(key, value);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return value;
  };
  return {
    /** Free-text address → up to 5 Canadian matches. */
    search(q) {
      const query = String(q || '').trim().slice(0, 200);
      if (query.length < 3) return Promise.resolve([]);
      return cached(`s:${query.toLowerCase()}`, async () => {
        const list = await request(
          `${SEARCH}?${new URLSearchParams({ q: query, format: 'jsonv2', countrycodes: 'ca', addressdetails: '1', limit: '5' })}`,
          { headers: { 'Accept-Language': 'en' } },
        );
        return (Array.isArray(list) ? list : []).map(placeFrom).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      });
    },
    /** Map point → nearest address (null when none). */
    reverse(lat, lon) {
      const key = `r:${lat.toFixed(5)},${lon.toFixed(5)}`;
      return cached(key, async () => {
        const r = await request(
          `${REVERSE}?${new URLSearchParams({ lat: String(lat), lon: String(lon), format: 'jsonv2', addressdetails: '1', zoom: '18' })}`,
          { headers: { 'Accept-Language': 'en' } },
        );
        return r && !r.error ? placeFrom(r) : null;
      });
    },
  };
}
