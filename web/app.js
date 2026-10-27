/* Outage Desk front end: full-bleed map with a floating HUD. Plain DOM +
 * MapLibre; every value from a utility or lookup is written as text, never
 * as HTML. */

const maplibregl = window.maplibregl;
maplibregl.setWorkerUrl('/vendor/maplibre-gl-csp-worker.js');

const REFRESH_MS = 30_000;
const HISTORY_REFRESH_MS = 120_000;
const LATE_MS = 3 * 60_000;
const CANADA = [[-141, 41.6], [-52.6, 62]];
const COLORS = {
  unplanned: '#ff3b5c',
  'planned-active': '#ffb02e',
  'planned-upcoming': '#6fa8dc',
  site: '#5ef0ff',
  internet: '#a993ff',
};
const SITE_COLORS = {
  out: '#ff3b5c',
  near: '#ffb02e',
  internet: '#a993ff',
  planned: '#6fa8dc',
  ok: '#5ef0ff',
  'no-coverage': '#7d8f9c',
};
const SITE_STATUS_TEXT = {
  out: 'Inside an outage',
  near: 'Outage nearby',
  internet: 'Internet disruption',
  planned: 'Planned work coming',
  ok: 'No outages nearby',
  'no-coverage': 'Power not monitored',
};
const KIND_TEXT = {
  unplanned: 'Unplanned outage',
  'planned-active': 'Planned work underway',
  'planned-upcoming': 'Planned work, upcoming',
};
const PROVINCE_NAMES = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories',
  NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec',
  SK: 'Saskatchewan', YT: 'Yukon',
};
const PROVINCE_ORDER = ['BC', 'AB', 'SK', 'MB', 'ON', 'NB', 'NS', 'PE', 'NL'];
const ZONES = {
  BC: 'America/Vancouver', SK: 'America/Regina', MB: 'America/Winnipeg', ON: 'America/Toronto',
  NB: 'America/Moncton', NS: 'America/Halifax', PE: 'America/Halifax', NL: 'America/St_Johns',
};
const PROVINCE_COLORS = {
  BC: '#4cc9f0', AB: '#f72585', SK: '#b5e48c', MB: '#ffd166', ON: '#7b9cff',
  NB: '#ff9f68', NS: '#2ec4b6', PE: '#e07a5f', NL: '#c77dff',
};
const DEFAULT_UTILITY_LABEL = {
  BC: 'BC Hydro', SK: 'SaskPower', MB: 'Manitoba Hydro', NB: 'NB Power', NS: 'Nova Scotia Power',
  PE: 'Maritime Electric', NL: 'NL Hydro (outside Newfoundland Power)', AB: 'ATCO / FortisAlberta',
};

// ------------------------------------------------------------ utilities --

const $ = (id) => document.getElementById(id);
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-CA') : '–');
const local = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private window: settings just don't persist */
    }
  },
};
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

/* Alberta has been on UTC-6 all year since March 2026 (see server/records.js);
 * a browser with older zone data would show MST, so Alberta is fixed here. */
const PERMANENT_MDT_FROM = Date.UTC(2026, 2, 8, 9);
const WHEN = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', weekday: 'short', hour: 'numeric', minute: '2-digit' });
const zoneFormats = new Map();
/** A time in the outage's own province, labelled with its zone. */
function when(ms, province) {
  if (!Number.isFinite(ms)) return null;
  if (province === 'AB' && ms >= PERMANENT_MDT_FROM) return `${WHEN.format(new Date(ms - 6 * 3600_000))} MT`;
  const zone = ZONES[province] || ZONES.ON;
  let f = zoneFormats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    zoneFormats.set(zone, f);
  }
  return f.format(new Date(ms));
}
const LOCAL = new Intl.DateTimeFormat('en-CA', { hour: 'numeric', minute: '2-digit' });
function ago(ms) {
  if (!Number.isFinite(ms)) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return `${hrs} h ${m % 60} min ago`;
  return `${Math.round(hrs / 24)} days ago`;
}
function duration(fromMs) {
  if (!Number.isFinite(fromMs)) return null;
  const m = Math.round((Date.now() - fromMs) / 60000);
  if (m < 0) return null;
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  return hrs < 48 ? `${hrs} h ${m % 60} min` : `${Math.round(hrs / 24)} days`;
}
function customersText(row) {
  if (row.customersText && !/^\d[\d,]*$/.test(row.customersText)) return row.customersText;
  return Number.isFinite(row.customers) ? fmt(row.customers) : '?';
}
const placeName = (row) => row.area || row.cause || 'Location not named';
const utilityName = (id) => state.snap?.sources.find((s) => s.id === id)?.name || id;
const statusWord = (s) => ({ ok: 'live', stale: 'stale', down: 'down', off: 'off' })[s] || s;

// ---------------------------------------------------------------- state --

const state = {
  snap: null,
  lastOkAt: 0,
  filter: 'all',
  province: local.get('provFilter') || '',
  search: '',
  selectedId: null,
  selectedSiteId: null,
  alerts: local.get('alerts') === 'on',
  editToken: local.get('editToken') || '',
  panel: null,
  picking: false,
  editingSiteId: null,
  draft: null, // {lat, lon, lookup}
  prevSiteStatus: null,
  prevOutageIds: null,
  history: [],
  events: [],
  layers: {
    outages: local.get('layer:outages') !== 'off',
    territories: local.get('layer:territories') === 'on',
    internet: local.get('layer:internet') !== 'off',
    ispnotices: local.get('layer:ispnotices') !== 'off',
    isp: local.get('layer:isp') === 'on',
    clients: local.get('layer:clients') !== 'off',
    labels: local.get('layer:labels') !== 'off',
  },
};

// ------------------------------------------------------------------ map --

