import { summarize } from './records.js';
import {
  distanceKm,
  distanceToPolygonsKm,
  pointInPolygons,
  polygonsOf,
} from './geo.js';

/** Past this, a failing source's last good snapshot is withdrawn. */
export const STALE_DROP_MS = 30 * 60_000;
export const DEFAULT_RADIUS_KM = 3;
const HISTORY_EVERY_MS = 5 * 60_000;
const BIG_OUTAGE = 1000;

const STATUS_RANK = {
  out: 0,
  near: 1,
  internet: 2,
  planned: 3,
  ok: 4,
  'no-coverage': 5,
};

/** Which province a point falls in, from the bundled outlines. */
export function provinceOf(point, provinces) {
  let nearest = null;
  let nearestKm = 25; // simplified coastlines: harbour-front sites fall just offshore
  for (const feature of provinces?.features || []) {
    const polygons = polygonsOf(feature.geometry);
    if (pointInPolygons(point, polygons)) return feature.properties.code;
    const km = distanceToPolygonsKm(point, polygons);
    if (km < nearestKm) {
      nearestKm = km;
      nearest = feature.properties.code;
    }
  }
  return nearest;
}

/**
 * Work out how outages affect one client site.
 * @returns {{status, province, outages: Array<{id, relation, distanceKm}>, internet: boolean}}
 */
export function siteImpact(site, rows, { provinces, coverage, internet }) {
  const point = { lat: site.lat, lon: site.lon };
  const radius = site.radiusKm || DEFAULT_RADIUS_KM;
  const province = provinceOf(point, provinces);
  const hits = [];
  for (const row of rows) {
    let relation = null;
    let distance;
    if (row.polygons?.length && pointInPolygons(point, row.polygons)) {
      relation = 'inside';
      distance = 0;
    } else {
      distance = row.polygons?.length
        ? distanceToPolygonsKm(point, row.polygons)
        : distanceKm(point, row.point);
      if (distance <= radius) relation = 'near';
    }
    if (!relation) continue;
    hits.push({
      id: row.stableId,
      kind: row.kind,
      relation,
      distanceKm: Math.round(distance * 10) / 10,
    });
  }
  hits.sort((a, b) => a.distanceKm - b.distanceKm);
  const live = hits.filter((h) => h.kind !== 'planned-upcoming');
  const internetActive = Boolean(province && internet?.provinces?.[province]?.active);
  let status;
  if (live.some((h) => h.relation === 'inside')) status = 'out';
  else if (live.length) status = 'near';
  else if (internetActive) status = 'internet';
  else if (hits.length) status = 'planned';
  else if (!province || !coverage[province]) status = 'no-coverage';
  else status = 'ok';
  return { status, province, outages: hits.slice(0, 5), internet: internetActive };
}

/**
 * Poll every source on its own schedule, keep the last good data per feed,
 * and assemble one snapshot for the dashboard.
 */
