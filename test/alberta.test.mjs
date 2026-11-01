import test from 'node:test';
import assert from 'node:assert/strict';
import { providerFor, registryAsns, providersIn } from '../server/providers.js';
import { parseCap, parseAeaFeed, capUrlFor, isTelecomAlert, noticeFromCap, loadAeaNotices } from '../server/sources/aea.js';
import { ispStatusFor, readEastlinkOutage, eastlinkQuery, createIspStatus } from '../server/isp-status.js';
import { providerBoard } from '../server/board.js';
import { parseTarget, checkTarget, createWanMonitor } from '../server/wan.js';

// A real Alberta Emergency Alert (Grande Prairie 911 outage, April 2025), shortened.
const CAP = `<?xml version="1.0" encoding="UTF-8"?><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>D2BE49DC</identifier><sender>CityofGrandePrairie</sender><sent>2025-04-28T12:27:17-06:00</sent><status>Actual</status><msgType>Alert</msgType><scope>Public</scope><info><language>en-CA</language><category>Infra</category><event>911 Service Inoperative</event><eventCode><valueName>profile:CAP-CP:Event:0.4</valueName><value>911Service</value></eventCode><effective>2025-04-28T12:27:17-06:00</effective><expires>2025-04-29T12:07:43-06:00</expires><senderName>City of Grande Prairie</senderName><headline>The City of Grande Prairie is issuing a 9-1-1 Service Outage alert.</headline><description>Grande Prairie 9-1-1 is currently experiencing technical difficulties and is unavailable. Telus is investigating. This outage affects the ability to call 9-1-1 on both cell phones and landlines.</description><area><areaDesc>This alert is in effect for Northwest Alberta.</areaDesc><polygon>55.0,-119.0 55.0,-118.5 55.4,-118.5 55.4,-119.0 55.0,-119.0</polygon></area></info><info><language>fr-CA</language><event>Panne du 911</event></info></alert>`;
const FIRE = CAP.replace('<category>Infra</category>', '<category>Fire</category>').replace('<event>911 Service Inoperative</event>', '<event>Wildfire</event>').replace('<value>911Service</value>', '<value>wildfire</value>').replace(/<description>[^<]*<\/description>/, '<description>Evacuate now.</description>').replace('D2BE49DC', 'FIRE1');
const NOW = Date.parse('2025-04-28T20:00:00Z');

test('Alberta providers resolve by the names technicians type', () => {
  assert.equal(providerFor('Shaw Business').key, 'rogers');
  assert.equal(providerFor('Starlink Business').key, 'starlink');
  assert.equal(providerFor('Xplornet').key, 'xplore');
  assert.equal(providerFor('MCS Net').key, 'mcsnet');
  assert.equal(providerFor('O-NET').key, 'onet');
  assert.equal(providerFor('Ebox').key, 'distributel');
  assert.equal(providerFor('Rigstar Communications').key, 'rigstar');
  assert.equal(providerFor('Paragon Internet'), null);
  const asns = registryAsns();
  for (const a of [852, 6327, 812, 11260, 14593, 22995, 36817]) assert.ok(asns.has(a), `AS${a}`);
  const ab = providersIn('AB').map((p) => p.key);
  assert.ok(ab.includes('starlink') && ab.includes('telus') && ab.includes('eastlink') && ab.includes('mcsnet'));
  assert.ok(!providersIn('NS').some((p) => p.key === 'mcsnet'));
});

test('CAP alerts: telecom outages become notices with their polygon and named carrier', () => {
  const cap = parseCap(CAP);
  assert.equal(cap.event, '911 Service Inoperative'); // English block, not French
  assert.deepEqual(cap.eventCodes, ['911Service']);
  assert.ok(isTelecomAlert(cap));
  assert.ok(!isTelecomAlert(parseCap(FIRE)));
  const n = noticeFromCap(cap, 'https://x/a.htm');
  assert.equal(n.provider, 'aea');
  assert.deepEqual(n.mentions, ['telus']);
  assert.deepEqual(n.services, ['911', 'Home Phone', 'Mobile']);
  assert.equal(n.internet, false);
  assert.equal(n.area, 'Northwest Alberta');
  assert.deepEqual(n.polygons[0][0][0], [-119, 55]);
  assert.equal(n.polygons[0][0].length, 5);
});

