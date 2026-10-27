/*
 * Every electricity distributor the dashboard knows by name, in the nine
 * provinces it covers. `source` is the live feed id when the dashboard reads
 * the utility's outage map; utilities without one are still named so a client
 * site shows who supplies it (and that it is not monitored).
 */

export const UTILITIES = Object.freeze([
  // British Columbia
  { id: 'bchydro', name: 'BC Hydro', province: 'BC', source: 'bchydro' },
  { id: 'fortisbc', name: 'FortisBC', province: 'BC', source: 'fortisbc' },
  { id: 'newwest', name: 'New Westminster Electric', province: 'BC', cities: ['new westminster'] },
  { id: 'nelsonhydro', name: 'Nelson Hydro', province: 'BC', cities: ['nelson'] },
  { id: 'penticton', name: 'City of Penticton Electric', province: 'BC', cities: ['penticton'] },
  { id: 'summerland', name: 'Summerland Electric', province: 'BC', cities: ['summerland'] },
  { id: 'grandforks', name: 'City of Grand Forks Electric', province: 'BC', cities: ['grand forks'] },
  { id: 'kelowna', name: 'City of Kelowna Electric (downtown core)', province: 'BC' },
  // Alberta
  { id: 'atco', name: 'ATCO Electric', province: 'AB', source: 'atco' },
  { id: 'fortis', name: 'FortisAlberta', province: 'AB', source: 'fortis' },
  { id: 'enmax', name: 'ENMAX Power', province: 'AB', source: 'enmax', cities: ['calgary'] },
  { id: 'epcor', name: 'EPCOR', province: 'AB', source: 'epcor', cities: ['edmonton'] },
  { id: 'lethbridge', name: 'City of Lethbridge Electric', province: 'AB', cities: ['lethbridge'] },
  { id: 'reddeer', name: 'Red Deer Electric Light & Power', province: 'AB', cities: ['red deer'] },
  { id: 'medhat', name: 'City of Medicine Hat Electric', province: 'AB', cities: ['medicine hat'] },
  { id: 'ponoka', name: 'Town of Ponoka Electric', province: 'AB', cities: ['ponoka'] },
  { id: 'cardston', name: 'Town of Cardston Electric', province: 'AB', cities: ['cardston'] },
  { id: 'fortmacleod', name: 'Town of Fort Macleod Electric', province: 'AB', cities: ['fort macleod'] },
  { id: 'abrea', name: 'Rural electrification association (EQUS, Battle River…)', province: 'AB' },
  // Saskatchewan
  { id: 'saskpower', name: 'SaskPower', province: 'SK', source: 'saskpower' },
  { id: 'slp', name: 'Saskatoon Light & Power', province: 'SK', source: 'slp' },
  { id: 'swiftcurrent', name: 'Swift Current Light & Power', province: 'SK', cities: ['swift current'] },
  // Manitoba
  { id: 'mbhydro', name: 'Manitoba Hydro', province: 'MB', source: 'mbhydro' },
  // Ontario: the four with live feeds; the rest come from the OEB boundary file.
  { id: 'hydroone', name: 'Hydro One', province: 'ON', source: 'hydroone', ldc: /^Hydro One\b/i },
  { id: 'torontohydro', name: 'Toronto Hydro', province: 'ON', source: 'torontohydro', ldc: /^Toronto Hydro\b/i },
  { id: 'alectra', name: 'Alectra Utilities', province: 'ON', source: 'alectra', ldc: /^Alectra\b/i },
  { id: 'hydroottawa', name: 'Hydro Ottawa', province: 'ON', source: 'hydroottawa', ldc: /^Hydro Ottawa\b/i },
  // New Brunswick
  { id: 'nbpower', name: 'NB Power', province: 'NB', source: 'nbpower' },
  { id: 'sje', name: 'Saint John Energy', province: 'NB', cities: ['saint john'] },
  { id: 'edmundston', name: 'Énergie Edmundston', province: 'NB', cities: ['edmundston'] },
  { id: 'perthandover', name: 'Perth-Andover Electric', province: 'NB', cities: ['perth-andover', 'perth andover'] },
  // Nova Scotia
  { id: 'nspower', name: 'Nova Scotia Power', province: 'NS', source: 'nspower' },
  { id: 'antigonish', name: 'Town of Antigonish Electric', province: 'NS', cities: ['antigonish'] },
  { id: 'berwick', name: 'Berwick Electric Commission', province: 'NS', cities: ['berwick'] },
  { id: 'mahonebay', name: 'Mahone Bay Electric', province: 'NS', cities: ['mahone bay'] },
  { id: 'lunenburg', name: 'Lunenburg Electric', province: 'NS', cities: ['lunenburg'] },
  { id: 'riverport', name: 'Riverport Electric', province: 'NS', cities: ['riverport'] },
  // Prince Edward Island
  { id: 'maritime', name: 'Maritime Electric', province: 'PE', source: 'maritime' },
  { id: 'summerside', name: 'City of Summerside Electric', province: 'PE', cities: ['summerside'] },
  // Newfoundland and Labrador
  { id: 'nfpower', name: 'Newfoundland Power', province: 'NL', source: 'nfpower' },
  { id: 'nlhydro', name: 'NL Hydro', province: 'NL', source: 'nlhydro' },
]);

const byId = new Map(UTILITIES.map((u) => [u.id, u]));
export const utilityById = (id) => byId.get(id) || null;

/** Stable id for an Ontario LDC name from the OEB file. */
export function ldcId(name) {
  const known = UTILITIES.find((u) => u.ldc?.test(String(name)));
  if (known) return known.id;
  return `on-${String(name)
    .toLowerCase()
    .replace(/\b(inc|ltd|limited|corporation|corp|company|co)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;
}

/** Tidy an OEB LDC name for display ("Burlington Hydro Inc." → "Burlington Hydro"). */
export function ldcDisplayName(name) {
  const known = UTILITIES.find((u) => u.ldc?.test(String(name)));
  if (known) return known.name;
  return String(name)
    .replace(/,?\s+(Inc|Ltd|Limited|Corporation|Corp|Incorporated)\.?$/i, '')
    .replace(/\s+Distribution$/i, '')
    .trim();
}

/** Default supplier when nothing more specific matches. */
export const PROVINCE_DEFAULT = Object.freeze({
  BC: 'bchydro',
  SK: 'saskpower',
  MB: 'mbhydro',
  ON: 'hydroone',
  NB: 'nbpower',
  NS: 'nspower',
  PE: 'maritime',
  NL: 'nlhydro',
});
