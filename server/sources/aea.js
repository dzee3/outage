/*
 * Alberta Emergency Alert: the province's official alert feed. Telecom
 * failures are issued here as CAP alerts ("911 Service Inoperative",
 * "Telephone Service") with the exact affected polygon, and the text often
 * names the carrier ("Telus is investigating"). The Atom feed lists the
 * alerts in effect; each entry links to its CAP XML.
 */

export const AEA_FEED = 'https://www.alberta.ca/data/aea/rss/feed-full.atom';
export const AEA_PAGE = 'https://www.alberta.ca/alberta-emergency-alert';

const unxml = (s) =>
  String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

const tag = (xml, name) => {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i').exec(xml);
  return m ? unxml(m[1]) : null;
};
const tags = (xml, name) =>
  [...String(xml).matchAll(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'gi'))].map((m) => m[1]);

/** "lat,lon lat,lon ..." → a closed GeoJSON ring of [lon, lat]. */
export function capPolygon(text) {
  const ring = String(text || '')
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(',').map(Number))
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon))
    .map(([lat, lon]) => [lon, lat]);
  if (ring.length < 3) return null;
  const [a, b] = [ring[0], ring.at(-1)];
  if (a[0] !== b[0] || a[1] !== b[1]) ring.push([...a]);
  return ring;
}

/** Atom feed → [{id, title, updated, links[], event, polygons}] (embedded CAP fields when present). */
export function parseAeaFeed(xml) {
  if (!/<feed\b/i.test(String(xml || ''))) return null;
  return tags(xml, 'entry').map((e) => ({
    id: tag(e, 'id'),
    title: tag(e, 'title'),
    updated: tag(e, 'updated'),
    summary: tag(e, 'summary') || tag(e, 'content'),
    links: [...e.matchAll(/<link\b[^>]*href="([^"]+)"/gi)].map((m) => unxml(m[1])),
    event: tag(e, 'event'),
    polygons: tags(e, 'polygon').map((p) => capPolygon(unxml(p))).filter(Boolean),
  }));
}

/** The CAP XML address for a feed entry, if it can be found. */
export function capUrlFor(entry) {
  const all = [...(entry.links || []), entry.id || ''];
  const xml = all.find((u) => /^https?:\/\/.*\/aea\/cap\/.*\.xml$/i.test(u));
  if (xml) return xml;
  const htm = all.find((u) => /^https?:\/\/.*\/aea\/cap\/.*\.html?$/i.test(u));
  return htm ? htm.replace(/\.html?$/i, '.xml') : null;
}

/** CAP 1.x XML → the fields used here (English info block). */
export function parseCap(xml) {
  const s = String(xml || '');
  if (!/<alert\b/i.test(s)) return null;
  const infos = tags(s, 'info');
  const info = infos.find((i) => /<language>\s*en/i.test(i)) || infos[0] || '';
  const codes = [...info.matchAll(/<eventCode>[\s\S]*?<value>([^<]*)<\/value>[\s\S]*?<\/eventCode>/gi)].map((m) => unxml(m[1]));
  const areas = tags(info, 'area').map((a) => ({
    desc: tag(a, 'areaDesc'),
    polygons: tags(a, 'polygon').map((p) => capPolygon(unxml(p))).filter(Boolean),
  }));
  return {
    identifier: tag(s, 'identifier'),
    sent: tag(s, 'sent'),
    status: tag(s, 'status'),
    msgType: tag(s, 'msgType'),
    references: tag(s, 'references'),
    category: tag(info, 'category'),
    event: tag(info, 'event'),
    eventCodes: codes,
    severity: tag(info, 'severity'),
    effective: tag(info, 'effective'),
    expires: tag(info, 'expires'),
    senderName: tag(info, 'senderName'),
    headline: tag(info, 'headline'),
    description: tag(info, 'description'),
    areas,
  };
}

const TELECOM_CODES = new Set(['911service', 'telephoneservice']);
const TELECOM_TEXT = /\b(9-?1-?1|telephone|landline|phone service|internet|telecom|cellular|cell service|wireless service|communications? (outage|service|disruption))\b/i;

