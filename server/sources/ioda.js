/*
 * Internet connectivity, by province, from IODA (Georgia Tech's Internet
 * Outage Detection and Analysis). Coarse by nature: IODA reports a whole
 * province's connectivity dropping (BGP, active probing, telescope), never a
 * town or a street. Its responses carry "Copyright Georgia Tech Research
 * Corporation, all rights reserved" and no other terms; this reads it the way
 * IODA's own public dashboard does and links back to it.
 */

const API = 'https://api.ioda.inetintel.cc.gatech.edu/v2';
export const IODA_DASHBOARD = 'https://ioda.inetintel.cc.gatech.edu/country/CA';
const LOOKBACK_S = 12 * 3600;
/** An event whose end is this close to "now" is treated as still going. */
const ONGOING_SLACK_S = 20 * 60;
const ENTITY_TTL_MS = 24 * 3600_000;

const PROVINCES = {
  AB: 'alberta',
  BC: 'british columbia',
  MB: 'manitoba',
  NB: 'new brunswick',
  NL: 'newfoundland and labrador',
  NS: 'nova scotia',
  NT: 'northwest territories',
  NU: 'nunavut',
  ON: 'ontario',
  PE: 'prince edward island',
  QC: 'quebec',
  SK: 'saskatchewan',
  YT: 'yukon',
};

const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+territory$/, '')
    .trim();

/** IODA region name → two-letter province code, or null. */
export function provinceCodeFor(name) {
  const folded = fold(name);
  for (const [code, provinceName] of Object.entries(PROVINCES))
    if (folded === provinceName) return code;
  if (folded === 'newfoundland') return 'NL';
  return null;
}

/**
 * Turn IODA events into per-province status.
 * @param {Array} events outages/events data
 * @param {Map<string,string>} codeToProvince IODA entity code → province code
 * @param {number} nowS epoch seconds
 */
export function summarizeIoda(events, codeToProvince, nowS) {
  const provinces = {};
  for (const code of Object.keys(PROVINCES))
    provinces[code] = { code, active: false, score: 0, signals: [], since: null, lastEventAt: null };
  const recent = [];
  for (const event of Array.isArray(events) ? events : []) {
    const province = codeToProvince.get(String(event?.entity?.code));
    if (!province) continue;
    const from = Number(event.from);
    const until = Number(event.until);
    if (!Number.isFinite(from) || !Number.isFinite(until)) continue;
    const ongoing = until >= nowS - ONGOING_SLACK_S;
    const p = provinces[province];
    p.lastEventAt = Math.max(p.lastEventAt ?? 0, until * 1000);
    recent.push({
      province,
      fromMs: from * 1000,
      untilMs: until * 1000,
      ongoing,
      score: Number(event.score) || 0,
      signal: String(event.datasource || ''),
    });
    if (!ongoing) continue;
    p.active = true;
    p.score = Math.max(p.score, Number(event.score) || 0);
    if (event.datasource && !p.signals.includes(event.datasource))
      p.signals.push(String(event.datasource));
    p.since = p.since == null ? from * 1000 : Math.min(p.since, from * 1000);
  }
  recent.sort((a, b) => b.untilMs - a.untilMs);
  return { provinces, recent: recent.slice(0, 50) };
}

/** IODA per-network (ASN) events → {asn: {asn, name, active, since, score, signals}}. */
export function summarizeNetworks(events, names, nowS) {
  const networks = {};
  for (const [asn, name] of names) networks[asn] = { asn: Number(asn), name, active: false, score: 0, signals: [], since: null };
  for (const event of Array.isArray(events) ? events : []) {
    const asn = String(event?.entity?.code ?? '');
    const n = networks[asn];
    if (!n) continue;
    const from = Number(event.from);
    const until = Number(event.until);
    if (!Number.isFinite(from) || !Number.isFinite(until)) continue;
    if (until < nowS - ONGOING_SLACK_S) continue;
    n.active = true;
    n.score = Math.max(n.score, Number(event.score) || 0);
    if (event.datasource && !n.signals.includes(event.datasource)) n.signals.push(String(event.datasource));
    n.since = n.since == null ? from * 1000 : Math.min(n.since, from * 1000);
  }
  return networks;
}

export function iodaSource({ request, now, watched = () => new Map() }) {
  let entities = null;
  let entitiesAt = 0;
  const get = async (path, params) => {
    const payload = await request(`${API}/${path}?${new URLSearchParams(params)}`, {
      tls12: true,
    });
    if (payload?.error) throw new Error(String(payload.error));
    return payload?.data;
  };
  return {
    id: 'ioda',
    name: 'IODA internet connectivity',
    region: 'All provinces and territories, province level only',
    map: IODA_DASHBOARD,
    ttl: 5 * 60_000,
    async load() {
      if (!entities || now() - entitiesAt > ENTITY_TTL_MS) {
        const list = await get('entities/query', {
          entityType: 'region',
          relatedTo: 'country/CA',
        });
        const map = new Map();
        for (const entity of Array.isArray(list) ? list : []) {
          const province = provinceCodeFor(entity?.name);
          if (province) map.set(String(entity.code), province);
        }
        if (!map.size) throw new Error('IODA returned no Canadian regions');
        entities = map;
        entitiesAt = now();
      }
      const nowS = Math.floor(now() / 1000);
      const events = await get('outages/events', {
        entityType: 'region',
        entityCode: [...entities.keys()].join(','),
        from: String(nowS - LOOKBACK_S),
        until: String(nowS),
        format: 'ioda',
      });
      const summary = summarizeIoda(events, entities, nowS);
      // Provider networks: a lost network shows here before (or without) a
      // whole province dipping. Failure here keeps the province data.
      const names = watched();
      summary.networks = {};
      if (names.size) {
        try {
          const netEvents = await get('outages/events', {
            entityType: 'asn',
            entityCode: [...names.keys()].join(','),
            from: String(nowS - LOOKBACK_S),
            until: String(nowS),
            format: 'ioda',
          });
          summary.networks = summarizeNetworks(netEvents, names, nowS);
        } catch (error) {
          summary.networksError = String(error?.message || error).slice(0, 200);
        }
      }
      return summary;
    },
  };
}