const BASEMAP = 'https://tiles.openfreemap.org/styles/dark';
const FALLBACK_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#05080b' } }],
};
let usingFallback = false;
const map = new maplibregl.Map({
  container: 'map',
  style: BASEMAP,
  bounds: CANADA,
  fitBoundsOptions: { padding: { top: 90, bottom: 80, left: 90, right: 40 } },
  attributionControl: { compact: true },
  maxPitch: 0,
  dragRotate: false,
  pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

let mapReady = false;
let popup = null;
let pin = null;

function diamond(color, size = 22) {
  const c = document.createElement('canvas');
  c.width = c.height = size * 2;
  const g = c.getContext('2d');
  g.scale(2, 2);
  g.translate(size / 2, size / 2);
  g.rotate(Math.PI / 4);
  g.shadowColor = color;
  g.shadowBlur = 6;
  g.fillStyle = '#071017';
  g.strokeStyle = color;
  g.lineWidth = 2.6;
  g.beginPath();
  g.rect(-5.5, -5.5, 11, 11);
  g.fill();
  g.stroke();
  g.shadowBlur = 0;
  g.fillStyle = color;
  g.fillRect(-1.8, -1.8, 3.6, 3.6);
  return g.getImageData(0, 0, size * 2, size * 2);
}

/** Pull the OpenFreeMap dark style toward the HUD palette. */
function tintBasemap() {
  for (const layer of map.getStyle().layers || []) {
    const id = layer.id;
    try {
      if (layer.type === 'background') map.setPaintProperty(id, 'background-color', '#070d12');
      else if (layer.type === 'fill' && /water/.test(id)) map.setPaintProperty(id, 'fill-color', '#04121b');
      else if (layer.type === 'fill' && /landcover|landuse|park|wood|grass/.test(id)) map.setPaintProperty(id, 'fill-opacity', 0.25);
      else if (layer.type === 'line' && /boundary|admin/.test(id)) map.setPaintProperty(id, 'line-color', '#2a4656');
      else if (layer.type === 'symbol' && /place|label/.test(id) && layer.paint?.['text-color'] !== undefined) map.setPaintProperty(id, 'text-color', '#7f97a6');
    } catch {
      /* layer without that property */
    }
  }
}

function useFallback(reason) {
  if (usingFallback) return;
  usingFallback = true;
  console.warn('[map] basemap unavailable, using outlines only:', reason);
  $('map-note').hidden = false;
  map.setStyle(FALLBACK_STYLE);
}
const basemapTimer = setTimeout(() => {
  if (!mapReady) useFallback('timeout');
}, 10_000);
map.on('error', (e) => {
  if (!mapReady && !usingFallback) useFallback(e?.error?.message || 'style error');
});

const empty = () => ({ type: 'FeatureCollection', features: [] });
const TEXT_FONT = ['Noto Sans Regular'];
const BOLD_FONT = ['Noto Sans Bold'];

map.on('style.load', () => {
  clearTimeout(basemapTimer);
  if (!usingFallback) tintBasemap();
  for (const [status, color] of Object.entries(SITE_COLORS))
    if (!map.hasImage(`site-${status}`)) map.addImage(`site-${status}`, diamond(color), { pixelRatio: 2 });
  const withText = !usingFallback;

  map.addSource('provinces', { type: 'geojson', data: '/data/provinces.geojson', promoteId: 'code' });
  map.addLayer({
    id: 'prov-dim',
    type: 'fill',
    source: 'provinces',
    paint: { 'fill-color': '#020406', 'fill-opacity': ['case', ['boolean', ['feature-state', 'covered'], false], 0, 0.55] },
  });
  map.addLayer({
    id: 'prov-internet',
    type: 'fill',
    source: 'provinces',
    paint: { 'fill-color': COLORS.internet, 'fill-opacity': ['case', ['boolean', ['feature-state', 'internet'], false], 0.16, 0] },
  });
  map.addLayer({
    id: 'prov-line',
    type: 'line',
    source: 'provinces',
    paint: {
      'line-color': ['case', ['boolean', ['feature-state', 'internet'], false], COLORS.internet, ['boolean', ['feature-state', 'covered'], false], '#3e7f8f', '#1d2c38'],
      'line-width': ['case', ['boolean', ['feature-state', 'internet'], false], 2, 1],
      'line-opacity': 0.8,
    },
  });

  // Utility service areas (published boundaries) + each province's main utility.
  map.addSource('territories', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'terr-fill',
    type: 'fill',
    source: 'territories',
    layout: { visibility: 'none' },
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.1 },
  });
  map.addLayer({
    id: 'terr-line',
    type: 'line',
    source: 'territories',
    layout: { visibility: 'none' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.7, 'line-dasharray': [3, 2] },
  });
  map.addSource('terr-labels', { type: 'geojson', data: empty() });
  if (withText)
    map.addLayer({
      id: 'terr-label',
      type: 'symbol',
      source: 'terr-labels',
      layout: {
        visibility: 'none',
        'text-field': ['get', 'name'],
        'text-font': BOLD_FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 8, 13],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.12,
        'text-max-width': 9,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#05080b', 'text-halo-width': 1.6, 'text-opacity': 0.85 },
    });

  // Internet providers sampled in view (hexagon outlines).
  map.addSource('isp-hex', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'isp-hex',
    type: 'line',
    source: 'isp-hex',
    paint: { 'line-color': COLORS.internet, 'line-width': 1, 'line-opacity': 0.45 },
  });

  // Internet providers' own outage notices (Telus cells, TekSavvy map, Rogers neighbourhoods).
  map.addSource('isp-notices', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'ispn-fill',
    type: 'fill',
    source: 'isp-notices',
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': ['case', ['==', ['get', 'kind'], 'planned'], '#ffb02e', ['get', 'internet'], COLORS.internet, '#8f86b8'], 'fill-opacity': ['case', ['get', 'internet'], 0.32, 0.2] },
  });
  map.addLayer({
    id: 'ispn-line',
    type: 'line',
    source: 'isp-notices',
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'line-color': ['case', ['==', ['get', 'kind'], 'planned'], '#ffb02e', ['get', 'internet'], COLORS.internet, '#8f86b8'], 'line-width': 1.4, 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'ispn-glow',
    type: 'circle',
    source: 'isp-notices',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 16, 'circle-color': ['case', ['==', ['get', 'kind'], 'planned'], '#ffb02e', ['get', 'internet'], COLORS.internet, '#8f86b8'], 'circle-opacity': 0.22, 'circle-blur': 0.8 },
  });
  map.addLayer({
    id: 'ispn-point',
    type: 'circle',
    source: 'isp-notices',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': 6,
      'circle-color': '#05080b',
      'circle-stroke-color': ['case', ['==', ['get', 'kind'], 'planned'], '#ffb02e', ['get', 'internet'], COLORS.internet, '#8f86b8'],
      'circle-stroke-width': 2.5,
    },
  });

  map.addSource('areas', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'areas-fill',
    type: 'fill',
    source: 'areas',
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['match', ['get', 'kind'], 'unplanned', 0.28, 0.16] },
  });
  map.addLayer({
    id: 'areas-line',
    type: 'line',
    source: 'areas',
    paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.9 },
  });

  map.addSource('points', { type: 'geojson', data: empty() });
  const radius = ['interpolate', ['linear'], ['sqrt', ['max', 1, ['coalesce', ['get', 'customers'], 1]]], 1, 4, 10, 7, 40, 13, 150, 22];
  map.addLayer({
    id: 'points-glow',
    type: 'circle',
    source: 'points',
    paint: {
      'circle-radius': ['*', radius, 2.6],
      'circle-color': ['get', 'color'],
      'circle-opacity': ['match', ['get', 'kind'], 'unplanned', 0.28, 0.14],
      'circle-blur': 1,
    },
  });
  map.addLayer({
    id: 'points',
    type: 'circle',
    source: 'points',
    paint: {
      'circle-radius': radius,
      'circle-color': ['get', 'color'],
      'circle-opacity': ['match', ['get', 'kind'], 'planned-upcoming', 0.7, 0.95],
      'circle-stroke-color': ['case', ['get', 'selected'], '#ffffff', '#05080b'],
      'circle-stroke-width': ['case', ['get', 'selected'], 2.5, 1.2],
    },
  });

  map.addSource('sites', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'sites',
    type: 'symbol',
    source: 'sites',
    layout: {
      'icon-image': ['concat', 'site-', ['get', 'status']],
      'icon-allow-overlap': true,
      'icon-size': ['case', ['in', ['get', 'status'], ['literal', ['out', 'near', 'internet']]], 1.3, 1],
      'symbol-sort-key': ['get', 'rank'],
    },
  });
  if (withText)
    map.addLayer({
      id: 'site-labels',
      type: 'symbol',
      source: 'sites',
      layout: {
        'text-field': ['format', ['upcase', ['get', 'name']], { 'font-scale': 1 }, '\n', {}, ['get', 'detail'], { 'font-scale': 0.82 }],
        'text-font': BOLD_FONT,
        'text-size': 12,
        'text-letter-spacing': 0.05,
        'text-offset': [1.1, 0],
        'text-anchor': 'left',
        'text-justify': 'left',
        'text-max-width': 18,
        'text-optional': true,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#05080b',
        'text-halo-width': 1.8,
      },
    });

  mapReady = true;
  applyLayerVisibility();
  loadTerritories();
  if (state.snap) renderMap();
});

{
  for (const layer of ['ispn-point', 'ispn-fill'])
    map.on('click', layer, (e) => {
      if (state.picking) return;
      const id = e.features[0]?.properties?.id;
      const n = state.snap?.ispNotices?.find((x) => x.id === id);
      if (n) openPopup(e.lngLat, ispNoticePopup(n));
    });
  for (const layer of ['points', 'areas-fill'])
    map.on('click', layer, (e) => {
      if (state.picking) return;
      const id = e.features[0]?.properties?.id;
      if (id) selectOutage(id, { fly: false, lngLat: e.lngLat });
    });
  map.on('click', 'sites', (e) => {
    if (state.picking) return;
    const id = e.features[0]?.properties?.id;
    if (id) selectSite(id, { fly: false });
  });
  for (const layer of ['points', 'areas-fill', 'sites', 'ispn-point', 'ispn-fill']) {
    map.on('mouseenter', layer, () => {
      if (!state.picking) map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layer, () => {
      if (!state.picking) map.getCanvas().style.cursor = '';
    });
  }
  map.on('click', (e) => {
    if (!state.picking) return;
    placeDraft(e.lngLat.lat, e.lngLat.lng);
  });
}

function setVisible(id, on) {
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}
function applyLayerVisibility() {
  if (!mapReady) return;
  const L = state.layers;
  for (const id of ['points', 'points-glow', 'areas-fill', 'areas-line']) setVisible(id, L.outages);
  for (const id of ['terr-fill', 'terr-line', 'terr-label']) setVisible(id, L.territories);
  setVisible('prov-internet', L.internet);
  setVisible('sites', L.clients);
  setVisible('site-labels', L.clients && L.labels);
  setVisible('isp-hex', L.isp);
  for (const id of ['ispn-fill', 'ispn-line', 'ispn-glow', 'ispn-point']) setVisible(id, L.ispnotices);
  $('isp-card').hidden = !L.isp;
  if (L.isp) loadIspInView();
}

function visibleRows() {
  const rows = state.snap?.rows || [];
  const f = state.filter;
  return rows.filter((r) => {
    if (state.province && r.province !== state.province) return false;
    if (f === 'all') return r.kind !== 'planned-upcoming';
    if (f === 'unplanned') return r.kind === 'unplanned';
    if (f === 'planned') return r.kind === 'planned-active';
    if (f === 'upcoming') return r.kind === 'planned-upcoming';
    return true;
  });
}

function siteDetail(s) {
  const first = s.impact.outages[0];
  if (s.impact.status === 'out') return 'NO POWER';
  if (s.impact.status === 'near' && first) return `outage ${first.distanceKm} km`;
  if (s.impact.status === 'internet') return s.impact.isp?.state === 'out' ? `${s.impact.isp.name} outage` : s.impact.network ? `${s.impact.network.name} network drop` : 'internet drop';
  if (s.impact.isp?.state === 'planned') return `${s.impact.isp.name} maintenance`;
  if (s.impact.status === 'planned' && first) return `planned work ${first.distanceKm} km`;
  return '';
}

/** A circle of c.km around (c.lat, c.lon) as a GeoJSON polygon. */
function circlePolygon(c, steps = 48) {
  const ring = [];
  const dLat = c.km / 110.57;
  const dLon = c.km / (111.32 * Math.cos((c.lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([c.lon + dLon * Math.cos(a), c.lat + dLat * Math.sin(a)]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

const ISP_NAMES = { telus: 'Telus', rogers: 'Rogers / Shaw', teksavvy: 'TekSavvy', sasktel: 'SaskTel' };
/** Provider notices for the Outages panel's Internet view. */
function visibleIspNotices() {
  return (state.snap?.ispNotices || []).filter((n) => !state.province || !n.province || n.province === state.province);
}

function renderMap() {
  if (!mapReady || !state.snap) return;
  const rows = visibleRows();
  const areas = [];
  const points = [];
  for (const r of rows) {
    const color = COLORS[r.kind];
    if (r.polygons.length)
      areas.push({ type: 'Feature', properties: { id: r.stableId, kind: r.kind, color }, geometry: { type: 'MultiPolygon', coordinates: r.polygons } });
    points.push({
      type: 'Feature',
      properties: { id: r.stableId, kind: r.kind, color, customers: r.customers ?? 1, selected: r.stableId === state.selectedId },
      geometry: { type: 'Point', coordinates: [r.point.lon, r.point.lat] },
    });
  }
  map.getSource('areas').setData({ type: 'FeatureCollection', features: areas });
  const ispFeatures = [];
  for (const n of state.snap.ispNotices || []) {
    if (state.province && n.province && n.province !== state.province) continue;
    const props = { id: n.id, kind: n.kind, internet: n.internet !== false };
    for (const c of n.circles || []) ispFeatures.push({ type: 'Feature', properties: props, geometry: circlePolygon(c) });
    if (n.circles?.length) continue;
    for (const [lat, lon, w, hgt] of n.cells || [])
      ispFeatures.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [[[lon, lat], [lon + w, lat], [lon + w, lat + hgt], [lon, lat + hgt], [lon, lat]]] } });
    for (const rings of n.polygons || []) ispFeatures.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: rings } });
    const pts = n.areaPoints?.length ? n.areaPoints : n.point ? [n.point] : [];
    for (const p of pts) ispFeatures.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } });
  }
  map.getSource('isp-notices')?.setData({ type: 'FeatureCollection', features: ispFeatures });
  map.getSource('points').setData({ type: 'FeatureCollection', features: points });
  const rank = { out: 0, near: 1, internet: 2, planned: 3, ok: 4, 'no-coverage': 5 };
  map.getSource('sites').setData({
    type: 'FeatureCollection',
    features: state.snap.sites.map((s) => ({
      type: 'Feature',
      properties: {
        id: s.id,
        name: s.name,
        detail: siteDetail(s),
        status: s.impact.status,
        color: s.impact.status === 'ok' ? '#cfeef5' : SITE_COLORS[s.impact.status],
        rank: rank[s.impact.status],
      },
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    })),
  });
  const covered = new Set(Object.keys(state.snap.coverage || {}));
  const internet = state.snap.internet?.provinces || {};
  for (const code of Object.keys(PROVINCE_NAMES))
    map.setFeatureState({ source: 'provinces', id: code }, { covered: covered.has(code), internet: Boolean(internet[code]?.active) });
}

