// Ultra-Crisp 600x300 Real Earth World Map Rasterizer & Ocean A* Pathfinding
// Uses real Natural Earth TopoJSON geometry from world-atlas (100% offline)

import { feature } from 'topojson-client';
import countriesAtlas from 'world-atlas/countries-110m.json';

export const MAP_W = 600;
export const MAP_H = 300;

export const TERRAIN_WATER = 0;
export const TERRAIN_PLAINS = 1;
export const TERRAIN_FOREST = 2;
export const TERRAIN_DESERT = 3;
export const TERRAIN_MOUNTAIN = 4;
export const TERRAIN_TUNDRA = 5;

const LAT_MAX = 79;
const LAT_MIN = -56;

function millerY(latDeg) {
  const rad = (latDeg * Math.PI) / 180;
  return 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * rad));
}

const M_MAX = millerY(LAT_MAX);
const M_MIN = millerY(LAT_MIN);

export function lonLatToMapXY(lon, lat) {
  const clampedLat = Math.max(LAT_MIN, Math.min(LAT_MAX, lat));
  const x = ((lon + 180) / 360) * MAP_W;
  const y = ((M_MAX - millerY(clampedLat)) / (M_MAX - M_MIN)) * MAP_H;
  return [x, y];
}

export function mapXYToLonLat(x, y) {
  const lon = (x / MAP_W) * 360 - 180;
  const my = M_MAX - (y / MAP_H) * (M_MAX - M_MIN);
  const rad = 2.5 * (Math.atan(Math.exp(0.8 * my)) - Math.PI / 4);
  const lat = (rad * 180) / Math.PI;
  return [lon, lat];
}

// Smooth deterministic 2D noise for organic natural biomes
function hash2(ix, iy) {
  let n = ix * 374761393 + iy * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967295;
}

function smoothNoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x, y) {
  return (
    smoothNoise(x * 0.045, y * 0.045) * 0.52 +
    smoothNoise(x * 0.11, y * 0.11) * 0.30 +
    smoothNoise(x * 0.24, y * 0.24) * 0.18
  );
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Major real mountain chains (lon, lat, radiusLon, radiusLat)
const MOUNTAIN_ZONES = [
  [86, 31, 18, 7],    // Himalayas / Tibet
  [10, 46.5, 7, 3],   // Alps
  [42, 41.5, 8, 3.5], // Caucasus / Eastern Anatolia
  [51, 33.5, 9, 4.5], // Zagros / Iranian Plateau
  [-111, 42, 9, 14],  // Rocky Mountains
  [-70, -18, 5, 25],  // Andes Mountains
  [38, 9, 6, 6],      // Ethiopian Highlands
  [60, 59, 4, 11],    // Urals
];

// Major arid/desert belts
const DESERT_ZONES = [
  [11, 23, 27, 10],   // Sahara
  [46, 23, 13, 8],    // Arabian Desert
  [64, 41, 12, 6],    // Central Asian steppe/desert
  [101, 42, 14, 6],   // Gobi
  [133, -25, 15, 7],  // Australian Outback
  [-111, 32, 8, 7],   // Mojave / Sonora
];

function zoneStrength(lon, lat, zones, warpX, warpY) {
  const wLon = lon + warpX;
  const wLat = lat + warpY;
  let best = 0;
  for (let i = 0; i < zones.length; i++) {
    const [cx, cy, rx, ry] = zones[i];
    const dx = (wLon - cx) / rx;
    const dy = (wLat - cy) / ry;
    const d = dx * dx + dy * dy;
    if (d < 1.0) {
      const s = 1.0 - d;
      if (s > best) best = s;
    }
  }
  return best;
}

let cachedWorldData = null;

export function getWorldRasterData() {
  if (cachedWorldData) return cachedWorldData;

  const countriesGeo = feature(countriesAtlas, countriesAtlas.objects.countries);

  // Offscreen canvas to rasterize each country with unique RGB ID
  const canvas = document.createElement('canvas');
  canvas.width = MAP_W;
  canvas.height = MAP_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, MAP_W, MAP_H);

  const countryList = [];

  function drawRing(ring) {
    if (!ring || ring.length < 3) return;
    let started = false;
    let prevLon = null;
    for (let i = 0; i < ring.length; i++) {
      const [lon, lat] = ring[i];
      const [px, py] = lonLatToMapXY(lon, lat);
      if (!started || (prevLon !== null && Math.abs(lon - prevLon) > 180)) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
      prevLon = lon;
    }
    ctx.closePath();
  }

  let cid = 1;
  for (const feat of countriesGeo.features) {
    if (feat.id === '010' || feat.id === '260') continue;
    const geom = feat.geometry;
    if (!geom) continue;

    const r = cid & 255;
    const g = (cid >> 8) & 255;
    ctx.fillStyle = `rgb(${r},${g},128)`;

    ctx.beginPath();
    if (geom.type === 'Polygon') {
      for (const ring of geom.coordinates) drawRing(ring);
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        for (const ring of poly) drawRing(ring);
      }
    }
    ctx.fill();

    countryList[cid] = {
      cid,
      isoId: feat.id,
      name: feat.properties?.name || `Bölge ${cid}`,
    };
    cid++;
  }

  const raw = ctx.getImageData(0, 0, MAP_W, MAP_H).data;
  const total = MAP_W * MAP_H;
  const isLand = new Uint8Array(total);
  const countryMask = new Uint16Array(total);
  const terrain = new Uint8Array(total);
  let totalLandPixels = 0;

  for (let i = 0; i < total; i++) {
    const b = raw[i * 4 + 2];
    if (b > 64) {
      const id = raw[i * 4] | (raw[i * 4 + 1] << 8);
      if (id > 0) {
        isLand[i] = 1;
        countryMask[i] = id;
        totalLandPixels++;
      }
    }
  }

  // Open narrow navigable canals (Suez & Panama) cleanly so naval ships pass between oceans!
  const canals = [
    [32.5, 30.2], // Suez
    [-79.8, 9.1], // Panama
  ];
  for (const [clon, clat] of canals) {
    const [cx, cy] = lonLatToMapXY(clon, clat);
    const ix = Math.round(cx);
    const iy = Math.round(cy);
    for (let dy = -2; dy <= 2; dy++) {
      const ny = iy + dy;
      if (ny >= 0 && ny < MAP_H && ix >= 0 && ix < MAP_W) {
        const idx = ny * MAP_W + ix;
        if (isLand[idx]) {
          isLand[idx] = 0;
          countryMask[idx] = 0;
          totalLandPixels--;
        }
      }
    }
  }

  // Compute ocean bathymetry distance from coast (BFS)
  const oceanDepth = new Uint8Array(total);
  oceanDepth.fill(255);
  const bfsQueue = new Int32Array(total);
  let qHead = 0;
  let qTail = 0;

  for (let i = 0; i < total; i++) {
    if (isLand[i]) {
      oceanDepth[i] = 0;
      bfsQueue[qTail++] = i;
    }
  }

  while (qHead < qTail) {
    const cur = bfsQueue[qHead++];
    const curD = oceanDepth[cur];
    if (curD >= 28) continue;
    const x = cur % MAP_W;
    const y = (cur / MAP_W) | 0;

    if (x > 0 && oceanDepth[cur - 1] === 255) { oceanDepth[cur - 1] = curD + 1; bfsQueue[qTail++] = cur - 1; }
    if (x < MAP_W - 1 && oceanDepth[cur + 1] === 255) { oceanDepth[cur + 1] = curD + 1; bfsQueue[qTail++] = cur + 1; }
    if (y > 0 && oceanDepth[cur - MAP_W] === 255) { oceanDepth[cur - MAP_W] = curD + 1; bfsQueue[qTail++] = cur - MAP_W; }
    if (y < MAP_H - 1 && oceanDepth[cur + MAP_W] === 255) { oceanDepth[cur + MAP_W] = curD + 1; bfsQueue[qTail++] = cur + MAP_W; }
  }

  // Build organic National Geographic-style Base Map ImageData (smooth domain-warped biomes!)
  const baseMapRgba = new Uint8ClampedArray(total * 4);

  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const idx = y * MAP_W + x;
      const p4 = idx * 4;

      if (!isLand[idx]) {
        terrain[idx] = TERRAIN_WATER;
        const d = oceanDepth[idx];
        let r, g, b;
        if (d <= 2) {
          r = 32; g = 114; b = 166;
        } else if (d <= 7) {
          const t = (d - 2) / 5;
          r = lerp(32, 17, t);
          g = lerp(114, 72, t);
          b = lerp(166, 124, t);
        } else if (d <= 18) {
          const t = (d - 7) / 11;
          r = lerp(17, 9, t);
          g = lerp(72, 38, t);
          b = lerp(124, 74, t);
        } else {
          r = 8; g = 34; b = 68;
        }

        const wave = Math.sin(x * 0.14 + y * 0.08) * 1.8;
        baseMapRgba[p4] = Math.max(0, Math.min(255, r + wave));
        baseMapRgba[p4 + 1] = Math.max(0, Math.min(255, g + wave));
        baseMapRgba[p4 + 2] = Math.max(0, Math.min(255, b + wave * 1.2));
        baseMapRgba[p4 + 3] = 255;
      } else {
        const [lon, lat] = mapXYToLonLat(x, y);
        const n = fbm(x, y);
        const n2 = fbm(x + 137, y + 73);
        const warpLon = (n - 0.5) * 18;
        const warpLat = (n2 - 0.5) * 11;

        const mntRaw = zoneStrength(lon, lat, MOUNTAIN_ZONES, warpLon * 0.6, warpLat * 0.6);
        const desRaw = zoneStrength(lon, lat, DESERT_ZONES, warpLon, warpLat);

        // Smooth domain-warped biome weights (no hard oval or straight snowline cutoffs!)
        const tundraWeight = clamp01((Math.abs(lat) + (n - 0.5) * 15 - 57) / 14);
        const desertWeight = clamp01((desRaw + (n2 - 0.5) * 0.35) * 1.45);
        const mountainWeight = clamp01((mntRaw + (n - 0.45) * 0.4) * 1.35);
        const forestWeight = clamp01((n - 0.42) * 2.2) * (1 - desertWeight) * (1 - tundraWeight);

        // Base temperate grass/plains color
        let r = 128 + n * 24;
        let g = 152 + n * 22;
        let b = 102 + n * 16;

        // Blend lush forest
        r = lerp(r, 82 + n * 20, forestWeight * 0.72);
        g = lerp(g, 122 + n * 24, forestWeight * 0.72);
        b = lerp(b, 76 + n * 16, forestWeight * 0.72);

        // Blend warm sandy desert organically
        r = lerp(r, 196 + n * 24, desertWeight * 0.85);
        g = lerp(g, 174 + n * 20, desertWeight * 0.85);
        b = lerp(b, 124 + n * 16, desertWeight * 0.85);

        // Blend rocky highlands/mountains
        r = lerp(r, 122 + n * 34, mountainWeight * 0.8);
        g = lerp(g, 114 + n * 30, mountainWeight * 0.8);
        b = lerp(b, 106 + n * 26, mountainWeight * 0.8);

        // Blend arctic tundra/snow smoothly
        r = lerp(r, 194 + n * 28, tundraWeight * 0.9);
        g = lerp(g, 206 + n * 26, tundraWeight * 0.9);
        b = lerp(b, 214 + n * 22, tundraWeight * 0.9);

        // Assign gameplay terrain class
        if (mountainWeight > 0.45) terrain[idx] = TERRAIN_MOUNTAIN;
        else if (tundraWeight > 0.55) terrain[idx] = TERRAIN_TUNDRA;
        else if (desertWeight > 0.45) terrain[idx] = TERRAIN_DESERT;
        else if (forestWeight > 0.42) terrain[idx] = TERRAIN_FOREST;
        else terrain[idx] = TERRAIN_PLAINS;

        // Crisp 1px coastline shadow and subtle real-world country borders
        const myCid = countryMask[idx];
        const touchesWater =
          (x > 0 && !isLand[idx - 1]) ||
          (x < MAP_W - 1 && !isLand[idx + 1]) ||
          (y > 0 && !isLand[idx - MAP_W]) ||
          (y < MAP_H - 1 && !isLand[idx + MAP_W]);

        const touchesOtherCountry =
          !touchesWater &&
          ((x < MAP_W - 1 && isLand[idx + 1] && countryMask[idx + 1] !== myCid) ||
            (y < MAP_H - 1 && isLand[idx + MAP_W] && countryMask[idx + MAP_W] !== myCid));

        if (touchesWater) {
          r *= 0.62; g *= 0.66; b *= 0.72;
        } else if (touchesOtherCountry) {
          r *= 0.86; g *= 0.86; b *= 0.86;
        }

        baseMapRgba[p4] = Math.max(0, Math.min(255, r));
        baseMapRgba[p4 + 1] = Math.max(0, Math.min(255, g));
        baseMapRgba[p4 + 2] = Math.max(0, Math.min(255, b));
        baseMapRgba[p4 + 3] = 255;
      }
    }
  }

  // Build coarse 300x150 water navigation grid for lightning-fast A* naval pathfinding
  const navW = MAP_W / 2;
  const navH = MAP_H / 2;
  const navWater = new Uint8Array(navW * navH);
  for (let ny = 0; ny < navH; ny++) {
    for (let nx = 0; nx < navW; nx++) {
      const bx = nx * 2;
      const by = ny * 2;
      const hasWater =
        !isLand[by * MAP_W + bx] ||
        !isLand[by * MAP_W + bx + 1] ||
        !isLand[(by + 1) * MAP_W + bx] ||
        !isLand[(by + 1) * MAP_W + bx + 1];
      navWater[ny * navW + nx] = hasWater ? 1 : 0;
    }
  }

  cachedWorldData = {
    width: MAP_W,
    height: MAP_H,
    isLand,
    countryMask,
    countryList,
    terrain,
    oceanDepth,
    baseMapRgba,
    totalLandPixels,
    navW,
    navH,
    navWater,
  };
  return cachedWorldData;
}