export function createMonitor({
  sources,
  internetSource = null,
  store,
  provinces,
  coverage,
  now = () => Date.now(),
  log = console,
}) {
  /** `${source}:${feed}` → {rows, lastSuccessAt, lastAttemptAt, error} */
  const feeds = new Map();
  let internet = { status: 'off', provinces: {}, recent: [] };
  let internetState = { value: null, lastSuccessAt: null, lastAttemptAt: 0, error: null };
  let snapshot = null;
  let previousRows = null;
  let previousSiteStatus = new Map();
  let lastHistoryAt = 0;
  let running = null;

  async function refreshFeed(source, feed) {
    const key = `${source.id}:${feed.id}`;
    const prior = feeds.get(key);
    if (prior && now() - prior.lastAttemptAt < feed.ttl) return;
    const attemptAt = now();
    try {
      const rows = await feed.load();
      feeds.set(key, { rows, lastSuccessAt: now(), lastAttemptAt: attemptAt, error: null });
    } catch (error) {
      feeds.set(key, {
        rows: prior?.rows || null,
        lastSuccessAt: prior?.lastSuccessAt || null,
        lastAttemptAt: attemptAt,
        error: String(error?.message || error).slice(0, 200),
      });
      log.warn?.(`[outages] ${key} failed: ${error?.message}`);
    }
  }

  async function refreshInternet() {
    if (!internetSource) return;
    if (now() - internetState.lastAttemptAt < internetSource.ttl) return;
    const attemptAt = now();
    try {
      const value = await internetSource.load();
      internetState = { value, lastSuccessAt: now(), lastAttemptAt: attemptAt, error: null };
    } catch (error) {
      internetState = {
        ...internetState,
        lastAttemptAt: attemptAt,
        error: String(error?.message || error).slice(0, 200),
      };
      log.warn?.(`[outages] internet failed: ${error?.message}`);
    }
  }

  function assemble() {
    const clock = now();
    const usable = (s) => s?.rows && s.lastSuccessAt && clock - s.lastSuccessAt < STALE_DROP_MS;
    const rows = [];
    const sourceViews = sources.map((source) => {
      const states = source.feeds.map((f) => feeds.get(`${source.id}:${f.id}`));
      const live = states[0];
      const sourceRows = states.filter(usable).flatMap((s) => s.rows);
      rows.push(...sourceRows);
      let status = 'ok';
      if (!usable(live)) status = 'down';
      else if (live.error) status = 'stale';
      return {
        id: source.id,
        name: source.name,
        province: source.province,
        region: source.region,
        map: source.map,
        status,
        lastSuccessAt: live?.lastSuccessAt || null,
        error: live?.error || null,
        plannedError: states.length > 1 ? states[1]?.error || null : null,
        ...summarize(sourceRows),
      };
    });

    if (internetSource) {
      const fresh =
        internetState.value &&
        internetState.lastSuccessAt &&
        clock - internetState.lastSuccessAt < STALE_DROP_MS;
      internet = {
        id: internetSource.id,
        name: internetSource.name,
        region: internetSource.region,
        map: internetSource.map,
        status: !fresh ? 'down' : internetState.error ? 'stale' : 'ok',
        lastSuccessAt: internetState.lastSuccessAt,
        error: internetState.error,
        provinces: fresh ? internetState.value.provinces : {},
        recent: fresh ? internetState.value.recent : [],
      };
    }

    const sites = store.listSites().map((site) => ({
      ...site,
      impact: siteImpact(site, rows, { provinces, coverage, internet }),
    }));
    sites.sort(
      (a, b) =>
        STATUS_RANK[a.impact.status] - STATUS_RANK[b.impact.status] ||
        a.name.localeCompare(b.name),
    );

    const events = [];
    diffOutages(rows, clock, events);
    diffSites(sites, clock, events);
    store.addEvents(events);

    if (clock - lastHistoryAt >= HISTORY_EVERY_MS) {
      lastHistoryAt = clock;
      const bySource = {};
      for (const view of sourceViews)
        bySource[view.id] = view.status === 'down' ? null : view.customersOut;
      store.addHistory({
        t: clock,
        bySource,
        customersOut: summarize(rows).customersOut,
        internet: Object.values(internet.provinces || {})
          .filter((p) => p.active)
          .map((p) => p.code),
      });
    }

    snapshot = {
      fetchedAt: clock,
      totals: {
        ...summarize(rows),
        sourcesLive: sourceViews.filter((s) => s.status === 'ok').length,
        sourcesTotal: sourceViews.length,
        sitesAffected: sites.filter((s) => ['out', 'near', 'internet'].includes(s.impact.status)).length,
        sitesTotal: sites.length,
        internetAlerts: Object.values(internet.provinces || {}).filter((p) => p.active).length,
        bigOutages: rows.filter((r) => r.kind === 'unplanned' && (r.customers ?? 0) >= BIG_OUTAGE).length,
      },
      sources: sourceViews,
      coverage,
      internet,
      sites,
      rows,
    };
    return snapshot;
  }

  function diffOutages(rows, clock, events) {
    const current = new Map(
      rows.filter((r) => r.kind !== 'planned-upcoming').map((r) => [r.stableId, r]),
    );
    if (previousRows) {
      for (const [id, row] of current)
        if (!previousRows.has(id))
          events.push({
            t: clock,
            type: row.kind === 'unplanned' ? 'outage-started' : 'planned-started',
            id,
            utility: row.utility,
            area: row.area,
            customers: row.customers,
          });
      for (const [id, row] of previousRows)
        if (!current.has(id))
          events.push({
            t: clock,
            type: row.kind === 'unplanned' ? 'outage-ended' : 'planned-ended',
            id,
            utility: row.utility,
            area: row.area,
            customers: row.customers,
            startMs: row.startMs,
          });
    }
    previousRows = current;
  }

  function diffSites(sites, clock, events) {
    const next = new Map();
    for (const site of sites) {
      const status = site.impact.status;
      next.set(site.id, status);
      const before = previousSiteStatus.get(site.id);
      if (before !== undefined && before !== status)
        events.push({ t: clock, type: 'site-status', siteId: site.id, site: site.name, from: before, to: status });
    }
    previousSiteStatus = next;
  }

  async function tick() {
    running ??= (async () => {
      try {
        await Promise.all([
          ...sources.flatMap((s) => s.feeds.map((f) => refreshFeed(s, f))),
          refreshInternet(),
        ]);
        return assemble();
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    tick,
    /** Rebuild site impacts after a site edit, without polling. */
    reassess: () => assemble(),
    snapshot: () => snapshot,
  };
}