// ------------------------------------------------- territories overlay --

function hashColor(id, province) {
  const base = PROVINCE_COLORS[province] || '#9fb4c2';
  let n = 0;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  const palette = [base, '#5ef0ff', '#ffd166', '#b5e48c', '#ff9f68', '#c77dff', '#7b9cff', '#f72585'];
  return palette[n % palette.length];
}

function bboxCenter(geometry) {
  let [w, s, e, n] = [180, 90, -180, -90];
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let best = null;
  let bestLen = 0;
  for (const p of polys) if (p[0].length > bestLen) [best, bestLen] = [p[0], p[0].length];
  for (const [x, y] of best || []) {
    w = Math.min(w, x);
    e = Math.max(e, x);
    s = Math.min(s, y);
    n = Math.max(n, y);
  }
  return [(w + e) / 2, (s + n) / 2];
}

async function loadTerritories() {
  try {
    const [terr, provs] = await Promise.all([
      fetch('/api/territories').then((r) => r.json()),
      fetch('/data/provinces.geojson').then((r) => r.json()),
    ]);
    for (const f of terr.features) f.properties.color = hashColor(f.properties.id, f.properties.province);
    map.getSource('territories')?.setData(terr);
    const labels = [];
    for (const f of terr.features)
      labels.push({ type: 'Feature', properties: { name: f.properties.name + (f.properties.monitored ? '' : ' ·'), color: f.properties.color, rank: 2 }, geometry: { type: 'Point', coordinates: bboxCenter(f.geometry) } });
    for (const f of provs.features) {
      const code = f.properties.code;
      if (!DEFAULT_UTILITY_LABEL[code]) continue;
      labels.push({ type: 'Feature', properties: { name: DEFAULT_UTILITY_LABEL[code], color: PROVINCE_COLORS[code], rank: 1 }, geometry: { type: 'Point', coordinates: bboxCenter(f.geometry) } });
    }
    map.getSource('terr-labels')?.setData({ type: 'FeatureCollection', features: labels });
  } catch (error) {
    console.warn('[map] territories unavailable', error);
  }
}

// ------------------------------------------------- ISP-in-view overlay --

let ispSeq = 0;
const loadIspInView = debounce(async () => {
  if (!state.layers.isp) return;
  const card = $('isp-card');
  card.hidden = false;
  card.textContent = '';
  const z = map.getZoom();
  if (z < 7.5) {
    card.append(h('h3', { text: 'Internet providers in view' }), h('p', { class: 'hint', text: 'Zoom in to a city or region to list providers.' }));
    map.getSource('isp-hex')?.setData(empty());
    return;
  }
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(4)).join(',');
  const seq = ++ispSeq;
  card.append(h('h3', { text: 'Internet providers in view' }), h('p', { class: 'hint' }, h('span', { class: 'spinner' }), ' Checking the National Broadband Map…'));
  try {
    const res = await fetch(`/api/isp/area?bbox=${bbox}`);
    const data = await res.json();
    if (seq !== ispSeq) return;
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    card.textContent = '';
    card.append(h('h3', { text: 'Internet providers in view' }));
    if (data.error && !data.providers.length) card.append(h('p', { class: 'hint', text: `Lookup failed: ${data.error}` }));
    const max = Math.max(1, ...data.providers.map((p) => p.hexes));
    card.append(
      h('ul', {}, data.providers.slice(0, 18).map((p) =>
        h('li', { title: p.techs.join(', ') },
          h('span', {}, p.name, h('div', { class: 'bar', style: `width:${Math.round((p.hexes / max) * 100)}%` })),
          h('small', { text: p.techs.filter((t) => !/Mobile/.test(t)).slice(0, 2).join(', ') || p.techs[0] || '' }),
        ),
      )),
      h('p', { class: 'hint', text: `${data.sampled} areas sampled. Source: ISED National Broadband Map.` }),
    );
    map.getSource('isp-hex')?.setData({
      type: 'FeatureCollection',
      features: data.hexes.filter((x) => x.polygon?.length > 3).map((x) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [x.polygon] } })),
    });
  } catch (error) {
    if (seq !== ispSeq) return;
    card.textContent = '';
    card.append(h('h3', { text: 'Internet providers in view' }), h('p', { class: 'hint', text: `Lookup failed: ${error.message}` }));
  }
}, 700);
map.on('moveend', () => {
  if (state.layers.isp) loadIspInView();
});

// --------------------------------------------------------------- popups --

function openPopup(lngLat, content) {
  popup?.remove();
  popup = new maplibregl.Popup({ maxWidth: '340px', focusAfterOpen: false }).setLngLat(lngLat).setDOMContent(content).addTo(map);
}

