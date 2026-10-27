import { distanceKm, pointInPolygons } from './geo.js';
import { closeRing, validRing } from './records.js';
import { PROVINCE_ZONES, zonedToUtc } from './zones.js';

/*
 * Internet-provider outage notices, read from each provider's own public
 * outage page, and matched to client sites by place.
 *
 *   Telus      national JSON feed with outage cells and radii   → by location
 *   Rogers     per-province notices naming city + neighbourhoods → by name,
 *   (Shaw)     and by distance to the geocoded neighbourhood
 *   TekSavvy   public Google My Maps layer                       → by location
 *   SaskTel    text list of reported outages                     → by city
 *
 * Bell's address check sits behind a CAPTCHA and is not automated; Bell
 * clients get a link to it. Providers without a public page rely on IODA's
 * network signals instead.
 */

const TTL_MS = 5 * 60_000;
const STALE_DROP_MS = 45 * 60_000;
const AREA_MATCH_KM = 2.5;
const POINT_MATCH_KM = 3;
const PROVINCES = ['BC', 'AB', 'SK', 'MB', 'ON', 'NB', 'NS', 'PE', 'NL'];
const PROVINCE_NAMES = {
  BC: 'British Columbia', AB: 'Alberta', SK: 'Saskatchewan', MB: 'Manitoba', ON: 'Ontario',
  NB: 'New Brunswick', NS: 'Nova Scotia', PE: 'Prince Edward Island', NL: 'Newfoundland and Labrador',
};

export const PROVIDER_PAGES = Object.freeze({
  telus: { name: 'Telus', page: 'https://www.telus.com/en/outages' },
  rogers: { name: 'Rogers / Shaw', page: 'https://www.rogers.com/support/outage' },
  teksavvy: { name: 'TekSavvy', page: 'https://www.teksavvy.com/network-status/' },
  sasktel: { name: 'SaskTel', page: 'https://www.sasktel.com/wps/wcm/connect/content/home/reported+outages' },
  bell: { name: 'Bell', page: 'https://support.bell.ca/outage-check', manual: 'Bell checks outages by address behind a CAPTCHA, so it cannot be checked automatically.' },
  eastlink: { name: 'Eastlink', page: 'https://www.eastlink.ca/support', manual: 'Eastlink publishes no public outage map.' },
  cogeco: { name: 'Cogeco', page: 'https://support.cogeco.ca/hc/en-ca/articles/360062803733', manual: 'Cogeco shows outages only after signing in.' },
  xplore: { name: 'Xplore', page: 'https://www.xplore.ca/support/', manual: 'Xplore publishes no public outage map.' },
});

/** Which provider page covers a client's ISP name. */
export function providerKey(isp) {
  const s = String(isp || '').trim().toLowerCase();
  if (!s) return null;
  if (/^(rogers|shaw|fido)\b/.test(s)) return 'rogers';
  if (/^(telus|koodo)\b/.test(s)) return 'telus';
  if (/^teksavvy\b/.test(s)) return 'teksavvy';
  if (/^sasktel\b/.test(s)) return 'sasktel';
  if (/^(bell|virgin)\b/.test(s)) return 'bell';
  if (/^eastlink\b/.test(s)) return 'eastlink';
  if (/^cogeco\b/.test(s)) return 'cogeco';
  if (/^(xplore|xplornet)\b/.test(s)) return 'xplore';
  return null;
}

/** Fold place names for comparison ("Sault Ste. Marie" = "sault ste marie"). */
export const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^(city|town|village|municipality|district) of\s+/, '')
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bsainte\b/g, 'ste')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const htmlToLines = (html) =>
  String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|h\d|li|div|button|tr|section)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&#8217;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

// ---------------------------------------------------------------- Telus ----

const COVERED = new Set(['BC', 'AB', 'SK', 'MB', 'ON', 'NB', 'NS', 'PE', 'NL']);
export const internetAffected = (services) => !services?.length || services.some((x) => /internet/i.test(x));

