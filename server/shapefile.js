import { inflateRawSync } from 'node:zlib';

/*
 * Just enough ZIP + ESRI shapefile reading for open-data boundary files
 * (polygons in WGS84). No dependencies.
 */

/** ZIP buffer → Map(name → Buffer). Handles stored and deflated entries. */
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad ZIP directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lnl = buf.readUInt16LE(offset + 26);
    const lel = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + lnl + lel;
    const raw = buf.subarray(start, start + csize);
    if (method === 0) files.set(name, Buffer.from(raw));
    else if (method === 8) files.set(name, inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** DBF → array of records (strings, trimmed). */
export function readDbf(buf, encoding = 'latin1') {
  const n = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);
  const fields = [];
  for (let o = 32; buf[o] !== 0x0d && o < headerLen; o += 32) {
    fields.push({
      name: buf.subarray(o, o + 11).toString('latin1').replace(/\0.*$/s, ''),
      len: buf[o + 16],
    });
  }
  const records = [];
  for (let i = 0; i < n; i++) {
    let o = headerLen + i * recordLen + 1;
    const r = {};
    for (const f of fields) {
      r[f.name] = buf.subarray(o, o + f.len).toString(encoding).trim();
      o += f.len;
    }
    records.push(r);
  }
  return records;
}

/** SHP (Polygon, type 5/15/25) → array of ring lists ([[x, y], ...][]). */
export function readShpPolygons(buf) {
  const shapes = [];
  let o = 100;
  while (o + 8 <= buf.length) {
    const len = buf.readInt32BE(o + 4) * 2;
    const c = o + 8;
    const type = buf.readInt32LE(c);
    if (type === 5 || type === 15 || type === 25) {
      const numParts = buf.readInt32LE(c + 36);
      const numPoints = buf.readInt32LE(c + 40);
      const parts = [];
      for (let i = 0; i < numParts; i++) parts.push(buf.readInt32LE(c + 44 + i * 4));
      const pts = c + 44 + numParts * 4;
      const rings = [];
      for (let i = 0; i < numParts; i++) {
        const end = i + 1 < numParts ? parts[i + 1] : numPoints;
        const ring = [];
        for (let j = parts[i]; j < end; j++) ring.push([buf.readDoubleLE(pts + j * 16), buf.readDoubleLE(pts + j * 16 + 8)]);
        rings.push(ring);
      }
      shapes.push(rings);
    } else shapes.push([]);
    o = c + len;
  }
  return shapes;
}

/** Signed area: positive for clockwise rings (shapefile outer rings). */
export function ringArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return s / 2;
}

/** Douglas–Peucker simplification (degrees). */
export function simplify(points, tolerance) {
  if (points.length < 5) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const t2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const L = dx * dx + dy * dy;
    let max = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      const d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      if (d > max) {
        max = d;
        idx = i;
      }
    }
    if (max > t2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const round = (ring) => ring.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]);

/**
 * Shapefile rings → GeoJSON MultiPolygon coordinates: outer rings
 * (clockwise) start polygons, counter-clockwise rings are holes of the
 * polygon before them. Tiny slivers are dropped.
 */
export function ringsToMultiPolygon(rings, tolerance = 0.0005, minArea = 1e-7) {
  const polygons = [];
  for (const ring of rings) {
    const area = ringArea(ring);
    if (Math.abs(area) < minArea) continue;
    let s = simplify(ring, tolerance);
    if (s.length < 4) continue;
    if (s[0][0] !== s[s.length - 1][0] || s[0][1] !== s[s.length - 1][1]) s = [...s, s[0]];
    s = round(s);
    if (area > 0 || !polygons.length) polygons.push([s]);
    else polygons[polygons.length - 1].push(s);
  }
  return polygons;
}
