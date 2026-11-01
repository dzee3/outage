/*
 * Internet providers the dashboard knows, starting with Alberta: what each
 * one is, which network a reseller rides on, and which public signals can
 * say something about its outages.
 *
 * Signals, strongest first:
 *   feed     the provider's own outage map / notices (Telus, Rogers/Shaw,
 *            TekSavvy, SaskTel)
 *   address  the provider's own per-address outage check (Eastlink)
 *   aea      Alberta Emergency Alert telecom / 911 alerts (any provider)
 *   network  IODA's view of the provider's own network (ASN): BGP, active
 *            probing and telescope traffic. For a regional network this is
 *            effectively a regional signal; for Starlink it is worldwide.
 *   wan      the client's own connection, pinged by this server (optional,
 *            per client; the only signal for providers that publish nothing)
 */

const NO_DATA = 'publishes no outage map. Turn on the connection check for these clients to know when they drop.';

/** kind: carrier (owns a wired network), reseller (rides others), rural (fixed wireless / satellite), regional. */
export const PROVIDERS = Object.freeze([
  // ---- Alberta's wired carriers
  {
    key: 'telus', name: 'Telus', kind: 'carrier', provinces: ['AB', 'BC'],
    match: /^(telus|koodo|public mobile)\b/i, asns: [852], feed: 'telus',
    page: 'https://www.telus.com/en/ab/outages',
    about: 'Outage areas from Telus\'s own outage map (Internet, TV, Home Phone, 911).',
  },
  {
    key: 'rogers', name: 'Rogers / Shaw', kind: 'carrier', provinces: ['AB', 'BC', 'SK', 'MB', 'ON', 'NB', 'NL'],
    match: /^(rogers|shaw|fido)\b/i, asns: [6327, 812], feed: 'rogers',
    page: 'https://www.rogers.com/support/outage?province=AB',
    about: 'Notices from the Rogers outage page (Shaw is now Rogers). Rogers names a town and neighbourhoods, not exact areas.',
  },
  {
    key: 'eastlink', name: 'Eastlink', kind: 'carrier', provinces: ['AB', 'NS', 'NB', 'PE', 'NL', 'ON'],
    match: /^eastlink\b/i, asns: [11260], address: 'eastlink',
    page: 'https://help.eastlink.ca/managing-your-account-billing/service-outage/',
    about: 'Each client address is checked with Eastlink\'s own outage lookup, which gives an estimated restore time.',
  },
  {
    key: 'sasktel', name: 'SaskTel', kind: 'carrier', provinces: ['SK', 'AB'],
    match: /^sasktel\b/i, asns: [803], feed: 'sasktel',
    page: 'https://www.sasktel.com/wps/wcm/connect/content/home/reported+outages',
    about: 'SaskTel\'s reported-outages list (Lloydminster area in Alberta).',
  },
  {
    key: 'northwestel', name: 'Northwestel', kind: 'carrier', provinces: ['AB'],
    match: /^north\s?wes?tel\b/i, asns: [6058],
    page: 'https://www.nwtel.ca/support',
    about: `Northwestel (far north Alberta) ${NO_DATA}`,
  },

  // ---- Rural and satellite
  {
    key: 'starlink', name: 'Starlink', kind: 'satellite', provinces: ['*'],
    match: /^(starlink|spacex)\b/i, asns: [14593],
    page: 'https://www.starlink.com/support',
    about: 'Starlink publishes no outage map. Its network is watched by IODA worldwide, so a drop there is Starlink-wide (not only Alberta). Starlink usually has no public address to ping; a client with a public IP (Priority plans) can use the connection check.',
    always: true,
  },
  {
    key: 'xplore', name: 'Xplore', kind: 'rural', provinces: ['*'],
    match: /^(xplore|xplornet|wiband)\b/i, asns: [22995],
    page: 'https://www.xplore.ca/',
    about: 'Xplore publishes no outage map. Its own network (AS22995) is watched by IODA.',
  },

  // ---- Resellers on Telus or Rogers/Shaw lines
  {
    key: 'bell', name: 'Bell', kind: 'reseller', provinces: ['*'],
    match: /^(bell|virgin|lucky mobile)\b/i, asns: [577], rides: ['telus'],
    page: 'https://support.bell.ca/outage-check',
    about: 'Bell checks outages behind a CAPTCHA. In Alberta Bell home internet runs on Telus fibre, so Telus outages at the address apply.',
  },
  {
    key: 'freedom', name: 'Freedom', kind: 'reseller', provinces: ['AB', 'BC', 'ON'],
    match: /^freedom\b/i, asns: [], rides: ['rogers', 'telus'],
    page: 'https://www.freedommobile.ca/en-CA/support',
    about: 'Freedom Home Internet runs on partner cable or fibre lines; outages on the line it uses apply.',
  },
  {
    key: 'teksavvy', name: 'TekSavvy', kind: 'reseller', provinces: ['*'],
    match: /^teksavvy\b/i, asns: [5645], feed: 'teksavvy', rides: ['rogers', 'telus'],
    page: 'https://www.teksavvy.com/network-status/',
    about: 'TekSavvy\'s own outage map, plus outages on the Shaw cable or Telus line it rides.',
  },
  {
    key: 'distributel', name: 'Distributel / Ebox', kind: 'reseller', provinces: ['*'],
    match: /^(distributel|ebox|thinktel|acanac|primus)\b/i, asns: [11814], rides: ['rogers', 'telus'],
    page: 'https://www.distributel.ca/',
    about: 'Distributel rides Shaw cable or Telus lines in Alberta; outages on that line apply.',
  },
  {
    key: 'reseller', name: 'Other reseller', kind: 'reseller', provinces: ['*'],
    match: /^(start\.?ca|start communications|oxio|carry telecom|vmedia|yak|altima|cik|fizz|novus)\b/i, asns: [], rides: ['rogers', 'telus'],
    page: null,
    about: 'Resellers ride Shaw cable or Telus lines in Alberta; outages on that line apply.',
  },

  // ---- Alberta regional providers with their own network
  { key: 'mcsnet', name: 'MCSnet', kind: 'regional', provinces: ['AB'], match: /^mcs\s?net\b/i, asns: [36817], page: 'https://mcsnet.ca/', about: 'MCSnet publishes no outage map. Its own network (AS36817) is watched by IODA.' },
  { key: 'airenet', name: 'AireNet', kind: 'regional', provinces: ['AB'], match: /^aire\s?net\b/i, asns: [62845, 25671], page: null, about: 'AireNet publishes no outage map. Its own network is watched by IODA.' },
  { key: 'syban', name: 'Syban Systems', kind: 'regional', provinces: ['AB'], match: /^syban\b/i, asns: [400833], page: null, about: 'Syban publishes no outage map. Its own network (AS400833) is watched by IODA.' },
  { key: 'gpnetworks', name: 'GPNetworks', kind: 'regional', provinces: ['AB'], match: /^g\.?p\.?\s?n(etworks?)?\b|^gpn wireless/i, asns: [393686], page: null, about: 'GPNetworks publishes no outage map. Its own network (AS393686) is watched by IODA.' },
  { key: 'onet', name: 'O-NET', kind: 'regional', provinces: ['AB'], match: /^o-?net\b/i, asns: [54841], page: null, about: 'O-NET (Olds fibre) publishes no outage map. Its own network (AS54841) is watched by IODA.' },
  { key: 'netago', name: 'Netago', kind: 'regional', provinces: ['AB'], match: /^netago\b/i, asns: [54359], page: null, about: 'Netago\'s own network (AS54359) is watched by IODA.' },
  { key: 'terabyte', name: 'Tera-byte', kind: 'regional', provinces: ['AB'], match: /^tera-?\s?byte\b/i, asns: [13911], page: null, about: 'Tera-byte\'s own network (AS13911) is watched by IODA.' },
  { key: 'cfoc', name: 'Canadian Fiber Optics', kind: 'regional', provinces: ['AB'], match: /^(canadian fib(er|re) optics|cfoc)\b/i, asns: [399016], page: null, about: 'Its own network (AS399016) is watched by IODA.' },

  // ---- Alberta regional providers with no public signal at all
  ...[
    ['rigstar', 'Rigstar Communications', /^rigstar\b/i],
    ['clearwave', 'Clearwave', /^clear\s?wave\b/i],
    ['ruralconnect', 'Rural Connect', /^rural\s?connect\b/i],
    ['edgar', 'Edgar HighSpeed', /^edgar\b/i],
    ['milkriver', 'Milk River Cable Club', /^milk river\b/i],
    ['mascon', 'Mascon', /^mascon\b/i],
    ['bellevista', 'BelleVista Broadband', /^belle\s?vista\b/i],
    ['swiftnet', 'Swift-Net.ca', /^swift-?\s?net\b/i],
    ['eidnet', 'EIDNet', /^eid\s?net\b/i],
    ['iwantwireless', 'I Want Wireless', /^i want wireless\b/i],
    ['slavelakecomm', 'Slave Lake Communications', /^slave lake comm/i],
    ['arrow', 'Arrow Technology Group', /^arrow tech/i],
    ['cci', 'CCI Wireless', /^(cci wireless|corridor communications)\b/i],
  ].map(([key, name, match]) => ({ key, name, kind: 'regional', provinces: ['AB'], match, asns: [], page: null, about: `${name} ${NO_DATA}` })),
]);

const BY_KEY = new Map(PROVIDERS.map((p) => [p.key, p]));

export const providerByKey = (key) => BY_KEY.get(key) || null;

/** The registry entry for a client's ISP name ("Shaw Business" → rogers). */
export function providerFor(isp) {
  const s = String(isp || '').trim();
  if (!s) return null;
  return PROVIDERS.find((p) => p.match.test(s)) || null;
}

/** Every provider ASN in the registry, for IODA: Map asn → provider name. */
export function registryAsns() {
  const out = new Map();
  for (const p of PROVIDERS) for (const a of p.asns) out.set(a, p.name);
  return out;
}

/** Providers listed for a province (Alberta board, client form extras). */
export const providersIn = (province) => PROVIDERS.filter((p) => p.provinces.includes(province) || p.provinces.includes('*'));

/** What can be known about a provider: the signals that exist for it. */
export function signalsFor(p) {
  if (!p) return [];
  const s = [];
  if (p.feed) s.push('feed');
  if (p.address) s.push('address');
  if (p.rides?.length) s.push('rides');
  if (p.asns.length) s.push('network');
  return s;
}