/**
 * Group a notice's affected cells into circles, the way Telus's own map
 * shows them: cells within ~3 km of each other form one circle, sized to
 * reach every cell plus the notice's own radius.
 */
export function cellCircles(points, minKm = 0.75) {
  const clusters = [];
  for (const p of points) {
    const c = clusters.find((k) => distanceKm(k.center, p) <= 3);
    if (c) {
      c.members.push(p);
      c.center = {
        lat: c.members.reduce((a, m) => a + m.lat, 0) / c.members.length,
        lon: c.members.reduce((a, m) => a + m.lon, 0) / c.members.length,
      };
    } else clusters.push({ center: { ...p }, members: [p] });
  }
  return clusters.map((c) => ({
    lat: c.center.lat,
    lon: c.center.lon,
    km: Math.round(Math.max(minKm, ...c.members.map((m) => distanceKm(c.center, m) + 0.3)) * 100) / 100,
  }));
}

/** Telus outagesOverview JSON → notices (every service: Internet, TV, phone, mobile). */
export function parseTelus(json, nowMs) {
  if (!Array.isArray(json?.outages)) return null;
  const all = [
    ...json.outages.map((o) => [o, 'outage']),
    ...(json.regionalOutages || []).map((o) => [o, 'outage']),
    ...(json.plannedOutages || []).map((o) => [o, 'planned']),
    ...(json.plannedRegionalOutages || []).map((o) => [o, 'planned']),
  ];
  const notices = [];
  for (const [o, kind] of all) {
    if (!o || o.isResolved || o.isCompleted) continue;
    if (o.province && !COVERED.has(o.province)) continue;
    const services = Array.isArray(o.impactedServices) ? o.impactedServices : [];
    let info = {};
    try {
      info = typeof o.polygonInfo === 'string' ? JSON.parse(o.polygonInfo) : o.polygonInfo || {};
    } catch {
      info = {};
    }
    const w = Number(info.length) || 0.002;
    const hgt = Number(info.height) || 0.0012;
    const center = o.outageCenter && Number.isFinite(o.outageCenter.lat) ? { lat: o.outageCenter.lat, lon: o.outageCenter.lon } : null;
    const rKm = Math.min(Math.max(Number(o.outageAreaRadius) || 0.5, 0.5), 25);
    // Each coord is the corner of a small affected cell (lat, lon).
    const cellPts = (Array.isArray(info.coords) ? info.coords : [])
      .filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))
      .map(([lat, lon]) => ({ lat: lat + hgt / 2, lon: lon + w / 2 }));
    let circles = cellCircles(cellPts, Math.max(0.75, rKm));
    for (const pin of Array.isArray(info.mobilityPins) ? info.mobilityPins : [])
      if (Number.isFinite(pin?.lt) && Number.isFinite(pin?.lg)) circles.push({ lat: pin.lt, lon: pin.lg, km: Math.min(Number(pin.r) || rKm, 30) });
    if (!circles.length && center) circles = [{ lat: center.lat, lon: center.lon, km: Math.max(0.75, rKm) }];
    const startMs = Date.parse(o.startTime || '') || null;
    if (kind === 'planned' && startMs && startMs - nowMs > 7 * 86400_000) continue;
    const text = String(o.impactedAreaText || '').trim();
    const city = /^([^,(]+?)\s*(?:\([^)]*\))?,\s*[A-Za-z ]+$/.exec(text)?.[1] || null;
    notices.push({
      id: `telus:${o._id || o.acr || text}`,
      provider: 'telus',
      kind,
      internet: internetAffected(services),
      title: text || 'Telus outage',
      detail: [o.cause?.cause, o.estimatedRepairDate ? `estimated repair ${o.estimatedRepairDate}${o.estimatedRepairTime ? ` (${o.estimatedRepairTime})` : ''}` : null].filter(Boolean).join('; ') || null,
      services,
      province: o.province || null,
      city,
      areas: [],
      point: center || (circles[0] ? { lat: circles[0].lat, lon: circles[0].lon } : null),
      radiusKm: null,
      circles,
      cells: [],
      startMs,
      endMs: kind === 'planned' && o.estimatedRepairDate ? Date.parse(`${o.estimatedRepairDate}T23:59:00-06:00`) : null,
      updated: o.lastUpdate || null,
      link: 'https://www.telus.com/en/outages',
    });
  }
  return notices;
}

