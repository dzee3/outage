/*
 * Addresses ⇄ map points for the search boxes and the add-client panel.
 *
 * People paste addresses straight off company websites ("Marex Canada
 * Limited\n541 Kingsview Way SE #102\nAirdrie, AB T4A 0C9\nCanada"), type a
 * bare postal code, or type a business name. No single free geocoder handles
 * all of that in Canada, so a search asks several and merges the answers:
 *
 *   Photon (photon.komoot.io)       OpenStreetMap, typo-tolerant, finds
 *                                   businesses by name and partial text.
 *   Nominatim (OpenStreetMap)       structured street + city search, exact
 *                                   house numbers, reverse lookups.
 *   NRCan Geolocator (geo.ca)       street addresses estimated along the
 *                                   national road network when OSM has no
 *                                   house number; postal areas (first three
 *                                   characters of a postal code).
 *
 * Full postal codes aren't open data in Canada, so a postal code resolves to
 * its area (or the exact code when OSM has it) and the nearest real address
 * there is offered as the suggestion.
 *
 * Each service gets its own polite request rate; Nominatim's policy is one
 * request a second, an identifying User-Agent, caching and attribution.
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const PHOTON = 'https://photon.komoot.io/api/';
const GEOLOCATOR = 'https://geolocator.api.geo.ca/';
const CANADA_BBOX = '-141.1,41.6,-52.5,83.2';
const CACHE_MAX = 500;
const MAX_RESULTS = 6;

const PROVINCES = {
  AB: ['alberta', 'alta'],
  BC: ['british columbia', 'b.c.', 'bc'],
  MB: ['manitoba', 'man'],
  NB: ['new brunswick', 'n.b.'],
  NL: ['newfoundland and labrador', 'newfoundland', 'nfld'],
  NS: ['nova scotia', 'n.s.'],
  NT: ['northwest territories', 'n.w.t.', 'nwt'],
  NU: ['nunavut'],
  ON: ['ontario', 'ont'],
  PE: ['prince edward island', 'p.e.i.', 'pei'],
  QC: ['quebec', 'québec', 'que', 'qué', 'pq'],
  SK: ['saskatchewan', 'sask'],
  YT: ['yukon', 'yukon territory'],
};
const PROVINCE_NAMES = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island',
  QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
};
const PROVINCE_LOOKUP = new Map();
for (const [code, names] of Object.entries(PROVINCES)) {
  PROVINCE_LOOKUP.set(code.toLowerCase(), code);
  for (const n of names) PROVINCE_LOOKUP.set(n.replace(/\.$/, ''), code);
}
const PROVINCE_FROM_ISO = Object.fromEntries(Object.keys(PROVINCES).map((c) => [`CA-${c}`, c]));
/** "Alberta", "AB", "Alta." → "AB" (null when it isn't a province). */
export function provinceCode(text) {
  if (!text) return null;
  return PROVINCE_LOOKUP.get(String(text).trim().toLowerCase().replace(/\.$/, '')) || null;
}

const PROVINCE_PATTERN = [...PROVINCE_LOOKUP.keys()]
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/[.]/g, '\\.?'))
  .join('|');