function outagePopup(r) {
  const rows = [
    ['Customers', customersText(r)],
    ['Area', r.area],
    ['Cause', r.cause],
    ['Status', r.status],
    [r.kind === 'planned-upcoming' ? 'Starts' : 'Started', when(r.startMs, r.province)],
    ['Out for', r.kind === 'planned-upcoming' ? null : duration(r.startMs)],
    ['Est. restore', when(r.estRestoreMs, r.province) || r.estRestoreText],
    ['Utility update', r.updatedMs ? ago(r.updatedMs) : null],
  ].filter(([, v]) => v);
  const source = state.snap.sources.find((s) => s.id === r.utility);
  return h('div', { class: 'pop' },
    h('div', { class: 'pop-kind', style: `color:${COLORS[r.kind]}`, text: KIND_TEXT[r.kind] }),
    h('h4', { text: `${utilityName(r.utility)} · ${r.province}` }),
    h('dl', {}, rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
    source?.map?.startsWith('http') ? h('div', { class: 'pop-actions' }, h('a', { class: 'btn', href: source.map, target: '_blank', rel: 'noopener', text: `Open ${source.name}'s map` })) : null,
  );
}

const ISP_STATE_TEXT = {
  out: 'outage reported at this address',
  planned: 'planned maintenance here',
  nearby: 'notice elsewhere in the same town',
  clear: 'no outage reported',
  unknown: 'outage page not reachable right now',
};
function ispNoticePopup(n) {
  const provider = { telus: 'Telus', rogers: 'Rogers / Shaw', teksavvy: 'TekSavvy', sasktel: 'SaskTel' }[n.provider] || n.provider;
  const rows = [
    ['Services', (n.services || []).join(', ')],
    ['Details', n.detail],
    [n.kind === 'planned' ? 'Starts' : 'Since', n.startMs ? new Date(n.startMs).toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null],
    ['Ends', n.endMs ? new Date(n.endMs).toLocaleString('en-CA', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : null],
  ].filter(([, v]) => v);
  return h('div', { class: 'pop' },
    h('div', {
      class: 'pop-kind',
      style: `color:${n.kind === 'planned' ? '#ffb02e' : n.internet === false ? '#a9a2cf' : COLORS.internet}`,
      text: `${n.internet === false ? 'Provider (not Internet)' : 'Internet'}: ${n.kind === 'planned' ? 'planned maintenance' : 'outage notice'}`,
    }),
    h('h4', { text: `${provider} · ${n.title}` }),
    h('dl', {}, rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
    n.link ? h('div', { class: 'pop-actions' }, h('a', { class: 'btn', href: n.link, target: '_blank', rel: 'noopener', text: `Open ${provider}'s outage page` })) : null,
  );
}
/** One line about a site's internet provider, from its outage page. */
function ispLine(isp) {
  if (!isp) return null;
  if (!isp.provider) return { state: 'manual', text: 'No public outage page is known for this provider.' };
  if (!isp.supported) return { state: 'manual', text: `${isp.name}: ${isp.note}`, link: isp.link };
  const top = isp.notices?.[0];
  let text = `${isp.name}: ${ISP_STATE_TEXT[isp.state] || isp.state}`;
  if (top) text += `, "${top.title}"${top.detail ? ` (${top.detail})` : ''}`;
  else if (isp.state === 'clear') text += isp.checkedAt ? ` (checked ${ago(isp.checkedAt)})` : '';
  return { state: isp.state, text, link: top?.link || isp.link };
}
function ispLineEl(isp) {
  const l = ispLine(isp);
  if (!l) return null;
  return h('p', { class: 'isp-line', dataset: { state: l.state } }, l.text, l.link ? h('span', {}, ' ', h('a', { href: l.link, target: '_blank', rel: 'noopener', text: 'outage page' })) : null);
}

function sitePopup(s) {
  const impact = s.impact;
  const rowsById = new Map(state.snap.rows.map((r) => [r.stableId, r]));
  const hits = impact.outages.map((o) => {
    const r = rowsById.get(o.id);
    const what = r ? `${utilityName(r.utility)}, ${customersText(r)} customers` : o.id;
    const where = o.relation === 'inside' ? 'site is inside the outage area' : `${o.distanceKm} km away`;
    const starts = r?.kind === 'planned-upcoming' ? `, starts ${when(r.startMs, r.province)}` : '';
    return h('li', { text: `${KIND_TEXT[o.kind]}: ${what}; ${where}${starts}` });
  });
  const internet = impact.internet ? state.snap.internet.provinces[impact.province] : null;
  const u = impact.utility;
  return h('div', { class: 'pop' },
    h('span', { class: `status status-${impact.status}`, text: SITE_STATUS_TEXT[impact.status] }),
    h('h4', { text: s.name }),
    s.address ? h('div', { class: 'item-meta', text: s.address }) : null,
    h('dl', { style: 'margin-top:8px' },
      h('dt', { text: 'Power' }), h('dd', { text: u ? `${u.name}${u.monitored ? '' : ' (not monitored)'}` : 'unknown' }),
      h('dt', { text: 'Internet' }), h('dd', { text: s.isp || 'not set' }),
    ),
    hits.length ? h('ul', {}, hits) : null,
    ispLineEl(impact.isp),
    impact.network ? h('p', { style: 'color:#c7b8ff', text: `${impact.network.name}'s network shows a drop since ${LOCAL.format(new Date(impact.network.since))} (IODA ${impact.network.signals.join(', ')}). National network signal, may not be this site.` }) : null,
    internet ? h('p', { style: 'color:#c7b8ff', text: `Internet connectivity across ${PROVINCE_NAMES[impact.province]} dropped ${ago(internet.since)} (IODA). Province-wide, not site-specific.` }) : null,
    impact.status === 'no-coverage' ? h('p', { style: 'color:#9fb4c2', text: u && !u.monitored ? `${u.name} publishes no live outage map, so this site cannot be checked automatically.` : `Power outages aren't monitored in ${PROVINCE_NAMES[impact.province] || 'this area'}.` }) : null,
    s.notes ? h('p', { text: s.notes }) : null,
    h('div', { class: 'pop-actions' }, h('button', { class: 'btn', type: 'button', text: 'Edit client', onclick: () => openSitePanel(s) })),
  );
}

function boundsOf(polygons) {
  const b = new maplibregl.LngLatBounds();
  for (const rings of polygons) for (const [x, y] of rings[0]) b.extend([x, y]);
  return b;
}

function selectOutage(id, { fly = true, lngLat = null } = {}) {
  const r = state.snap?.rows.find((x) => x.stableId === id);
  if (!r) return;
  state.selectedId = id;
  state.selectedSiteId = null;
  if (fly) {
    if (r.polygons.length) map.fitBounds(boundsOf(r.polygons), { padding: 120, maxZoom: 13, duration: 900 });
    else map.flyTo({ center: [r.point.lon, r.point.lat], zoom: Math.max(map.getZoom(), 11), duration: 900 });
  }
  openPopup(lngLat || [r.point.lon, r.point.lat], outagePopup(r));
  renderMap();
  renderOutageList();
}

function selectSite(id, { fly = true } = {}) {
  const s = state.snap?.sites.find((x) => x.id === id);
  if (!s) return;
  state.selectedSiteId = id;
  state.selectedId = null;
  if (fly) map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 11), duration: 900 });
  openPopup([s.lon, s.lat], sitePopup(s));
  renderSiteList();
}

// ------------------------------------------------------------ top HUD --

function renderTop() {
  const s = state.snap;
  $('demo-badge').hidden = !s.demo;
  const t = s.totals;
  const down = s.sources.filter((x) => x.status === 'down');
  const stale = s.sources.filter((x) => x.status === 'stale');
  const noData = down.length === s.sources.length;
  const k = $('k-customers');
  k.textContent = noData ? 'No data' : fmt(t.customersOut);
  k.classList.toggle('no-data', noData);
  k.classList.toggle('zero', !noData && t.customersOut === 0);
  $('k-label').textContent = noData ? 'feeds down' : 'customers out';
  $('kpi-out').classList.toggle('alert', !noData && t.bigOutages > 0);
  const n = (v) => (noData ? '–' : fmt(v));
  $('k-unplanned').textContent = n(t.outages);
  $('k-planned').textContent = n(t.plannedActive);
  $('k-clients').textContent = t.sitesTotal ? `${t.sitesAffected}/${t.sitesTotal}` : '0';
  $('kpi-clients').classList.toggle('alert', t.sitesAffected > 0);
  // Provider-reported Internet outages (not planned work) plus IODA drops.
  const ispOut = (s.ispNotices || []).filter((n) => n.kind === 'outage' && n.internet !== false).length;
  const netAlerts = ispOut + (t.internetAlerts || 0) + (t.networkAlerts || 0);
  $('kpi-net').title = `${ispOut} Internet outage${ispOut === 1 ? '' : 's'} reported by providers (Telus, Rogers/Shaw, TekSavvy, SaskTel)` +
    `, ${t.internetAlerts || 0} province-wide drop${t.internetAlerts === 1 ? '' : 's'} and ${t.networkAlerts || 0} provider network drop${t.networkAlerts === 1 ? '' : 's'} (IODA). Click for the list.`;
  $('k-internet').textContent = s.internet?.status === 'down' ? '–' : fmt(netAlerts);
  $('kpi-net').classList.toggle('alert', netAlerts > 0);
  const live = s.sources.length - down.length - stale.length;
  $('feeds-dot').dataset.status = down.length ? 'down' : stale.length ? 'stale' : 'ok';
  $('feeds-text').textContent = `${live}/${s.sources.length} live`;
  $('btn-feeds').title = down.length ? `Down: ${down.map((x) => x.name).join(', ')}` : 'All utility feeds answering';
  $('c-outages').textContent = String(t.outages + t.plannedActive || '');
  $('c-clients').textContent = t.sitesAffected ? String(t.sitesAffected) : '';
  stampUpdated();
}

function stampUpdated() {
  const el = $('updated');
  if (!state.lastOkAt) return;
  const late = Date.now() - state.lastOkAt > LATE_MS;
  $('btn-feeds').classList.toggle('late', late);
  el.textContent = late ? `not updating, ${ago(state.lastOkAt)}` : ago(state.snap?.fetchedAt);
}

// --------------------------------------------------------------- panels --

const PANEL_TITLES = { outages: 'Outages', clients: 'Client sites', layers: 'Layers', sources: 'Sources', history: 'Last 24 hours' };
function openPanel(name) {
  if (state.panel === name) name = null;
  state.panel = name;
  $('panel').hidden = !name;
  for (const b of document.querySelectorAll('.dock-btn')) b.setAttribute('aria-pressed', String(b.dataset.panel === name));
  for (const v of Object.keys(PANEL_TITLES)) $(`view-${v}`).hidden = v !== name;
  if (name) $('panel-title').textContent = PANEL_TITLES[name];
  if (name === 'history') loadHistory();
  local.set('panel', name || '');
}
for (const b of document.querySelectorAll('.dock-btn')) b.addEventListener('click', () => openPanel(b.dataset.panel));
$('panel-close').addEventListener('click', () => openPanel(null));
$('btn-feeds').addEventListener('click', () => openPanel('sources'));
$('kpi-clients').addEventListener('click', () => openPanel('clients'));
$('kpi-net').addEventListener('click', () => {
  state.filter = 'internet';
  for (const o of document.querySelectorAll('.segmented button')) o.setAttribute('aria-pressed', String(o.dataset.filter === 'internet'));
  if (state.panel !== 'outages') openPanel('outages');
  renderOutageList();
});

// ---------------------------------------------------------- outage list --