// --------------------------------------------------------------- Rogers ----

const WORD_NUMS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Rogers outage page HTML (one province) → notices. */
export function parseRogers(html, province, nowMs) {
  const lines = htmlToLines(html);
  if (!lines.some((l) => /^Region:/i.test(l))) return null;
  const notices = [];
  let cur = null;
  const flush = () => {
    if (cur) notices.push(cur);
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = /^(Service Interruption|Planned maintenance|Service Outage|Outage)\s*\|?\s*(.*)$/i.exec(line);
    if (head && !/^planned maintenance$/i.test(line)) {
      flush();
      let title = head[2].trim();
      if (!title && lines[i + 1] && !/^(Impacted|Cause|Current|Expected)/i.test(lines[i + 1])) title = lines[++i];
      cur = { kind: /planned/i.test(head[1]) ? 'planned' : 'outage', title, fields: {} };
      continue;
    }
    if (!cur) continue;
    const f = /^(Impacted services|Cause|Current status|Expected Start|Updates)\s*:?\s*(.*)$/i.exec(line);
    if (f) cur.fields[f[1].toLowerCase()] = f[2].trim();
    if (/^(Learn more|Region includes)/i.test(line)) flush();
  }
  flush();

  const zone = PROVINCE_ZONES[province];
  const year = new Date(nowMs).getUTCFullYear();
  const out = [];
  for (const n of notices) {
    const services = n.fields['impacted services'] || '';
    if (services && !/internet/i.test(services)) continue;
    const status = n.fields['current status'] || '';
    // "Service will be restored automatically…" is a plan, not a resolution.
    if (/^\s*(service restored|resolved)|has been (completed|restored|resolved)/i.test(status)) continue;
    let city = null;
    let areas = [];
    let startMs = null;
    let endMs = null;
    if (n.kind === 'outage') {
      const m = /near\s+(.+?)\s+in\s+(.+?)\s*\.?$/i.exec(n.title) || /in\s+(.+?)\s*\.?$/i.exec(n.title);
      if (m && m[2]) {
        city = m[2];
        areas = m[1].split(/\s*(?:&|,|\band\b)\s*/i).filter(Boolean);
      } else if (m) city = m[1];
    } else {
      const m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\s*-\s*([^(]+?)\s*(?:\((.+)\))?\s*$/.exec(n.title);
      if (m) {
        city = m[3].trim();
        areas = (m[4] || '').split(/\s*,\s*/).filter(Boolean);
        const mo = MONTHS[m[1].toLowerCase()];
        const st = /(\d{1,2}):(\d{2})\s*([ap])\.?m/i.exec(n.fields['expected start'] || '');
        let h = st ? (Number(st[1]) % 12) + (st[3].toLowerCase() === 'p' ? 12 : 0) : 0;
        if (mo) {
          startMs = zonedToUtc(zone, year, mo, Number(m[2]), h, st ? Number(st[2]) : 0);
          if (startMs - nowMs > 200 * 86400_000) startMs = zonedToUtc(zone, year - 1, mo, Number(m[2]), h, st ? Number(st[2]) : 0);
          if (nowMs - startMs > 200 * 86400_000) startMs = zonedToUtc(zone, year + 1, mo, Number(m[2]), h, st ? Number(st[2]) : 0);
          const dur = /approximately\s+(?:\w+\s+)?\((\d+)\)\s*hours?|approximately\s+(\d+|\w+)\s+hours?/i.exec(status);
          const hours = dur ? Number(dur[1] || dur[2]) || WORD_NUMS[String(dur[2]).toLowerCase()] || 6 : 6;
          endMs = startMs + hours * 3600_000;
        }
      }
      if (endMs && endMs < nowMs) continue;
      if (startMs && startMs - nowMs > 7 * 86400_000) continue;
    }
    out.push({
      id: `rogers:${province}:${fold(n.title)}`,
      provider: 'rogers',
      kind: n.kind,
      internet: true,
      title: n.title,
      detail: [n.fields.cause ? `Cause: ${n.fields.cause}` : null, status || null].filter(Boolean).join('. ') || null,
      services: services ? services.split(/\s*,\s*/) : [],
      province,
      city,
      areas,
      point: null,
      radiusKm: null,
      cells: [],
      startMs,
      endMs,
      updated: null,
      link: `https://www.rogers.com/support/outage?province=${province}`,
    });
  }
  return out;
}

// ------------------------------------------------------------- TekSavvy ----

/** TekSavvy's Google My Maps KML → notices. */
export function parseKmlNotices(kml, provider, link) {
  if (typeof kml !== 'string' || !/<kml/i.test(kml)) return null;
  const out = [];
  for (const pm of kml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/gi)) {
    const body = pm[1];
    const name = (/<name>([\s\S]*?)<\/name>/i.exec(body)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const desc = (/<description>([\s\S]*?)<\/description>/i.exec(body)?.[1] || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const polygons = [];
    let point = null;
    for (const c of body.matchAll(/<(Polygon|Point|LineString)>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/gi)) {
      const pts = c[2].trim().split(/\s+/).map((t) => t.split(',').map(Number)).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (/point/i.test(c[1]) && pts[0]) point = { lon: pts[0][0], lat: pts[0][1] };
      else if (/polygon/i.test(c[1])) {
        const ring = closeRing(pts.map((p) => [p[0], p[1]]));
        if (validRing(ring)) polygons.push([ring]);
      }
    }
    if (!point && polygons.length) {
      const r = polygons[0][0];
      point = { lon: r.reduce((a, p) => a + p[0], 0) / r.length, lat: r.reduce((a, p) => a + p[1], 0) / r.length };
    }
    if (!point) continue;
    out.push({
      id: `${provider}:${fold(name)}:${point.lat.toFixed(3)},${point.lon.toFixed(3)}`,
      provider,
      kind: /maint|planned|scheduled/i.test(`${name} ${desc}`) ? 'planned' : 'outage',
      internet: true,
      title: name || 'Reported outage',
      detail: desc.slice(0, 400) || null,
      services: [],
      province: null,
      city: null,
      areas: [],
      point,
      radiusKm: polygons.length ? null : POINT_MATCH_KM,
      polygons,
      cells: [],
      startMs: null,
      endMs: null,
      updated: null,
      link,
    });
  }
  return out;
}

// -------------------------------------------------------------- SaskTel ----

/** SaskTel "Reported outages" page → one notice per listed outage (city-level). */
export function parseSaskTel(html) {
  const lines = htmlToLines(html);
  const a = lines.findIndex((l) => /latest outage updates/i.test(l));
  if (a < 0) return null;
  const b = lines.findIndex((l, i) => i > a && /^(report an outage|call 1\.800)/i.test(l));
  const body = lines.slice(a + 1, b < 0 ? a + 60 : b);
  if (body.some((l) => /currently no outages/i.test(l))) return [];
  const out = [];
  for (const line of body) {
    if (line.length < 12) continue;
    out.push({
      id: `sasktel:${fold(line).slice(0, 80)}`,
      provider: 'sasktel',
      internet: !/\b(home phone|landline|mobile|wireless)\b/i.test(line) || /internet/i.test(line),
      kind: /planned|maintenance|scheduled/i.test(line) ? 'planned' : 'outage',
      title: line.slice(0, 200),
      detail: null,
      services: [],
      province: 'SK',
      city: null, // matched against the site's city inside the text
      text: fold(line),
      areas: [],
      point: null,
      radiusKm: null,
      cells: [],
      startMs: null,
      endMs: null,
      updated: null,
      link: PROVIDER_PAGES.sasktel.page,
    });
  }
  return out;
}

// -------------------------------------------------------------- matching ----

const inCell = (p, [lat, lon, w, hgt]) => {
  const padLon = Math.max(w, 0.002);
  const padLat = Math.max(hgt, 0.0012);
  return p.lat >= lat - padLat && p.lat <= lat + 2 * padLat && p.lon >= lon - padLon && p.lon <= lon + 2 * padLon;
};

/**
 * How one notice relates to a site: 'area' (the site is in or next to the
 * affected area), 'city' (same town, elsewhere in it) or null.
 */
export function matchNotice(notice, site) {
  const p = { lat: site.lat, lon: site.lon };
  if (notice.cells?.length) {
    if (notice.cells.some((c) => inCell(p, c))) return 'area';
  }
  if (notice.circles?.some((c) => distanceKm(p, c) <= c.km)) return 'area';
  if (notice.polygons?.length && pointInPolygons(p, notice.polygons)) return 'area';
  if (notice.point && notice.radiusKm && distanceKm(p, notice.point) <= notice.radiusKm) return 'area';
  for (const ap of notice.areaPoints || []) if (distanceKm(p, ap) <= AREA_MATCH_KM) return 'area';
  const city = fold(site.city);
  const area = fold(site.area);
  if (area && notice.areas?.some((a) => fold(a) === area)) {
    if (!notice.city || !city || fold(notice.city) === city) return 'area';
  }
  if (city) {
    if (notice.city && fold(notice.city) === city) return 'city';
    if (notice.text && ` ${notice.text} `.includes(` ${city} `)) return 'city';
  }
  if ((notice.cells?.length || notice.circles?.length) && notice.point && distanceKm(p, notice.point) <= 15 && !notice.city) return 'city';
  return null;
}

/** A site's ISP picture from the current notices. */
export function ispStatusFor(site, notices, health) {
  const key = providerKey(site.isp);
  if (!key) return site.isp ? { provider: null, supported: false } : null;
  const page = PROVIDER_PAGES[key];
  if (page.manual) return { provider: key, name: page.name, supported: false, note: page.manual, link: page.page };
  const h = health[key];
  const hits = [];
  for (const n of notices) {
    if (n.provider !== key) continue;
    const match = matchNotice(n, site);
    if (match) hits.push({ id: n.id, kind: n.kind, match, internet: n.internet !== false, title: n.title, detail: n.detail, services: n.services, startMs: n.startMs, endMs: n.endMs, link: n.link });
  }
  hits.sort((a, b) => Number(b.internet) - Number(a.internet) || (a.match === 'area' ? 0 : 1) - (b.match === 'area' ? 0 : 1) || (a.kind === 'outage' ? 0 : 1) - (b.kind === 'outage' ? 0 : 1));
  const nowMs = Date.now();
  // Only notices that affect Internet raise the client; phone/TV/mobile-only
  // notices at the address are shown, not alerted.
  const net = hits.filter((x) => x.internet && x.match === 'area');
  let state = 'clear';
  if (net.some((x) => x.kind === 'outage')) state = 'out';
  else if (net.some((x) => x.kind === 'planned' && (!x.startMs || x.startMs <= nowMs))) state = 'out';
  else if (net.some((x) => x.kind === 'planned')) state = 'planned';
  else if (hits.length) state = 'nearby';
  if (h?.status === 'down') state = 'unknown';
  return { provider: key, name: page.name, supported: true, state, notices: hits.slice(0, 4), link: page.page, checkedAt: h?.lastSuccessAt || null, error: h?.error || null };
}

// --------------------------------------------------------------- poller ----

export function createIspStatus({ request, requestText, geocoder, now = () => Date.now(), log = console, provincesFor = () => PROVINCES }) {
  /** key → {notices, lastSuccessAt, lastAttemptAt, error} */
  const state = {};
  const areaPointCache = new Map();
  let running = null;

  async function load(key) {
    const nowMs = now();
    if (key === 'telus') {
      const json = await request('https://www.telus.com/outages/backend/outagesOverview/consumer', { headers: { Referer: 'https://www.telus.com/en/outages' } });
      const n = parseTelus(json, nowMs);
      if (!n) throw new Error('Unexpected Telus response');
      return n;
    }
    if (key === 'rogers') {
      const all = [];
      for (const prov of provincesFor()) {
        const html = await requestText(`https://www.rogers.com/support/outage?province=${prov}`, { headers: { Accept: 'text/html' }, timeoutMs: 25_000 });
        const n = parseRogers(html, prov, nowMs);
        if (!n) throw new Error(`Unexpected Rogers page for ${prov}`);
        all.push(...n);
      }
      await locateAreas(all);
      return all;
    }
    if (key === 'teksavvy') {
      const kml = await requestText('https://www.google.com/maps/d/kml?mid=1XU_xQ56c8N9a0DAW4PKBkns4de4&forcekml=1');
      const n = parseKmlNotices(kml, 'teksavvy', PROVIDER_PAGES.teksavvy.page);
      if (!n) throw new Error('Unexpected TekSavvy map');
      return n;
    }
    if (key === 'sasktel') {
      const n = parseSaskTel(await requestText(PROVIDER_PAGES.sasktel.page, { headers: { Accept: 'text/html' } }));
      if (!n) throw new Error('Unexpected SaskTel page');
      return n;
    }
    return [];
  }

  /** Put neighbourhoods named by Rogers on the map (cached; a few per poll). */
  async function locateAreas(notices) {
    let budget = 12;
    for (const n of notices) {
      if (!n.city) continue;
      n.areaPoints = [];
      for (const area of n.areas.length ? n.areas : []) {
        const key = fold(`${area}|${n.city}|${n.province}`);
        if (!areaPointCache.has(key)) {
          if (budget-- <= 0) continue;
          try {
            const [hit] = await geocoder.search(`${area}, ${n.city}, ${PROVINCE_NAMES[n.province] || ''}`);
            areaPointCache.set(key, hit && fold(hit.city) === fold(n.city) ? { lat: hit.lat, lon: hit.lon } : null);
          } catch {
            continue;
          }
        }
        const pt = areaPointCache.get(key);
        if (pt) n.areaPoints.push(pt);
      }
      if (!n.point && n.areaPoints.length) n.point = n.areaPoints[0];
      n.circles = n.areaPoints.map((p) => ({ ...p, km: AREA_MATCH_KM }));
    }
  }

  async function refresh() {
    running ??= (async () => {
      for (const key of ['telus', 'rogers', 'teksavvy', 'sasktel']) {
        const prior = state[key];
        if (prior && now() - prior.lastAttemptAt < TTL_MS) continue;
        const attemptAt = now();
        try {
          const notices = await load(key);
          state[key] = { notices, lastSuccessAt: now(), lastAttemptAt: attemptAt, error: null };
        } catch (error) {
          state[key] = { ...(prior || { notices: [] }), lastAttemptAt: attemptAt, error: String(error?.message || error).slice(0, 200) };
          log.warn?.(`[isp-status] ${key}: ${error?.message}`);
        }
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  function health() {
    const out = {};
    for (const key of ['telus', 'rogers', 'teksavvy', 'sasktel']) {
      const s = state[key];
      const fresh = s?.lastSuccessAt && now() - s.lastSuccessAt < STALE_DROP_MS;
      out[key] = {
        id: key,
        name: PROVIDER_PAGES[key].name,
        page: PROVIDER_PAGES[key].page,
        status: !fresh ? 'down' : s.error ? 'stale' : 'ok',
        lastSuccessAt: s?.lastSuccessAt || null,
        error: s?.error || null,
        notices: fresh ? s.notices.length : 0,
      };
    }
    return out;
  }

  function notices() {
    const h = health();
    return Object.entries(state).flatMap(([key, s]) => (h[key].status === 'down' ? [] : s.notices || []));
  }

  return { refresh, notices, health, statusFor: (site) => ispStatusFor(site, notices(), health()) };
}