test('AEA feed: entries link to CAP files; expired, cancelled and non-telecom alerts drop out', async () => {
  const feed = `<?xml version='1.0'?><feed xmlns="http://www.w3.org/2005/Atom"><title>AEA</title>
    <entry><id>urn:1</id><title>911</title><link href="https://www.alberta.ca/aea/cap/2025/04/28/a.htm"/></entry>
    <entry><id>urn:2</id><title>Fire</title><link href="https://www.alberta.ca/aea/cap/2025/04/28/b.xml"/></entry>
  </feed>`;
  const entries = parseAeaFeed(feed);
  assert.equal(capUrlFor(entries[0]), 'https://www.alberta.ca/aea/cap/2025/04/28/a.xml');
  const pages = { 'https://www.alberta.ca/data/aea/rss/feed-full.atom': feed, 'https://www.alberta.ca/aea/cap/2025/04/28/a.xml': CAP, 'https://www.alberta.ca/aea/cap/2025/04/28/b.xml': FIRE };
  const requestText = async (url) => pages[url] ?? '';
  const live = await loadAeaNotices({ requestText, nowMs: NOW });
  assert.deepEqual(live.map((n) => n.id), ['aea:D2BE49DC']);
  assert.equal(live[0].link, 'https://www.alberta.ca/aea/cap/2025/04/28/a.htm');
  assert.deepEqual(await loadAeaNotices({ requestText, nowMs: Date.parse('2025-05-01T00:00:00Z') }), []);
  assert.equal(parseAeaFeed('<html>'), null);
});

test('Eastlink lookups: query from the saved address, outage with restore time', () => {
  assert.equal(eastlinkQuery('Marex, 4802 50 Ave #3, Camrose, AB T4V 0R9'), '4802 50 Ave Camrose');
  assert.equal(eastlinkQuery('Camrose'), null);
  assert.deepEqual(readEastlinkOutage({ statusCode: 0, statusMessage: 'NoOutage', outageNodes: [] }), { state: 'clear', restoreAt: null, nodes: 0 });
  const out = readEastlinkOutage({ statusCode: 1, outageNodes: [{ estimatedRestoreTime: '2026-11-01T10:00:00' }, { estimatedRestoreTime: '2026-11-01T12:00:00' }] });
  assert.equal(out.state, 'out');
  assert.equal(out.restoreAt, Date.parse('2026-11-01T12:00:00'));
  assert.throws(() => readEastlinkOutage('<html>'));
});

test('Eastlink per-site check runs the two public lookups and feeds the status', async () => {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    if (url.includes('suggestaddress')) return [{ address: '4802 50 AVE CAMROSE AB T4V0R9', alias: 'x' }];
    return { statusCode: 1, outageNodes: [{ estimatedRestoreTime: '2026-11-01T12:00:00' }] };
  };
  const isp = createIspStatus({ request, requestText: async () => '', geocoder: null, now: () => NOW, log: {} });
  const site = { id: 's1', name: 'Camrose office', isp: 'Eastlink', address: '4802 50 Ave, Camrose, AB', lat: 53.02, lon: -112.83 };
  await isp.refreshSites([site, { id: 's2', isp: 'Telus', address: '1 Main St, Calgary' }]);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /suggestaddress\/4802%2050%20Ave%20Camrose$/);
  assert.match(calls[1], /checkOutage\/4802%2050%20AVE%20CAMROSE%20AB%20T4V0R9$/);
  const st = isp.statusFor(site, { province: 'AB' });
  assert.equal(st.state, 'out');
  assert.match(st.checks.find((c) => c.id === 'address').text, /Outage at 4802 50 AVE CAMROSE/);
});

test('status combines signals: reseller lines, Alberta alerts, network drop and the connection check', () => {
  const telusOut = { id: 't1', provider: 'telus', kind: 'outage', internet: true, title: 'Calgary (Evergreen), Alberta', services: ['Internet'], circles: [{ lat: 51, lon: -114, km: 2 }] };
  const health = { telus: { status: 'ok', lastSuccessAt: NOW }, rogers: { status: 'ok' }, aea: { status: 'ok', lastSuccessAt: NOW } };
  const site = { lat: 51.001, lon: -114.001, isp: 'TekSavvy' };
  // A reseller: possible until the line is known, then out.
  let st = ispStatusFor(site, [telusOut], { ...health, teksavvy: { status: 'ok' } }, NOW, { province: 'AB' });
  assert.equal(st.state, 'nearby');
  assert.equal(st.checks.find((c) => c.id === 'rides-telus').state, 'possible');
  st = ispStatusFor({ ...site, ispNetwork: 'telus' }, [telusOut], { ...health, teksavvy: { status: 'ok' } }, NOW, { province: 'AB' });
  assert.equal(st.state, 'out');
  assert.ok(!st.checks.some((c) => c.id === 'rides-rogers'), 'only the chosen line');
  // The client's own line answering outranks the map.
  st = ispStatusFor({ ...site, ispNetwork: 'telus', monitorHost: '203.0.113.9' }, [telusOut], { ...health, teksavvy: { status: 'ok' } }, NOW, { province: 'AB', wan: { state: 'up', rttMs: 20, method: 'ping', lastCheckAt: NOW } });
  assert.equal(st.state, 'nearby');
  // Connection down is "out" whatever the maps say.
  st = ispStatusFor({ lat: 51.5, lon: -113, isp: 'Rigstar', monitorHost: '203.0.113.9' }, [], health, NOW, { province: 'AB', wan: { state: 'down', since: NOW, lastCheckAt: NOW } });
  assert.equal(st.state, 'out');
  // An Alberta 911 alert over the site: shown, not an internet outage.
  const alert = noticeFromCap(parseCap(CAP));
  st = ispStatusFor({ lat: 55.17, lon: -118.79, isp: 'Telus' }, [alert], health, NOW, { province: 'AB' });
  assert.equal(st.checks.find((c) => c.id === 'aea').state, 'nearby');
  assert.equal(st.state, 'nearby');
  // Starlink: no map, only its network.
  st = ispStatusFor({ lat: 52, lon: -113, isp: 'Starlink' }, [], health, NOW, { province: 'AB', networks: { 14593: { active: true, since: NOW - 600_000, signals: ['bgp'] } }, networkStatus: 'ok' });
  const net = st.checks.find((c) => c.id === 'network');
  assert.equal(net.state, 'degraded');
  assert.match(net.text, /Starlink-wide/);
});