function renderProvinceFilter() {
  const sel = $('prov-filter');
  const have = new Set(Object.keys(state.snap.coverage || {}));
  if (sel.options.length > 1) return;
  for (const code of PROVINCE_ORDER) if (have.has(code)) sel.append(h('option', { value: code, text: PROVINCE_NAMES[code] }));
  sel.value = state.province;
}
$('prov-filter').addEventListener('change', (e) => {
  state.province = e.target.value;
  local.set('provFilter', state.province);
  renderOutageList();
  renderMap();
});

function renderIspList() {
  const list = $('outage-list');
  const q = state.search.trim().toLowerCase();
  const items = visibleIspNotices()
    .filter((n) => !q || [n.title, n.detail, ISP_NAMES[n.provider], (n.services || []).join(' '), PROVINCE_NAMES[n.province]].some((v) => v && v.toLowerCase().includes(q)))
    .sort((a, b) => (a.kind === 'planned') - (b.kind === 'planned') || Number(b.internet !== false) - Number(a.internet !== false) || (b.startMs ?? 0) - (a.startMs ?? 0));
  list.textContent = '';
  const pages = Object.values(state.snap.ispSources || {});
  if (!items.length) {
    list.append(h('li', { class: 'empty' },
      h('p', { text: q || state.province ? 'Nothing matches that filter.' : 'No provider outage notices right now.' }),
      h('p', { text: pages.length ? `Pages answering: ${pages.filter((x) => x.status !== 'down').map((x) => x.name).join(', ') || 'none'}.` : '' }),
    ));
    return;
  }
  for (const n of items) {
    const t = n.kind === 'planned' ? `Planned${n.startMs ? `, ${new Date(n.startMs).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}` : n.startMs ? `Out ${duration(n.startMs)}` : '';
    list.append(h('li', {},
      h('button', { type: 'button', class: 'item', dataset: { kind: n.kind === 'planned' ? 'planned-active' : n.internet === false ? 'phone' : 'internet' }, onclick: () => selectIspNotice(n) },
        h('span', { class: 'item-bar', 'aria-hidden': 'true' }),
        h('span', {},
          h('span', { class: 'item-title' }, n.province ? h('span', { class: 'prov-tag', text: n.province }) : null, n.title),
          h('span', { class: 'item-meta', text: [ISP_NAMES[n.provider], (n.services || []).join(', '), t].filter(Boolean).join(' · ') }),
        ),
        h('span', { class: 'item-num' }, n.internet !== false ? 'NET' : 'PHONE', h('small', { text: n.internet !== false ? 'internet' : 'other' })),
      ),
    ));
  }
}

function selectIspNotice(n) {
  const cs = n.circles?.length ? n.circles : n.point ? [{ ...n.point, km: 2 }] : [];
  if (!cs.length) return;
  const b = new maplibregl.LngLatBounds();
  for (const c of cs) for (const [x, y] of circlePolygon(c, 12).coordinates[0]) b.extend([x, y]);
  map.fitBounds(b, { padding: 140, maxZoom: 13, duration: 900 });
  openPopup([cs[0].lon, cs[0].lat], ispNoticePopup(n));
}

function renderOutageList() {
  if (state.filter === 'internet') return renderIspList();
  const list = $('outage-list');
  const q = state.search.trim().toLowerCase();
  const order = { unplanned: 0, 'planned-active': 1, 'planned-upcoming': 2 };
  const rows = visibleRows()
    .filter((r) => !q || [r.area, r.cause, r.status, utilityName(r.utility), PROVINCE_NAMES[r.province]].some((v) => v && v.toLowerCase().includes(q)))
    .sort((a, b) =>
      a.kind === 'planned-upcoming' && b.kind === 'planned-upcoming'
        ? (a.startMs ?? 0) - (b.startMs ?? 0)
        : order[a.kind] - order[b.kind] || (b.customers ?? -1) - (a.customers ?? -1),
    );
  list.textContent = '';
  if (!rows.length) {
    const live = state.snap.sources.filter((s) => s.status !== 'down').length;
    list.append(h('li', { class: 'empty' },
      h('p', { text: q || state.province ? 'Nothing matches that filter.' : 'No outages reported right now.' }),
      h('p', { text: `${live} of ${state.snap.sources.length} utility feeds are answering.` }),
    ));
    return;
  }
  for (const r of rows.slice(0, 400)) {
    const t = r.kind === 'planned-upcoming' ? `Starts ${when(r.startMs, r.province) || 'soon'}` : r.startMs ? `Out ${duration(r.startMs)}` : r.status || '';
    list.append(h('li', {},
      h('button', { type: 'button', class: `item${r.stableId === state.selectedId ? ' active' : ''}`, dataset: { kind: r.kind }, onclick: () => selectOutage(r.stableId) },
        h('span', { class: 'item-bar', 'aria-hidden': 'true' }),
        h('span', {},
          h('span', { class: 'item-title' }, h('span', { class: 'prov-tag', text: r.province }), placeName(r)),
          h('span', { class: 'item-meta', text: [utilityName(r.utility), t].filter(Boolean).join(' · ') }),
        ),
        h('span', { class: 'item-num' }, customersText(r), h('small', { text: 'customers' })),
      ),
    ));
  }
}

// ------------------------------------------------------------ site list --

function siteMeta(s) {
  const first = s.impact.outages[0];
  const ispNow = s.impact.isp;
  if (ispNow?.state === 'out' && !['out', 'near'].includes(s.impact.status)) return `${ispNow.name} reports an outage here: ${ispNow.notices[0]?.title || ''}`;
  if (ispNow?.state === 'planned' && s.impact.status === 'planned' && !first) return `${ispNow.name} planned maintenance: ${ispNow.notices[0]?.title || ''}`;
  const u = s.impact.utility;
  if (first && s.impact.status !== 'planned') return first.relation === 'inside' ? `Inside a ${utilityName(first.utility)} outage` : `${first.distanceKm} km from a ${utilityName(first.utility)} outage`;
  if (s.impact.status === 'planned' && first) {
    const r = state.snap.rows.find((x) => x.stableId === first.id);
    return `Planned work ${first.distanceKm} km away, starts ${when(r?.startMs, r?.province) || 'soon'}`;
  }
  if (s.impact.status === 'internet') return s.impact.network ? `${s.impact.network.name} network drop` : `Internet drop across ${PROVINCE_NAMES[s.impact.province]}`;
  return [u?.name, s.isp].filter(Boolean).join(' · ') || s.address || '';
}

function renderSiteList() {
  const list = $('site-list');
  const sites = state.snap.sites;
  list.textContent = '';
  $('sites-empty').hidden = sites.length > 0;
  for (const s of sites)
    list.append(h('li', {},
      h('button', { type: 'button', class: `item${s.id === state.selectedSiteId ? ' active' : ''}`, dataset: { status: s.impact.status }, onclick: () => selectSite(s.id) },
        h('span', { class: 'item-bar', 'aria-hidden': 'true' }),
        h('span', {},
          h('span', { class: 'item-title' }, s.impact.province ? h('span', { class: 'prov-tag', text: s.impact.province }) : null, s.name),
          h('span', { class: 'item-meta', text: siteMeta(s) }),
        ),
        h('span', {}, h('span', { class: `status status-${s.impact.status}`, text: SITE_STATUS_TEXT[s.impact.status] })),
      ),
    ));
  renderTvFeed();
}

function renderTvFeed() {
  const feed = $('tv-feed');
  feed.textContent = '';
  const bad = state.snap.sites.filter((s) => ['out', 'near', 'internet', 'planned'].includes(s.impact.status));
  if (!bad.length) feed.append(h('div', { class: 'tv-row', dataset: { status: 'ok' } }, h('b', { text: 'All client sites clear' }), h('span', { text: `${state.snap.sites.length} sites watched` })));
  for (const s of bad.slice(0, 8)) feed.append(h('div', { class: 'tv-row', dataset: { status: s.impact.status } }, h('b', { text: s.name }), h('span', { text: siteMeta(s) })));
}

// --------------------------------------------------------------- sources --

function renderSources() {
  const s = state.snap;
  const list = $('source-list');
  list.textContent = '';
  const card = (src, lines) =>
    h('li', { class: 'source', dataset: { status: src.status } },
      h('div', { class: 'source-head' }, h('span', { class: 'lamp-dot', 'aria-hidden': 'true' }), h('b', { text: src.name }), h('span', { class: 'source-state', text: statusWord(src.status) })),
      ...lines.filter(Boolean),
    );
  for (const code of PROVINCE_ORDER) {
    const srcs = s.sources.filter((x) => x.province === code);
    if (!srcs.length) continue;
    list.append(h('li', { class: 'prov-head', text: PROVINCE_NAMES[code] }));
    for (const src of srcs)
      list.append(card(src, [
        h('p', { text: src.region }),
        h('p', { text: `${fmt(src.outages)} unplanned, ${fmt(src.plannedActive)} planned now, ${fmt(src.customersOut)} customers out. Last good data ${ago(src.lastSuccessAt)}.` }),
        src.status === 'stale' ? h('p', { text: 'Showing its last good data while the feed is failing; dropped after 30 minutes.' }) : null,
        src.error ? h('p', { class: 'source-error', text: `Last error: ${src.error}` }) : null,
        src.map?.startsWith('http') ? h('p', {}, h('a', { href: src.map, target: '_blank', rel: 'noopener', text: `Open ${src.name}'s own outage map` })) : null,
      ]));
  }
  if (s.internet && s.internet.status !== 'off') {
    const active = Object.values(s.internet.provinces || {}).filter((p) => p.active);
    const nets = Object.values(s.internet.networks || {}).filter((n) => n.active);
    list.append(h('li', { class: 'prov-head', text: 'Internet' }));
    list.append(card(s.internet, [
      h('p', { text: active.length ? `Province-wide drop now: ${active.map((p) => `${PROVINCE_NAMES[p.code]} (since ${LOCAL.format(new Date(p.since))})`).join('; ')}.` : 'No province-wide internet drop right now.' }),
      h('p', { text: nets.length ? `Provider networks dropping: ${nets.map((n) => `${n.name} (AS${n.asn}, since ${LOCAL.format(new Date(n.since))})`).join('; ')}.` : `Watching ${Object.keys(s.internet.networks || {}).length} provider networks (Bell, Rogers, Shaw, Telus, SaskTel, Eastlink, Cogeco…): all normal.` }),
      (() => {
        const long = [
          ...Object.values(s.internet.provinces || {}).filter((p) => p.longRunning).map((p) => PROVINCE_NAMES[p.code]),
          ...Object.values(s.internet.networks || {}).filter((n) => n.longRunning).map((n) => n.name),
        ];
        return long.length ? h('p', { text: `Ignored as long-running routing changes (open for more than 48 h): ${long.join(', ')}.` }) : null;
      })(),
      s.internet.networksError ? h('p', { class: 'source-error', text: `Provider networks: ${s.internet.networksError}` }) : null,
      s.internet.error ? h('p', { class: 'source-error', text: `Last error: ${s.internet.error}` }) : null,
      h('p', { text: 'Data: IODA, Georgia Tech. Measured connectivity, not provider status pages.' }),
    ]));
  }
  const pages = Object.values(s.ispSources || {});
  if (pages.length) {
    list.append(h('li', { class: 'prov-head', text: 'Internet provider outage pages' }));
    for (const src of pages)
      list.append(card(src, [
        h('p', { text: `${fmt(src.notices)} open notice${src.notices === 1 ? '' : 's'} with Internet affected. Last good data ${ago(src.lastSuccessAt)}.` }),
        src.error ? h('p', { class: 'source-error', text: `Last error: ${src.error}` }) : null,
        h('p', {}, h('a', { href: src.page, target: '_blank', rel: 'noopener', text: `Open ${src.name}'s outage page` })),
      ]));
    list.append(h('li', {}, h('p', { class: 'hint', text: 'Bell checks addresses behind a CAPTCHA, and Eastlink, Cogeco and Xplore publish no public map, so those clients rely on the network signals above.' })));
  }
  const cov = $('coverage');
  cov.textContent = '';
  cov.append(h('h3', { text: 'Not covered' }));
  for (const code of PROVINCE_ORDER) {
    const c = s.coverage?.[code];
    if (c?.unmonitored?.length) cov.append(h('p', { text: `${c.name}:` }), h('ul', {}, c.unmonitored.map((u) => h('li', { text: u }))));
  }
  cov.append(h('p', { text: 'Quebec and the territories are not monitored.' }));
}

