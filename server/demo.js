import { readFileSync } from 'node:fs';

/*
 * Demo mode (DEMO=1): replays Alberta outages captured on 2026-10-26 with
 * their times shifted to now, plus one example internet alert. For showing
 * the dashboard without network access; never use it in the office.
 */

const shift = (value, delta) => (Number.isFinite(value) ? value + delta : value);

export function demoSources({ fixturePath, now }) {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const delta = () => now() - Date.parse(fixture.capturedAt);
  const rowsFor = (utility) => () =>
    fixture.rows
      .filter((row) => row.utility === utility)
      .map((row) => ({
        ...row,
        province: 'AB',
        startMs: shift(row.startMs, delta()),
        estRestoreMs: shift(row.estRestoreMs, delta()),
        updatedMs: shift(row.updatedMs, delta()),
      }));
  const make = (id, name, region) => ({
    id,
    name,
    province: 'AB',
    region,
    map: '#demo',
    feeds: [{ id: 'live', ttl: 60_000, load: async () => rowsFor(id)() }],
  });
  return [
    make('atco', 'ATCO Electric', 'Northern and east-central Alberta'),
    make('fortis', 'FortisAlberta', 'Central and southern Alberta, rural and towns'),
    make('enmax', 'ENMAX Power', 'Calgary'),
    make('epcor', 'EPCOR', 'Edmonton'),
  ];
}

export function demoInternet({ now }) {
  return {
    id: 'ioda',
    name: 'IODA internet connectivity',
    region: 'All provinces and territories, province level only',
    map: '#demo',
    ttl: 60_000,
    async load() {
      const t = now();
      const provinces = {};
      for (const code of ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'])
        provinces[code] = { code, active: false, score: 0, signals: [], since: null, lastEventAt: null };
      provinces.BC = {
        code: 'BC',
        active: true,
        score: 142,
        signals: ['bgp', 'ping-slash24'],
        since: t - 47 * 60_000,
        lastEventAt: t,
      };
      return {
        provinces,
        recent: [
          { province: 'BC', fromMs: t - 47 * 60_000, untilMs: t, ongoing: true, score: 142, signal: 'bgp' },
          { province: 'MB', fromMs: t - 6 * 3600_000, untilMs: t - 5.4 * 3600_000, ongoing: false, score: 61, signal: 'ping-slash24' },
        ],
      };
    },
  };
}
