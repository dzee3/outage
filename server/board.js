/*
 * The provider board: one row per internet provider in a province, saying
 * what each public signal reports right now and how many clients it touches.
 */

import { providersIn, providerFor, signalsFor } from './providers.js';

const RECENT_MS = 7 * 86400_000;
const ORDER = { outage: 0, degraded: 1, planned: 2, unknown: 3, normal: 4, 'no-data': 5 };
const KIND_ORDER = { carrier: 0, reseller: 1, satellite: 2, rural: 3, regional: 4 };

export function providerBoard({ province = 'AB', notices = [], health = {}, networks = {}, networkStatus = 'ok', sites = [], nowMs = Date.now() }) {
  const rows = providersIn(province)
    .filter((p) => p.key !== 'reseller')
    .map((p) => {
      const inProvince = (n) => !n.province || n.province === province;
      const recent = (n) => n.kind === 'planned' || !n.startMs || nowMs - n.startMs <= RECENT_MS;
      const own = p.feed ? notices.filter((n) => n.provider === p.feed && inProvince(n)) : [];
      const internet = own.filter((n) => n.kind !== 'planned' && n.internet !== false && recent(n));
      const other = own.filter((n) => n.kind !== 'planned' && n.internet === false && recent(n));
      const planned = own.filter((n) => n.kind === 'planned');
      const older = own.filter((n) => n.kind !== 'planned' && !recent(n)).length;
      const alerts = notices.filter((n) => n.provider === 'aea' && n.mentions?.includes(p.key));
      const nets = p.asns.map((a) => networks?.[a]).filter(Boolean);
      const drop = nets.filter((n) => n.active);
      const clients = sites.filter((s) => providerFor(s.isp)?.key === p.key);
      const affected = clients.filter((s) => s.impact?.isp?.state === 'out' || (s.impact?.status === 'internet' && s.impact?.network));
      const feed = p.feed ? health[p.feed] : null;
      const signals = signalsFor(p);
      let state = 'normal';
      if (internet.length || alerts.length || affected.length) state = 'outage';
      else if (drop.length) state = 'degraded';
      else if (planned.length) state = 'planned';
      else if (!signals.length) state = 'no-data';
      // "Normal" only when some signal was actually read.
      const read =
        (feed && feed.status !== 'down') ||
        (nets.length > 0 && networkStatus !== 'down') ||
        (p.rides || []).some((r) => health[r] && health[r].status !== 'down') ||
        (p.address && clients.some((s) => s.impact?.isp?.checks?.some((c) => c.id === 'address' && ['clear', 'out'].includes(c.state))));
      if (state === 'normal' && !read) state = 'unknown';
      return {
        key: p.key,
        name: p.name,
        kind: p.kind,
        signals,
        rides: p.rides || [],
        state,
        counts: { internet: internet.length, other: other.length, planned: planned.length, older, alerts: alerts.length },
        network: p.asns.length
          ? { asns: p.asns, active: drop.length > 0, since: drop.length ? Math.min(...drop.map((n) => n.since)) : null, signals: [...new Set(drop.flatMap((n) => n.signals))], watched: nets.length > 0 }
          : null,
        clients: { total: clients.length, affected: affected.length, names: affected.map((s) => s.name).slice(0, 6) },
        feed: feed ? { status: feed.status, checkedAt: feed.lastSuccessAt, error: feed.error, via: feed.via || null } : null,
        page: p.page,
        about: p.about,
      };
    });
  rows.sort(
    (a, b) =>
      ORDER[a.state] - ORDER[b.state] ||
      Number(b.clients.total > 0) - Number(a.clients.total > 0) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.name.localeCompare(b.name),
  );
  return rows;
}