// --------------------------------------------------------------- history --

async function loadHistory() {
  try {
    const [hist, ev] = await Promise.all([fetch('/api/history?hours=24').then((r) => r.json()), fetch('/api/events?limit=80').then((r) => r.json())]);
    state.history = (hist.points || []).slice().sort((a, b) => a.t - b.t);
    state.events = ev.events || [];
    renderHistory();
  } catch {
    /* next refresh retries */
  }
}

function renderHistory() {
  const box = $('chart');
  const pts = state.history;
  box.textContent = '';
  const legend = $('chart-legend');
  legend.textContent = '';
  const provOf = new Map((state.snap?.sources || []).map((s) => [s.id, s.province]));
  if (pts.length < 2) {
    box.append(h('p', { class: 'empty', text: 'The chart fills in as the server records a point every 5 minutes.' }));
  } else {
    const ids = PROVINCE_ORDER;
    const byProv = (p) => {
      const out = Object.fromEntries(ids.map((c) => [c, 0]));
      for (const [id, v] of Object.entries(p.bySource || {})) {
        const c = provOf.get(id) || 'AB';
        if (c in out) out[c] += v ?? 0;
      }
      return out;
    };
    const W = Math.max(280, box.clientWidth || 360);
    const H = 180;
    const pad = { l: 44, r: 8, t: 8, b: 22 };
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const stacks = pts.map((p) => {
      const v = byProv(p);
      let acc = 0;
      return ids.map((id) => (acc += v[id]));
    });
    const max = Math.max(10, ...stacks.map((s) => s[s.length - 1]));
    const step = 10 ** Math.floor(Math.log10(max));
    const top = Math.ceil(max / step) * step;
    const x = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
    const y = (v) => H - pad.b - (v / top) * (H - pad.t - pad.b);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const el = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      svg.append(e);
      return e;
    };
    for (const v of [0, top / 2, top]) {
      el('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: 'rgba(159,180,194,0.18)' });
      el('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end', fill: '#9fb4c2', 'font-size': 11 }).textContent = fmt(v);
    }
    for (let i = ids.length - 1; i >= 0; i--) {
      const upper = pts.map((p, j) => `${x(p.t)},${y(stacks[j][i])}`);
      const lower = pts.map((p, j) => `${x(p.t)},${y(i ? stacks[j][i - 1] : 0)}`).reverse();
      el('polygon', { points: [...upper, ...lower].join(' '), fill: PROVINCE_COLORS[ids[i]], 'fill-opacity': 0.8 });
    }
    const hours = (t1 - t0) / 3600_000;
    const tickEvery = hours > 12 ? 6 : hours > 4 ? 2 : 1;
    const first = Math.ceil(t0 / (tickEvery * 3600_000)) * tickEvery * 3600_000;
    for (let t = first; t <= t1; t += tickEvery * 3600_000)
      el('text', { x: x(t), y: H - 6, 'text-anchor': 'middle', fill: '#9fb4c2', 'font-size': 11 }).textContent = LOCAL.format(new Date(t));
    box.append(svg);
    for (const id of ids) legend.append(h('span', {}, h('i', { style: `background:${PROVINCE_COLORS[id]}` }), id));
  }

  const list = $('events');
  list.textContent = '';
  if (!state.events.length) list.append(h('li', {}, h('span'), h('span', { class: 'empty', text: 'No changes recorded yet.' })));
  for (const e of state.events) {
    let cls = '';
    let text = '';
    const who = utilityName(e.utility);
    const where = e.area || 'unnamed area';
    const cust = Number.isFinite(e.customers) ? `, ${fmt(e.customers)} customers` : '';
    if (e.type === 'outage-started') [cls, text] = ['ev-start', `Outage started: ${who}, ${where}${cust}`];
    else if (e.type === 'outage-ended') [cls, text] = ['ev-end', `Restored: ${who}, ${where}${e.startMs ? ` after ${duration(e.startMs)}` : ''}`];
    else if (e.type === 'planned-started') [cls, text] = ['', `Planned work began: ${who}, ${where}${cust}`];
    else if (e.type === 'planned-ended') [cls, text] = ['ev-end', `Planned work finished: ${who}, ${where}`];
    else if (e.type === 'site-status') [cls, text] = ['ev-site', `${e.site}: ${SITE_STATUS_TEXT[e.to] || e.to}`];
    else continue;
    list.append(h('li', {}, h('time', { datetime: new Date(e.t).toISOString(), text: LOCAL.format(new Date(e.t)) }), h('span', { class: cls, text })));
  }
}

// ---------------------------------------------------------------- alerts --

let audio = null;
function beep() {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.5);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.5);
  } catch {
    /* no audio device */
  }
}

function toast(title, body, tone = 'site') {
  const t = h('div', { class: 'toast', dataset: { tone } }, h('b', { text: title }), body ? h('span', { text: body }) : null);
  $('toasts').append(t);
  setTimeout(() => t.remove(), 12_000);
}

function checkAlerts() {
  const s = state.snap;
  const now = new Map(s.sites.map((x) => [x.id, x.impact.status]));
  const bad = new Set(['out', 'near', 'internet']);
  const outageIds = new Set(s.rows.filter((r) => r.kind === 'unplanned').map((r) => r.stableId));
  if (state.prevSiteStatus) {
    for (const site of s.sites) {
      const before = state.prevSiteStatus.get(site.id);
      const after = site.impact.status;
      if (before !== undefined && before !== after && bad.has(after)) notify(`${site.name}: ${SITE_STATUS_TEXT[after]}`, siteMeta(site), 'bad');
      if (before !== undefined && bad.has(before) && !bad.has(after)) notify(`${site.name}: clear`, SITE_STATUS_TEXT[after]);
    }
    for (const r of s.rows)
      if (r.kind === 'unplanned' && (r.customers ?? 0) >= 1000 && !state.prevOutageIds.has(r.stableId))
        notify(`Large outage: ${fmt(r.customers)} customers`, `${utilityName(r.utility)}, ${placeName(r)}`, 'bad');
  }
  state.prevSiteStatus = now;
  state.prevOutageIds = outageIds;
}

function notify(title, body, tone) {
  toast(title, body, tone);
  if (!state.alerts) return;
  beep();
  if ('Notification' in window && Notification.permission === 'granted')
    try {
      new Notification(title, { body, icon: '/icon.svg', tag: title });
    } catch {
      /* some browsers only allow notifications from a service worker */
    }
}

