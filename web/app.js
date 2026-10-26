/* Outage Desk front end. Plain DOM + MapLibre; every value from a utility
 * is written as text, never as HTML. */

const maplibregl = window.maplibregl;
maplibregl.setWorkerUrl('/vendor/maplibre-gl-csp-worker.js');

const REFRESH_MS = 30_000;
const HISTORY_REFRESH_MS = 120_000;
const LATE_MS = 3 * 60_000;
const CANADA = [
  [-141, 41.6],
  [-52.6, 70],
];
const ALBERTA = [
  [-120.2, 48.9],
  [-109.9, 60.1],
];
const COLORS = {
  unplanned: '#ff5a47',
  'planned-active': '#f6b73c',
  'planned-upcoming': '#6fa8dc',
  site: '#2ec4b6',
  internet: '#a78bfa',
};
const SITE_COLORS = {
  out: '#ff5a47',
  near: '#f6b73c',
  internet: '#a78bfa',
  planned: '#6fa8dc',
  ok: '#2ec4b6',
  'no-coverage': '#8fa1b3',
};
const SITE_STATUS_TEXT = {
  out: 'Inside an outage',
  near: 'Outage nearby',
  internet: 'Internet disruption in province',
  planned: 'Planned work coming',
  ok: 'No outages nearby',
  'no-coverage': 'Power not monitored here',
};
const KIND_TEXT = {
  unplanned: 'Unplanned outage',
  'planned-active': 'Planned work underway',
  'planned-upcoming': 'Planned work, upcoming',
};
const UTILITY = { atco: 'ATCO Electric', fortis: 'FortisAlberta', enmax: 'ENMAX', epcor: 'EPCOR' };
const SHORT = { atco: 'ATCO', fortis: 'Fortis', enmax: 'ENMAX', epcor: 'EPCOR', ioda: 'Internet' };
const CHART_COLORS = { atco: '#5b8def', fortis: '#7fb685', enmax: '#d9a441', epcor: '#c38d9e' };
const PROVINCE_NAMES = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories',
  NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec',
  SK: 'Saskatchewan', YT: 'Yukon',
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
const store = {
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

/* Alberta has been on UTC-6 all year since March 2026 (see server/records.js). */
const PERMANENT_MDT_FROM = Date.UTC(2026, 2, 8, 9);
function albertaOffset(ms) {
  if (ms >= PERMANENT_MDT_FROM) return -6 * 3600_000;
  const y = new Date(ms).getUTCFullYear();
  const sunday = (m, n) => {
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + 7 * (n - 1);
  };
  const start = Date.UTC(y, 2, sunday(2, 2), 9);
  const end = Date.UTC(y, 10, sunday(10, 1), 8);
  return ms >= start && ms < end ? -6 * 3600_000 : -7 * 3600_000;
}
const MT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC',
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
function mt(ms) {
  if (!Number.isFinite(ms)) return null;
  return `${MT.format(new Date(ms + albertaOffset(ms)))} MT`;
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

// ---------------------------------------------------------------- state --

const state = {
  snap: null,
  lastOkAt: 0,
  filter: 'all',
  search: '',
  selectedId: null,
  selectedSiteId: null,
  alerts: store.get('alerts') === 'on',
  editToken: store.get('editToken') || '',
  picking: false,
  editingSiteId: null,
  prevSiteStatus: null,
  prevOutageIds: null,
  history: [],
  events: [],
  tab: 'outages',
};

// ------------------------------------------------------------------ map --

const BASEMAP = 'https://tiles.openfreemap.org/styles/dark';
/** If the basemap host is unreachable, outages still draw on province outlines. */
const FALLBACK_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0d1419' } }],
};
let usingFallback = false;
const map = new maplibregl.Map({
  container: 'map',
  style: BASEMAP,
  bounds: CANADA,
  fitBoundsOptions: { padding: 30 },
  attributionControl: { compact: true },
  maxPitch: 0,
  dragRotate: false,
  pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

let mapReady = false;
let popup = null;

function diamond(color) {
  const size = 22;
  const c = document.createElement('canvas');
  c.width = c.height = size * 2;
  const g = c.getContext('2d');
  g.scale(2, 2);
  g.translate(size / 2, size / 2);
  g.rotate(Math.PI / 4);
  g.fillStyle = '#0f161d';
  g.strokeStyle = color;
  g.lineWidth = 3;
  g.beginPath();
  g.rect(-6, -6, 12, 12);
  g.fill();
  g.stroke();
  g.fillStyle = color;
  g.fillRect(-2, -2, 4, 4);
  return g.getImageData(0, 0, size * 2, size * 2);
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

map.on('style.load', () => {
  clearTimeout(basemapTimer);
  for (const [status, color] of Object.entries(SITE_COLORS))
    if (!map.hasImage(`site-${status}`)) map.addImage(`site-${status}`, diamond(color), { pixelRatio: 2 });

  map.addSource('provinces', { type: 'geojson', data: '/data/provinces.geojson', promoteId: 'code' });
  map.addLayer({
    id: 'prov-dim',
    type: 'fill',
    source: 'provinces',
    paint: {
      'fill-color': '#05090c',
      'fill-opacity': ['case', ['boolean', ['feature-state', 'covered'], false], 0, 0.45],
    },
  });
  map.addLayer({
    id: 'prov-internet',
    type: 'fill',
    source: 'provinces',
    paint: {
      'fill-color': COLORS.internet,
      'fill-opacity': ['case', ['boolean', ['feature-state', 'internet'], false], 0.2, 0],
    },
  });
  map.addLayer({
    id: 'prov-line',
    type: 'line',
    source: 'provinces',
    paint: {
      'line-color': [
        'case',
        ['boolean', ['feature-state', 'internet'], false],
        COLORS.internet,
        ['boolean', ['feature-state', 'covered'], false],
        '#6b7f93',
        '#33424f',
      ],
      'line-width': ['case', ['boolean', ['feature-state', 'internet'], false], 2, 1],
    },
  });

  map.addSource('areas', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'areas-fill',
    type: 'fill',
    source: 'areas',
    paint: {
      'fill-color': ['get', 'color'],
      'fill-opacity': ['match', ['get', 'kind'], 'unplanned', 0.32, 0.18],
    },
  });
  map.addLayer({
    id: 'areas-line',
    type: 'line',
    source: 'areas',
    paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.9 },
  });

  map.addSource('points', { type: 'geojson', data: empty() });
  const radius = [
    'interpolate',
    ['linear'],
    ['sqrt', ['max', 1, ['coalesce', ['get', 'customers'], 1]]],
    1, 5,
    10, 9,
    40, 16,
    150, 26,
  ];
  map.addLayer({
    id: 'points-halo',
    type: 'circle',
    source: 'points',
    filter: ['all', ['==', ['get', 'kind'], 'unplanned'], ['>=', ['coalesce', ['get', 'customers'], 0], 100]],
    paint: {
      'circle-radius': ['*', radius, 1.9],
      'circle-color': COLORS.unplanned,
      'circle-opacity': 0.16,
      'circle-blur': 0.4,
    },
  });
  map.addLayer({
    id: 'points',
    type: 'circle',
    source: 'points',
    paint: {
      'circle-radius': radius,
      'circle-color': ['get', 'color'],
      'circle-opacity': ['match', ['get', 'kind'], 'planned-upcoming', 0.75, 0.92],
      'circle-stroke-color': ['case', ['get', 'selected'], '#ffffff', '#0b1116'],
      'circle-stroke-width': ['case', ['get', 'selected'], 2.5, 1.5],
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
      'icon-size': ['case', ['in', ['get', 'status'], ['literal', ['out', 'near', 'internet']]], 1.25, 1],
      'symbol-sort-key': ['get', 'rank'],
      ...(usingFallback
        ? {}
        : {
            'text-field': ['step', ['zoom'], '', 7, ['get', 'name']],
            'text-font': ['Noto Sans Regular'],
            'text-size': 12,
            'text-offset': [0, 1.3],
            'text-anchor': 'top',
            'text-optional': true,
          }),
    },
    paint: usingFallback
      ? {}
      : {
          'text-color': '#cfe9e6',
          'text-halo-color': '#0b1116',
          'text-halo-width': 1.5,
        },
  });

  mapReady = true;
  if (state.snap) renderMap();
});

{
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
  for (const layer of ['points', 'areas-fill', 'sites']) {
    map.on('mouseenter', layer, () => {
      if (!state.picking) map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layer, () => {
      if (!state.picking) map.getCanvas().style.cursor = '';
    });
  }
  map.on('click', (e) => {
    if (!state.picking) return;
    finishPicking(e.lngLat);
  });
}

const empty = () => ({ type: 'FeatureCollection', features: [] });

function visibleRows() {
  const rows = state.snap?.rows || [];
  const f = state.filter;
  return rows.filter((r) => {
    if (f === 'all') return r.kind !== 'planned-upcoming';
    if (f === 'unplanned') return r.kind === 'unplanned';
    if (f === 'planned') return r.kind === 'planned-active';
    if (f === 'upcoming') return r.kind === 'planned-upcoming';
    return true;
  });
}

function renderMap() {
  if (!mapReady || !state.snap) return;
  const rows = visibleRows();
  const areas = [];
  const points = [];
  for (const r of rows) {
    const color = COLORS[r.kind];
    if (r.polygons.length)
      areas.push({
        type: 'Feature',
        properties: { id: r.stableId, kind: r.kind, color },
        geometry: { type: 'MultiPolygon', coordinates: r.polygons },
      });
    points.push({
      type: 'Feature',
      properties: {
        id: r.stableId,
        kind: r.kind,
        color,
        customers: r.customers ?? 1,
        selected: r.stableId === state.selectedId,
      },
      geometry: { type: 'Point', coordinates: [r.point.lon, r.point.lat] },
    });
  }
  map.getSource('areas').setData({ type: 'FeatureCollection', features: areas });
  map.getSource('points').setData({ type: 'FeatureCollection', features: points });
  const rank = { out: 0, near: 1, internet: 2, planned: 3, ok: 4, 'no-coverage': 5 };
  map.getSource('sites').setData({
    type: 'FeatureCollection',
    features: state.snap.sites.map((s) => ({
      type: 'Feature',
      properties: { id: s.id, name: s.name, status: s.impact.status, rank: 10 - rank[s.impact.status] },
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    })),
  });
  const covered = new Set(Object.keys(state.snap.coverage || {}));
  const internet = state.snap.internet?.provinces || {};
  for (const code of Object.keys(PROVINCE_NAMES))
    map.setFeatureState(
      { source: 'provinces', id: code },
      { covered: covered.has(code), internet: Boolean(internet[code]?.active) },
    );
}

// --------------------------------------------------------------- popups --

function openPopup(lngLat, content) {
  popup?.remove();
  popup = new maplibregl.Popup({ maxWidth: '340px', focusAfterOpen: false })
    .setLngLat(lngLat)
    .setDOMContent(content)
    .addTo(map);
}

function outagePopup(r) {
  const rows = [
    ['Customers', customersText(r)],
    ['Area', r.area],
    ['Cause', r.cause],
    ['Status', r.status],
    [r.kind === 'planned-upcoming' ? 'Starts' : 'Started', mt(r.startMs)],
    ['Out for', r.kind === 'planned-upcoming' ? null : duration(r.startMs)],
    ['Est. restore', mt(r.estRestoreMs) || r.estRestoreText],
    ['Utility update', r.updatedMs ? ago(r.updatedMs) : null],
  ].filter(([, v]) => v);
  const source = state.snap.sources.find((s) => s.id === r.utility);
  return h(
    'div',
    { class: 'pop' },
    h('div', { class: 'pop-kind', style: `color:${COLORS[r.kind]}`, text: KIND_TEXT[r.kind] }),
    h('h4', { text: UTILITY[r.utility] || r.utility }),
    h('dl', {}, rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
    source?.map && source.map.startsWith('http')
      ? h('div', { class: 'pop-actions' }, h('a', { class: 'btn', href: source.map, target: '_blank', rel: 'noopener', text: `Open ${SHORT[r.utility]}'s map` }))
      : null,
  );
}

function sitePopup(s) {
  const impact = s.impact;
  const rowsById = new Map(state.snap.rows.map((r) => [r.stableId, r]));
  const hits = impact.outages.map((o) => {
    const r = rowsById.get(o.id);
    const what = r ? `${UTILITY[r.utility]}, ${customersText(r)} customers` : o.id;
    const where = o.relation === 'inside' ? 'site is inside the outage area' : `${o.distanceKm} km away`;
    const when = r?.kind === 'planned-upcoming' ? `, starts ${mt(r.startMs)}` : '';
    return h('li', { text: `${KIND_TEXT[o.kind]}: ${what}; ${where}${when}` });
  });
  const internet = impact.internet ? state.snap.internet.provinces[impact.province] : null;
  return h(
    'div',
    { class: 'pop' },
    h('span', { class: `status status-${impact.status}`, text: SITE_STATUS_TEXT[impact.status] }),
    h('h4', { text: s.name }),
    s.address ? h('div', { class: 'item-meta', text: s.address }) : null,
    hits.length ? h('ul', { style: 'margin:8px 0 0;padding-left:18px;font-size:13px' }, hits) : null,
    internet
      ? h('p', { style: 'margin:8px 0 0;font-size:13px;color:#c7b8ff', text: `Internet connectivity in ${PROVINCE_NAMES[impact.province]} dropped ${ago(internet.since)} (IODA). Province-wide signal, not site-specific.` })
      : null,
    impact.status === 'no-coverage'
      ? h('p', { style: 'margin:8px 0 0;font-size:13px;color:#8fa1b3', text: `Power outages aren't monitored in ${PROVINCE_NAMES[impact.province] || 'this area'} yet.` })
      : null,
    s.notes ? h('p', { style: 'margin:8px 0 0;font-size:13px', text: s.notes }) : null,
    h('div', { class: 'pop-actions' }, h('button', { class: 'btn', type: 'button', text: 'Edit site', onclick: () => openSiteForm(s) })),
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
    if (r.polygons.length) map.fitBounds(boundsOf(r.polygons), { padding: 80, maxZoom: 13, duration: 900 });
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
  renderMap();
  renderSiteList();
}

// ------------------------------------------------------------- top + KPIs --

function renderTop() {
  const s = state.snap;
  const lamps = $('lamps');
  lamps.textContent = '';
  for (const src of s.sources) {
    lamps.append(
      h(
        'li',
        { class: 'lamp', dataset: { status: src.status }, title: `${src.name} (${src.region}): ${statusWord(src.status)}, last good data ${ago(src.lastSuccessAt)}${src.error ? `. ${src.error}` : ''}` },
        h('span', { class: 'lamp-dot', 'aria-hidden': 'true' }),
        h('b', { text: SHORT[src.id] || src.name }),
        src.status === 'ok' ? null : statusWord(src.status),
      ),
    );
  }
  if (s.internet?.status && s.internet.status !== 'off') {
    lamps.append(h('li', { class: 'lamp-sep', 'aria-hidden': 'true' }));
    lamps.append(
      h(
        'li',
        { class: 'lamp', dataset: { status: s.internet.status }, title: `IODA internet signals: ${statusWord(s.internet.status)}${s.internet.error ? `. ${s.internet.error}` : ''}` },
        h('span', { class: 'lamp-dot', 'aria-hidden': 'true' }),
        h('b', { text: 'Internet' }),
        s.internet.status === 'ok' ? null : statusWord(s.internet.status),
      ),
    );
  }
  $('demo-badge').hidden = !s.demo;

  const t = s.totals;
  const k = $('k-customers');
  const down = s.sources.filter((x) => x.status === 'down');
  const noData = down.length === s.sources.length;
  k.textContent = noData ? 'No data' : fmt(t.customersOut);
  k.classList.toggle('has-out', !noData && t.customersOut > 0);
  k.classList.toggle('no-data', noData);
  $('k-label').textContent = noData
    ? 'every utility feed is down; see Sources'
    : down.length
      ? `customers without power; ${down.map((x) => SHORT[x.id] || x.name).join(' and ')} feed down, not counted`
      : 'customers without power';
  const n = (v) => (noData ? '–' : fmt(v));
  $('k-unplanned').textContent = n(t.outages);
  $('k-planned').textContent = n(t.plannedActive);
  $('k-clients').textContent = t.sitesTotal ? `${t.sitesAffected} / ${t.sitesTotal}` : '0';
  $('k-clients').parentElement.classList.toggle('alert', t.sitesAffected > 0);
  $('k-internet').textContent = s.internet?.status === 'down' ? '–' : fmt(t.internetAlerts);
  $('k-internet').parentElement.classList.toggle('alert', t.internetAlerts > 0);
  $('c-outages').textContent = String(t.outages + t.plannedActive);
  $('c-clients').textContent = t.sitesAffected ? String(t.sitesAffected) : '';
  stampUpdated();
}
const statusWord = (s) => ({ ok: 'live', stale: 'stale', down: 'down', off: 'off' })[s] || s;

function stampUpdated() {
  const el = $('updated');
  if (!state.lastOkAt) return;
  const late = Date.now() - state.lastOkAt > LATE_MS;
  el.classList.toggle('late', late);
  el.textContent = late
    ? `Not updating, last data ${ago(state.lastOkAt)}`
    : `Updated ${ago(state.snap?.fetchedAt)}`;
}

// ---------------------------------------------------------- outage list --

function renderOutageList() {
  const list = $('outage-list');
  const q = state.search.trim().toLowerCase();
  const order = { unplanned: 0, 'planned-active': 1, 'planned-upcoming': 2 };
  const rows = visibleRows()
    .filter((r) => !q || [r.area, r.cause, r.status, UTILITY[r.utility]].some((v) => v && v.toLowerCase().includes(q)))
    .sort((a, b) =>
      a.kind === 'planned-upcoming' && b.kind === 'planned-upcoming'
        ? (a.startMs ?? 0) - (b.startMs ?? 0)
        : order[a.kind] - order[b.kind] || (b.customers ?? -1) - (a.customers ?? -1),
    );
  list.textContent = '';
  if (!rows.length) {
    const live = state.snap.sources.filter((s) => s.status !== 'down').length;
    list.append(
      h('li', { class: 'empty' },
        h('p', { text: q ? 'Nothing matches that filter.' : 'No outages reported right now.' }),
        q ? null : h('p', { text: `${live} of ${state.snap.sources.length} utility feeds are answering. Check the Sources tab if one is down.` }),
      ),
    );
    return;
  }
  for (const r of rows) {
    const when =
      r.kind === 'planned-upcoming'
        ? `Starts ${mt(r.startMs) || 'soon'}`
        : r.startMs
          ? `Out ${duration(r.startMs)}`
          : r.status || '';
    list.append(
      h('li', {},
        h('button', {
          type: 'button',
          class: `item${r.stableId === state.selectedId ? ' active' : ''}`,
          dataset: { kind: r.kind },
          onclick: () => selectOutage(r.stableId),
        },
          h('span', { class: 'item-bar', 'aria-hidden': 'true' }),
          h('span', {},
            h('span', { class: 'item-title', text: placeName(r) }),
            h('span', { class: 'item-meta', text: [UTILITY[r.utility], when].filter(Boolean).join(', ') }),
          ),
          h('span', { class: 'item-num' }, customersText(r), h('small', { text: 'customers' })),
        ),
      ),
    );
  }
}

// ------------------------------------------------------------ site list --

function renderSiteList() {
  const list = $('site-list');
  const sites = state.snap.sites;
  list.textContent = '';
  $('sites-empty').hidden = sites.length > 0;
  for (const s of sites) {
    const first = s.impact.outages[0];
    let detail = s.address || '';
    if (first && s.impact.status !== 'planned')
      detail = first.relation === 'inside' ? 'Inside the outage area' : `${first.distanceKm} km from the outage`;
    else if (s.impact.status === 'planned' && first) {
      const r = state.snap.rows.find((x) => x.stableId === first.id);
      detail = `Planned work ${first.distanceKm} km away, starts ${mt(r?.startMs) || 'soon'}`;
    }
    list.append(
      h('li', {},
        h('button', {
          type: 'button',
          class: `item${s.id === state.selectedSiteId ? ' active' : ''}`,
          dataset: { status: s.impact.status },
          onclick: () => selectSite(s.id),
        },
          h('span', { class: 'item-bar', 'aria-hidden': 'true' }),
          h('span', {},
            h('span', { class: 'item-title', text: s.name }),
            h('span', { class: 'item-meta', text: detail }),
          ),
          h('span', {}, h('span', { class: `status status-${s.impact.status}`, text: SITE_STATUS_TEXT[s.impact.status] })),
        ),
      ),
    );
  }
}

// --------------------------------------------------------------- sources --

function renderSources() {
  const s = state.snap;
  const list = $('source-list');
  list.textContent = '';
  const card = (src, lines) =>
    h('li', { class: 'source', dataset: { status: src.status } },
      h('div', { class: 'source-head' },
        h('span', { class: 'lamp-dot', 'aria-hidden': 'true' }),
        h('b', { text: src.name }),
        h('span', { class: 'source-state', text: statusWord(src.status) }),
      ),
      ...lines.filter(Boolean),
    );
  for (const src of s.sources) {
    list.append(
      card(src, [
        h('p', { text: src.region }),
        h('p', { text: `${fmt(src.outages)} unplanned, ${fmt(src.plannedActive)} planned now, ${fmt(src.customersOut)} customers out. Last good data ${ago(src.lastSuccessAt)}.` }),
        src.status === 'stale' ? h('p', { text: 'Showing its last good data while the feed is failing; dropped after 30 minutes.' }) : null,
        src.error ? h('p', { class: 'source-error', text: `Last error: ${src.error}` }) : null,
        src.map?.startsWith('http') ? h('p', {}, h('a', { href: src.map, target: '_blank', rel: 'noopener', text: `Open ${src.name}'s own outage map` })) : null,
      ]),
    );
  }
  if (s.internet && s.internet.status !== 'off') {
    const active = Object.values(s.internet.provinces || {}).filter((p) => p.active);
    list.append(
      card(s.internet, [
        h('p', { text: s.internet.region }),
        h('p', {
          text: active.length
            ? `Disruption now: ${active.map((p) => `${PROVINCE_NAMES[p.code]} (since ${LOCAL.format(new Date(p.since))}, ${p.signals.join(' and ')})`).join('; ')}.`
            : 'No province-level internet disruption right now.',
        }),
        h('p', { text: 'A province-wide drop in measured connectivity, not a specific provider or town. Data: IODA, Georgia Tech.' }),
        s.internet.error ? h('p', { class: 'source-error', text: `Last error: ${s.internet.error}` }) : null,
        s.internet.map?.startsWith('http') ? h('p', {}, h('a', { href: s.internet.map, target: '_blank', rel: 'noopener', text: 'Open the IODA dashboard for Canada' })) : null,
      ]),
    );
  }
  const cov = $('coverage');
  cov.textContent = '';
  const monitored = Object.values(s.coverage || {});
  const missing = Object.keys(PROVINCE_NAMES).filter((c) => !s.coverage?.[c]);
  cov.append(
    h('h3', { text: 'What is monitored' }),
    h('p', { text: `Power: ${monitored.map((c) => c.name).join(', ') || 'none'}. Darkened provinces on the map have no power feed yet; client sites there show "Power not monitored here".` }),
  );
  for (const c of monitored)
    if (c.unmonitored?.length)
      cov.append(
        h('p', { text: `Not covered in ${c.name} (no live feed published):` }),
        h('ul', {}, c.unmonitored.map((u) => h('li', { text: u }))),
      );
  cov.append(h('p', { text: `No power data yet: ${missing.map((c) => PROVINCE_NAMES[c]).join(', ')}.` }));
}

// --------------------------------------------------------------- history --

async function loadHistory() {
  try {
    const [hist, ev] = await Promise.all([
      fetch('/api/history?hours=24').then((r) => r.json()),
      fetch('/api/events?limit=80').then((r) => r.json()),
    ]);
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
  if (pts.length < 2) {
    box.append(h('p', { class: 'empty', text: 'The chart fills in as the server records a point every 5 minutes.' }));
  } else {
    const ids = Object.keys(CHART_COLORS);
    const W = Math.max(280, box.clientWidth || 360);
    const H = 180;
    const pad = { l: 40, r: 8, t: 8, b: 22 };
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const stacks = pts.map((p) => {
      let acc = 0;
      return ids.map((id) => (acc += p.bySource?.[id] ?? 0));
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
      el('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: '#2b3947' });
      el('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end', fill: '#8fa1b3', 'font-size': 11 }).textContent = fmt(v);
    }
    for (let i = ids.length - 1; i >= 0; i--) {
      const upper = pts.map((p, j) => `${x(p.t)},${y(stacks[j][i])}`);
      const lower = pts.map((p, j) => `${x(p.t)},${y(i ? stacks[j][i - 1] : 0)}`).reverse();
      el('polygon', { points: [...upper, ...lower].join(' '), fill: CHART_COLORS[ids[i]], 'fill-opacity': 0.85 });
    }
    const hours = (t1 - t0) / 3600_000;
    const tickEvery = hours > 12 ? 6 : hours > 4 ? 2 : 1;
    const first = Math.ceil(t0 / (tickEvery * 3600_000)) * tickEvery * 3600_000;
    for (let t = first; t <= t1; t += tickEvery * 3600_000)
      el('text', { x: x(t), y: H - 6, 'text-anchor': 'middle', fill: '#8fa1b3', 'font-size': 11 }).textContent = LOCAL.format(new Date(t));
    box.append(svg);
    for (const id of ids)
      legend.append(h('span', {}, h('i', { style: `background:${CHART_COLORS[id]}` }), UTILITY[id]));
  }

  const list = $('events');
  list.textContent = '';
  if (!state.events.length) list.append(h('li', {}, h('span'), h('span', { class: 'empty', text: 'No changes recorded yet.' })));
  for (const e of state.events) {
    let cls = '';
    let text = '';
    const who = UTILITY[e.utility] || e.utility;
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
      if (before !== undefined && before !== after && bad.has(after)) notify(`${site.name}: ${SITE_STATUS_TEXT[after]}`, site.address || '', 'bad');
      if (before !== undefined && bad.has(before) && !bad.has(after)) notify(`${site.name}: clear`, SITE_STATUS_TEXT[after]);
    }
    for (const r of s.rows)
      if (r.kind === 'unplanned' && (r.customers ?? 0) >= 1000 && !state.prevOutageIds.has(r.stableId))
        notify(`Large outage: ${fmt(r.customers)} customers`, `${UTILITY[r.utility]}, ${placeName(r)}`, 'bad');
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
  store.set('alerts', state.alerts ? 'on' : 'off');
  if (state.alerts) {
    beep();
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    toast('Alerts on', 'You will hear a tone when a client site is hit, and see a desktop notice if allowed.');
  }
  renderAlertButton();
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
      store.set('editToken', code);
      return api(method, url, body, type);
    }
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function startPicking() {
  state.picking = true;
  state.editingSiteId = null;
  $('add-hint').hidden = false;
  $('site-form').hidden = true;
  document.body.classList.add('map-picking');
  map.getCanvas().style.cursor = 'crosshair';
  popup?.remove();
}
function stopPicking() {
  state.picking = false;
  $('add-hint').hidden = true;
  document.body.classList.remove('map-picking');
  map.getCanvas().style.cursor = '';
}
function finishPicking(lngLat) {
  stopPicking();
  openSiteForm(null, lngLat);
}

function openSiteForm(site, lngLat = null) {
  setTab('clients');
  popup?.remove();
  const form = $('site-form');
  form.hidden = false;
  form.reset();
  $('site-error').hidden = true;
  state.editingSiteId = site?.id || null;
  $('site-form-title').textContent = site ? `Edit ${site.name}` : 'New site';
  $('site-delete').hidden = !site;
  const v = site || {};
  form.elements.name.value = v.name || '';
  form.elements.address.value = v.address || '';
  form.elements.notes.value = v.notes || '';
  form.elements.radiusKm.value = v.radiusKm || '';
  form.elements.lat.value = lngLat ? lngLat.lat.toFixed(6) : v.lat ?? '';
  form.elements.lon.value = lngLat ? lngLat.lng.toFixed(6) : v.lon ?? '';
  form.elements.name.focus();
  form.scrollIntoView({ block: 'nearest' });
}

$('btn-add-site').addEventListener('click', startPicking);
$('site-cancel').addEventListener('click', () => {
  $('site-form').hidden = true;
  state.editingSiteId = null;
});
$('site-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = JSON.stringify({
    name: f.name.value,
    address: f.address.value,
    notes: f.notes.value,
    lat: f.lat.value,
    lon: f.lon.value,
    radiusKm: f.radiusKm.value,
  });
  try {
    const id = state.editingSiteId;
    const saved = id ? await api('PUT', `/api/sites/${id}`, body) : await api('POST', '/api/sites', body);
    $('site-form').hidden = true;
    state.editingSiteId = null;
    toast(id ? 'Site saved' : 'Site added', saved.site.name);
    await refresh();
    selectSite(saved.site.id);
  } catch (error) {
    $('site-error').textContent = error.message;
    $('site-error').hidden = false;
  }
});
$('site-delete').addEventListener('click', async () => {
  const id = state.editingSiteId;
  const site = state.snap.sites.find((s) => s.id === id);
  if (!id || !window.confirm(`Remove ${site?.name || 'this site'}?`)) return;
  try {
    await api('DELETE', `/api/sites/${id}`);
    $('site-form').hidden = true;
    state.editingSiteId = null;
    toast('Site removed', site?.name);
    await refresh();
  } catch (error) {
    $('site-error').textContent = error.message;
    $('site-error').hidden = false;
  }
});
$('csv-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const replace =
    state.snap.sites.length > 0 &&
    window.confirm('Replace all existing sites with this file? Choose Cancel to add them to the current list instead.');
  try {
    const res = await api('POST', `/api/sites/import?mode=${replace ? 'replace' : 'append'}`, await file.text(), 'text/csv');
    toast(`Imported ${res.imported} site${res.imported === 1 ? '' : 's'}`, res.errors?.length ? `${res.errors.length} rows skipped: ${res.errors[0]}` : '');
    await refresh();
  } catch (error) {
    toast('Import failed', error.message, 'bad');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.picking) stopPicking();
});

// ------------------------------------------------------------ tabs, etc. --

function setTab(name) {
  state.tab = name;
  for (const t of ['outages', 'clients', 'sources', 'history']) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`view-${t}`).hidden = t !== name;
  }
  if (name === 'history') loadHistory();
}
for (const t of ['outages', 'clients', 'sources', 'history'])
  $(`tab-${t}`).addEventListener('click', () => setTab(t));
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  const tabs = ['outages', 'clients', 'sources', 'history'];
  const i = tabs.indexOf(state.tab);
  if (e.key === 'ArrowRight') setTab(tabs[(i + 1) % tabs.length]);
  else if (e.key === 'ArrowLeft') setTab(tabs[(i + tabs.length - 1) % tabs.length]);
  else return;
  $(`tab-${state.tab}`).focus();
});

for (const b of document.querySelectorAll('.segmented button'))
  b.addEventListener('click', () => {
    state.filter = b.dataset.filter;
    for (const o of document.querySelectorAll('.segmented button'))
      o.setAttribute('aria-pressed', String(o === b));
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
  setTimeout(() => {
    map.resize();
    if (on) map.fitBounds(ALBERTA, { padding: 40, duration: 0 });
  }, 50);
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
    const el = $('updated');
    el.classList.add('late');
    el.textContent = state.lastOkAt
      ? `Cannot reach the server, last data ${ago(state.lastOkAt)}`
      : `Cannot reach the server (${error.message})`;
  }
}

renderAlertButton();
if (new URLSearchParams(location.search).get('tv') === '1' || location.pathname === '/tv') setTv(true);
refresh();
loadHistory();
setInterval(refresh, REFRESH_MS);
setInterval(() => {
  if (state.tab === 'history') loadHistory();
}, HISTORY_REFRESH_MS);
setInterval(stampUpdated, 5_000);
window.addEventListener('resize', () => {
  if (state.tab === 'history') renderHistory();
});
