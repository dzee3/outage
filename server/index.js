import http from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestJson, requestRaw, requestText } from './http.js';
import { createIspStatus } from './isp-status.js';
import { albertaSources, ALBERTA_UNMONITORED } from './sources/alberta.js';
import { canadaSources, CANADA_UNMONITORED } from './sources/canada.js';
import { iodaSource } from './sources/ioda.js';
import { createTerritory } from './territory.js';
import { createGeocoder } from './geocode.js';
import { createIspLookup, watchedAsns, NBM_PAGE } from './isp.js';
import { utilityById } from './utilities.js';
import { demoSources, demoInternet } from './demo.js';
import { createStore, sitesFromCsv, sitesToCsv } from './store.js';
import { createMonitor, provinceOf } from './monitor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');

const env = process.env;
const config = {
  port: Number(env.PORT || 8080),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, 'data')),
  pollSeconds: Math.max(30, Number(env.POLL_SECONDS || 60)),
  demo: env.DEMO === '1',
  internet: env.INTERNET !== 'off',
  editToken: env.EDIT_TOKEN || '',
};

const now = () => Date.now();
const request = (url, options) => requestJson(url, options);

const PROVINCE_NAMES = {
  BC: 'British Columbia', AB: 'Alberta', SK: 'Saskatchewan', MB: 'Manitoba', ON: 'Ontario',
  NB: 'New Brunswick', NS: 'Nova Scotia', PE: 'Prince Edward Island', NL: 'Newfoundland and Labrador',
};

const store = createStore(config.dataDir, { now });
if (config.demo && store.listSites().length === 0) {
  const demoSites = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/demo-sites.json'), 'utf8'));
  store.replaceSites(demoSites);
}

// Province outlines: used to place client sites in a province. Missing outlines
// degrade site matching instead of stopping the server.
let provinces = { type: 'FeatureCollection', features: [] };
try {
  provinces = JSON.parse(readFileSync(path.join(WEB, 'data/provinces.geojson'), 'utf8'));
} catch (error) {
  console.error(`[outages] province outlines unavailable (${error.message}); sites will show "not monitored"`);
}

const sources = config.demo
  ? demoSources({ fixturePath: path.join(ROOT, 'fixtures/demo-alberta.json'), now })
  : [...albertaSources({ request, now }), ...canadaSources({ request, now })];

// Provinces with at least one live power feed, and what is not covered there.
const coverage = {};
for (const src of sources) {
  const c = (coverage[src.province] ??= {
    name: PROVINCE_NAMES[src.province] || src.province,
    sources: [],
    unmonitored: src.province === 'AB' ? ALBERTA_UNMONITORED : CANADA_UNMONITORED[src.province] || [],
  });
  c.sources.push(src.id);
}

const territory = createTerritory({ dataDir: config.dataDir, requestRaw, requestJson: request, now });
const geocoder = createGeocoder({ request });
const isp = createIspLookup({ request, dataDir: config.dataDir, now });
const ispStatus = createIspStatus({ request, requestText, geocoder, now });

/** Who supplies a site: the technician's choice, else the territory lookup. */
const utilityCache = new Map();
function utilityFor(site, province) {
  if (site.utility) {
    const u = utilityById(site.utility);
    const options = province ? territory.options(province) : [];
    const name = u?.name || options.find((o) => o.id === site.utility)?.name || site.utility;
    return { id: site.utility, name, monitored: Boolean(u?.source), source: u?.source || null, confidence: 'chosen' };
  }
  const key = `${site.lat},${site.lon},${province}`;
  if (!utilityCache.has(key)) {
    const { options, ...guess } = territory.lookup({ lat: site.lat, lon: site.lon, province });
    utilityCache.set(key, guess.id ? guess : null);
    if (utilityCache.size > 5000) utilityCache.clear();
  }
  return utilityCache.get(key);
}

const monitor = createMonitor({
  sources,
  internetSource: !config.internet
    ? null
    : config.demo
      ? demoInternet({ now })
      : iodaSource({ request, now, watched: () => watchedAsns(store.listSites()) }),
  store,
  provinces,
  coverage,
  utilityFor,
  ispFor: config.demo ? null : (site) => ispStatus.statusFor(site),
  now,
});
if (!config.demo)
  territory.refresh().then(() => {
    utilityCache.clear();
    monitor.reassess();
  });

// ------------------------------------------------------------------ HTTP --

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tiles.openfreemap.org",
  "connect-src 'self' https://tiles.openfreemap.org",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