const TRAILING_PROVINCE = new RegExp(`(?:^|[\\s,])(${PROVINCE_PATTERN})\\.?\\s*$`, 'i');
const POSTCODE = /\b([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPR-TV-Z])[ -]?(\d[ABCEGHJ-NPR-TV-Z]\d)\b/i;
const FSA_ONLY = /^\s*([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPR-TV-Z])\s*$/i;
const UNIT_SEGMENT = /^(?:#|unit\b|suite\b|ste\b|apt\b|apartment\b|bay\b|room\b|rm\b|floor\b|fl\b|\d+(?:st|nd|rd|th) floor\b|po box\b|p\.o\. box\b|attn\b)/i;
const STREET_START = /^\d+[a-z]?\s+\S/i;

/**
 * Drop what geocoders can't match: unit numbers ("#4", "Suite 102",
 * "102-541 Kingsview Way") stop them finding the building at all.
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

const tidy = (s) => s.replace(/\s+,/g, ',').replace(/,\s*,+/g, ',').replace(/\s{2,}/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '');

/**
 * Whatever was pasted or typed → its parts. Company names, phone numbers,
 * emails, links, unit numbers and "Canada" are dropped; the postal code and
 * province are pulled out.
 * @returns {{text: string, street: string|null, house: string|null, city: string|null,
 *            province: string|null, postcode: string|null, fsa: string|null, postalOnly: boolean}}
 */
export function parseAddress(input) {
  let s = String(input || '')
    .slice(0, 400)
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
    .replace(/\b(?:tel|phone|ph|fax|toll[- ]free)\s*[:.]?\s*(?=[+(\d])|\b[tf]\s*[:.]\s*(?=[+(\d])/gi, ' ')
    .replace(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, ' ')
    .replace(/[\r\n\t|•·;]+/g, ', ')
    // The country, not "Marex Canada Limited".
    .replace(/(?:^|,)\s*canada\s*(?=,|$)/gi, ',')
    .replace(/\s+canada\s*$/i, '')
    .replace(/\b([NS])\.\s?([EW])\.?(?=[\s,]|$)/g, '$1$2');

  let postcode = null;
  const pc = POSTCODE.exec(s);
  if (pc) {
    postcode = `${pc[1]} ${pc[2]}`.toUpperCase();
    s = s.replace(pc[0], ' ');
  }
  const fsaOnly = FSA_ONLY.exec(s);
  if (!postcode && fsaOnly) {
    return { text: fsaOnly[1].toUpperCase(), plain: '', street: null, house: null, city: null, province: null, postcode: null, fsa: fsaOnly[1].toUpperCase(), postalOnly: true };
  }

  let province = null;
  let segments = s.split(',').map((x) => x.trim()).filter(Boolean);
  segments = segments
    .map((seg) => {
      const whole = provinceCode(seg);
      if (whole) {
        province ??= whole;
        return '';
      }
      const m = TRAILING_PROVINCE.exec(seg);
      // "Airdrie AB" → city + province; "1015 4 St SW Calgary AB" keeps its street.
      if (m && provinceCode(m[1]) && seg.slice(0, m.index).trim().split(/\s+/).length >= (STREET_START.test(seg) ? 3 : 1)) {
        province ??= provinceCode(m[1]);
        return seg.slice(0, m.index).trim();
      }
      return seg;
    })
    .filter((seg) => seg && !UNIT_SEGMENT.test(seg));

  const streetAt = segments.findIndex((seg) => STREET_START.test(cleanAddress(seg)));
  let street = null;
  let city = null;
  if (streetAt >= 0) {
    street = cleanAddress(segments[streetAt]);
    city = segments[streetAt + 1] ? tidy(segments[streetAt + 1]) : null;
    segments = [street, ...(city ? [city] : [])];
  } else segments = segments.map(cleanAddress).filter(Boolean);

  const house = street ? /^(\d+[a-z]?)\b/i.exec(street)[1] : null;
  const text = tidy([...segments, province ? PROVINCE_NAMES[province] : null, postcode].filter(Boolean).join(', '));
  return {
    text,
    // Postal codes trip up free-text search; the code is used separately.
    plain: tidy([...segments, province ? PROVINCE_NAMES[province] : null].filter(Boolean).join(', ')),
    street,
    house,
    city,
    province,
    postcode,
    fsa: postcode ? postcode.slice(0, 3) : null,
    postalOnly: Boolean(postcode) && !segments.length,
  };
}

/** Kept for callers that only want the cleaned free-text version. */
export function queryVariants(q) {
  const cleaned = cleanAddress(q);
  const noPostcode = tidy(cleaned.replace(new RegExp(POSTCODE.source, 'gi'), ' '));
  return [...new Set([q, cleaned, noPostcode].filter((v) => v.length >= 3))];
}

const join = (...parts) => parts.filter(Boolean).join(', ');

/** Nominatim result → the fields the dashboard uses. */
export function placeFrom(r) {
  const a = r?.address || {};
  const city = a.city || a.town || a.village || a.municipality || a.hamlet || a.county || null;
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const province = PROVINCE_FROM_ISO[a['ISO3166-2-lvl4']] || provinceCode(a.state) || null;
  const name = r?.name && r.name !== a.road && r.name !== city && r.name !== a.house_number ? r.name : null;
  const short = join(name && street ? name : null, street || name || a.neighbourhood || a.suburb || null, city, province || a.state || null, a.postcode || null);
  return {
    label: short || r?.display_name || '',
    full: r?.display_name || '',
    lat: Number(r?.lat),
    lon: Number(r?.lon),
    city,
    area: a.neighbourhood || a.suburb || a.quarter || a.city_district || null,
    province,
    postcode: a.postcode || null,
    houseNumber: a.house_number || null,
    precise: Boolean(a.house_number),
    // What the point stands for: a building, a road, a town… Anything but a
    // building is approximate, and two clients in one town would share it.
    kind: a.house_number ? 'address' : r?.addresstype || r?.type || 'place',
    source: 'osm',
  };
}

/** Photon GeoJSON feature → the same fields. */
export function placeFromPhoton(f) {
  const p = f?.properties || {};
  const [lon, lat] = f?.geometry?.coordinates || [];
  const city = p.city || p.town || p.village || p.locality || p.county || null;
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const province = provinceCode(p.state);
  const isPlaceName = p.name && p.name !== p.street && p.name !== city && p.name !== p.housenumber;
  const named = isPlaceName && (street || p.osm_key !== 'place') ? p.name : null;
  const kind = p.housenumber ? 'address' : p.type === 'house' ? 'place' : p.type || p.osm_value || 'place';
  const label = join(named, street || (!named ? p.name : null) || p.district || null, city !== p.name || street ? city : null, province || p.state || null, p.postcode || null);
  return {
    label: label || p.name || '',
    full: join(p.name, street, p.district, city, p.state, p.postcode, p.country),
    lat: Number(lat),
    lon: Number(lon),
    city,
    area: p.district || p.locality || null,
    province,
    postcode: p.postcode || null,
    houseNumber: p.housenumber || null,
    precise: Boolean(p.housenumber),
    kind,
    countryCode: (p.countrycode || '').toUpperCase(),
    source: 'osm',
  };
}

/** NRCan Geolocator result → the same fields. */
export function placeFromGeolocator(r) {
  const name = String(r?.name || '');
  const category = String(r?.category || '');
  const tags = (Array.isArray(r?.tag) ? r.tag : [r?.tag]).filter(Boolean).map(String);
  const province = provinceCode(r?.province);
  const postal = /postal|fsa/i.test(category) || r?.key === 'fsa';
  const address = !postal && STREET_START.test(name);
  return {
    label: postal ? `${name.toUpperCase()} postal area` : join(name, province && !name.includes(province) ? province : null),
    full: join(name, r?.province),
    lat: Number(r?.lat),
    lon: Number(r?.lng ?? r?.lon),
    city: null,
    area: null,
    province,
    postcode: postal ? name.toUpperCase() : null,
    houseNumber: address ? /^(\d+[a-z]?)/i.exec(name)[1] : null,
    // Estimated along the road network: within a block, good enough to pin.
    precise: address,
    kind: postal ? 'postal-area' : address ? (tags.some((t) => /interpolat/i.test(t)) ? 'estimated' : 'address') : category.toLowerCase() || 'place',
    source: 'nrcan',
  };
}

const KIND_RANK = { address: 0, estimated: 1, nearest: 2, road: 3, street: 3, postcode: 4, 'postal-area': 5 };
const valid = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.label;

/** Best first: the right house number, then any building, streets, areas. */
export function rankPlaces(list, parsed = {}) {
  const score = (p, i) => {
    let s = KIND_RANK[p.kind] ?? 6;
    if (parsed.house && p.houseNumber && p.houseNumber.toLowerCase() !== parsed.house.toLowerCase()) s += 2.5;
    if (parsed.province && p.province && p.province !== parsed.province) s += 4;
    if (parsed.city && p.city && !p.city.toLowerCase().includes(parsed.city.toLowerCase().split(/\s+/)[0])) s += 1.5;
    return s + i / 1000;
  };
  const sorted = list.filter(valid).map((p, i) => [score(p, i), p]).sort((a, b) => a[0] - b[0]).map(([, p]) => p);
  // One entry per spot: the same building from two sources shows once.
  const out = [];
  for (const p of sorted) {
    const k = Math.cos((p.lat * Math.PI) / 180);
    const dup = out.some((q) => Math.hypot((q.lat - p.lat) * 111_320, (q.lon - p.lon) * 111_320 * k) < (p.precise ? 40 : 400) && q.precise === p.precise && (p.precise || q.kind === p.kind));
    if (!dup) out.push(p);
  }
  return out.slice(0, MAX_RESULTS);
}

export function createGeocoder({ request, minIntervalMs = 1100, log = console }) {
  const cache = new Map();

  /** One queue per service, so each keeps to its own request rate. */
  const queue = (gapMs) => {
    let chain = Promise.resolve();
    let last = 0;
    return (fn) => {
      const run = chain.then(async () => {
        const wait = last + gapMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        return fn();
      });
      chain = run.catch(() => {});
      return run;
    };
  };
  const nominatimQueue = queue(minIntervalMs);
  const photonQueue = queue(Math.min(minIntervalMs, 250));
  const nrcanQueue = queue(Math.min(minIntervalMs, 150));

  const cached = async (key, fn) => {
    if (cache.has(key)) return cache.get(key);
    const value = await fn();
    // An empty answer may just be a service hiccup; ask again next time.
    if (value == null || (Array.isArray(value) && !value.length)) return value;
    cache.set(key, value);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return value;
  };
  const quietly = (name) => (error) => {
    log?.warn?.(`geocode: ${name} failed: ${error.message}`);
    return [];
  };
  const headers = { 'Accept-Language': 'en' };

  const nominatim = (params) =>
    nominatimQueue(() =>
      request(`${NOMINATIM}/search?${new URLSearchParams({ format: 'jsonv2', countrycodes: 'ca', addressdetails: '1', limit: '5', ...params })}`, { headers, timeoutMs: 8000 }),
    ).then((list) => (Array.isArray(list) ? list.map(placeFrom) : []), quietly('Nominatim'));

  const photon = (q) =>
    photonQueue(() => request(`${PHOTON}?${new URLSearchParams({ q, lang: 'en', limit: '8', bbox: CANADA_BBOX })}`, { headers, timeoutMs: 6000 })).then(
      (r) => (Array.isArray(r?.features) ? r.features.map(placeFromPhoton).filter((p) => !p.countryCode || p.countryCode === 'CA') : []),
      quietly('Photon'),
    );

  const geolocator = (q, keys) =>
    nrcanQueue(() => request(`${GEOLOCATOR}?${new URLSearchParams({ q, lang: 'en', keys })}`, { timeoutMs: 6000 })).then(
      (list) => (Array.isArray(list) ? list.map(placeFromGeolocator) : []),
      quietly('NRCan Geolocator'),
    );

  const reverse = (lat, lon) =>
    cached(`r:${lat.toFixed(5)},${lon.toFixed(5)}`, async () => {
      const r = await nominatimQueue(() =>
        request(`${NOMINATIM}/reverse?${new URLSearchParams({ lat: String(lat), lon: String(lon), format: 'jsonv2', addressdetails: '1', zoom: '18' })}`, { headers, timeoutMs: 8000 }),
      );
      return r && !r.error ? placeFrom(r) : null;
    });

  /** Postal code (or its first three characters) → the area, plus the nearest real address there. */
  const postal = async (parsed) => {
    const found = [];
    if (parsed.postcode) {
      const exact = (await nominatim({ postalcode: parsed.postcode, country: 'Canada' })).filter((p) => p.postcode?.replace(/\s/g, '') === parsed.postcode.replace(/\s/g, ''));
      for (const p of exact) found.push({ ...p, label: `${parsed.postcode}${p.city ? `, ${p.city}` : ''}`, kind: 'postcode' });
    }
    if (!found.length) found.push(...(await geolocator(parsed.fsa, 'fsa')).filter(valid));
    const centre = found[0];
    if (!centre) return [];
    const near = await reverse(centre.lat, centre.lon).catch(quietly('Nominatim reverse'));
    const suggestions = [];
    if (near && valid(near) && near.precise)
      suggestions.push({ ...near, kind: 'nearest', precise: false, label: `Near ${parsed.postcode || parsed.fsa}: ${near.label}`, address: near.label, postcode: near.postcode || parsed.postcode });
    return [...suggestions, ...found];
  };

  return {
    parse: parseAddress,
    /**
     * Pasted or typed text → up to 6 Canadian matches, best first. Each has
     * `precise` (a building) and `kind` (address, estimated, nearest, road,
     * postcode, postal-area, city…).
     */
    search(q) {
      const parsed = parseAddress(String(q || '').trim());
      if (parsed.text.length < 3) return Promise.resolve([]);
      return cached(`s:${parsed.text.toLowerCase()}`, async () => {
        if (parsed.postalOnly) return rankPlaces(await postal(parsed), parsed);

        const fromPhoton = photon(parsed.plain);
        const structured = parsed.street && parsed.city
          ? nominatim({ street: parsed.street, city: parsed.city, ...(parsed.province ? { state: PROVINCE_NAMES[parsed.province] } : {}), country: 'Canada' })
          : nominatim({ q: parsed.plain });
        let places = [...(await structured), ...(await fromPhoton)];
        const hasHouse = () => places.some((p) => p.precise && (!parsed.house || p.houseNumber?.toLowerCase() === parsed.house.toLowerCase()));

        if (parsed.street && !hasHouse()) {
          // OSM often lacks house numbers in Canada; the national road network estimates them.
          const where = parsed.street + (parsed.city ? `, ${parsed.city}` : '') + (parsed.province ? `, ${parsed.province}` : '');
          places.push(...(await geolocator(where, 'locate')));
          if (!hasHouse() && parsed.city) places.push(...(await nominatim({ q: parsed.plain })));
        }
        if (parsed.postcode && !places.some((p) => p.precise)) places.push(...(await postal(parsed)));
        return rankPlaces(places, parsed);
      });
    },
    /** Map point → nearest address (null when none). */
    reverse,
  };
}
