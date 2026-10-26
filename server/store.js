import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/*
 * Everything the dashboard keeps lives in DATA_DIR as plain files:
 *   sites.json      client sites (yours; never sent anywhere)
 *   events.jsonl    outage started/restored and client-impact changes
 *   history.jsonl   customers out per utility, every 5 minutes
 * Back up that folder and you have backed up the dashboard.
 */

const HISTORY_KEEP_MS = 7 * 24 * 3600_000;
const EVENTS_KEEP = 2000;

function readJsonl(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A torn last line after a crash is skipped, not fatal.
    }
  }
  return rows;
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const clean = (value, max) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

/** Validate one site; throws with a message the UI can show. */
export function validateSite(input, existing = {}) {
  const site = { ...existing };
  if ('name' in input) site.name = clean(input.name, 120);
  if (!site.name) throw new Error('Give the site a name.');
  for (const key of ['lat', 'lon']) {
    if (key in input) site[key] = Number(input[key]);
  }
  if (!Number.isFinite(site.lat) || Math.abs(site.lat) > 90)
    throw new Error('Latitude must be a number between -90 and 90.');
  if (!Number.isFinite(site.lon) || Math.abs(site.lon) > 180)
    throw new Error('Longitude must be a number between -180 and 180.');
  if ('address' in input) site.address = clean(input.address, 300);
  if ('notes' in input) site.notes = clean(input.notes, 500);
  if ('radiusKm' in input && input.radiusKm !== '' && input.radiusKm != null) {
    const r = Number(input.radiusKm);
    if (!Number.isFinite(r) || r < 0.2 || r > 50)
      throw new Error('Alert radius must be between 0.2 and 50 km.');
    site.radiusKm = r;
  }
  for (const key of ['address', 'notes']) if (site[key] === '') delete site[key];
  site.lat = Math.round(site.lat * 1e6) / 1e6;
  site.lon = Math.round(site.lon * 1e6) / 1e6;
  return site;
}

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const HEADER_ALIASES = {
  name: ['name', 'site', 'client', 'site name', 'client name'],
  lat: ['lat', 'latitude'],
  lon: ['lon', 'lng', 'long', 'longitude'],
  address: ['address', 'location'],
  notes: ['notes', 'note', 'comments'],
  radiusKm: ['radius_km', 'radius', 'radius km', 'alert radius'],
};

/** CSV text → {sites, errors}. Needs a header row with name, lat, lon. */
export function sitesFromCsv(text) {
  const rows = parseCsv(String(text || '').replace(/^﻿/, ''));
  if (rows.length < 2)
    return { sites: [], errors: ['The file needs a header row and at least one site.'] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES))
    col[key] = header.findIndex((h) => aliases.includes(h));
  if (col.name < 0 || col.lat < 0 || col.lon < 0)
    return {
      sites: [],
      errors: ['The header row must include name, lat and lon columns.'],
    };
  const sites = [];
  const errors = [];
  rows.slice(1).forEach((cells, index) => {
    const input = {};
    for (const [key, i] of Object.entries(col)) if (i >= 0) input[key] = cells[i] ?? '';
    try {
      sites.push(validateSite(input));
    } catch (error) {
      errors.push(`Row ${index + 2}: ${error.message}`);
    }
  });
  return { sites, errors };
}

export function sitesToCsv(sites) {
  const q = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ['name,lat,lon,address,notes,radius_km'];
  for (const s of sites)
    lines.push([s.name, s.lat, s.lon, s.address, s.notes, s.radiusKm].map(q).join(','));
  return `${lines.join('\n')}\n`;
}

export function createStore(dataDir, { now = () => Date.now() } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const sitesFile = path.join(dataDir, 'sites.json');
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const historyFile = path.join(dataDir, 'history.jsonl');

  let sites = [];
  if (existsSync(sitesFile)) {
    try {
      const parsed = JSON.parse(readFileSync(sitesFile, 'utf8'));
      if (Array.isArray(parsed)) sites = parsed;
    } catch (error) {
      throw new Error(`Cannot read ${sitesFile}: ${error.message}`);
    }
  }
  let events = readJsonl(eventsFile).slice(-EVENTS_KEEP);
  let history = readJsonl(historyFile).filter((h) => now() - h.t < HISTORY_KEEP_MS);
  // Compact on start so the files never grow without bound.
  writeAtomic(eventsFile, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  writeAtomic(historyFile, history.map((h) => JSON.stringify(h)).join('\n') + (history.length ? '\n' : ''));

  const saveSites = () => writeAtomic(sitesFile, `${JSON.stringify(sites, null, 2)}\n`);

  return {
    listSites: () => sites.slice(),
    addSite(input) {
      const site = { id: randomUUID(), ...validateSite(input) };
      sites.push(site);
      saveSites();
      return site;
    },
    updateSite(id, input) {
      const index = sites.findIndex((s) => s.id === id);
      if (index < 0) return null;
      sites[index] = { ...validateSite(input, sites[index]), id };
      saveSites();
      return sites[index];
    },
    removeSite(id) {
      const before = sites.length;
      sites = sites.filter((s) => s.id !== id);
      if (sites.length !== before) saveSites();
      return sites.length !== before;
    },
    replaceSites(list, { append = false } = {}) {
      const fresh = list.map((s) => ({ id: randomUUID(), ...validateSite(s) }));
      sites = append ? [...sites, ...fresh] : fresh;
      saveSites();
      return fresh.length;
    },
    addEvents(list) {
      if (!list.length) return;
      events.push(...list);
      appendFileSync(eventsFile, list.map((e) => JSON.stringify(e)).join('\n') + '\n');
      if (events.length > EVENTS_KEEP * 1.5) events = events.slice(-EVENTS_KEEP);
    },
    recentEvents: (limit = 200) => events.slice(-limit).reverse(),
    addHistory(point) {
      history.push(point);
      appendFileSync(historyFile, `${JSON.stringify(point)}\n`);
      const cutoff = now() - HISTORY_KEEP_MS;
      if (history.length && history[0].t < cutoff) history = history.filter((h) => h.t >= cutoff);
    },
    historySince: (sinceMs) =>
      history.filter((h) => h.t >= sinceMs).sort((a, b) => a.t - b.t),
  };
}