function renderAlertButton() {
  const b = $('btn-alerts');
  b.setAttribute('aria-pressed', String(state.alerts));
  b.querySelector('.btn-label').textContent = state.alerts ? 'Alerts on' : 'Alerts off';
}
$('btn-alerts').addEventListener('click', async () => {
  state.alerts = !state.alerts;
  local.set('alerts', state.alerts ? 'on' : 'off');
  if (state.alerts) {
    beep();
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    toast('Alerts on', 'You will hear a tone when a client site is hit, and see a desktop notice if allowed.');
  }
  renderAlertButton();
});

// ------------------------------------------------------- place search --

/** Short badge for what a suggestion stands for. */
const KIND_BADGES = {
  address: ['Exact', 'exact'],
  estimated: ['On street', 'exact'],
  nearest: ['Nearest address', 'approx'],
  road: ['Street', 'approx'],
  street: ['Street', 'approx'],
  postcode: ['Postal code', 'approx'],
  'postal-area': ['Postal area', 'approx'],
};
const kindBadge = (p) => {
  const [text, tone] = KIND_BADGES[p.kind] || [p.precise ? 'Exact' : 'Area', p.precise ? 'exact' : ''];
  return h('span', { class: `kind ${tone}`, text });
};

function attachSuggest(input, listEl, onPick) {
  let seq = 0;
  let results = [];
  let resultsFor = null; // the text `results` were found for
  const close = () => {
    listEl.hidden = true;
  };
  const search = async (q) => {
    const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`).then((x) => x.json());
    return r;
  };
  const doSearch = async () => {
    const q = input.value.trim();
    if (q.length < 3) return close();
    const my = ++seq;
    if (listEl.hidden || !listEl.querySelector('.busy')) {
      listEl.textContent = '';
      listEl.append(h('li', { class: 'busy' }, h('span', { class: 'spinner' }), 'Searching…'));
      listEl.hidden = false;
    }
    try {
      const r = await search(q);
      if (my !== seq) return;
      results = r.results || [];
      resultsFor = q;
      listEl.textContent = '';
      if (!results.length) listEl.append(h('li', {}, h('button', { type: 'button', disabled: true, text: r.error || 'No matches in Canada' })));
      for (const p of results)
        listEl.append(h('li', {}, h('button', { type: 'button', onclick: () => {
          close();
          onPick(p);
        } }, kindBadge(p), p.label || p.full, h('small', { text: p.full }))));
      listEl.hidden = false;
    } catch {
      close();
    }
  };
  const run = debounce(doSearch, 450);
  input.addEventListener('input', (e) => {
    // Older matches belong to older text; never let Enter pick one of them.
    results = [];
    resultsFor = null;
    if (e.inputType === 'insertFromPaste') doSearch();
    else run();
  });
  // A pasted address (often several lines off a website) arrives as one line.
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text');
    if (!text || !/[\r\n]/.test(text)) return;
    e.preventDefault();
    input.value = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).join(', ');
    input.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste' }));
  });
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') close();
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = input.value.trim();
    if (q.length < 3) return;
    if (resultsFor === q && results[0]) {
      close();
      return onPick(results[0]);
    }
    // Typed or pasted faster than the suggestions arrived: search now.
    const my = ++seq;
    try {
      const r = await search(q);
      if (my !== seq || input.value.trim() !== q) return;
      results = r.results || [];
      resultsFor = q;
      close();
      if (results[0]) onPick(results[0]);
      else toast('No matches in Canada', q, 'bad');
    } catch {
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 200));
}
attachSuggest($('go-search'), $('go-suggest'), (p) => map.flyTo({ center: [p.lon, p.lat], zoom: p.precise ? 15 : 12, duration: 1200 }));
attachSuggest($('addr-search'), $('addr-suggest'), (p) => {
  placeDraft(p.lat, p.lon, p);
  map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), p.precise ? 15 : 12), duration: 900 });
});

// ----------------------------------------------------------- site editing --

async function api(method, url, body, type = 'application/json') {
  const headers = { 'Content-Type': type };
  if (state.editToken) headers['X-Edit-Token'] = state.editToken;
  const res = await fetch(url, { method, headers, body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && state.snap?.editProtected) {
    const code = window.prompt('Enter the edit code to change client sites:');
    if (code) {
      state.editToken = code;
      local.set('editToken', code);
      return api(method, url, body, type);
    }
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function setPicking(on) {
  state.picking = on;
  $('pick-banner').hidden = !on;
  document.body.classList.toggle('map-picking', on);
  map.getCanvas().style.cursor = on ? 'crosshair' : '';
}

function openSitePanel(site = null) {
  popup?.remove();
  state.editingSiteId = site?.id || null;
  $('site-panel').hidden = false;
  $('site-form-title').textContent = site ? `Edit ${site.name}` : 'New client';
  $('site-delete').hidden = !site;
  $('site-error').hidden = true;
  $('addr-search').value = '';
  const form = $('site-form');
  form.reset();
  if (site) {
    form.elements.name.value = site.name;
    form.elements.address.value = site.address || '';
    form.elements.notes.value = site.notes || '';
    form.elements.radiusKm.value = site.radiusKm || '';
    placeDraft(site.lat, site.lon, null, site);
  } else {
    form.hidden = true;
    $('lookup').textContent = '';
    removePin();
    setPicking(true);
    $('addr-search').focus();
  }
}

function closeSitePanel() {
  $('site-panel').hidden = true;
  state.editingSiteId = null;
  state.draft = null;
  setPicking(false);
  removePin();
}

function removePin() {
  pin?.remove();
  pin = null;
}

function ensurePin(lat, lon) {
  if (!pin) {
    const el = h('div', { class: 'draft-pin', title: 'Drag to adjust' }, h('i'));
    pin = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([lon, lat]).addTo(map);
    pin.on('dragend', () => {
      const p = pin.getLngLat();
      placeDraft(p.lat, p.lng, null, state.snap?.sites.find((s) => s.id === state.editingSiteId) || null);
    });
  } else pin.setLngLat([lon, lat]);
}

let lookupSeq = 0;
/** A point was chosen (click, search or drag): fill coordinates and look it up. */
async function placeDraft(lat, lon, place = null, site = null) {
  setPicking(false);
  ensurePin(lat, lon);
  const form = $('site-form');
  form.hidden = false;
  form.elements.lat.value = lat.toFixed(6);
  form.elements.lon.value = lon.toFixed(6);
  const addr = form.elements.address;
  if (place?.label && !site) {
    addr.value = place.address || place.label;
    addr.dataset.auto = '1';
  }
  const box = $('lookup');
  box.textContent = '';
  box.append(h('div', { class: 'row' }, h('span', { class: 'spinner' }), ' Looking up utility and internet providers…'));
  const seq = ++lookupSeq;
  let info;
  try {
    info = await fetch(`/api/lookup?lat=${lat}&lon=${lon}`).then((r) => r.json());
  } catch (error) {
    info = { error: error.message };
  }
  if (seq !== lookupSeq) return;
  state.draft = { lat, lon, info };
  if (!site && !place && info.address?.label && (!addr.value || addr.dataset.auto === '1')) {
    addr.value = info.address.label;
    addr.dataset.auto = '1';
  }
  if (!site && !form.elements.name.value) form.elements.name.focus();
  renderLookup(info, site, place);
}

const KIND_NAMES = { road: 'the street', street: 'the street', postcode: 'the postal code', 'postal-area': 'the postal area', town: 'the town', city: 'the city', village: 'the village', suburb: 'the neighbourhood', neighbourhood: 'the neighbourhood', municipality: 'the municipality', county: 'the county' };

/** Other clients pinned within `m` metres of a point. */
function sitesNear(lat, lon, exceptId, m = 30) {
  const k = Math.cos((lat * Math.PI) / 180);
  return (state.snap?.sites || []).filter((s) => s.id !== exceptId && Math.hypot((s.lat - lat) * 111_320, (s.lon - lon) * 111_320 * k) < m);
}

function renderLookup(info, site, place = null) {
  const box = $('lookup');
  box.textContent = '';
  const fe = $('site-form').elements;
  fe.city.value = info.address?.city || site?.city || '';
  fe.area.value = info.address?.area || site?.area || '';
  const province = info.provinceName || info.province || 'outside the covered provinces';
  box.append(h('div', { class: 'row' }, h('b', { text: 'Where' }), h('span', { text: `${info.address?.city ? `${info.address.city}, ` : ''}${province}` })));
  if (info.province && !info.covered) box.append(h('div', { class: 'row' }, h('b', { text: 'Note' }), h('span', { text: 'Power outages are not monitored in this province.' })));
  if (place?.kind === 'nearest')
    box.append(h('div', { class: 'row warn' }, h('b', { text: 'Check' }), h('span', { text: 'Pinned at the nearest known address in that postal code. Drag the pin onto the site so outage distances are right.' })));
  else if (place && !place.precise)
    box.append(h('div', { class: 'row warn' }, h('b', { text: 'Check' }), h('span', { text: `The search only matched ${KIND_NAMES[place.kind] || 'an area'}, not the building. Drag the pin onto the site so outage distances are right.` })));
  else if (place?.kind === 'estimated')
    box.append(h('div', { class: 'row' }, h('b', { text: 'Note' }), h('span', { text: 'Position estimated along the street. Check the pin is on the right building.' })));
  const lat = Number($('site-form').elements.lat.value);
  const lon = Number($('site-form').elements.lon.value);
  const twins = sitesNear(lat, lon, site?.id);
  if (twins.length)
    box.append(h('div', { class: 'row warn' }, h('b', { text: 'Check' }), h('span', { text: `Same spot as ${twins.map((t) => t.name).join(', ')}. Drag the pin if this client is somewhere else.` })));

  // Power utility: the lookup's answer first, the province's others after.
  const sel = $('f-utility');
  sel.textContent = '';
  const p = info.power || {};
  const opts = p.options || [];
  sel.append(h('option', { value: '', text: p.id ? `Automatic: ${p.name}` : 'Automatic (unknown)' }));
  for (const o of opts) sel.append(h('option', { value: o.id, text: `${o.name}${o.monitored ? '' : ' (not monitored)'}` }));
  if (site?.utility) sel.value = site.utility;
  const confText = { boundary: 'service-area map', city: 'municipal utility', province: 'main utility in province', guess: 'best guess, confirm on bill', chosen: 'chosen' };
  $('utility-hint').textContent = p.id
    ? `${p.name} (${confText[p.confidence] || p.confidence})${p.monitored ? ', live outages monitored' : ', no live outage feed'}.`
    : 'No utility found for this point.';
  if (p.id)
    box.append(h('div', { class: 'row' }, h('b', { text: 'Power' }), h('span', {}, p.name, h('span', { class: `conf ${p.confidence}`, text: confText[p.confidence] || p.confidence }))));

  // Internet providers serving this hexagon.
  const isp = $('f-isp');
  isp.textContent = '';
  isp.append(h('option', { value: '', text: 'Not set' }));
  const providers = info.internet?.providers || [];
  const retail = providers.filter((x) => x.retail);
  for (const x of retail) isp.append(h('option', { value: x.name, text: `${x.name} · ${x.techs.filter((t) => !/transport/i.test(t)).join(', ')}${x.ioda ? ' · network watched' : ''}` }));
  isp.append(h('option', { value: '__other', text: 'Other…' }));
  const other = $('f-isp-other');
  if (site?.isp) {
    if (retail.some((x) => x.name === site.isp)) isp.value = site.isp;
    else {
      isp.value = '__other';
      other.value = site.isp;
    }
  }
  other.hidden = isp.value !== '__other';
  checkIsp();
  $('isp-hint').textContent = info.internet
    ? `${retail.length} provider${retail.length === 1 ? '' : 's'} serve this area (National Broadband Map).`
    : `Provider list unavailable${info.internetError ? ` (${info.internetError})` : ''}. Choose Other to type one.`;
  if (retail.length)
    box.append(h('div', { class: 'row' }, h('b', { text: 'Internet' }), h('span', { text: retail.slice(0, 5).map((x) => x.name).join(', ') + (retail.length > 5 ? ` +${retail.length - 5}` : '') })));
}

$('site-form').elements.address.addEventListener('input', (e) => {
  e.target.dataset.auto = '';
});
let ispCheckSeq = 0;
/** Ask the selected provider's outage page about this address. */
async function checkIsp() {
  const f = $('site-form').elements;
  const name = f.ispPick.value === '__other' ? $('f-isp-other').value : f.ispPick.value;
  const box = $('isp-check');
  box.textContent = '';
  delete box.dataset.state;
  if (!name || !f.lat.value) return;
  const seq = ++ispCheckSeq;
  try {
    const q = new URLSearchParams({ lat: f.lat.value, lon: f.lon.value, isp: name, city: f.city.value, area: f.area.value });
    const { status } = await fetch(`/api/isp/check?${q}`).then((r) => r.json());
    if (seq !== ispCheckSeq) return;
    const l = ispLine(status);
    if (!l) return;
    box.dataset.state = l.state;
    box.append(h('b', { text: 'Outage check: ' }), l.text, l.link ? h('span', {}, ' ', h('a', { href: l.link, target: '_blank', rel: 'noopener', text: 'outage page' })) : null);
  } catch {
    /* the site list will show it after saving */
  }
}
$('f-isp').addEventListener('change', (e) => {
  $('f-isp-other').hidden = e.target.value !== '__other';
  if (e.target.value === '__other') $('f-isp-other').focus();
  checkIsp();
});
$('f-isp-other').addEventListener('change', checkIsp);
for (const id of ['btn-add-site', 'btn-add-site-2']) $(id).addEventListener('click', () => openSitePanel(null));
$('site-cancel').addEventListener('click', closeSitePanel);
$('site-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const twins = sitesNear(Number(f.lat.value), Number(f.lon.value), state.editingSiteId);
  if (twins.length && !window.confirm(`${f.name.value || 'This client'} is pinned at the same spot as ${twins.map((t) => t.name).join(', ')}. Save it there anyway?`)) return;
  const ispPick = f.ispPick.value;
  const body = JSON.stringify({
    name: f.name.value,
    address: f.address.value,
    notes: f.notes.value,
    lat: f.lat.value,
    lon: f.lon.value,
    radiusKm: f.radiusKm.value,
    utility: f.utility.value,
    isp: ispPick === '__other' ? $('f-isp-other').value : ispPick,
    city: f.city.value,
    area: f.area.value,
  });
  try {
    const id = state.editingSiteId;
    const saved = id ? await api('PUT', `/api/sites/${id}`, body) : await api('POST', '/api/sites', body);
    closeSitePanel();
    toast(id ? 'Client saved' : 'Client added', saved.site.name);
    await refresh();
    selectSite(saved.site.id, { fly: false });
  } catch (error) {
    $('site-error').textContent = error.message;
    $('site-error').hidden = false;
  }
});
$('site-delete').addEventListener('click', async () => {
  const id = state.editingSiteId;
  const site = state.snap.sites.find((s) => s.id === id);
  if (!id || !window.confirm(`Remove ${site?.name || 'this client'}?`)) return;
  try {
    await api('DELETE', `/api/sites/${id}`);
    closeSitePanel();
    toast('Client removed', site?.name);
    await refresh();
  } catch (error) {
    $('site-error').textContent = error.message;
    $('site-error').hidden = false;
  }
});
for (const name of ['lat', 'lon'])
  $('site-form').elements[name].addEventListener('change', () => {
    const f = $('site-form').elements;
    const lat = Number(f.lat.value);
    const lon = Number(f.lon.value);
    if (Number.isFinite(lat) && Number.isFinite(lon)) placeDraft(lat, lon, null, state.snap.sites.find((s) => s.id === state.editingSiteId));
  });
$('csv-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const replace = state.snap.sites.length > 0 && window.confirm('Replace all existing clients with this file? Choose Cancel to add them to the current list instead.');
  try {
    const res = await api('POST', `/api/sites/import?mode=${replace ? 'replace' : 'append'}`, await file.text(), 'text/csv');
    toast(`Imported ${res.imported} client${res.imported === 1 ? '' : 's'}`, res.errors?.length ? `${res.errors.length} rows skipped: ${res.errors[0]}` : '');
    await refresh();
  } catch (error) {
    toast('Import failed', error.message, 'bad');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.picking) {
    setPicking(false);
    if (!state.draft) closeSitePanel();
  }
});

// ------------------------------------------------------------- layers --

for (const box of document.querySelectorAll('[data-layer]')) {
  box.checked = state.layers[box.dataset.layer];
  box.addEventListener('change', () => {
    state.layers[box.dataset.layer] = box.checked;
    local.set(`layer:${box.dataset.layer}`, box.checked ? 'on' : 'off');
    applyLayerVisibility();
  });
}

// ---------------------------------------------------------- outage tools --

for (const b of document.querySelectorAll('.segmented button'))
  b.addEventListener('click', () => {
    state.filter = b.dataset.filter;
    for (const o of document.querySelectorAll('.segmented button')) o.setAttribute('aria-pressed', String(o === b));
    renderOutageList();
    renderMap();
  });
$('search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderOutageList();
});

function setTv(on) {
  document.body.classList.toggle('tv', on);
  const url = new URL(location.href);
  if (on) url.searchParams.set('tv', '1');
  else url.searchParams.delete('tv');
  history.replaceState(null, '', url);
  $('btn-tv').querySelector('.btn-label').textContent = on ? 'Exit wall view' : 'Wall view';
  if (on) openPanel(null);
  setTimeout(() => map.resize(), 50);
}
$('btn-tv').addEventListener('click', () => setTv(!document.body.classList.contains('tv')));

// --------------------------------------------------------------- refresh --

async function refresh() {
  try {
    const res = await fetch('/api/snapshot', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.snap = await res.json();
    state.lastOkAt = Date.now();
    renderTop();
    renderProvinceFilter();
    renderOutageList();
    renderSiteList();
    renderSources();
    renderMap();
    checkAlerts();
    if (popup && state.selectedId) {
      const r = state.snap.rows.find((x) => x.stableId === state.selectedId);
      if (r) popup.setDOMContent(outagePopup(r));
      else popup.remove();
    }
  } catch (error) {
    $('btn-feeds').classList.add('late');
    $('updated').textContent = state.lastOkAt ? `server unreachable, ${ago(state.lastOkAt)}` : `server unreachable (${error.message})`;
  }
}

renderAlertButton();
if (new URLSearchParams(location.search).get('tv') === '1' || location.pathname === '/tv') setTv(true);
else if (local.get('panel')) openPanel(local.get('panel'));
refresh();
setInterval(refresh, REFRESH_MS);
setInterval(() => {
  if (state.panel === 'history') loadHistory();
}, HISTORY_REFRESH_MS);
setInterval(stampUpdated, 5_000);
window.addEventListener('resize', () => {
  if (state.panel === 'history') renderHistory();
});