test('provider board ranks providers with outages first and counts only recent ones', () => {
  const notices = [
    { id: 'a', provider: 'telus', kind: 'outage', internet: true, province: 'AB', startMs: NOW - 3600_000 },
    { id: 'b', provider: 'telus', kind: 'outage', internet: false, province: 'AB', startMs: NOW - 3600_000 },
    { id: 'c', provider: 'telus', kind: 'outage', internet: true, province: 'AB', startMs: NOW - 30 * 86400_000 },
    { id: 'd', provider: 'telus', kind: 'outage', internet: true, province: 'BC', startMs: NOW },
  ];
  const board = providerBoard({
    notices,
    health: { telus: { status: 'ok' }, rogers: { status: 'ok' } },
    networks: { 36817: { active: true, since: NOW, signals: ['bgp'] }, 14593: { active: false } },
    sites: [{ isp: 'Starlink', impact: {} }],
    nowMs: NOW,
  });
  const by = Object.fromEntries(board.map((r) => [r.key, r]));
  assert.equal(board[0].key, 'telus');
  assert.deepEqual(by.telus.counts, { internet: 1, other: 1, planned: 0, older: 1, alerts: 0 });
  assert.equal(by.mcsnet.state, 'degraded');
  assert.equal(by.starlink.state, 'normal');
  assert.equal(by.starlink.clients.total, 1);
  assert.equal(by.rigstar.state, 'no-data');
  assert.ok(!by.reseller);
});

test('connection check: targets, ping then TCP, two misses before down', async () => {
  assert.deepEqual(parseTarget('203.0.113.9'), { host: '203.0.113.9', port: null });
  assert.deepEqual(parseTarget('fw.client.ca:4443'), { host: 'fw.client.ca', port: 4443 });
  assert.deepEqual(parseTarget('[2001:db8::1]:443'), { host: '2001:db8::1', port: 443 });
  for (const bad of ['', '999.1.1.1', 'a b', '1.2.3.4:99999', 'x;rm -rf /', '$(id)']) assert.equal(parseTarget(bad), null, bad);
  // Firewall drops ping but answers on 443.
  const r = await checkTarget({ host: 'h', port: null }, { ping: async () => ({ up: false, method: 'ping' }), tcp: async (h, port) => ({ up: port === 443, method: `tcp/${port}` }) });
  assert.deepEqual([r.up, r.method], [true, 'tcp/443']);
  // No ping binary: TCP straight away.
  const r2 = await checkTarget({ host: 'h', port: null }, { ping: async () => null, tcp: async () => ({ up: false, method: 'tcp' }) });
  assert.equal(r2.up, false);

  let t = 0;
  let up = true;
  const wan = createWanMonitor({ now: () => t, intervalMs: 1000, check: async () => ({ up, method: 'ping', rttMs: 9 }), log: {} });
  const sites = [{ id: 'a', name: 'A', monitorHost: '203.0.113.9' }, { id: 'b', name: 'B' }];
  await wan.run(sites);
  assert.equal(wan.get('a').state, 'up');
  assert.equal(wan.get('b'), null);
  up = false;
  t = 2000;
  await wan.run(sites);
  assert.equal(wan.get('a').state, 'up', 'one miss is not an outage');
  t = 4000;
  await wan.run(sites);
  assert.equal(wan.get('a').state, 'down');
  assert.equal(wan.get('a').since, 4000);
});

