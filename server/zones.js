/*
 * Wall-clock times without a zone, read in a province's time zone.
 *
 * Utilities mostly publish local times with no offset ("2026-10-28T17:00:00",
 * "10/28/2026 5:00 PM"). Alberta has its own fixed rule in records.js because
 * its 2026 permanent-daylight change is newer than many runtimes' tzdata;
 * every other province's rules are long-standing, so the runtime's ICU zone
 * data is trusted here.
 */

export const PROVINCE_ZONES = Object.freeze({
  BC: 'America/Vancouver',
  AB: 'America/Edmonton',
  SK: 'America/Regina',
  MB: 'America/Winnipeg',
  ON: 'America/Toronto',
  QC: 'America/Toronto',
  NB: 'America/Moncton',
  NS: 'America/Halifax',
  PE: 'America/Halifax',
  NL: 'America/St_Johns',
});

const formatters = new Map();
function partsIn(zone, ms) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}

/** Offset of `zone` from UTC (ms) at instant `ms`. */
export function zoneOffsetMs(zone, ms) {
  return partsIn(zone, ms) - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock fields in `zone` → epoch ms (two passes settle DST edges). */
export function zonedToUtc(zone, y, mo, d, h = 0, mi = 0, s = 0) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = wall - zoneOffsetMs(zone, wall);
  guess = wall - zoneOffsetMs(zone, guess);
  return guess;
}

/**
 * Parse a utility timestamp in a given zone.
 * Accepts epoch ms/s (number or digits), ISO with an offset (absolute),
 * zone-less ISO ("2026-10-28T17:00:00"), and US-style "10/28/2026 5:00 PM"
 * (a stray "17:00 PM" is read as 17:00). Returns epoch ms or null.
 */
export function parseZoned(value, zone) {
  if (Number.isFinite(value)) return value > 0 ? (value < 1e11 ? value * 1000 : value) : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (/^\d{10,13}$/.test(s)) return s.length === 10 ? Number(s) * 1000 : Number(s);
  if (/\d(Z|[+-]\d\d:?\d\d)$/i.test(s)) {
    const ms = Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
    return Number.isFinite(ms) ? ms : null;
  }
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(s);
  if (m) return zonedToUtc(zone, +m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]\.?M\.?)?)?$/i.exec(s);
  if (m) {
    let hour = +(m[4] || 0);
    const ampm = (m[7] || '').replace(/\./g, '').toUpperCase();
    if (ampm && hour <= 12) {
      if (ampm === 'PM' && hour < 12) hour += 12;
      if (ampm === 'AM' && hour === 12) hour = 0;
    }
    return zonedToUtc(zone, +m[3], +m[1], +m[2], hour, +(m[5] || 0), +(m[6] || 0));
  }
  return null;
}