export function findNearestWater(x, y, isLand, maxRadius = 12) {
  const ix = Math.max(0, Math.min(MAP_W - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(MAP_H - 1, Math.round(y)));
  if (!isLand[iy * MAP_W + ix]) return { x: ix, y: iy };

  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const nx = ix + dx;
        const ny = iy + dy;
        if (nx >= 0 && nx < MAP_W && ny >= 0 && ny < MAP_H && !isLand[ny * MAP_W + nx]) {
          return { x: nx, y: ny };
        }
      }
    }
  }
  return null;
}

export function findNearestLand(x, y, isLand, maxRadius = 16) {
  const ix = Math.max(0, Math.min(MAP_W - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(MAP_H - 1, Math.round(y)));
  if (isLand[iy * MAP_W + ix]) return { x: ix, y: iy };

  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const nx = ix + dx;
        const ny = iy + dy;
        if (nx >= 0 && nx < MAP_W && ny >= 0 && ny < MAP_H && isLand[ny * MAP_W + nx]) {
          return { x: nx, y: ny };
        }
      }
    }
  }
  return null;
}

function isWaterLineClear(x0, y0, x1, y1, navWater, navW, navH) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.ceil(Math.hypot(dx, dy) * 1.5);
  if (steps <= 1) return true;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = Math.round(x0 + dx * t);
    const y = Math.round(y0 + dy * t);
    if (x < 0 || x >= navW || y < 0 || y >= navH || !navWater[y * navW + x]) {
      return false;
    }
  }
  return true;
}

