/**
 * Google encoded-polyline decoding (the format Kubra storm centres and the
 * simplified territory files use). Returns [[lon, lat], ...].
 * @param {string} str
 * @param {number} [precision=5] decimal places (5 → 1e5)
 */
export function decodePolyline(str, precision = 5) {
  if (typeof str !== 'string') return [];
  const factor = 10 ** precision;
  const out = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b;
    do {
      if (index >= str.length) return null;
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && shift < 35);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < str.length) {
    const dLat = next();
    const dLon = next();
    if (dLat == null || dLon == null) break;
    lat += dLat;
    lon += dLon;
    out.push([lon / factor, lat / factor]);
  }
  return out;
}
