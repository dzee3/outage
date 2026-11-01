/*
 * Two Outage Desk instances covering for each other.
 *
 *   - Each fetches every source itself. Once a minute they swap what each
 *     fetched itself (never what it borrowed); a source is used from the
 *     peer only while the local fetch is failing.
 *   - One side owns the client list (SITES=owner), the other mirrors it
 *     (SITES=mirror). Edits made on the mirror are applied locally at once,
 *     queued on disk with no time limit, and applied by the owner, in order,
 *     at the next exchange. The owner's list then comes back and replaces the
 *     mirror's; edits still queued are re-applied on top.
 *   - Only the side with PEER_URL connects. In the planned setup that is the
 *     office, reaching home through a Cloudflare Tunnel; home never connects
 *     out. Every request carries the peer key; Cloudflare Access headers are
 *     added when configured.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sitesFromCsv } from './store.js';

export const PEER_PROTOCOL = 1;
const SYNC_EVERY_MS = 60_000;
const SYNC_FAST_MS = 15_000; // while edits wait on either side
const CONNECTED_MS = 3 * 60_000;
const MAX_BODY = 32 * 1024 * 1024;

const digest = (s) => createHash('sha256').update(String(s)).digest();
/** Constant-time key comparison. */
export function keyMatches(given, expected) {
  if (!expected || !given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** One queued client edit → applied to a store. Returns a short description, or null if it no longer applies. */
export function applyOp(store, op) {
  if (op.kind === 'add') {
    if (store.getSite(op.siteId)) return applyOp(store, { ...op, kind: 'update' });
    const site = store.addSite(op.input, { id: op.siteId });
    return `added ${site.name}`;
  }
  if (op.kind === 'update') {
    const site = store.updateSite(op.siteId, op.input);
    return site ? `changed ${site.name}` : null;
  }
  if (op.kind === 'remove') {
    const site = store.getSite(op.siteId);
    return store.removeSite(op.siteId) ? `removed ${site?.name || 'a client'}` : null;
  }
  if (op.kind === 'import') {
    const { sites } = sitesFromCsv(op.csv);
    if (!sites.length) return null;
    const n = store.replaceSites(sites, { append: op.mode !== 'replace' });
    return `imported ${n} clients`;
  }
  return null;
}

/** The mirror's queue of edits for the owner: saved to disk, kept until applied. */
export function createEditQueue(dataDir) {
  const file = path.join(dataDir, 'peer-queue.json');
  let state = { baseVersion: null, ops: [] };
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(parsed?.ops)) state = { baseVersion: parsed.baseVersion ?? null, ops: parsed.ops };
    } catch {
      /* a damaged queue file is kept aside below and replaced */
      renameSync(file, `${file}.damaged-${Date.now()}`);
    }
  }
  const save = () => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, file);
  };
  return {
    list: () => state.ops.slice(),
    push(op) {
      const full = { id: randomUUID(), at: Date.now(), ...op };
      state.ops.push(full);
      save();
      return full;
    },
    /** The owner applied (or skipped) these. */
    drop(ids) {
      const gone = new Set(ids || []);
      if (!gone.size) return;
      const before = state.ops.length;
      state.ops = state.ops.filter((o) => !gone.has(o.id));
      if (state.ops.length !== before) save();
    },
    baseVersion: () => state.baseVersion,
    setBase(v) {
      state.baseVersion = v;
      save();
    },
    pendingIds: () => new Set(state.ops.map((o) => o.siteId).filter(Boolean)),
  };
}

