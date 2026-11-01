import { distanceKm, pointInPolygons } from './geo.js';
import { closeRing, validRing } from './records.js';
import { PROVINCE_ZONES, zonedToUtc } from './zones.js';
import { providerFor, providerByKey } from './providers.js';
import { loadAeaNotices, AEA_PAGE } from './sources/aea.js';
import { parseAddress } from './geocode.js';

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
 *   Eastlink   per-address outage lookup                         → per client
 *   Alberta    Emergency Alert telecom / 911 alerts (polygons)   → by location
 *
 * Bell's address check sits behind a CAPTCHA and is not automated. Which
 * provider a client name means, and which line a reseller rides, comes from
 * providers.js. Providers without a public page rely on IODA's network
 * signals and the optional per-client connection check instead.
 */

const TTL_MS = 5 * 60_000;
const STALE_DROP_MS = 45 * 60_000;
const AREA_MATCH_KM = 2.5;
const POINT_MATCH_KM = 3;
// A notice that names only a town is drawn as a circle this size around it.
const TOWN_KM = 5;
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
  aea: { name: 'Alberta Emergency Alert', page: AEA_PAGE },
  xplore: { name: 'Xplore', page: 'https://www.xplore.ca/support/', manual: 'Xplore publishes no public outage map.' },
});

