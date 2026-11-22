// High-DPI 60 FPS Cartographic World Map Renderer
// Composites seamless per-region custom flags, crisp borders, animated battlefronts,
// A* sailing warships, defensive citadels, and crisp auto-scaled nation labels

import { MAP_W, MAP_H, TERRAIN_MOUNTAIN, TERRAIN_FOREST } from './worldRasterizer';
import { FLAG_W, FLAG_H } from './flagLibrary';
import { formatTroops } from './worldEngine';

export class WorldMapRenderer {
  constructor(worldData) {
    this.worldData = worldData;

    // Offscreen 480x240 buffer canvas for blazing-fast pixel-exact flag compositing
    this.bufferCanvas = document.createElement('canvas');
    this.bufferCanvas.width = MAP_W;
    this.bufferCanvas.height = MAP_H;
    this.bufferCtx = this.bufferCanvas.getContext('2d', { willReadFrequently: true });
    this.imageData = this.bufferCtx.createImageData(MAP_W, MAP_H);

    // Initialize with gorgeous base topographic Earth map
    this.imageData.data.set(worldData.baseMapRgba);
    this.bufferCtx.putImageData(this.imageData, 0, 0);
  }

  // Re-composite territory flag pixels onto offscreen ImageData (~1.5ms for full Earth!)
  updateTerritoryBuffer(engine, hoveredNationId = 0, selectedNationId = 0) {
    const dst = this.imageData.data;
    const base = this.worldData.baseMapRgba;
    const owners = engine.owners;
    const terrain = this.worldData.terrain;
    const fresh = engine.freshness;
    const pixReg = engine.pixelRegion;
    const regions = engine.regions;

    // Fast copy of topographic base Earth (oceans + neutral land)
    dst.set(base);

    // Pre-build quick nation lookup array by ID for hot pixel loop
    const maxId = engine.nations.reduce((m, n) => Math.max(m, n.id), 1);
    const nationArr = new Array(maxId + 1);
    const largestRegByNation = new Array(maxId + 1);

    for (let i = 0; i < engine.nations.length; i++) {
      const n = engine.nations[i];
      nationArr[n.id] = n;
    }
    for (let i = 0; i < regions.length; i++) {
      const reg = regions[i];
      const prev = largestRegByNation[reg.ownerId];
      if (!prev || reg.count > prev.count) {
        largestRegByNation[reg.ownerId] = reg;
      }
    }

    for (let y = 0; y < MAP_H; y++) {
      const row = y * MAP_W;
      for (let x = 0; x < MAP_W; x++) {
        const idx = row + x;
        const o = owners[idx];
        if (o <= 0) continue;

        const nation = nationArr[o];
        if (!nation) continue;

        const p4 = idx * 4;
        const regIdx = pixReg[idx];
        const reg = regIdx >= 0 ? regions[regIdx] : largestRegByNation[o];

        let r, g, b;

        if (nation.flagRgba && reg) {
          // Seamless per-connected-region flag projection (identical to flag world maps!)
          let u = (x - reg.minX) / reg.w;
          let v = (y - reg.minY) / reg.h;
          if (u < 0) u = 0; else if (u > 0.999) u = 0.999;
          if (v < 0) v = 0; else if (v > 0.999) v = 0.999;

          const fx = (u * FLAG_W) | 0;
          const fy = (v * FLAG_H) | 0;
          const fp = (fy * FLAG_W + fx) * 4;

          r = nation.flagRgba[fp];
          g = nation.flagRgba[fp + 1];
          b = nation.flagRgba[fp + 2];
        } else {
          r = 220; g = 40; b = 60;
        }

        // Subtle topographic relief blend so mountains & terrain remain tactile under flags
        const t = terrain[idx];
        if (t === TERRAIN_MOUNTAIN) {
          r *= 0.84; g *= 0.84; b *= 0.86;
        } else if (t === TERRAIN_FOREST) {
          r *= 0.95; g *= 0.96; b *= 0.95;
        }

        // Hover / Selection subtle bright highlight
        if (o === selectedNationId) {
          r = Math.min(255, r * 1.15 + 18);
          g = Math.min(255, g * 1.15 + 18);
          b = Math.min(255, b * 1.15 + 18);
        } else if (o === hoveredNationId) {
          r = Math.min(255, r * 1.08 + 10);
          g = Math.min(255, g * 1.08 + 10);
          b = Math.min(255, b * 1.08 + 10);
        }

        // Crisp 1px outer border only where territory meets ocean or another country
        const isBorder =
          x === 0 ||
          x === MAP_W - 1 ||
          y === 0 ||
          y === MAP_H - 1 ||
          owners[idx - 1] !== o ||
          owners[idx + 1] !== o ||
          owners[idx - MAP_W] !== o ||
          owners[idx + MAP_W] !== o;

        if (isBorder) {
          if (nation.isPlayer) {
            // Radiant gold border for Player Empire!
            r = 251; g = 191; b = 36;
          } else if (nation.vassalOfPlayer) {
            // Royal violet-gold border for Vassals
            r = 192; g = 132; b = 252;
          } else if (nation.alliedWithPlayer) {
            // Emerald peace border for Allies
            r = 52; g = 211; b = 153;
          } else if (o === selectedNationId) {
            r = 255; g = 255; b = 255;
          } else {
            // Crisp dark cartographic ink border
            r *= 0.28; g *= 0.28; b *= 0.34;
          }
        }

        // Molten battlefront glow on freshly conquered pixels
        const fr = fresh[idx];
        if (fr > 35) {
          const glow = Math.min(0.75, (fr - 35) / 240);
          r = r + (255 - r) * glow;
          g = g + (195 - g) * glow;
          b = b + (65 - b) * glow;
        }

        dst[p4] = r;
        dst[p4 + 1] = g;
        dst[p4 + 2] = b;
        dst[p4 + 3] = 255;
      }
    }

    this.bufferCtx.putImageData(this.imageData, 0, 0);
  }

