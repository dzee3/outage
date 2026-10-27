import {
  normalizeAlectra,
  normalizeBcHydro,
  normalizeMaritime,
  normalizeNbPower,
  normalizeNfPower,
  normalizeOmsCases,
  normalizeSaskPower,
  normalizeSew,
  parseSaskPowerKml,
} from '../records-canada.js';
import { requestRaw, requestText } from '../http.js';
import { PROVINCE_ZONES } from '../zones.js';
import { kubraLegacy, kubraV2 } from './kubra.js';

/*
 * Utilities outside Alberta, one descriptor each, in the same shape as
 * sources/alberta.js. Every endpoint is the one the utility's own public
 * outage map calls; none is a documented public API, so each reports its own
 * health and the monitor keeps its last good data for 30 minutes.
 */

const LIVE_TTL_MS = 120_000;
const KUBRA_TTL_MS = 180_000;
const PLANNED_TTL_MS = 15 * 60_000;

const arcgisQuery = (layerUrl, extra = {}) =>
  `${layerUrl}/query?${new URLSearchParams({
    where: '1=1',
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
    ...extra,
  })}`;

const tagged = (province) => (rows, what) => {
  if (!rows) throw new Error(`Unexpected ${what} response format`);
  return rows.map((row) => ({ ...row, province }));
};

/** SEW "OuterOutage" portals need the page's session cookie and CSRF token. */
async function sewOuterOutage(pageUrl, requestFn = requestRaw) {
  const page = await requestFn(pageUrl);
  if (page.status !== 200) throw new Error(`Outage page HTTP ${page.status}`);
  const token = /id="hdnCSRFToken"[^>]*value="([^"]+)"/.exec(page.text)?.[1] ||
    /value="([^"]+)"[^>]*id="hdnCSRFToken"/.exec(page.text)?.[1];
  if (!token) throw new Error('Outage page has no CSRF token');
  const cookies = (page.headers.getSetCookie?.() || [page.headers.get('set-cookie') || ''])
    .map((c) => c.split(';')[0])
    .filter(Boolean)
    .join('; ');
  const r = await requestFn(new URL('OuterOutage.aspx/loadLatLongOuterOutage', pageUrl).href, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json',
      csrftoken: token,
      isajax: '1',
      Cookie: cookies,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({ Zipcode: '', IsPlannedOutage: 0, timeOffsetMinutes: 0 }),
  });
  if (r.status !== 200) throw new Error(`Outage data HTTP ${r.status}`);
  const outer = JSON.parse(r.text);
  const data = JSON.parse(outer.d);
  if (data?.dtException) throw new Error(String(data.dtException[0]?.MessageInformation || 'Portal error'));
  return data;
}

