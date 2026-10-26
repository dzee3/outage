import {
  normalizeAtcoActive,
  normalizeAtcoPlanned,
  normalizeFortis,
  normalizeEnmax,
  normalizeEpcor,
} from '../records.js';

/*
 * Alberta: the four distributors with live outage maps. Each is read the way
 * its own public map reads it. None of these are documented public APIs, so
 * each source reports its own health and the monitor keeps its last good
 * snapshot (flagged stale) when a poll fails.
 */

const LIVE_TTL_MS = 120_000;
const PLANNED_TTL_MS = 15 * 60_000;

// ATCO's public web-app Firebase configuration (shipped in its own page).
const ATCO_FIREBASE_KEY = 'AIzaSyBSiuJOrgTBjtT0ycyjDxmEXpfVfMz2U2w';
const ATCO_DOCS =
  'https://firestore.googleapis.com/v1/projects/outage-notification-291d8/databases/(default)/documents';
const FORTIS_API = 'https://fortisalberta.azure-api.net/outages';
const FORTIS_BBOX = 'north=61&south=48&east=-109&west=-121';
const ENMAX_API = 'https://powerservices.enmax.com/api/outage?type=Current';
const EPCOR_QUERY =
  'https://services6.arcgis.com/Ji2rusuWXDFSqNsP/ArcGIS/rest/services/ocps_prod_av/FeatureServer/0/query?' +
  new URLSearchParams({
    where: '1=1',
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  });

export const ALBERTA_UNMONITORED = Object.freeze([
  'Red Deer Electric Light & Power',
  'City of Lethbridge Electric',
  'City of Medicine Hat Electric',
  'Rural electrification associations (EQUS, Battle River and others)',
  'Town utilities (Cardston, Fort Macleod, Ponoka)',
]);

const tag = (rows) => rows.map((row) => ({ ...row, province: 'AB' }));

/** ATCO signs every map visitor in anonymously; so does this, once an hour. */
function createAtcoSession(request, now) {
  let session = null;
  let pending = null;
  async function signIn() {
    const clock = now();
    if (session?.refreshToken) {
      try {
        const r = await request(
          `https://securetoken.googleapis.com/v1/token?key=${ATCO_FIREBASE_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: session.refreshToken,
            }).toString(),
          },
        );
        if (r?.id_token) {
          session = {
            idToken: r.id_token,
            refreshToken: r.refresh_token || session.refreshToken,
            expiresAt: clock + Number(r.expires_in || 3600) * 1000,
          };
          return session.idToken;
        }
      } catch {
        // Fall through to a fresh anonymous session.
      }
    }
    const r = await request(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${ATCO_FIREBASE_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }),
      },
    );
    if (!r?.idToken) throw new Error('ATCO sign-in failed');
    session = {
      idToken: r.idToken,
      refreshToken: r.refreshToken || null,
      expiresAt: clock + Number(r.expiresIn || 3600) * 1000,
    };
    return session.idToken;
  }
  return {
    token() {
      if (session && session.expiresAt - 300_000 > now())
        return Promise.resolve(session.idToken);
      pending ??= signIn().finally(() => {
        pending = null;
      });
      return pending;
    },
    reset() {
      session = null;
    },
  };
}

/**
 * @param {{request: Function, now: () => number}} ctx
 * @returns {Array<object>} source descriptors
 */
export function albertaSources({ request, now }) {
  const atco = createAtcoSession(request, now);
  async function atcoCollection(name) {
    const documents = [];
    let pageToken = '';
    for (let page = 0; page < 10; page++) {
      const token = await atco.token();
      const url =
        `${ATCO_DOCS}/${name}?pageSize=300&key=${ATCO_FIREBASE_KEY}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      let payload;
      try {
        payload = await request(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (error) {
        if (error.status === 401 || error.status === 403) atco.reset();
        throw error;
      }
      documents.push(...(payload?.documents || []));
      pageToken = payload?.nextPageToken || '';
      if (!pageToken) break;
    }
    return documents;
  }
  const must = (rows, what) => {
    if (!rows) throw new Error(`Unexpected ${what} response format`);
    return tag(rows);
  };
  const fortis = async (planned) => {
    const base = planned ? `${FORTIS_API}/planned` : FORTIS_API;
    const [markers, areas] = await Promise.all([
      request(`${base}/markers?${FORTIS_BBOX}`),
      request(`${base}/areas?${FORTIS_BBOX}`),
    ]);
    return must(
      normalizeFortis(markers, areas, { planned, nowMs: now() }),
      'FortisAlberta',
    );
  };

  return [
    {
      id: 'atco',
      name: 'ATCO Electric',
      province: 'AB',
      region: 'Northern and east-central Alberta',
      map: 'https://poweroutage.atco.com/map',
      feeds: [
        {
          id: 'live',
          ttl: LIVE_TTL_MS,
          load: async () =>
            must(normalizeAtcoActive(await atcoCollection('ActiveOutages')), 'ATCO'),
        },
        {
          id: 'planned',
          ttl: PLANNED_TTL_MS,
          load: async () =>
            must(
              normalizeAtcoPlanned(await atcoCollection('PlanOutages'), now()),
              'ATCO planned',
            ),
        },
      ],
    },
    {
      id: 'fortis',
      name: 'FortisAlberta',
      province: 'AB',
      region: 'Central and southern Alberta, rural and towns',
      map: 'https://service.fortisalberta.com/',
      feeds: [
        { id: 'live', ttl: LIVE_TTL_MS, load: () => fortis(false) },
        { id: 'planned', ttl: PLANNED_TTL_MS, load: () => fortis(true) },
      ],
    },
    {
      id: 'enmax',
      name: 'ENMAX Power',
      province: 'AB',
      region: 'Calgary',
      map: 'https://powerservices.enmax.com/',
      feeds: [
        {
          id: 'live',
          ttl: LIVE_TTL_MS,
          load: async () => must(normalizeEnmax(await request(ENMAX_API), now()), 'ENMAX'),
        },
      ],
    },
    {
      id: 'epcor',
      name: 'EPCOR',
      province: 'AB',
      region: 'Edmonton',
      map: 'https://outages.epcor.com/#/outages/power/edmonton',
      feeds: [
        {
          id: 'live',
          ttl: LIVE_TTL_MS,
          load: async () => must(normalizeEpcor(await request(EPCOR_QUERY)), 'EPCOR'),
        },
      ],
    },
  ];
}