  // Draw complete 60 FPS frame onto high-DPI viewport canvas
  renderFrame(ctx, viewW, viewH, camera, engine, uiState = {}) {
    const {
      phase = 'PLAYING', // 'SPAWN' | 'PLAYING'
      hoveredMapPos = null,
      hoveredNationId = 0,
      selectedNationId = 0,
      actionMode = 'AUTO',
      timeSec = 0,
    } = uiState;

    // Only rebuild pixel buffer when engine mutated pixels or hover/selection changed
    const cacheKey = `${hoveredNationId}:${selectedNationId}`;
    if (engine.dirtyPixels || this._lastCacheKey !== cacheKey) {
      this.updateTerritoryBuffer(engine, hoveredNationId, selectedNationId);
      engine.dirtyPixels = false;
      this._lastCacheKey = cacheKey;
    }

    // 1. Deep ocean background fill
    ctx.fillStyle = '#061529';
    ctx.fillRect(0, 0, viewW, viewH);

    // Compute world-to-screen transform
    const baseScale = Math.min(viewW / MAP_W, viewH / MAP_H);
    const scale = baseScale * camera.zoom;
    const mapScreenW = MAP_W * scale;
    const mapScreenH = MAP_H * scale;
    const originX = (viewW - mapScreenW) / 2 + camera.panX;
    const originY = (viewH - mapScreenH) / 2 + camera.panY;

    ctx.save();
    ctx.translate(originX, originY);

    // 2. Render composited World + Seamless Flags map
    ctx.imageSmoothingEnabled = scale < 2.2;
    ctx.drawImage(this.bufferCanvas, 0, 0, mapScreenW, mapScreenH);

    // 3. Subtle Cartographic Latitude/Longitude Graticule Lines
    ctx.strokeStyle = 'rgba(148, 210, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = 1; gx < 12; gx++) {
      const sx = (gx / 12) * mapScreenW;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, mapScreenH);
    }
    for (let gy = 1; gy < 6; gy++) {
      const sy = (gy / 6) * mapScreenH;
      ctx.moveTo(0, sy);
      ctx.lineTo(mapScreenW, sy);
    }
    ctx.stroke();

    // Crisp outer map frame
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0, 0, mapScreenW, mapScreenH);

    // 4. Draw Fortified Citadels (Sınır Kaleleri) & Defense Auras
    for (let i = 0; i < engine.forts.length; i++) {
      const f = engine.forts[i];
      const fx = f.x * scale;
      const fy = f.y * scale;
      const auraR = 18 * scale;
      const isPlayerFort = f.ownerId === 1;

      // Subtle defensive aura ring
      ctx.save();
      ctx.beginPath();
      ctx.arc(fx, fy, auraR, 0, Math.PI * 2);
      ctx.fillStyle = isPlayerFort ? 'rgba(251, 191, 36, 0.08)' : 'rgba(248, 113, 113, 0.07)';
      ctx.fill();
      ctx.strokeStyle = isPlayerFort ? 'rgba(251, 191, 36, 0.35)' : 'rgba(248, 113, 113, 0.3)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      // Star-Fort Shield Badge
      const r = Math.max(5, Math.min(11, 3.2 * scale));
      ctx.save();
      ctx.translate(fx, fy);
      ctx.fillStyle = isPlayerFort ? '#fbbf24' : '#e2e8f0';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const rad = k % 2 === 0 ? r : r * 0.62;
        const a = (k * Math.PI) / 4;
        if (k === 0) ctx.moveTo(Math.cos(a) * rad, Math.sin(a) * rad);
        else ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // 5. Draw Sailing Fleets (Naval Ships, Wake Trails, Routes, Troop Badges)
    for (let i = 0; i < engine.fleets.length; i++) {
      const fl = engine.fleets[i];
      const owner = engine.nationMap.get(fl.ownerId);
      const isPlayer = owner?.isPlayer;

      // Dashed future route preview for player ships
      if (isPlayer && fl.path && fl.waypointIdx < fl.path.length) {
        ctx.save();
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(fl.x * scale, fl.y * scale);
        for (let w = fl.waypointIdx; w < fl.path.length; w++) {
          ctx.lineTo(fl.path[w].x * scale, fl.path[w].y * scale);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Ocean foam wake trail
      if (fl.trail.length > 1) {
        ctx.save();
        ctx.strokeStyle = 'rgba(186, 230, 253, 0.5)';
        ctx.lineWidth = Math.max(1.5, scale * 0.8);
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let t = 0; t < fl.trail.length; t++) {
          const pt = fl.trail[t];
          if (t === 0) ctx.moveTo(pt.x * scale, pt.y * scale);
          else ctx.lineTo(pt.x * scale, pt.y * scale);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Crisp Vector Warship Silhouette rotated along heading
      const sx = fl.x * scale;
      const sy = fl.y * scale;
      const sz = fl.shipType === 'DREADNOUGHT' ? 10 : fl.shipType === 'FRIGATE' ? 8 : 6.5;

      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(fl.angle);

      // Hull shadow
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.moveTo(sz + 1.5, 1.5);
      ctx.lineTo(-sz * 0.75 + 1.5, -sz * 0.55 + 1.5);
      ctx.lineTo(-sz * 0.45 + 1.5, 1.5);
      ctx.lineTo(-sz * 0.75 + 1.5, sz * 0.55 + 1.5);
      ctx.closePath();
      ctx.fill();

      // Main ship hull
      ctx.fillStyle = isPlayer ? '#fbbf24' : owner?.color || '#f87171';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(sz, 0);
      ctx.lineTo(-sz * 0.75, -sz * 0.55);
      ctx.lineTo(-sz * 0.5, 0);
      ctx.lineTo(-sz * 0.75, sz * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Dreadnought armored deck stripe
      if (fl.shipType === 'DREADNOUGHT') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-sz * 0.35, -1.5, sz * 0.65, 3);
      }
      ctx.restore();

      // Fleet troop badge
      const label = formatTroops(fl.troops);
      ctx.save();
      ctx.font = '800 10px Inter, system-ui, sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
      ctx.beginPath();
      ctx.roundRect(sx - tw / 2 - 4, sy - sz - 15, tw + 8, 13, 4);
      ctx.fill();
      ctx.fillStyle = isPlayer ? '#fde68a' : '#f8fafc';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, sx, sy - sz - 8.5);
      ctx.restore();
    }

    // 6. Draw Battle Sparks & Explosion Particles
    for (let i = 0; i < engine.particles.length; i++) {
      const p = engine.particles[i];
      const alpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(p.x * scale, p.y * scale, p.size * Math.max(0.8, scale * 0.4), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 7. Draw Clean Auto-Scaled Nation Labels with 2D Collision Avoidance (Zero Overlapping Text!)
    if (phase === 'PLAYING') {
      const largestByNation = new Map();
      for (let i = 0; i < engine.regions.length; i++) {
        const reg = engine.regions[i];
        const prev = largestByNation.get(reg.ownerId);
        if (!prev || reg.count > prev.count) {
          largestByNation.set(reg.ownerId, reg);
        }
      }

      let leaderId = -1;
      let maxLand = 0;
      for (const n of engine.nations) {
        if (n.alive && n.landCount > maxLand) {
          maxLand = n.landCount;
          leaderId = n.id;
        }
      }

      // Priority order: Player -> Selected -> Hovered -> Largest Empires
      const sortedNations = engine.nations
        .filter((n) => n.alive && largestByNation.has(n.id))
        .sort((a, b) => {
          const prio = (n) =>
            n.isPlayer
              ? 1e9
              : n.id === selectedNationId
              ? 5e8
              : n.id === hoveredNationId
              ? 2e8
              : n.landCount;
          return prio(b) - prio(a);
        });

      const placedBoxes = [];
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (const nation of sortedNations) {
        const reg = largestByNation.get(nation.id);
        const boxScreenW = reg.w * scale;
        const boxScreenH = reg.h * scale;
        const minDim = Math.min(boxScreenW, boxScreenH);
        const isPriority = nation.isPlayer || nation.id === hoveredNationId || nation.id === selectedNationId;

        if (!isPriority && minDim < 22) continue;

        const lx = reg.cx * scale;
        const ly = reg.cy * scale;
        const nameSize = Math.max(9.5, Math.min(16, Math.sqrt(reg.count) * scale * 0.21));
        const troopSize = Math.max(8, nameSize * 0.82);

        const prefix =
          nation.id === leaderId
            ? '👑 '
            : nation.vassalOfPlayer
            ? '⚜️ '
            : nation.alliedWithPlayer
            ? '🛡️ '
            : nation.isPlayer
            ? '★ '
            : '';

        const fullName = `${prefix}${nation.name}`;
        ctx.font = `900 ${Math.round(nameSize)}px Inter, system-ui, sans-serif`;
        const textW = ctx.measureText(fullName).width + 10;
        const textH = nameSize + troopSize + 8;

        const x1 = lx - textW / 2;
        const y1 = ly - textH / 2;
        const x2 = lx + textW / 2;
        const y2 = ly + textH / 2;

        // Check overlap with higher-priority placed labels
        if (!nation.isPlayer && nation.id !== selectedNationId) {
          let overlaps = false;
          for (let b = 0; b < placedBoxes.length; b++) {
            const box = placedBoxes[b];
            if (x1 < box.x2 && x2 > box.x1 && y1 < box.y2 && y2 > box.y1) {
              overlaps = true;
              break;
            }
          }
          if (overlaps) continue;
        }

        placedBoxes.push({ x1, y1, x2, y2 });

        // Nation Name with dark cartographic halo
        ctx.lineWidth = 3.2;
        ctx.strokeStyle = 'rgba(8, 15, 30, 0.9)';
        ctx.lineJoin = 'round';
        ctx.strokeText(fullName, lx, ly - troopSize * 0.45);
        ctx.fillStyle = nation.isPlayer ? '#fef08a' : '#ffffff';
        ctx.fillText(fullName, lx, ly - troopSize * 0.45);

        // Troop Counter underneath
        const troopStr = formatTroops(nation.troops);
        ctx.font = `800 ${Math.round(troopSize)}px Inter, system-ui, sans-serif`;
        ctx.lineWidth = 2.6;
        ctx.strokeStyle = 'rgba(8, 15, 30, 0.9)';
        ctx.strokeText(troopStr, lx, ly + nameSize * 0.56);
        ctx.fillStyle = nation.isPlayer ? '#fde047' : '#cbd5e1';
        ctx.fillText(troopStr, lx, ly + nameSize * 0.56);
      }
    }

    // 8. Spawn Phase Interactive Landing Target Ring
    if (phase === 'SPAWN' && hoveredMapPos) {
      const hx = hoveredMapPos.x * scale;
      const hy = hoveredMapPos.y * scale;
      const idx = Math.floor(hoveredMapPos.y) * MAP_W + Math.floor(hoveredMapPos.x);
      const validLand =
        hoveredMapPos.x >= 0 &&
        hoveredMapPos.x < MAP_W &&
        hoveredMapPos.y >= 0 &&
        hoveredMapPos.y < MAP_H &&
        this.worldData.isLand[idx] === 1;

      const pulse = 1 + Math.sin(timeSec * 6) * 0.14;
      ctx.save();
      ctx.beginPath();
      ctx.arc(hx, hy, 12 * pulse, 0, Math.PI * 2);
      ctx.strokeStyle = validLand ? '#fbbf24' : '#ef4444';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fillStyle = validLand ? 'rgba(251, 191, 36, 0.22)' : 'rgba(239, 68, 68, 0.2)';
      ctx.fill();

      ctx.font = '900 11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = validLand ? '#fef08a' : '#fca5a5';
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 3;
      const msg = validLand ? '★ Buraya Başkent Kur' : 'Kara Bölgesi Seç';
      ctx.strokeText(msg, hx, hy - 18);
      ctx.fillText(msg, hx, hy - 18);
      ctx.restore();
    }

    // 9. Fortify / Naval mode target reticle
    if (phase === 'PLAYING' && hoveredMapPos && (actionMode === 'FORTIFY' || actionMode === 'NAVAL')) {
      const hx = hoveredMapPos.x * scale;
      const hy = hoveredMapPos.y * scale;
      ctx.save();
      ctx.beginPath();
      ctx.arc(hx, hy, actionMode === 'FORTIFY' ? 18 * scale : 10, 0, Math.PI * 2);
      ctx.strokeStyle = actionMode === 'FORTIFY' ? '#fbbf24' : '#38bdf8';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();

    return { scale, originX, originY, mapScreenW, mapScreenH };
  }
}