/** Which provider a client's ISP name means (registry key), or null. */
export function providerKey(isp) {
  const p = providerFor(isp);
  if (p) return p.key;
  const s = String(isp || '').trim().toLowerCase();
  if (/^cogeco\b/.test(s)) return 'cogeco';
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
  const region = lines.find((l) => /^Region:/i.test(l));
  if (!region) return null;
  // Rogers picks the region from a cookie; never file one province's page under another.
  const want = PROVINCE_NAMES[province];
  if (want && !fold(region).includes(fold(want))) throw new Error(`Rogers sent "${region}" when asked for ${want}`);
  const notices = [];
  let cur = null;
  const flush = () => {
    if (cur) notices.push(cur);
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Real notices read "Service Interruption | ..." / "Planned maintenance | ...";
    // the pipe keeps page text such as "Outages guide" from becoming a notice.
    const head = /^(Service Interruption|Planned maintenance|Service Outage|Outage)\s*\|\s*(.*)$/i.exec(line);
    if (head) {
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
  if (notice.circles?.some((c) => !c.town && distanceKm(p, c) <= c.km)) return 'area';
  if (notice.polygons?.length && pointInPolygons(p, notice.polygons)) return 'area';
  if (notice.point && notice.radiusKm && distanceKm(p, notice.point) <= notice.radiusKm) return 'area';
  for (const ap of notice.areaPoints || []) if (distanceKm(p, ap) <= AREA_MATCH_KM) return 'area';
  // A circle round a whole town means "somewhere in this town", not here.
  const inTown = notice.circles?.some((c) => c.town && distanceKm(p, c) <= c.km);
  const city = fold(site.city);
  const area = fold(site.area);
  if (area && notice.areas?.some((a) => fold(a) === area)) {
    if (!notice.city || !city || fold(notice.city) === city) return 'area';
  }
  if (inTown) return 'city';
  if (city) {
    if (notice.city && fold(notice.city) === city) return 'city';
    if (notice.text && ` ${notice.text} `.includes(` ${city} `)) return 'city';
  }
  if ((notice.cells?.length || notice.circles?.length) && notice.point && distanceKm(p, notice.point) <= 15 && !notice.city) return 'city';
  return null;
}

const LABEL = { telus: 'Telus', rogers: 'Rogers / Shaw', teksavvy: 'TekSavvy', sasktel: 'SaskTel' };
const hitOf = (n, match, via = null) => ({
  id: n.id, provider: n.provider, via, kind: n.kind, match, internet: n.internet !== false, title: n.title, detail: n.detail,
  services: n.services, startMs: n.startMs, endMs: n.endMs, link: n.link,
});
const rank = (x) => (x.internet ? 0 : 2) + (x.match === 'area' ? 0 : 1);

/**
 * A site's internet picture: one line per signal (provider map, address
 * lookup, the line a reseller rides, Alberta alerts, the provider's network,
 * the client's own connection), and an overall state:
 *   out      a signal says this client's internet is down here
 *   planned  provider maintenance here, not started
 *   nearby   something nearby or same town, or phone/TV only, or only possible
 *   clear    every signal that exists is clear
 *   unknown  no signal could be read
 * @param {object} ctx {siteCheck, wan, networks, networkStatus}
 */
export function ispStatusFor(site, notices, health, nowMs = Date.now(), ctx = {}) {
  const p = providerFor(site.isp);
  const legacy = !p && providerKey(site.isp);
  if (!p && !legacy) {
    if (!site.isp && !site.monitorHost) return null;
  }
  const key = p?.key || legacy || null;
  const name = p?.name || PROVIDER_PAGES[legacy]?.name || site.isp || 'Internet';
  const link = p?.page ?? PROVIDER_PAGES[legacy]?.page ?? null;
  const checks = [];
  const hits = [];
  let out = false;
  let planned = false;
  let nearby = false;

  // 1. The provider's own outage map or notices.
  const feedKey = p?.feed || (legacy && !PROVIDER_PAGES[legacy]?.manual ? legacy : null);
  if (feedKey) {
    const h = health[feedKey];
    const own = notices.filter((n) => n.provider === feedKey).map((n) => [n, matchNotice(n, site)]).filter(([, m]) => m).map(([n, m]) => hitOf(n, m));
    hits.push(...own);
    const net = own.filter((x) => x.internet && x.match === 'area');
    let state = 'clear';
    if (net.some((x) => x.kind === 'outage' || !x.startMs || x.startMs <= nowMs)) state = 'out';
    else if (net.length) state = 'planned';
    else if (own.length) state = 'nearby';
    if (h?.status === 'down') state = 'unknown';
    out ||= state === 'out';
    planned ||= state === 'planned';
    nearby ||= state === 'nearby';
    const first = own[0];
    checks.push({
      id: 'feed', label: `${LABEL[feedKey] || name} outage map`, state, link: PROVIDER_PAGES[feedKey]?.page || link,
      text: state === 'unknown' ? `Could not be read${h?.error ? ` (${h.error})` : ''}` : first ? `${first.title}${first.services?.length ? ` · ${first.services.join(', ')}` : ''}` : 'Nothing reported here',
      checkedAt: h?.lastSuccessAt || null,
    });
  }

  // 2. The provider's own per-address lookup (Eastlink).
  if (p?.address) {
    const c = ctx.siteCheck;
    const state = !c ? 'pending' : c.error ? 'unknown' : c.state;
    if (state === 'out') out = true;
    checks.push({
      id: 'address', label: `${name} address lookup`, state, link,
      text: !c ? 'Checking this address…' : c.error ? `Could not check (${c.error})` : c.state === 'out'
        ? `Outage at ${c.matched}${c.restoreAt ? `, estimated back ${new Date(c.restoreAt).toLocaleString('en-CA', { timeZone: 'America/Edmonton', weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}`
        : c.matched ? `No outage at ${c.matched}` : 'Address not found by Eastlink; set the full street address',
      checkedAt: c?.checkedAt || null,
    });
  }

  // 3. Resellers: outages on the Telus or Shaw line they ride.
  for (const via of p?.rides || []) {
    if (site.ispNetwork && site.ispNetwork !== via) continue;
    const h = health[via];
    const own = notices.filter((n) => n.provider === via).map((n) => [n, matchNotice(n, site)]).filter(([, m]) => m).map(([n, m]) => hitOf(n, m, via));
    hits.push(...own);
    const here = own.filter((x) => x.internet && x.match === 'area' && (x.kind === 'outage' || !x.startMs || x.startMs <= nowMs));
    const sure = site.ispNetwork === via;
    let state = h?.status === 'down' ? 'unknown' : here.length ? (sure ? 'out' : 'possible') : own.length ? 'nearby' : 'clear';
    if (state === 'out') out = true;
    if (state === 'possible' || state === 'nearby') nearby = true;
    checks.push({
      id: `rides-${via}`, label: `${LABEL[via]} line${sure ? '' : ' (if it rides this one)'}`, state, link: PROVIDER_PAGES[via]?.page,
      text: here.length ? `${LABEL[via]} reports ${here[0].title}${sure ? '' : '. Set which line this client uses to be sure.'}` : own.length ? `${LABEL[via]}: ${own[0].title}` : `No ${LABEL[via]} outage here`,
      checkedAt: h?.lastSuccessAt || null,
    });
  }

  // 4. Alberta Emergency Alert telecom alerts covering the site.
  const aeaHealth = health.aea;
  if (aeaHealth && (ctx.province === 'AB' || notices.some((n) => n.provider === 'aea'))) {
    const alerts = notices.filter((n) => n.provider === 'aea' && n.polygons?.length && pointInPolygons(site, n.polygons));
    for (const a of alerts) hits.push(hitOf(a, 'area'));
    const forUs = alerts.filter((a) => a.internet || !a.mentions?.length || a.mentions.includes(key) || (p?.rides || []).some((r) => a.mentions.includes(r)));
    const state = aeaHealth.status === 'down' ? 'unknown' : forUs.some((a) => a.internet && (!a.mentions.length || a.mentions.includes(key))) ? 'out' : alerts.length ? 'nearby' : 'clear';
    if (state === 'out') out = true;
    if (state === 'nearby') nearby = true;
    if (ctx.province === 'AB' || alerts.length)
      checks.push({
        id: 'aea', label: 'Alberta Emergency Alert', state, link: alerts[0]?.link || AEA_PAGE,
        text: alerts.length ? `${alerts[0].title}${alerts[0].mentions?.length ? ` (${alerts[0].mentions.map((m) => LABEL[m] || providerByKey(m)?.name || m).join(', ')})` : ''}` : 'No telecom alert here',
        checkedAt: aeaHealth.lastSuccessAt || null,
      });
  }

  // 5. The provider's own network, as IODA sees it.
  if (p?.asns?.length && ctx.networks) {
    const nets = p.asns.map((a) => ctx.networks[a]).filter(Boolean);
    const active = nets.filter((n) => n.active);
    const state = ctx.networkStatus === 'down' ? 'unknown' : active.length ? 'degraded' : 'clear';
    checks.push({
      id: 'network', label: `${name} network`, state, link: 'https://ioda.inetintel.cc.gatech.edu/',
      text: active.length
        ? `Drop since ${new Date(Math.min(...active.map((n) => n.since))).toLocaleString('en-CA', { timeZone: 'America/Edmonton', hour: 'numeric', minute: '2-digit', weekday: 'short' })} (${[...new Set(active.flatMap((n) => n.signals))].join(', ')})${p.key === 'starlink' ? ', Starlink-wide' : ''}`
        : `Normal (AS${p.asns.join(', AS')})`,
      checkedAt: null,
    });
  }

  // 6. The client's own connection.
  if (site.monitorHost) {
    const w = ctx.wan;
    const state = !w ? 'pending' : w.state === 'up' ? 'clear' : w.state === 'down' ? 'out' : w.state === 'split' ? 'nearby' : w.state === 'invalid' ? 'unknown' : 'pending';
    if (state === 'out') out = true;
    checks.push({
      id: 'wan', label: `Connection check (${site.monitorHost})`, state, link: null,
      text: !w ? 'First check pending'
        : w.state === 'up' ? `Answering${w.rttMs != null ? `, ${w.rttMs} ms` : ''}${w.sites?.length > 1 ? ' at both sites' : w.sites?.length === 1 ? ` (checked by ${w.sites[0]})` : ` (${w.method})`}`
        : w.state === 'down' ? `No answer${w.sites?.length > 1 ? ' from either site' : ''} since ${new Date(w.since).toLocaleTimeString('en-CA', { timeZone: 'America/Edmonton', hour: 'numeric', minute: '2-digit' })}`
        : w.state === 'split' ? `${w.down} can't reach it but ${w.up} can, so most likely ${w.down}'s own internet`
        : w.state === 'invalid' ? w.error : 'Checking…',
      checkedAt: w?.lastCheckAt || null,
    });
  }

  hits.sort((a, b) => rank(a) - rank(b) || (a.kind === 'outage' ? 0 : 1) - (b.kind === 'outage' ? 0 : 1));
  const readable = checks.filter((c) => !['unknown', 'pending'].includes(c.state));
  const wanUp = ctx.wan?.state === 'up';
  let state = out ? 'out' : planned ? 'planned' : nearby ? 'nearby' : readable.length ? 'clear' : 'unknown';
  // The client's own line answering beats a map saying the area is out.
  if (state === 'out' && wanUp && !checks.some((c) => c.id === 'wan' && c.state === 'out')) state = 'nearby';
  const degraded = checks.some((c) => c.state === 'degraded');
  return {
    provider: key,
    name,
    kind: p?.kind || null,
    supported: checks.some((c) => c.id !== 'network' || p?.kind === 'regional'),
    state,
    networkDrop: degraded,
    checks,
    notices: hits.slice(0, 5),
    link,
    about: p?.about || PROVIDER_PAGES[legacy]?.manual || null,
    note: p?.about || PROVIDER_PAGES[legacy]?.manual || null,
    checkedAt: checks.map((c) => c.checkedAt).filter(Boolean).sort().at(-1) || null,
  };
}

// --------------------------------------------------------------- poller ----

const FEEDS = ['telus', 'rogers', 'teksavvy', 'sasktel', 'aea'];

// Some provider sites refuse anything that does not look like a browser.
export const BROWSER_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Accept-Language': 'en-CA,en;q=0.9',
});

/** Why a site said no, from its answer: shown on the Sources panel. */
export function blockedBy(r) {
  const h = (k) => (typeof r.headers?.get === 'function' ? r.headers.get(k) : null) || '';
  const text = String(r.text || '').slice(0, 3000);
  if (h('cf-mitigated') || /just a moment|cf-chl|challenge-platform/i.test(text)) return ' (Cloudflare bot check)';
  if (/akamai/i.test(h('server')) || /access denied[\s\S]*reference/i.test(text)) return ' (Akamai block)';
  if (/cloudflare/i.test(h('server'))) return ' (Cloudflare)';
  return '';
}
const EASTLINK = 'https://help.eastlink.ca/api/gis';
const PROVIDERS_EASTLINK_PAGE = 'https://help.eastlink.ca/managing-your-account-billing/service-outage/';

/** A street address as Eastlink's lookup wants it: "4802 50 Ave Camrose". */
export function eastlinkQuery(address) {
  const a = parseAddress(address);
  if (!a.street) return null;
  return [a.street, a.city].filter(Boolean).join(' ');
}

/** Eastlink checkOutage answer → {state, restoreAt, nodes}. */
export function readEastlinkOutage(json) {
  if (!json || typeof json.statusCode !== 'number') throw new Error('Unexpected Eastlink answer');
  const nodes = Array.isArray(json.outageNodes) ? json.outageNodes : [];
  const restore = nodes.map((n) => Date.parse(n.estimatedRestoreTime)).filter(Number.isFinite);
  return {
    state: json.statusCode === 1 || nodes.length ? 'out' : json.statusCode === 0 ? 'clear' : 'unknown',
    restoreAt: restore.length ? Math.max(...restore) : null,
    nodes: nodes.length,
  };
}

export function createIspStatus({ request, requestText, requestRaw = null, geocoder, now = () => Date.now(), log = console, provincesFor = () => PROVINCES }) {
  /** key → {notices, lastSuccessAt, lastAttemptAt, error} */
  const state = {};
  /** siteId → per-address check result (Eastlink) */
  const siteChecks = new Map();
  /** The peer's copies: provider feeds and address checks (see chosen). */
  const borrowed = {};
  const peerChecks = new Map();
  const areaPointCache = new Map();
  let running = null;

  async function load(key) {
    const nowMs = now();
    if (key === 'telus') return loadTelus(nowMs);
    if (key === 'rogers') {
      const all = [];
      for (const prov of provincesFor()) {
        const html = await requestText(`https://www.rogers.com/support/outage?province=${prov}`, {
          headers: { ...BROWSER_HEADERS, Accept: 'text/html', Cookie: `province=${prov}; language=en` },
          timeoutMs: 25_000,
        });
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
    if (key === 'aea') return loadAeaNotices({ requestText, nowMs, log });
    if (key === 'sasktel') {
      const n = parseSaskTel(await requestText(PROVIDER_PAGES.sasktel.page, { headers: { Accept: 'text/html' } }));
      if (!n) throw new Error('Unexpected SaskTel page');
      return n;
    }
    return [];
  }

  /** Telus's outage feed, asked for the way its own outage page asks. */
  async function loadTelus(nowMs) {
    const problems = [];
    for (const seg of ['consumer', 'business']) {
      const r = await (requestRaw || rawFromText)(`https://www.telus.com/outages/backend/outagesOverview/${seg}`, {
        headers: { ...BROWSER_HEADERS, Accept: 'application/json, text/plain, */*', Referer: 'https://www.telus.com/en/ab/outages', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' },
      });
      if (r.status === 200) {
        let json = null;
        try {
          json = JSON.parse(r.text);
        } catch {
          /* fall through */
        }
        const n = json && parseTelus(json, nowMs);
        if (n) return n;
        problems.push(`${seg}: not the outage feed${blockedBy(r)}`);
      } else problems.push(`${seg}: HTTP ${r.status}${blockedBy(r)}`);
    }
    throw new Error(`Telus refused (${problems.join('; ')})`);
  }
  const rawFromText = async (url, options) => ({ status: 200, headers: new Map(), text: JSON.stringify(await request(url, options)) });

  /** Put neighbourhoods named by Rogers on the map (cached; a few per poll). */
  async function locateAreas(notices) {
    let budget = 14;
    const lookup = async (key, query) => {
      if (areaPointCache.has(key)) return areaPointCache.get(key);
      if (budget-- <= 0) return undefined;
      try {
        const [hit] = await geocoder.search(query);
        const pt = hit && Number.isFinite(hit.lat) ? { lat: hit.lat, lon: hit.lon, city: hit.city || null } : null;
        areaPointCache.set(key, pt);
        return pt;
      } catch {
        return undefined;
      }
    };
    for (const n of notices) {
      if (!n.city) continue;
      const prov = PROVINCE_NAMES[n.province] || '';
      const town = await lookup(fold(`|${n.city}|${n.province}`), `${n.city}, ${prov}`);
      n.areaPoints = [];
      for (const area of n.areas || []) {
        const pt = await lookup(fold(`${area}|${n.city}|${n.province}`), `${area}, ${n.city}, ${prov}`);
        // Keep a neighbourhood only if it really is in that town.
        if (pt && (!town || distanceKm(pt, town) <= 30)) n.areaPoints.push({ lat: pt.lat, lon: pt.lon });
      }
      if (n.areaPoints.length) n.circles = n.areaPoints.map((p) => ({ ...p, km: AREA_MATCH_KM }));
      else if (town) n.circles = [{ lat: town.lat, lon: town.lon, km: TOWN_KM, town: true }];
      else n.circles = [];
      n.point ??= n.areaPoints[0] || (town ? { lat: town.lat, lon: town.lon } : null);
    }
  }

  async function refresh() {
    running ??= (async () => {
      for (const key of FEEDS) {
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

  /** Our copy when healthy; the peer's when ours is failing and theirs is newer and fresh. */
  function chosen(key) {
    const own = state[key];
    const theirs = borrowed[key];
    const fresh = (x) => x?.lastSuccessAt && now() - x.lastSuccessAt < STALE_DROP_MS;
    if (fresh(own) && !own.error) return own;
    if (fresh(theirs) && (!fresh(own) || theirs.lastSuccessAt > own.lastSuccessAt))
      return { notices: theirs.notices, lastSuccessAt: theirs.lastSuccessAt, error: null, via: theirs.from, ownError: own?.error || null };
    return own;
  }

  function health() {
    const out = {};
    for (const key of FEEDS) {
      const s = chosen(key);
      const fresh = s?.lastSuccessAt && now() - s.lastSuccessAt < STALE_DROP_MS;
      out[key] = {
        id: key,
        name: PROVIDER_PAGES[key].name,
        page: PROVIDER_PAGES[key].page,
        status: !fresh ? 'down' : s.error ? 'stale' : 'ok',
        lastSuccessAt: s?.lastSuccessAt || null,
        error: s?.error || null,
        via: s?.via || null,
        ownError: s?.ownError || null,
        notices: fresh ? s.notices.length : 0,
      };
    }
    return out;
  }

  /** Provider feeds this instance fetched itself, minus what the peer already has. */
  function exportFeeds(have = {}) {
    const out = [];
    for (const key of FEEDS) {
      const f = state[key];
      if (f?.lastSuccessAt && now() - f.lastSuccessAt < STALE_DROP_MS && have[key] !== f.lastSuccessAt)
        out.push({ key, notices: f.notices, fetchedAt: f.lastSuccessAt, error: f.error });
    }
    return out;
  }
  /** Our own address lookups (Eastlink), by site id. */
  const exportSiteChecks = () => Object.fromEntries([...siteChecks].filter(([, c]) => c.checkedAt && !c.error));
  function importPeer({ feeds: list = [], siteChecks: checks = {} }, { offsetMs = 0, from = 'peer' } = {}) {
    for (const f of list) {
      if (!FEEDS.includes(f.key) || !Array.isArray(f.notices) || !Number.isFinite(f.fetchedAt)) continue;
      borrowed[f.key] = { notices: f.notices, lastSuccessAt: f.fetchedAt + offsetMs, originAt: f.fetchedAt, from };
    }
    for (const [id, c] of Object.entries(checks || {}))
      if (c && Number.isFinite(c.checkedAt)) peerChecks.set(id, { ...c, checkedAt: c.checkedAt + offsetMs, via: from });
  }
  const borrowedHave = () => Object.fromEntries(Object.entries(borrowed).map(([k, v]) => [k, v.originAt]));
  /** Our lookup, unless it failed and the peer has a newer good one. */
  function siteCheck(id) {
    const own = siteChecks.get(id) || null;
    const theirs = peerChecks.get(id) || null;
    if (theirs && (!own || own.error) && now() - theirs.checkedAt < STALE_DROP_MS) return theirs;
    return own;
  }

  /** Per-address lookups for clients whose provider offers one (Eastlink). */
  async function refreshSites(sites) {
    for (const site of sites) {
      const p = providerFor(site.isp);
      if (p?.address !== 'eastlink') {
        siteChecks.delete(site.id);
        continue;
      }
      const prior = siteChecks.get(site.id);
      if (prior && prior.address === site.address && now() - prior.attemptAt < TTL_MS) continue;
      const attemptAt = now();
      const base = { address: site.address, attemptAt };
      try {
        const q = eastlinkQuery(site.address || '');
        if (!q) {
          siteChecks.set(site.id, { ...base, checkedAt: now(), matched: null, state: 'unknown', error: 'no street address saved' });
          continue;
        }
        const list = await request(`${EASTLINK}/mobile/suggestaddress/${encodeURIComponent(q)}`, { headers: { Referer: PROVIDERS_EASTLINK_PAGE } });
        const pick = Array.isArray(list) ? list[0] : null;
        if (!pick?.address) {
          siteChecks.set(site.id, { ...base, checkedAt: now(), matched: null, state: 'unknown', error: null });
          continue;
        }
        const r = readEastlinkOutage(await request(`${EASTLINK}/checkOutage/${encodeURIComponent(pick.address)}`, { headers: { Referer: PROVIDERS_EASTLINK_PAGE } }));
        siteChecks.set(site.id, { ...base, ...r, matched: pick.address, checkedAt: now(), error: null });
      } catch (error) {
        siteChecks.set(site.id, { ...(prior || {}), ...base, error: String(error?.message || error).slice(0, 120) });
        log.warn?.(`[isp-status] eastlink ${site.name}: ${error?.message}`);
      }
    }
  }

  function notices() {
    const h = health();
    return FEEDS.flatMap((key) => (h[key].status === 'down' ? [] : chosen(key)?.notices || []));
  }

  return {
    refresh,
    refreshSites,
    notices,
    health,
    siteCheck,
    exportFeeds,
    exportSiteChecks,
    importPeer,
    borrowedHave,
    statusFor: (site, ctx = {}) => ispStatusFor(site, notices(), health(), now(), { ...ctx, siteCheck: siteCheck(site.id) }),
  };
}