export function canadaSources({ request, now }) {
  const BC = tagged('BC');
  const SK = tagged('SK');
  const MB = tagged('MB');
  const ON = tagged('ON');
  const NB = tagged('NB');
  const NS = tagged('NS');
  const PE = tagged('PE');
  const NL = tagged('NL');

  // SaskPower region polygons barely change; fetch the 600 kB KML hourly.
  let skRegions = null;
  let skRegionsAt = 0;
  const saskPower = async () => {
    if (!skRegions || now() - skRegionsAt > 3600_000) {
      const kml = await requestText('https://www.saskpower.com/api/sitecore/Content/GetOutageKmlFile');
      const parsed = parseSaskPowerKml(kml);
      if (!parsed) throw new Error('Unexpected SaskPower KML');
      skRegions = parsed;
      skRegionsAt = now();
    }
    const json = await request('https://www.saskpower.com/api/sitecore/Content/GetOutageJsonFile');
    return SK(normalizeSaskPower(json, skRegions, now()), 'SaskPower');
  };

  const oms = (host, utility, province) => async () => {
    const xml = await requestText(`${host}/Outages/Home/UpdatePushpin`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    return tagged(province)(normalizeOmsCases(xml, { utility, zone: PROVINCE_ZONES[province], nowMs: now() }), utility);
  };

  const hydroOne = kubraV2({ request, now, utility: 'hydroone', stormcenter: 'b8d8094c-3809-49e5-bf8b-1ddd27f6e12d', view: '5c2283d7-eff9-4f7e-966b-3afd90d8a6b9', zone: PROVINCE_ZONES.ON });
  const torontoHydro = kubraV2({ request, now, utility: 'torontohydro', stormcenter: 'c3ecf8d4-47fb-4846-9070-70cb83d5368d', view: 'b7626c3d-feea-40d6-ae65-944aa67ffeea', zone: PROVINCE_ZONES.ON });
  const hydroOttawa = kubraV2({ request, now, utility: 'hydroottawa', stormcenter: '75aa35eb-53c1-42e0-b705-d8abcf71334a', view: '671ab4e4-6e66-453f-9179-040b44c3f155', zone: PROVINCE_ZONES.ON });
  const nsPower = kubraLegacy({ request, now, utility: 'nspower', host: 'https://outagemap.nspower.ca', bbox: [43.3, -66.6, 47.1, -59.6], minZoom: 6, zone: PROVINCE_ZONES.NS });

  const NB_FS = 'https://services1.arcgis.com/nXhKU3TMjpIZsCx0/arcgis/rest/services/PublicOutageFC_Prod/FeatureServer';
  const ME_FS = 'https://services.arcgis.com/IUHS0rm95L1JaTkq/arcgis/rest/services/PublicOutageRT_PROD/FeatureServer';
  const NP_FS = 'https://services1.arcgis.com/X4jBywOcHsB7HKqU/arcgis/rest/services/Public_Outage_Map_Prod/FeatureServer';
  const AL_FS = 'https://services8.arcgis.com/BiisLrqUuQvkdMCP/arcgis/rest/services/DEV_Outage_Layers/FeatureServer';

  return [
    // ---------------------------------------------------------------- BC --
    {
      id: 'bchydro',
      name: 'BC Hydro',
      province: 'BC',
      region: 'Most of British Columbia',
      map: 'https://www.bchydro.com/power-outages/app/outage-map.html',
      feeds: [
        {
          id: 'live',
          ttl: LIVE_TTL_MS,
          load: async () =>
            BC(normalizeBcHydro(await request('https://www.bchydro.com/power-outages/app/outages-map-data.json', { headers: { Referer: 'https://www.bchydro.com/power-outages/app/outage-map.html' } }), now()), 'BC Hydro'),
        },
      ],
    },
    {
      id: 'fortisbc',
      name: 'FortisBC',
      province: 'BC',
      region: 'Southern Interior (Okanagan, Kootenay, Boundary)',
      map: 'https://outages.fortisbc.com/Outages/Home/OutageMap',
      feeds: [{ id: 'live', ttl: LIVE_TTL_MS, load: oms('https://outages.fortisbc.com', 'fortisbc', 'BC') }],
    },
    // ---------------------------------------------------------------- SK --
    {
      id: 'saskpower',
      name: 'SaskPower',
      province: 'SK',
      region: 'Saskatchewan (by service region, no customer counts)',
      map: 'https://www.saskpower.com/outages/power-outages/outage-updates',
      feeds: [{ id: 'live', ttl: LIVE_TTL_MS, load: saskPower }],
    },
    {
      id: 'slp',
      name: 'Saskatoon Light & Power',
      province: 'SK',
      region: 'Central Saskatoon',
      map: 'https://outages.saskatoon.ca/outages',
      feeds: [{ id: 'live', ttl: LIVE_TTL_MS, load: oms('https://outages.saskatoon.ca', 'slp', 'SK') }],
    },
    // ---------------------------------------------------------------- MB --
    {
      id: 'mbhydro',
      name: 'Manitoba Hydro',
      province: 'MB',
      region: 'Manitoba',
      map: 'https://www.hydro.mb.ca/outages/outage-map/',
      feeds: [
        {
          id: 'live',
          ttl: LIVE_TTL_MS,
          load: async () =>
            MB(normalizeSew(await sewOuterOutage('https://account.hydro.mb.ca/Portal/OuterOutage.aspx'), { utility: 'mbhydro', zone: PROVINCE_ZONES.MB, nowMs: now() }), 'Manitoba Hydro'),
        },
      ],
    },
    // ---------------------------------------------------------------- ON --
    {
      id: 'hydroone',
      name: 'Hydro One',
      province: 'ON',
      region: 'Rural and small-town Ontario',
      map: 'https://stormcentre.hydroone.com/',
      feeds: [
        { id: 'live', ttl: KUBRA_TTL_MS, load: async () => ON(await hydroOne.live(), 'Hydro One') },
        { id: 'planned', ttl: PLANNED_TTL_MS, load: async () => ON(await hydroOne.planned(), 'Hydro One planned') },
      ],
    },
    {
      id: 'torontohydro',
      name: 'Toronto Hydro',
      province: 'ON',
      region: 'City of Toronto',
      map: 'https://outagemap.torontohydro.com/',
      feeds: [{ id: 'live', ttl: KUBRA_TTL_MS, load: async () => ON(await torontoHydro.live(), 'Toronto Hydro') }],
    },
    {
      id: 'alectra',
      name: 'Alectra Utilities',
      province: 'ON',
      region: 'GTA west and north, Hamilton, St. Catharines, Guelph, Barrie',
      map: 'https://experience.arcgis.com/experience/8371de586076441192a1fa7058816c00',
      feeds: [
        {
          id: 'live',
          ttl: LIVE_TTL_MS,
          load: async () => {
            const [cases, areas] = await Promise.all([request(arcgisQuery(`${AL_FS}/1`)), request(arcgisQuery(`${AL_FS}/2`))]);
            return ON(normalizeAlectra(cases, areas, now()), 'Alectra');
          },
        },
      ],
    },
    {
      id: 'hydroottawa',
      name: 'Hydro Ottawa',
      province: 'ON',
      region: 'Ottawa',
      map: 'https://outages.hydroottawa.com/',
      feeds: [
        { id: 'live', ttl: KUBRA_TTL_MS, load: async () => ON(await hydroOttawa.live(), 'Hydro Ottawa') },
        { id: 'planned', ttl: PLANNED_TTL_MS, load: async () => ON(await hydroOttawa.planned(), 'Hydro Ottawa planned') },
      ],
    },
    // ---------------------------------------------------------------- NB --
    {
      id: 'nbpower',
      name: 'NB Power',
      province: 'NB',
      region: 'New Brunswick',
      map: 'https://www.nbpower.com/Open/Outages.aspx',
      feeds: [
        {
          id: 'live',
          ttl: LIVE_TTL_MS,
          load: async () => {
            const [pts, hulls] = await Promise.all([request(arcgisQuery(`${NB_FS}/7`)), request(arcgisQuery(`${NB_FS}/8`))]);
            return NB(normalizeNbPower(pts, hulls), 'NB Power');
          },
        },
      ],
    },
    // ---------------------------------------------------------------- NS --
    {
      id: 'nspower',
      name: 'Nova Scotia Power',
      province: 'NS',
      region: 'Nova Scotia',
      map: 'https://outagemap.nspower.ca/',
      feeds: [{ id: 'live', ttl: KUBRA_TTL_MS, load: async () => NS(await nsPower(), 'NS Power') }],
    },
    // ---------------------------------------------------------------- PE --
    {
      id: 'maritime',
      name: 'Maritime Electric',
      province: 'PE',
      region: 'Prince Edward Island',
      map: 'https://www.maritimeelectric.com/outages/outage-map/outage-map/',
      feeds: [
        {
          id: 'live',
          ttl: LIVE_TTL_MS,
          load: async () => PE(normalizeMaritime(await request(arcgisQuery(`${ME_FS}/2`)), now()), 'Maritime Electric'),
        },
      ],
    },
    // ---------------------------------------------------------------- NL --
    {
      id: 'nfpower',
      name: 'Newfoundland Power',
      province: 'NL',
      region: 'Island of Newfoundland (most customers)',
      map: 'https://www.newfoundlandpower.com/en/Outages/Outage-Map',
      feeds: [
        {
          id: 'live',
          ttl: LIVE_TTL_MS,
          load: async () => NL(normalizeNfPower(await request(arcgisQuery(`${NP_FS}/0`)), { planned: false, nowMs: now() }), 'Newfoundland Power'),
        },
        {
          id: 'planned',
          ttl: PLANNED_TTL_MS,
          load: async () => NL(normalizeNfPower(await request(arcgisQuery(`${NP_FS}/1`)), { planned: true, nowMs: now() }), 'Newfoundland Power planned'),
        },
      ],
    },
    {
      id: 'nlhydro',
      name: 'NL Hydro',
      province: 'NL',
      region: 'Labrador, the Northern Peninsula and isolated systems',
      map: 'https://my.nlhydro.com/outage/',
      feeds: [
        {
          id: 'live',
          ttl: LIVE_TTL_MS,
          load: async () => {
            const [c, p] = await Promise.all([
              request('https://my.nlhydro.com/outage/json/GetOutageSummery_C.json'),
              request('https://my.nlhydro.com/outage/json/GetOutageSummery_P.json').catch(() => []),
            ]);
            const opts = { utility: 'nlhydro', zone: PROVINCE_ZONES.NL, nowMs: now() };
            const cur = normalizeSew(c, opts);
            const plan = normalizeSew(p, opts) || [];
            return NL(cur && [...cur, ...plan.map((r) => (r.kind === 'unplanned' ? { ...r, kind: 'planned-active' } : r))], 'NL Hydro');
          },
        },
      ],
    },
  ];
}

/** Utilities with no public live feed, listed so the gaps are visible. */
export const CANADA_UNMONITORED = Object.freeze({
  BC: ['City of New Westminster Electric', 'Nelson Hydro', 'Penticton, Summerland and Grand Forks city utilities'],
  SK: ['City of Swift Current Light & Power'],
  MB: [],
  ON: ['Elexicon, London Hydro, Enova, ENWIN and the other ~50 local distributors (their own sites)'],
  NB: ['Saint John Energy', 'Énergie Edmundston', 'Perth-Andover Electric Light Commission'],
  NS: ['Municipal utilities: Antigonish, Berwick, Mahone Bay, Riverport, Lunenburg'],
  PE: ['City of Summerside Electric'],
  NL: [],
});
