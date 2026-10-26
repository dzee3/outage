/** Small geometry helpers: no dependencies, degrees in, kilometres out. */

const R_KM = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;

export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function inRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/** polygons: [[outer, ...holes], ...] of [lon, lat]. */
export function pointInPolygons(point, polygons) {
  for (const [outer, ...holes] of polygons || []) {
    if (inRing(point, outer) && !holes.some((h) => inRing(point, h))) return true;
  }
  return false;
}

/** Shortest distance from a point to any polygon edge (km, approximate). */
export function distanceToPolygonsKm(point, polygons) {
  let best = Infinity;
  const kx = 111.32 * Math.cos(rad(point.lat));
  const ky = 110.57;
  for (const rings of polygons || []) {
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i++) {
        const ax = (ring[i - 1][0] - point.lon) * kx;
        const ay = (ring[i - 1][1] - point.lat) * ky;
        const bx = (ring[i][0] - point.lon) * kx;
        const by = (ring[i][1] - point.lat) * ky;
        const dx = bx - ax;
        const dy = by - ay;
        const len = dx * dx + dy * dy;
        const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
        best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
      }
    }
  }
  return best;
}

/** GeoJSON MultiPolygon/Polygon geometry → [[outer, ...holes], ...]. */
export function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}
