import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzip, readDbf, readShpPolygons, ringsToMultiPolygon } from '../server/shapefile.js';
import { createTerritory, parseOntarioLdcZip, parseServiceAreaText } from '../server/territory.js';

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const comp = deflateRawSync(data);
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, comp);
    central.push(ch, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function shp(polys) {
  const recs = polys.map((ring, i) => {
    const b = Buffer.alloc(8 + 44 + 4 + ring.length * 16);
    b.writeInt32BE(i + 1, 0); b.writeInt32BE((b.length - 8) / 2, 4);
    b.writeInt32LE(5, 8); b.writeInt32LE(1, 44); b.writeInt32LE(ring.length, 48); b.writeInt32LE(0, 52);
    ring.forEach(([x, y], j) => { b.writeDoubleLE(x, 56 + j * 16); b.writeDoubleLE(y, 64 + j * 16); });
    return b;
  });
  const head = Buffer.alloc(100);
  head.writeInt32BE(9994, 0);
  return Buffer.concat([head, ...recs]);
}

function dbf(names) {
  const len = 60;
  const head = Buffer.alloc(32 + 32 + 1);
  head.writeUInt32LE(names.length, 4); head.writeUInt16LE(65, 8); head.writeUInt16LE(len + 1, 10);
  head.write('LDC', 32, 'latin1'); head[32 + 11] = 0x43; head[32 + 16] = len; head[64] = 0x0d;
  const rows = names.map((n) => Buffer.concat([Buffer.from(' '), Buffer.from(n.padEnd(len), 'latin1')]));
  return Buffer.concat([head, ...rows]);
}

// Clockwise squares (shapefile outer rings).
const sq = (x, y, s) => [[x, y], [x, y + s], [x + s, y + s], [x + s, y], [x, y]];

test('ZIP + shapefile + DBF reading', () => {
  const z = zip({ 'a.shp': shp([sq(-80, 43, 1), sq(-79.6, 43.6, 0.2)]), 'a.dbf': dbf(['Hydro One Networks Inc.', 'Toronto Hydro-Electric System Limited']), 'a.prj': Buffer.from('GEOGCS["GCS_WGS_1984"]') });
  const files = unzip(z);
  assert.equal(files.size, 3);
  assert.equal(readDbf(files.get('a.dbf'))[1].LDC, 'Toronto Hydro-Electric System Limited');
  assert.equal(readShpPolygons(files.get('a.shp')).length, 2);
  const features = parseOntarioLdcZip(z);
  assert.deepEqual(features.map((f) => f.id), ['hydroone', 'torontohydro']);
  assert.equal(features[1].name, 'Toronto Hydro');
  assert.equal(ringsToMultiPolygon([sq(0, 0, 1)]).length, 1);
});

test('service_area.txt polygons', () => {
  const polys = parseServiceAreaText('polygon, color=#cb7712\r\n-119.77,49.0\r\n-119.80,49.07\r\n-120.05,49.22\r\n-119.9,49.0\r\nPolygon,Color=#013ca6\r\n-106.65,52.08\r\n-106.66,52.09\r\n-106.64,52.09\r\n-106.64,52.08\r\n');
  assert.equal(polys.length, 2);
  assert.deepEqual(polys[0][0][0], polys[0][0][polys[0][0].length - 1]);
});

test('lookup: boundary beats city beats province; Alberta is a guess', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'terr-'));
  mkdirSync(path.join(dir, 'territory'));
  writeFileSync(path.join(dir, 'territory', 'ontario.json'), JSON.stringify({ updatedAt: Date.now(), features: [
    { id: 'hydroone', name: 'Hydro One', province: 'ON', polygons: [[sq(-80, 43, 1)]] },
    { id: 'torontohydro', name: 'Toronto Hydro', province: 'ON', polygons: [[sq(-79.6, 43.6, 0.2)]] },
  ] }));
  const t = createTerritory({ dataDir: dir, requestRaw: async () => ({ status: 500 }), requestJson: async () => { throw new Error('offline'); }, log: {} });
  assert.equal(t.lookup({ lat: 43.7, lon: -79.5, province: 'ON' }).id, 'torontohydro');
  assert.equal(t.lookup({ lat: 43.2, lon: -79.9, province: 'ON' }).id, 'hydroone');
  assert.equal(t.lookup({ lat: 43.2, lon: -79.9, province: 'ON' }).confidence, 'boundary');
  const leth = t.lookup({ lat: 49.69, lon: -112.84, province: 'AB', city: 'City of Lethbridge' });
  assert.equal(leth.id, 'lethbridge');
  assert.equal(leth.monitored, false);
  assert.equal(t.lookup({ lat: 56.7, lon: -111.4, province: 'AB' }).id, 'atco');
  assert.equal(t.lookup({ lat: 50.4, lon: -114.0, province: 'AB' }).confidence, 'guess');
  assert.equal(t.lookup({ lat: 45.27, lon: -66.06, province: 'NB', city: 'Saint John' }).id, 'sje');
  assert.equal(t.lookup({ lat: 45.9, lon: -66.6, province: 'NB', city: 'Fredericton' }).id, 'nbpower');
  assert.ok(t.options('ON').some((o) => o.id === 'torontohydro' && o.monitored));
  assert.equal(t.geojson().features.length, 2);
});
