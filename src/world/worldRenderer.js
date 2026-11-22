// High-DPI 60 FPS Cartographic World Map Renderer (Original Game Style on World Map)
// Composites seamless per-region custom flags, crisp borders, defensive walls,
// World city landmarks & conquest badges, legal move highlights, sailing warships,
// and auto-scaled cartographic labels

import { MAP_W, MAP_H, TERRAIN_MOUNTAIN, TERRAIN_FOREST, TERRAIN_DESERT } from './worldRasterizer';
import { FLAG_W, FLAG_H } from './flagLibrary';
import { formatTroops } from './worldEngine';

export class WorldMapRenderer {
  constructor(worldData) {
    this.worldData = worldData;

    // Offscreen 1000x500 buffer canvas for blazing-fast pixel-exact flag compositing
    this.bufferCanvas = document.createElement('canvas');
    this.bufferCanvas.width = MAP_W;
    this.bufferCanvas.height = MAP_H;
    this.bufferCtx = this.bufferCanvas.getContext('2d', { willReadFrequently: true });
    this.imageData = this.bufferCtx.createImageData(MAP_W, MAP_H);

    // Initialize with base topographic Earth map
    this.imageData.data.set(worldData.baseMapRgba);
    this.bufferCtx.putImageData(this.imageData, 0, 0);
  }

  // Re-composite territory flag pixels onto offscreen ImageData
  updateTerritoryBuffer(engine) {
    const dst = this.imageData.data;
    const base = this.worldData.baseMapRgba;
    const owners = engine.owners;
    const walls = engine.walls;
    const terrain = this.worldData.terrain;
    const fresh = engine.freshness;
    const pixReg = engine.pixelRegion;
    const regions = engine.regions;

    // Fast copy of topographic base Earth
    dst.set(base);

    // Build lookup for players
    const playerMap = new Map();
    for (const p of engine.players) {
      playerMap.set(p.id, p);
    }

    const largestRegByPlayer = new Map();
    for (const reg of regions) {
      const prev = largestRegByPlayer.get(reg.ownerId);
      if (!prev || reg.count > prev.count) {
        largestRegByPlayer.set(reg.ownerId, reg);
      }
    }

    const activePlayer = engine.getActivePlayer();
    const activePlayerId = activePlayer?.id || 1;

    for (let y = 0; y < MAP_H; y++) {
      const row = y * MAP_W;
      for (let x = 0; x < MAP_W; x++) {
        const idx = row + x;
        const o = owners[idx];
        if (o <= 0) continue;

        const player = playerMap.get(o);
        if (!player) continue;

        const p4 = idx * 4;
        const regIdx = pixReg[idx];
        const reg = regIdx >= 0 ? regions[regIdx] : largestRegByPlayer.get(o);

        let r, g, b;

        if (player.flagRgba && reg) {
          // Seamless per-connected-region flag projection (covers the conquered nation)
          let u = (x - reg.minX) / reg.w;
          let v = (y - reg.minY) / reg.h;
          if (u < 0) u = 0; else if (u > 0.999) u = 0.999;
          if (v < 0) v = 0; else if (v > 0.999) v = 0.999;

          const fx = (u * FLAG_W) | 0;
          const fy = (v * FLAG_H) | 0;
          const fp = (fy * FLAG_W + fx) * 4;

          r = player.flagRgba[fp];
          g = player.flagRgba[fp + 1];
          b = player.flagRgba[fp + 2];
        } else {
          // Fallback to solid player color
          r = 220; g = 38; b = 38;
        }

        // Relief blend so mountains & forests remain tactile under flags
        const t = terrain[idx];
        if (t === TERRAIN_MOUNTAIN) {
          r *= 0.82; g *= 0.82; b *= 0.84;
        } else if (t === TERRAIN_FOREST) {
          r *= 0.94; g *= 0.96; b *= 0.94;
        }

        // Fortified Stone Wall on this cell!
        const isWall = walls[idx] === 1;
        if (isWall) {
          // Ashlar granite stone color with metallic sheen
          r = Math.min(255, r * 0.4 + 140);
          g = Math.min(255, g * 0.4 + 144);
          b = Math.min(255, b * 0.4 + 155);
        }

        // Crisp 1px outer border where territory meets ocean or neutral land or another player
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
          if (isWall) {
            // Stone wall border
            r = 71; g = 85; b = 105;
          } else if (o === activePlayerId) {
            // Radiant gold border for active player!
            r = 251; g = 191; b = 36;
          } else {
            // High-contrast cartographic ink border
            r = 30; g = 41; b = 59;
          }
        }

        // Freshly conquered cell glow
        const fr = fresh[idx];
        if (fr > 0) {
          const glow = Math.min(0.7, fr / 4);
          r = Math.min(255, r + (255 - r) * glow);
          g = Math.min(255, g + (215 - g) * glow);
          b = Math.min(255, b + (0 - b) * glow);
        }

        dst[p4] = r;
        dst[p4 + 1] = g;
        dst[p4 + 2] = b;
        dst[p4 + 3] = 255;
      }
    }