export function findOceanPath(startX, startY, endX, endY, worldData) {
  const { navW, navH, navWater } = worldData;
  const sx = Math.max(0, Math.min(navW - 1, Math.floor(startX / 2)));
  const sy = Math.max(0, Math.min(navH - 1, Math.floor(startY / 2)));
  const ex = Math.max(0, Math.min(navW - 1, Math.floor(endX / 2)));
  const ey = Math.max(0, Math.min(navH - 1, Math.floor(endY / 2)));

  const total = navW * navH;
  const startIdx = sy * navW + sx;
  const endIdx = ey * navW + ex;

  if (startIdx === endIdx) {
    return [{ x: startX, y: startY }, { x: endX, y: endY }];
  }

  if (isWaterLineClear(sx, sy, ex, ey, navWater, navW, navH)) {
    return [{ x: startX, y: startY }, { x: endX, y: endY }];
  }

  const gScore = new Float32Array(total);
  gScore.fill(1e9);
  const parent = new Int32Array(total);
  parent.fill(-1);
  const closed = new Uint8Array(total);

  const heapIdx = new Int32Array(total);
  const heapF = new Float32Array(total);
  let heapSize = 0;

  function heapPush(node, f) {
    let i = heapSize++;
    heapIdx[i] = node;
    heapF[i] = f;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= heapF[i]) break;
      const ti = heapIdx[p]; const tf = heapF[p];
      heapIdx[p] = heapIdx[i]; heapF[p] = heapF[i];
      heapIdx[i] = ti; heapF[i] = tf;
      i = p;
    }
  }

  function heapPop() {
    const top = heapIdx[0];
    heapSize--;
    if (heapSize > 0) {
      heapIdx[0] = heapIdx[heapSize];
      heapF[0] = heapF[heapSize];
      let i = 0;
      while (true) {
        let smallest = i;
        const l = i * 2 + 1;
        const r = l + 1;
        if (l < heapSize && heapF[l] < heapF[smallest]) smallest = l;
        if (r < heapSize && heapF[r] < heapF[smallest]) smallest = r;
        if (smallest === i) break;
        const ti = heapIdx[i]; const tf = heapF[i];
        heapIdx[i] = heapIdx[smallest]; heapF[i] = heapF[smallest];
        heapIdx[smallest] = ti; heapF[smallest] = tf;
        i = smallest;
      }
    }
    return top;
  }

  gScore[startIdx] = 0;
  heapPush(startIdx, Math.hypot(ex - sx, ey - sy));

  const dirs = [
    [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
    [-1, -1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [1, 1, 1.414],
  ];

  let found = false;
  let iterations = 0;
  const MAX_ITER = 26000;

  while (heapSize > 0 && iterations++ < MAX_ITER) {
    const cur = heapPop();
    if (cur === endIdx) {
      found = true;
      break;
    }
    if (closed[cur]) continue;
    closed[cur] = 1;

    const cx = cur % navW;
    const cy = (cur / navW) | 0;
    const curG = gScore[cur];

    for (let d = 0; d < 8; d++) {
      const nx = cx + dirs[d][0];
      const ny = cy + dirs[d][1];
      if (nx < 0 || nx >= navW || ny < 0 || ny >= navH) continue;
      const nIdx = ny * navW + nx;
      if (closed[nIdx]) continue;
      if (!navWater[nIdx] && nIdx !== endIdx) continue;

      const ng = curG + dirs[d][2];
      if (ng < gScore[nIdx]) {
        gScore[nIdx] = ng;
        parent[nIdx] = cur;
        const h = Math.hypot(ex - nx, ey - ny) * 1.05;
        heapPush(nIdx, ng + h);
      }
    }
  }

  if (!found) return null;

  const rawPath = [];
  let cur = endIdx;
  while (cur !== -1) {
    rawPath.push({ x: cur % navW, y: (cur / navW) | 0 });
    cur = parent[cur];
  }
  rawPath.reverse();

  const smooth = [rawPath[0]];
  let anchor = 0;
  while (anchor < rawPath.length - 1) {
    let farthest = anchor + 1;
    for (let test = Math.min(rawPath.length - 1, anchor + 50); test > anchor + 1; test--) {
      if (isWaterLineClear(rawPath[anchor].x, rawPath[anchor].y, rawPath[test].x, rawPath[test].y, navWater, navW, navH)) {
        farthest = test;
        break;
      }
    }
    smooth.push(rawPath[farthest]);
    anchor = farthest;
  }

  const finalPath = smooth.map((p) => ({ x: p.x * 2 + 1, y: p.y * 2 + 1 }));
  finalPath[0] = { x: startX, y: startY };
  finalPath[finalPath.length - 1] = { x: endX, y: endY };
  return finalPath;
}