export function createPeer({
  config,
  store,
  queue,
  monitor,
  ispStatus,
  wan,
  now = () => Date.now(),
  fetchImpl = globalThis.fetch,
  log = console,
  onChange = () => {},
  syncEveryMs = SYNC_EVERY_MS,
}) {
  const fastMs = Math.min(SYNC_FAST_MS, syncEveryMs);
  const role = config.sites === 'owner' || config.sites === 'mirror' ? config.sites : null;
  const st = {
    peerName: null,
    lastOkAt: null,
    lastAttemptAt: null,
    lastError: null,
    lastSeenAt: null, // last exchange in either direction
    peerRole: null,
    peerPending: 0,
    peerHave: null, // what the peer holds from us
    peerSitesVersion: null,
    appliedForPeer: [], // op ids we applied for the peer, to confirm next time
    justApplied: false, // applied new edits: answer with the new list at once
  };

  /** What we send: our own data, the client list or queued edits. */
  function payload(peerHave = st.peerHave) {
    const have = peerHave || {};
    const body = {
      protocol: PEER_PROTOCOL,
      instance: config.instanceName,
      sentAt: now(),
      role,
      feeds: monitor.exportFeeds(have.feeds || {}),
      internet: monitor.exportInternet(have.internet ?? null),
      isp: ispStatus.exportFeeds(have.isp || {}),
      siteChecks: ispStatus.exportSiteChecks(),
      wan: wan.exportResults(),
      have: { ...monitor.borrowedHave(), isp: ispStatus.borrowedHave() },
    };
    if (role === 'owner') {
      const version = store.sitesVersion();
      body.sites = { version };
      if (st.peerRole === 'mirror' && st.peerSitesVersion !== version) body.sites.list = store.listSites();
      body.applied = st.appliedForPeer;
    }
    if (role === 'mirror') {
      body.sites = { version: queue.baseVersion() };
      body.edits = queue.list();
    }
    return body;
  }

  /** What we do with the peer's half of an exchange. */
  function absorb(body) {
    if (!body || body.protocol !== PEER_PROTOCOL)
      throw Object.assign(new Error(`Peer runs a different Outage Desk version (sync protocol ${body?.protocol ?? '?'}, this one ${PEER_PROTOCOL}). Update both.`), { status: 409 });
    const offsetMs = Number.isFinite(body.sentAt) ? now() - body.sentAt : 0;
    const from = String(body.instance || 'peer').slice(0, 60);
    st.peerName = from;
    st.peerRole = body.role || null;
    st.peerHave = body.have || null;
    st.peerSitesVersion = body.sites?.version ?? null;
    st.peerPending = Array.isArray(body.edits) ? body.edits.length : 0;
    monitor.importPeer({ feeds: body.feeds || [], internet: body.internet || null }, { offsetMs, from });
    ispStatus.importPeer({ feeds: body.isp || [], siteChecks: body.siteChecks || {} }, { offsetMs, from });
    wan.importPeer(body.wan || {}, { offsetMs, from });
    let sitesChanged = false;

    // Owner: apply the mirror's queued edits, in order; confirm them next time.
    if (role === 'owner' && body.role === 'mirror') {
      const done = new Set(st.appliedForPeer);
      const applied = [];
      const events = [];
      for (const op of body.edits || []) {
        if (done.has(op.id)) {
          applied.push(op.id);
          continue;
        }
        let what = null;
        try {
          what = applyOp(store, op);
        } catch (error) {
          what = null;
          log.warn?.(`[peer] edit from ${from} not applied: ${error.message}`);
        }
        applied.push(op.id);
        st.justApplied = true;
        events.push({ t: now(), type: what ? 'peer-edit' : 'peer-edit-skipped', from, what: what || `${op.kind} of a client that no longer exists here`, at: op.at });
        if (what) sitesChanged = true;
      }
      st.appliedForPeer = applied;
      if (events.length) store.addEvents(events);
    }

    // Mirror: drop what the owner applied, take its list, re-apply what still waits.
    if (role === 'mirror' && body.role === 'owner') {
      queue.drop(body.applied);
      if (Array.isArray(body.sites?.list)) {
        store.setSitesExact(body.sites.list);
        queue.setBase(body.sites.version);
        for (const op of queue.list()) {
          try {
            applyOp(store, op);
          } catch {
            /* stays queued; the owner decides */
          }
        }
        sitesChanged = true;
      }
    }
    st.lastSeenAt = now();
    st.lastError = null;
    onChange({ sitesChanged });
  }

  // ------------------------------------------------------------ caller ---

  async function syncOnce() {
    if (!config.peerUrl) return;
    st.lastAttemptAt = now();
    try {
      const body = gzipSync(Buffer.from(JSON.stringify(payload())));
      const headers = {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Accept-Encoding': 'gzip',
        'X-Peer-Key': config.peerKey,
      };
      if (config.peerAccessId) headers['CF-Access-Client-Id'] = config.peerAccessId;
      if (config.peerAccessSecret) headers['CF-Access-Client-Secret'] = config.peerAccessSecret;
      const res = await fetchImpl(`${config.peerUrl.replace(/\/+$/, '')}/api/peer/sync`, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(45_000),
      });
      const text = await res.text();
      if (res.status !== 200) {
        let msg = `HTTP ${res.status}`;
        try {
          msg = JSON.parse(text).error || msg;
        } catch {
          if (res.status === 302 || res.status === 403) msg += ' (Cloudflare Access refused: check PEER_ACCESS_ID and PEER_ACCESS_SECRET)';
        }
        throw new Error(msg);
      }
      absorb(JSON.parse(text));
      st.lastOkAt = now();
    } catch (error) {
      st.lastError = String(error?.cause?.code || error?.message || error).slice(0, 200);
      log.warn?.(`[peer] sync failed: ${st.lastError}`);
    }
  }

  let timer = null;
  let syncing = null;
  function sync() {
    syncing ??= syncOnce().finally(() => {
      syncing = null;
    });
    return syncing;
  }
  function start() {
    if (!config.peerUrl || timer) return;
    const loop = async () => {
      await sync();
      if (st.justApplied) {
        st.justApplied = false;
        await sync();
      }
      // An owner that just applied edits answers straight away; waiting edits sync faster.
      const busy = st.peerPending > 0 || (role === 'mirror' && queue.list().length > 0);
      timer = setTimeout(loop, busy ? fastMs : syncEveryMs);
      timer.unref?.();
    };
    loop();
  }
  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  // --------------------------------------------------------- responder ---

  /** POST /api/peer/sync: the other side's half in, ours out. */
  async function handle(req, res) {
    if (!config.peerKey) return reply(res, 404, { error: 'Peer sync is not set up here (no PEER_KEY).' });
    if (!keyMatches(req.headers['x-peer-key'], config.peerKey)) return reply(res, 403, { error: 'Wrong peer key.' });
    let body;
    try {
      body = JSON.parse((await readPeerBody(req)).toString('utf8'));
    } catch (error) {
      return reply(res, 400, { error: `Unreadable sync request: ${error.message}` });
    }
    try {
      absorb(body);
    } catch (error) {
      return reply(res, error.status || 400, { error: error.message });
    }
    const out = Buffer.from(JSON.stringify(payload()));
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
    });
    res.end(gz ? gzipSync(out) : out);
  }

  function status() {
    const t = now();
    const seen = st.lastSeenAt;
    return {
      configured: Boolean(config.peerKey && (config.peerUrl || config.tunnelToken || role)),
      instance: config.instanceName,
      role,
      calls: Boolean(config.peerUrl),
      peerName: st.peerName,
      peerRole: st.peerRole,
      connected: Boolean(seen && t - seen < CONNECTED_MS),
      lastSeenAt: seen,
      lastError: st.lastError,
      pendingEdits: role === 'mirror' ? queue.list().length : st.peerPending,
    };
  }

  return { start, stop, sync, handle, status, payload, absorb };
}

function reply(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readPeerBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  return /gzip/i.test(req.headers['content-encoding'] || '') ? gunzipSync(raw, { maxOutputLength: 8 * MAX_BODY }) : raw;
}