const json = (res, status, value) =>
  send(res, status, JSON.stringify(value), {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Upload is larger than 1 MB.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function canEdit(req) {
  return !config.editToken || req.headers['x-edit-token'] === config.editToken;
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/tv') rel = '/index.html';
  const file = path.normalize(path.join(WEB, rel));
  if (!file.startsWith(WEB + path.sep) || !existsSync(file) || !statSync(file).isFile())
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  const ext = path.extname(file);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    ...(ext === '.html' ? { 'Content-Security-Policy': PAGE_CSP } : {}),
  });
  createReadStream(file).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  try {
    if (p === '/healthz') return json(res, 200, { ok: true, demo: config.demo });
    if (p === '/api/snapshot' && req.method === 'GET') {
      const snap = monitor.snapshot() || (await monitor.tick());
      return json(res, 200, {
        ...snap,
        ispNotices: ispStatus.notices().map(({ text, ...n }) => n),
        ispSources: ispStatus.health(),
        demo: config.demo,
        canEdit: !config.editToken,
        editProtected: Boolean(config.editToken),
      });
    }
    if (p === '/api/history' && req.method === 'GET') {
      const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours') || 24)));
      return json(res, 200, { points: store.historySince(now() - hours * 3600_000) });
    }
    if (p === '/api/events' && req.method === 'GET') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
      return json(res, 200, { events: store.recentEvents(limit) });
    }
    if (p === '/api/geocode' && req.method === 'GET') {
      const results = await geocoder.search(url.searchParams.get('q'));
      return json(res, 200, { results, attribution: '© OpenStreetMap contributors (Nominatim, Photon); Natural Resources Canada (Geolocator)' });
    }
    if (p === '/api/lookup' && req.method === 'GET') {
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
        return json(res, 400, { error: 'lat and lon are required.' });
      const province = provinceOf({ lat, lon }, provinces);
      const [place, internet] = await Promise.allSettled([geocoder.reverse(lat, lon), isp.at(lat, lon)]);
      const address = place.status === 'fulfilled' ? place.value : null;
      const power = territory.lookup({ lat, lon, province, city: address?.city });
      return json(res, 200, {
        lat,
        lon,
        province,
        provinceName: PROVINCE_NAMES[province] || null,
        covered: Boolean(coverage[province]),
        address,
        addressError: place.status === 'rejected' ? place.reason?.message : null,
        power,
        internet: internet.status === 'fulfilled' ? internet.value : null,
        internetError: internet.status === 'rejected' ? internet.reason?.message : null,
        internetSource: NBM_PAGE,
      });
    }
    if (p === '/api/isp/check' && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      const site = { lat: Number(q.lat), lon: Number(q.lon), isp: q.isp, city: q.city, area: q.area };
      if (!Number.isFinite(site.lat) || !Number.isFinite(site.lon)) return json(res, 400, { error: 'lat and lon are required.' });
      return json(res, 200, { status: ispStatus.statusFor(site) });
    }
    if (p === '/api/isp/area' && req.method === 'GET') {
      const b = String(url.searchParams.get('bbox') || '').split(',').map(Number);
      if (b.length !== 4 || !b.every(Number.isFinite)) return json(res, 400, { error: 'bbox=w,s,e,n is required.' });
      if (b[2] - b[0] > 4 || b[3] - b[1] > 3) return json(res, 400, { error: 'Zoom in further to list internet providers.' });
      return json(res, 200, await isp.area(b));
    }
    if (p === '/api/territories' && req.method === 'GET')
      return send(res, 200, JSON.stringify(territory.geojson()), {
        'Content-Type': 'application/geo+json',
        'Cache-Control': 'public, max-age=3600',
      });
    if (p === '/api/utilities' && req.method === 'GET') {
      const province = String(url.searchParams.get('province') || '').toUpperCase();
      return json(res, 200, { province, utilities: territory.options(province), status: territory.status() });
    }
    if (p === '/api/sites/export.csv' && req.method === 'GET')
      return send(res, 200, sitesToCsv(store.listSites()), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="client-sites.csv"',
        'Cache-Control': 'no-store',
      });
    if (p.startsWith('/api/sites')) {
      if (req.method !== 'GET' && !canEdit(req))
        return json(res, 403, { error: 'Editing sites needs the edit code (EDIT_TOKEN).' });
      if (p === '/api/sites' && req.method === 'GET') return json(res, 200, { sites: store.listSites() });
      if (p === '/api/sites' && req.method === 'POST') {
        const site = store.addSite(JSON.parse(await readBody(req)));
        utilityCache.clear();
        monitor.reassess();
        return json(res, 201, { site });
      }
      if (p === '/api/sites/import' && req.method === 'POST') {
        const { sites, errors } = sitesFromCsv(await readBody(req));
        if (!sites.length) return json(res, 400, { error: errors[0] || 'No sites found.', errors });
        const count = store.replaceSites(sites, { append: url.searchParams.get('mode') !== 'replace' });
        monitor.reassess();
        return json(res, 200, { imported: count, errors });
      }
      const match = /^\/api\/sites\/([0-9a-f-]{36})$/.exec(p);
      if (match && req.method === 'PUT') {
        const site = store.updateSite(match[1], JSON.parse(await readBody(req)));
        if (!site) return json(res, 404, { error: 'That site no longer exists.' });
        utilityCache.clear();
        monitor.reassess();
        return json(res, 200, { site });
      }
      if (match && req.method === 'DELETE') {
        if (!store.removeSite(match[1])) return json(res, 404, { error: 'That site no longer exists.' });
        monitor.reassess();
        return json(res, 200, { removed: true });
      }
      return json(res, 404, { error: 'Unknown sites route.' });
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'Unknown API route.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, p);
  } catch (error) {
    const status = error.status || (error instanceof SyntaxError ? 400 : 400);
    return json(res, status, { error: error.message || 'Request failed.' });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => json(res, 500, { error: String(error?.message || error) }));
});