// Trimmed from the live Rogers pages (Oct 31, 2026): the Alberta page, and
// the Ontario page every province got when the region cookie was missing.
const ROGERS_AB = `<main><h1>Network Outages</h1><h2>Region: Alberta region</h2>
<p>No outages</p><p>All networks and services running as expected. </p>
<div><p><b>Service Interruption |</b> Some customers near Evergreen in Calgary</p><p><b>Impacted services:</b>&nbsp;<span>Internet, TV, Home Phone </span></p><p><b>Cause:</b> Technical</p><p><b>Current status:</b>&nbsp;<span>Service restored</span> (updated 11:55 a.m. MT)</p></div>
<div><h2>Planned Maintenance</h2><p><b>Planned maintenance |</b> <span>Nov 2 </span>- Airdrie (Wildflower)</p><p><b>Impacted services:&nbsp;</b><b>&nbsp;</b><span>Internet, TV, Home Phone </span>(including 911 calls)</p><p><b>Expected Start:</b>&nbsp;<span>Nov 2 </span>- 12:00 a.m. MT</p><p><b>Cause:</b> Network Upgrades</p><p><b>Current status:&nbsp;</b>This interruption is expected to last approximately six (6) hours. Service will be restored automatically when the maintenance is complete.</p></div>
<div><p><b>Service Interruption |</b> Some customers near Bowness &amp; Montgomery in Calgary</p><p><b>Impacted services:</b> <span>Internet, TV</span></p><p><b>Current status:</b> Technicians on site, repairs underway</p></div>
<h2>Learn more</h2><p>Outages guide</p><p>Learn more about service interruptions, network outages and how Rogers handles them–Internet, TV &amp; home phone.</p></main>`;
const ROGERS_ON = `<main><h2>Region: Ontario region</h2><h2>Planned Maintenance</h2><p><b>Planned maintenance |</b> Nov 2- Manitouwadge</p><p><b>Expected Start:</b>&nbsp;Nov 2 - 6:00 a.m. ET</p><h2>Learn more</h2><p>Outages guide</p></main>`;

test('Rogers: real Alberta page; restored and "Outages guide" are not outages; wrong region refused', async () => {
  const { parseRogers } = await import('../server/isp-status.js');
  const now = Date.parse('2026-11-01T02:00:00Z');
  const n = parseRogers(ROGERS_AB, 'AB', now);
  assert.deepEqual(n.map((x) => [x.kind, x.city, x.areas]), [
    ['planned', 'Airdrie', ['Wildflower']],
    ['outage', 'Calgary', ['Bowness', 'Montgomery']],
  ]);
  assert.equal(n[0].startMs, Date.parse('2026-11-02T06:00:00Z')); // midnight MT
  assert.ok(!n.some((x) => /guide/i.test(x.title)));
  assert.throws(() => parseRogers(ROGERS_ON, 'AB', now), /Ontario region.*Alberta/);
  assert.deepEqual(parseRogers(ROGERS_ON, 'ON', now).map((x) => x.city), ['Manitouwadge']);
});

test('Rogers poll sends the province cookie and puts town-only notices on the map as "same town"', async () => {
  const { createIspStatus, matchNotice } = await import('../server/isp-status.js');
  const asked = [];
  const requestText = async (url, opts) => {
    if (!url.includes('rogers.com')) return '';
    asked.push(opts?.headers?.Cookie);
    return url.includes('province=AB') ? ROGERS_AB.replace('Bowness &amp; Montgomery in Calgary', 'in Calgary') : ROGERS_ON.replace('Ontario', /province=(\w\w)/.exec(url)[1] === 'ON' ? 'Ontario' : 'X');
  };
  const geocoder = { search: async (q) => (/^Calgary/.test(q) ? [{ lat: 51.045, lon: -114.06, city: 'Calgary' }] : /Wildflower/.test(q) ? [{ lat: 51.27, lon: -113.98, city: 'Airdrie' }] : /^Airdrie/.test(q) ? [{ lat: 51.29, lon: -114.01, city: 'Airdrie' }] : []) };
  const isp = createIspStatus({ request: async () => ({}), requestText, requestRaw: async () => ({ status: 403, headers: new Map(), text: '<title>Just a moment...</title>' }), geocoder, now: () => Date.parse('2026-11-01T02:00:00Z'), log: {}, provincesFor: () => ['AB'] });
  await isp.refresh();
  assert.deepEqual(asked, ['province=AB; language=en']);
  const h = isp.health();
  assert.equal(h.rogers.status, 'ok', h.rogers.error);
  assert.match(h.telus.error, /HTTP 403 \(Cloudflare bot check\)/);
  const calgary = isp.notices().find((x) => x.city === 'Calgary');
  assert.equal(calgary.circles[0].town, true);
  assert.equal(matchNotice(calgary, { lat: 51.05, lon: -114.07 }), 'city', 'town-wide notice is "same town", not "here"');
  const airdrie = isp.notices().find((x) => x.city === 'Airdrie');
  assert.equal(matchNotice(airdrie, { lat: 51.271, lon: -113.981 }), 'area');
});