/** True for alerts about phone / 911 / internet service, not fires or floods. */
export function isTelecomAlert(cap) {
  if (!cap) return false;
  if (cap.eventCodes?.some((c) => TELECOM_CODES.has(String(c).toLowerCase()))) return true;
  if (TELECOM_TEXT.test(cap.event || '')) return true;
  return /^infra$/i.test(cap.category || '') && TELECOM_TEXT.test(`${cap.headline || ''} ${cap.description || ''}`);
}

const NAMED = [
  ['telus', /\btelus\b/i],
  ['rogers', /\b(rogers|shaw)\b/i],
  ['bell', /\bbell\b/i],
  ['eastlink', /\beastlink\b/i],
  ['xplore', /\bxplor(e|net)\b/i],
  ['starlink', /\bstarlink\b/i],
  ['sasktel', /\bsasktel\b/i],
];

/** A telecom CAP alert → a provider notice the map and site matching understand. */
export function noticeFromCap(cap, link = AEA_PAGE) {
  const text = `${cap.event || ''} ${cap.headline || ''} ${cap.description || ''}`;
  const services = [];
  if (/9-?1-?1/.test(text)) services.push('911');
  if (/telephone|landline|home phone|phone service/i.test(text)) services.push('Home Phone');
  if (/\binternet\b/i.test(text)) services.push('Internet');
  if (/cell(ular)?\b|wireless|mobile/i.test(text)) services.push('Mobile');
  const polygons = cap.areas.flatMap((a) => a.polygons).map((ring) => [ring]);
  const startMs = Date.parse(cap.effective || cap.sent || '') || null;
  return {
    id: `aea:${cap.identifier}`,
    provider: 'aea',
    kind: 'outage',
    province: 'AB',
    title: cap.event || 'Telecom alert',
    detail: String(cap.description || cap.headline || '').replace(/\s+/g, ' ').slice(0, 400),
    services: services.length ? services : ['Phone'],
    internet: services.includes('Internet'),
    mentions: NAMED.filter(([, re]) => re.test(text)).map(([k]) => k),
    area: cap.areas.map((a) => a.desc).filter(Boolean).join('; ').replace(/^This alert is in effect for\s*/i, '').replace(/\.$/, ''),
    sender: cap.senderName || null,
    polygons,
    point: polygons.length ? centroid(polygons[0][0]) : null,
    startMs,
    endMs: Date.parse(cap.expires || '') || null,
    link,
  };
}

function centroid(ring) {
  let lat = 0;
  let lon = 0;
  const n = Math.max(1, ring.length - 1);
  for (const [x, y] of ring.slice(0, n)) {
    lon += x;
    lat += y;
  }
  return { lat: lat / n, lon: lon / n };
}

/**
 * Feed → telecom notices in effect. Cancelled and expired alerts drop out;
 * an update replaces the alert it references.
 */
export async function loadAeaNotices({ requestText, nowMs, log = console }) {
  const feed = parseAeaFeed(await requestText(AEA_FEED, { headers: { Accept: 'application/atom+xml' } }));
  if (!feed) throw new Error('Unexpected Alberta Emergency Alert feed');
  const caps = [];
  for (const entry of feed.slice(0, 40)) {
    const url = capUrlFor(entry);
    let cap = null;
    if (url) {
      try {
        cap = parseCap(await requestText(url, { headers: { Accept: 'application/xml' } }));
      } catch (error) {
        log.warn?.(`[aea] ${url}: ${error?.message}`);
      }
    }
    // Fall back to what the feed entry itself carries.
    cap ??= {
      identifier: entry.id,
      event: entry.event || entry.title,
      eventCodes: [],
      category: 'Infra',
      headline: entry.title,
      description: entry.summary,
      effective: entry.updated,
      areas: [{ desc: null, polygons: entry.polygons }],
    };
    const page = url ? url.replace(/\.xml$/i, '.htm') : AEA_PAGE;
    caps.push({ cap, page });
  }
  const replaced = new Set(caps.flatMap(({ cap }) => String(cap.references || '').split(/\s+/).map((r) => r.split(',')[1]).filter(Boolean)));
  return caps
    .filter(({ cap }) => !replaced.has(cap.identifier))
    .filter(({ cap }) => !/cancel/i.test(cap.msgType || '') && !/^(test|exercise|draft)$/i.test(cap.status || ''))
    .filter(({ cap }) => !cap.expires || Date.parse(cap.expires) > nowMs)
    .filter(({ cap }) => isTelecomAlert(cap))
    .map(({ cap, page }) => noticeFromCap(cap, page));
}
