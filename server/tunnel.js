/*
 * Cloudflare Tunnel for the home side of a two-site setup: `cloudflared`
 * (bundled in the image) dials out to Cloudflare, so the office can reach
 * this instance's sync endpoint with no port open and no home address in
 * DNS. Started only when TUNNEL_TOKEN is set; restarted if it stops.
 *
 * The token goes to cloudflared through its environment, never on the
 * command line, so it doesn't show up in process listings.
 */

import { spawn } from 'node:child_process';

const state = { running: false, since: null, restarts: 0, lastError: null, connected: false };

export const tunnelStatus = () => ({ ...state });

export function startTunnel({ token, binary = 'cloudflared', log = console, spawnImpl = spawn }) {
  let delay = 2000;
  let stopped = false;
  let child = null;
  const run = () => {
    if (stopped) return;
    try {
      child = spawnImpl(binary, ['tunnel', '--no-autoupdate', '--loglevel', 'info', 'run'], {
        env: { ...process.env, TUNNEL_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      state.lastError = error.message;
      log.error?.(`[tunnel] cannot start cloudflared: ${error.message}`);
      return;
    }
    state.running = true;
    state.since = Date.now();
    const onLine = (buf) => {
      for (const line of String(buf).split('\n')) {
        if (!line.trim()) continue;
        if (/Registered tunnel connection/i.test(line)) {
          state.connected = true;
          delay = 2000;
        }
        // "2026-11-01T03:00:00Z ERR ..." lines, and bare messages such as
        // "Provided Tunnel token is not valid."
        const bare = !/^\d{4}-\d{2}-\d{2}T/.test(line);
        if (/\bERR\b|error|not valid|invalid|unauthori[sz]ed/i.test(line) && !/^See '/.test(line))
          state.lastError = (bare ? line : line.replace(/^\S+\s+\S+\s+/, '')).trim().slice(0, 200);
        if (/Registered tunnel connection|ERR|Unauthori[sz]ed|Retrying|not valid|invalid/i.test(line)) log.info?.(`[tunnel] ${line.trim().slice(0, 300)}`);
      }
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);
    child.on('error', (error) => {
      state.lastError = error.code === 'ENOENT' ? 'cloudflared is not installed in this image' : error.message;
      log.error?.(`[tunnel] ${state.lastError}`);
    });
    child.on('exit', (code) => {
      state.running = false;
      state.connected = false;
      if (stopped) return;
      state.restarts += 1;
      log.warn?.(`[tunnel] cloudflared exited (${code}); restarting in ${Math.round(delay / 1000)} s`);
      setTimeout(run, delay).unref?.();
      delay = Math.min(delay * 2, 5 * 60_000);
    });
  };
  run();
  const stop = () => {
    stopped = true;
    child?.kill('SIGTERM');
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  return { stop, status: tunnelStatus };
}