server.listen(config.port, config.host, () => {
  console.log(
    `[outages] listening on http://${config.host}:${config.port}` +
      `${config.demo ? ' (DEMO data)' : ''}; data in ${config.dataDir}`,
  );
});

// Poll in the background so history and alerts keep going with no one watching.
await monitor.tick();
if (config.demo && store.historySince(now() - 24 * 3600_000).length < 2) seedDemoHistory();

/** Demo only: a made-up 24 h curve (an overnight wind event) so the chart has a shape. */
function seedDemoHistory() {
  const t1 = now();
  const base = { atco: 18, fortis: 0, enmax: 133, epcor: 0 };
  for (let t = t1 - 24 * 3600_000; t < t1; t += 5 * 60_000) {
    const hAgo = (t1 - t) / 3600_000;
    const storm = Math.max(0, 1 - Math.abs(hAgo - 15) / 4);
    const wiggle = 0.85 + 0.3 * Math.abs(Math.sin(t / 3_700_000));
    const bySource = {
      atco: Math.round((base.atco + storm * 2600) * wiggle),
      fortis: Math.round(storm * 6800 * wiggle),
      enmax: Math.round((hAgo < 2 ? base.enmax : 12) * wiggle),
      epcor: Math.round(storm * 900 * wiggle),
    };
    store.addHistory({
      t,
      bySource,
      customersOut: Object.values(bySource).reduce((a, b) => a + b, 0),
      internet: hAgo < 0.8 ? ['BC'] : [],
    });
  }
  const ev = (minsAgo, e) => ({ t: t1 - minsAgo * 60_000, ...e });
  store.addEvents([
    ev(900, { type: 'outage-started', id: 'demo:1', utility: 'fortis', area: 'Athabasca', customers: 6250 }),
    ev(860, { type: 'outage-started', id: 'demo:2', utility: 'atco', area: 'Lac La Biche', customers: 2100 }),
    ev(640, { type: 'outage-ended', id: 'demo:2', utility: 'atco', area: 'Lac La Biche', startMs: t1 - 860 * 60_000 }),
    ev(560, { type: 'outage-ended', id: 'demo:1', utility: 'fortis', area: 'Athabasca', startMs: t1 - 900 * 60_000 }),
    ev(66, { type: 'planned-started', id: 'demo:3', utility: 'enmax', area: 'Beltline', customers: 108 }),
    ev(66, { type: 'site-status', siteId: 'demo', site: 'Beltline office (example)', from: 'planned', to: 'near' }),
    ev(47, { type: 'site-status', siteId: 'demo', site: 'Kelowna branch (example)', from: 'no-coverage', to: 'internet' }),
  ]);
}
const timer = setInterval(() => {
  monitor.tick().catch((error) => console.error('[outages] tick failed', error));
}, config.pollSeconds * 1000);
// Provider outage pages: own 5-minute schedule; re-score sites when they change.
async function pollIsps() {
  if (config.demo) return;
  await ispStatus.refresh();
  monitor.reassess();
}
pollIsps().catch((error) => console.error('[isp-status] poll failed', error));
const ispTimer = setInterval(() => pollIsps().catch(() => {}), 60_000);
ispTimer.unref();

// Sites added by CSV (or before this version) get a city and neighbourhood,
// which provider notices are matched against. A few per minute.
const backfillTried = new Set();
const backfillTimer = setInterval(async () => {
  if (config.demo) return;
  const todo = store.listSites().filter((s) => !s.city && !backfillTried.has(s.id)).slice(0, 3);
  for (const site of todo) {
    backfillTried.add(site.id);
    try {
      const place = await geocoder.reverse(site.lat, site.lon);
      if (place?.city) store.updateSite(site.id, { city: place.city, area: place.area || '' });
    } catch {
      /* try again after a restart */
    }
  }
  if (todo.length) monitor.reassess();
}, 60_000);
backfillTimer.unref();

const territoryTimer = setInterval(() => {
  if (!config.demo)
    territory.refresh().then(() => {
      utilityCache.clear();
    });
}, 6 * 3600_000);
territoryTimer.unref();

for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