    this.bufferCtx.putImageData(this.imageData, 0, 0);
  }

  // Draw complete 60 FPS frame onto viewport canvas
  renderFrame(ctx, viewW, viewH, camera, engine, uiState = {}) {
    const {
      phase = 'PLAYING', // 'SETUP' | 'SPAWN' | 'PLAYING'
      hoveredMapPos = null,
      placingMode = 'EXPAND', // 'EXPAND' | 'WALL' | 'NAVAL'
      timeSec = 0,
    } = uiState;

    if (engine.dirtyRegions) {
      engine.updateConnectedRegions();
    }
    if (engine.dirtyPixels) {
      this.updateTerritoryBuffer(engine);
      engine.dirtyPixels = false;
    }

    // 1. Ocean deep background
    ctx.fillStyle = '#061529';
    ctx.fillRect(0, 0, viewW, viewH);

    // World transform
    const baseScale = Math.min(viewW / MAP_W, viewH / MAP_H);
    const scale = baseScale * camera.zoom;
    const mapScreenW = MAP_W * scale;
    const mapScreenH = MAP_H * scale;
    const originX = (viewW - mapScreenW) / 2 + camera.panX;
    const originY = (viewH - mapScreenH) / 2 + camera.panY;

    ctx.save();
    ctx.translate(originX, originY);

    // 2. Render offscreen buffer
    ctx.imageSmoothingEnabled = scale < 2.5;
    ctx.drawImage(this.bufferCanvas, 0, 0, mapScreenW, mapScreenH);

    // 3. Latitude/Longitude Grid Lines (subtle cartographic lines)
    ctx.strokeStyle = 'rgba(148, 210, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = 1; gx < 16; gx++) {
      const sx = (gx / 16) * mapScreenW;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, mapScreenH);
    }
    for (let gy = 1; gy < 8; gy++) {
      const sy = (gy / 8) * mapScreenH;
      ctx.moveTo(0, sy);
      ctx.lineTo(mapScreenW, sy);
    }
    ctx.stroke();

    // Map boundary frame
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.3)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0, 0, mapScreenW, mapScreenH);

    const activePlayer = engine.getActivePlayer();

    // 4. Highlight Valid Move / Frontier Hints (just like original GameBoard!)
    if (phase === 'PLAYING' && activePlayer && activePlayer.troops > 0 && scale > 1.2) {
      // Find candidate border cells when zoomed in
      const owners = engine.owners;
      const isLand = this.worldData.isLand;
      const pId = activePlayer.id;

      // Only check visible screen bounding box to maintain 60 FPS
      const minX = Math.max(0, Math.floor(-camera.panX / scale));
      const maxX = Math.min(MAP_W - 1, Math.ceil((viewW - camera.panX) / scale));
      const minY = Math.max(0, Math.floor(-camera.panY / scale));
      const maxY = Math.min(MAP_H - 1, Math.ceil((viewH - camera.panY) / scale));

      if (placingMode === 'EXPAND') {
        ctx.fillStyle = 'rgba(251, 191, 36, 0.22)';
        for (let y = minY; y <= maxY; y++) {
          const row = y * MAP_W;
          for (let x = minX; x <= maxX; x++) {
            const idx = row + x;
            if (!isLand[idx] || owners[idx] === pId) continue;

            const isAdjacent =
              (x > 0 && owners[idx - 1] === pId) ||
              (x < MAP_W - 1 && owners[idx + 1] === pId) ||
              (y > 0 && owners[idx - MAP_W] === pId) ||
              (y < MAP_H - 1 && owners[idx + MAP_W] === pId);

            if (isAdjacent) {
              const sx = x * scale;
              const sy = y * scale;
              ctx.fillRect(sx, sy, Math.max(1, scale), Math.max(1, scale));
            }
          }
        }
      }
    }

    // 5. Draw World City Metropolises (Landmark Pins, Icons & Conquest Badges)
    if (this.worldData.cities && scale > 0.75) {
      for (const city of this.worldData.cities) {
        const cx = city.x * scale;
        const cy = city.y * scale;

        // Skip cities offscreen
        if (cx + originX < -60 || cx + originX > viewW + 60 || cy + originY < -60 || cy + originY > viewH + 60) {
          continue;
        }

        // Check if a player controls this city
        let cityOwner = null;
        for (const p of engine.players) {
          if (p.conqueredCities?.includes(city.id)) {
            cityOwner = p;
            break;
          }
        }

        const isMetropolis = city.tier === 'METROPOLIS';
        const pulse = isMetropolis ? 1 + Math.sin(timeSec * 3 + city.x) * 0.08 : 1;

        // City aura circle
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, (city.radius || 3) * scale, 0, Math.PI * 2);
        if (cityOwner) {
          ctx.fillStyle = `${cityOwner.color}33`;
          ctx.strokeStyle = cityOwner.color;
        } else {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        }
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        // Pin Landmark Icon & City Name Badge
        const pinSize = Math.max(10, Math.min(18, 5 * scale * pulse));
        ctx.save();
        ctx.translate(cx, cy);

        // Marker pill
        ctx.font = `${Math.round(pinSize * 0.85)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(city.icon || '🏛️', 0, -pinSize * 0.6);

        // Name label if zoomed in enough
        if (scale > 1.4 || isMetropolis) {
          const fontSize = Math.max(9, Math.min(13, 3.2 * scale));
          ctx.font = `800 ${Math.round(fontSize)}px Inter, system-ui, sans-serif`;
          const label = cityOwner ? `👑 ${city.name}` : city.name;
          const textW = ctx.measureText(label).width + 8;
          const textH = fontSize + 4;

          ctx.fillStyle = cityOwner ? 'rgba(15, 23, 42, 0.9)' : 'rgba(15, 23, 42, 0.75)';
          ctx.strokeStyle = cityOwner ? cityOwner.color : 'rgba(255, 255, 255, 0.3)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(-textW / 2, pinSize * 0.2, textW, textH, 4);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = cityOwner ? '#fef08a' : '#f8fafc';
          ctx.fillText(label, 0, pinSize * 0.2 + textH / 2);
        }

        ctx.restore();
      }
    }

    // 6. Draw Sailing Naval Fleets
    for (const fl of engine.fleets) {
      const owner = engine.players.find((p) => p.id === fl.playerId);
      const sx = fl.x * scale;
      const sy = fl.y * scale;

      // Dashed route
      if (fl.path && fl.step < fl.path.length) {
        ctx.save();
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        for (let w = fl.step; w < fl.path.length; w += 2) {
          ctx.lineTo(fl.path[w].x * scale, fl.path[w].y * scale);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Ship icon
      ctx.save();
      ctx.translate(sx, sy);
      ctx.font = `${Math.max(14, Math.min(24, 7 * scale))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⛵', 0, 0);

      // Troop count badge
      const tLabel = `${fl.troops} Asker`;
      ctx.font = '800 10px Inter, sans-serif';
      const tw = ctx.measureText(tLabel).width + 6;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
      ctx.roundRect(-tw / 2, -18, tw, 13, 3);
      ctx.fill();
      ctx.fillStyle = '#fde68a';
      ctx.fillText(tLabel, 0, -11);
      ctx.restore();
    }

    // 7. Interactive Hover Cursor / Reticle
    if (hoveredMapPos) {
      const hx = Math.floor(hoveredMapPos.x) * scale;
      const hy = Math.floor(hoveredMapPos.y) * scale;
      const hIdx = Math.floor(hoveredMapPos.y) * MAP_W + Math.floor(hoveredMapPos.x);

      if (phase === 'SPAWN') {
        const validLand = this.worldData.isLand[hIdx] === 1;
        ctx.save();
        ctx.beginPath();
        ctx.arc(hx + scale / 2, hy + scale / 2, Math.max(10, 4 * scale), 0, Math.PI * 2);
        ctx.strokeStyle = validLand ? '#fbbf24' : '#ef4444';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.fillStyle = validLand ? 'rgba(251, 191, 36, 0.25)' : 'rgba(239, 68, 68, 0.25)';
        ctx.fill();

        ctx.font = '900 12px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = validLand ? '#fef08a' : '#fca5a5';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 3;
        const msg = validLand ? '★ Buraya Başkent Kur' : 'Denize Kurulamaz!';
        ctx.strokeText(msg, hx, hy - 14);
        ctx.fillText(msg, hx, hy - 14);
        ctx.restore();
      } else if (phase === 'PLAYING') {
        const cellSz = Math.max(2, scale);
        ctx.save();
        ctx.strokeStyle = placingMode === 'WALL' ? '#94a3b8' : placingMode === 'NAVAL' ? '#38bdf8' : '#fbbf24';
        ctx.lineWidth = 2;
        ctx.strokeRect(hx, hy, cellSz, cellSz);
        ctx.restore();
      }
    }

    ctx.restore();

    return { scale, originX, originY, mapScreenW, mapScreenH };
  }
}
