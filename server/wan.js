/*
 * Connection check: this server pings each client's own internet address
 * (their firewall or modem's public IP or hostname). It is the one signal
 * that is exact for every provider, including Starlink and small wireless
 * providers that publish nothing.
 *
 * ICMP ping when the container has `ping`, otherwise (or with host:port) a
 * TCP connect: "connection refused" still proves the address answered.
 * Two failed checks in a row mark the connection down, so one lost packet
 * never raises an alert.
 */

import net from 'node:net';
import { execFile } from 'node:child_process';

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{2,39}$/i;
const FAILS_TO_DOWN = 2;

/** "1.2.3.4", "fw.example.ca", "1.2.3.4:443", "[2001:db8::1]:443" → {host, port} or null. */
export function parseTarget(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let host = s;
  let port = null;
  const v6 = /^\[([0-9a-f:]+)\](?::(\d{1,5}))?$/i.exec(s);
  if (v6) [, host, port] = v6;
  else if (/^[^:]+:\d{1,5}$/.test(s)) [host, port] = s.split(':');
  port = port == null ? null : Number(port);
  if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
  if (!HOST_RE.test(host)) return null;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split('.').some((o) => Number(o) > 255)) return null;
  return { host: host.toLowerCase(), port };
}

function tcpCheck(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const done = (up, error = null) => {
      socket.destroy();
      resolve({ up, rttMs: up ? Date.now() - started : null, method: `tcp/${port}`, error });
    };
    socket.setTimeout(timeoutMs, () => done(false, 'timed out'));
    socket.once('connect', () => done(true));
    socket.once('error', (e) => (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' ? done(true) : done(false, e.code || e.message)));
  });
}

function pingCheck(host, timeoutS) {
  return new Promise((resolve) => {
    execFile('ping', ['-n', '-c', '3', '-i', '0.3', '-W', String(timeoutS), host], { timeout: (timeoutS + 4) * 1000 }, (error, stdout = '', stderr = '') => {
      const rtt = /=\s*[\d.]+\/([\d.]+)\//.exec(stdout);
      const received = /(\d+)\s+(?:packets\s+)?received/.exec(stdout);
      if (received && Number(received[1]) > 0) return resolve({ up: true, rttMs: rtt ? Math.round(Number(rtt[1])) : null, method: 'ping' });
      // No ping binary or no permission: let the caller fall back to TCP.
      if (error?.code === 'ENOENT' || /permission|not permitted|socket/i.test(stderr)) return resolve(null);
      resolve({ up: false, rttMs: null, method: 'ping', error: received ? 'no reply' : String(stderr || error?.message || 'no reply').trim().slice(0, 80) });
    });
  });
}

/** One check: ICMP if possible, then TCP 443 and 80. */
export async function checkTarget(target, { timeoutMs = 3000, ping = pingCheck, tcp = tcpCheck } = {}) {
  if (target.port) return tcp(target.host, target.port, timeoutMs);
  const viaPing = await ping(target.host, Math.ceil(timeoutMs / 1000));
  if (viaPing?.up) return viaPing;
  // A firewall that drops ping may still answer on a web or VPN port.
  for (const port of [443, 80]) {
    const r = await tcp(target.host, port, timeoutMs);
    if (r.up) return r;
  }
  return viaPing || { up: false, rttMs: null, method: 'tcp/443,80', error: 'no answer' };
}

const PEER_FRESH_MS = 5 * 60_000;

/**
 * Two sites' checks of one client → one answer. Down only when both lose
 * it; when one site loses it and the other doesn't, the problem is most
 * likely that site's own internet: 'split', shown but not alerted.
 */
export function combineWan(own, peer, { selfName = 'This site', nowMs = Date.now() } = {}) {
  const known = (r) => r && (r.state === 'up' || r.state === 'down');
  const peerOk = known(peer) && nowMs - peer.lastCheckAt < PEER_FRESH_MS;
  if (!peerOk) return own || null;
  if (!known(own)) return { ...peer, sites: [peer.via] };
  const names = [selfName, peer.via];
  if (own.state === peer.state)
    return { ...own, since: Math.max(own.since, peer.since), sites: names, rttMs: own.rttMs ?? peer.rttMs };
  const [down, up] = own.state === 'down' ? [selfName, peer.via] : [peer.via, selfName];
  return { ...own, state: 'split', down, up, since: own.state === 'down' ? own.since : peer.since, sites: names };
}

export function createWanMonitor({ now = () => Date.now(), intervalMs = 60_000, check = checkTarget, log = console, selfName = 'This site' } = {}) {
  /** siteId → {target, state, since, lastCheckAt, rttMs, method, fails, error} */
  const results = new Map();
  /** siteId → the peer's result for the same client (our clock) */
  const peerResults = new Map();
  let running = null;

  async function run(sites) {
    running ??= (async () => {
      const due = sites.filter((s) => s.monitorHost).filter((s) => {
        const r = results.get(s.id);
        return !r || r.target !== s.monitorHost || now() - r.lastCheckAt >= intervalMs;
      });
      const ids = new Set(sites.filter((s) => s.monitorHost).map((s) => s.id));
      for (const id of results.keys()) if (!ids.has(id)) results.delete(id);
      const queue = [...due];
      const worker = async () => {
        for (let s = queue.shift(); s; s = queue.shift()) {
          const target = parseTarget(s.monitorHost);
          const prior = results.get(s.id);
          const same = prior?.target === s.monitorHost ? prior : null;
          if (!target) {
            results.set(s.id, { target: s.monitorHost, state: 'invalid', since: now(), lastCheckAt: now(), fails: 0, error: 'Not an IP address or host name' });
            continue;
          }
          let r;
          try {
            r = await check(target);
          } catch (error) {
            r = { up: false, error: String(error?.message || error) };
          }
          const fails = r.up ? 0 : (same?.fails || 0) + 1;
          const state = r.up ? 'up' : fails >= FAILS_TO_DOWN ? 'down' : same?.state === 'down' ? 'down' : same?.state || 'checking';
          results.set(s.id, {
            target: s.monitorHost,
            state,
            since: same?.state === state ? same.since : now(),
            lastCheckAt: now(),
            lastUpAt: r.up ? now() : same?.lastUpAt || null,
            rttMs: r.rttMs ?? null,
            method: r.method || null,
            fails,
            error: r.up ? null : r.error || 'no answer',
          });
          if (same && same.state !== state && (state === 'down' || state === 'up')) log.info?.(`[wan] ${s.name}: ${state}`);
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    run,
    /** Combined with the peer's check when there is one. */
    get: (id) => combineWan(results.get(id) || null, peerResults.get(id) || null, { selfName, nowMs: now() }),
    own: (id) => results.get(id) || null,
    exportResults: () =>
      Object.fromEntries([...results].filter(([, r]) => r.state === 'up' || r.state === 'down').map(([id, r]) => [id, { target: r.target, state: r.state, since: r.since, lastCheckAt: r.lastCheckAt, rttMs: r.rttMs, method: r.method }])),
    importPeer(list = {}, { offsetMs = 0, from = 'peer' } = {}) {
      for (const [id, r] of Object.entries(list || {}))
        if (r && Number.isFinite(r.lastCheckAt) && (r.state === 'up' || r.state === 'down'))
          peerResults.set(id, { ...r, since: r.since + offsetMs, lastCheckAt: r.lastCheckAt + offsetMs, via: from });
    },
  };
}
