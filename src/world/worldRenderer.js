// High-DPI 60 FPS Cartographic Renderer for Massive Minimalist Grey Earth Map
// Seamless custom picture mapping on territory + full image avatar badge even at 1 pixel
// Clean grey continents, deep dark oceans, zero city clutter

import { MAP_W, MAP_H } from './worldRasterizer';
import { FLAG_W, FLAG_H } from './flagLibrary';

export class WorldMapRenderer {
  constructor(worldData) {
    this.worldData = worldData;

    // Offscreen 1000x500 buffer canvas
    this.bufferCanvas = document.createElement('canvas');
    this.bufferCanvas.width = MAP_W;
    this.bufferCanvas.height = MAP_H;
    this.bufferCtx = this.bufferCanvas.getContext('2d', { willReadFrequently: true });
    this.imageData = this.bufferCtx.createImageData(MAP_W, MAP_H);

    // Initialize with sleek grey Earth map
    this.imageData.data.set(worldData.baseMapRgba);
    this.bufferCtx.putImageData(this.imageData, 0, 0);

    // Image cache for HTMLImageElements to draw crisp avatar pins on canvas
    this.imgCache = new Map(); // dataUrl -> HTMLImageElement
  }

  getOrLoadImage(dataUrl) {
    if (!dataUrl) return null;
    let img = this.imgCache.get(dataUrl);
    if (!img) {
      img = new Image();
      img.src = dataUrl;
      this.imgCache.set(dataUrl, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  // Composite custom country images onto the offscreen grey Earth buffer
  updateTerritoryBuffer(engine) {
    const dst = this.imageData.data;
    const base = this.worldData.baseMapRgba;
    const owners = engine.owners;

    // 1. Reset to clean grey Earth
    dst.set(base);

    // 2. Compute country bounding boxes for full-picture UV mapping
    const bounds = engine.computeCountryBounds();

    for (let y = 0; y < MAP_H; y++) {
      const row = y * MAP_W;
      for (let x = 0; x < MAP_W; x++) {
        const idx = row + x;
        const o = owners[idx];
        if (o <= 0) continue;

        const country = engine.countryMap.get(o);
        if (!country) continue;

        const p4 = idx * 4;
        const b = bounds.get(o);
        const bw = b && b.maxX >= b.minX ? Math.max(1, b.maxX - b.minX + 1) : 1;
        const bh = b && b.maxY >= b.minY ? Math.max(1, b.maxY - b.minY + 1) : 1;

        let r = 220, g = 38, bCol = 38;

        if (country.flagRgba && b) {
          // Normalize (x, y) relative to country's total bounding box
          // This ensures the ENTIRE uploaded image is visible across the country!
          let u = (x - b.minX) / bw;
          let v = (y - b.minY) / bh;
          if (u < 0) u = 0; else if (u > 0.999) u = 0.999;
          if (v < 0) v = 0; else if (v > 0.999) v = 0.999;

          const fx = (u * FLAG_W) | 0;
          const fy = (v * FLAG_H) | 0;
          const fp = (fy * FLAG_W + fx) * 4;

          r = country.flagRgba[fp];
          g = country.flagRgba[fp + 1];
          bCol = country.flagRgba[fp + 2];
        }

        // Crisp 1px perimeter border outline for country
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
          // Highlight border with bright nation outline
          if (country.id === engine.myCountryId) {
            r = Math.min(255, r * 0.4 + 220);
            g = Math.min(255, g * 0.4 + 180);
            bCol = Math.min(255, bCol * 0.4 + 40);
          } else {
            r = Math.max(0, r * 0.5);
            g = Math.max(0, g * 0.5);
            bCol = Math.max(0, bCol * 0.5);
          }
        }

        dst[p4] = r;
        dst[p4 + 1] = g;
        dst[p4 + 2] = bCol;
        dst[p4 + 3] = 255;
      }
    }

    this.bufferCtx.putImageData(this.imageData, 0, 0);
  }

  // Draw 60 FPS viewport frame
  renderFrame(ctx, viewW, viewH, camera, engine, uiState = {}) {
    const { hoveredMapPos = null, timeSec = 0 } = uiState;

    if (engine.dirtyRegions) {
      engine.computeCountryBounds();
    }
    if (engine.dirtyPixels) {
      this.updateTerritoryBuffer(engine);
      engine.dirtyPixels = false;
    }

    // 1. Deep space/ocean background
    ctx.fillStyle = '#0a0e17';
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

    // 2. Render Grey Earth Map + Countries buffer
    ctx.imageSmoothingEnabled = scale < 2.5;
    ctx.drawImage(this.bufferCanvas, 0, 0, mapScreenW, mapScreenH);

    // 3. Subtle cartographic frame border
    ctx.strokeStyle = 'rgba(71, 85, 105, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0, 0, mapScreenW, mapScreenH);

    const myCountry = engine.getMyCountry();

    // 4. Highlight frontier cells where player can legally conquer (glow effect)
    if (myCountry && myCountry.troops >= 1.0 && scale > 1.0) {
      const owners = engine.owners;
      const isLand = this.worldData.isLand;
      const myId = myCountry.id;

      const minX = Math.max(0, Math.floor(-camera.panX / scale));
      const maxX = Math.min(MAP_W - 1, Math.ceil((viewW - camera.panX) / scale));
      const minY = Math.max(0, Math.floor(-camera.panY / scale));
      const maxY = Math.min(MAP_H - 1, Math.ceil((viewH - camera.panY) / scale));

      ctx.fillStyle = 'rgba(251, 191, 36, 0.28)';
      for (let y = minY; y <= maxY; y++) {
        const row = y * MAP_W;
        for (let x = minX; x <= maxX; x++) {
          const idx = row + x;
          if (!isLand[idx] || owners[idx] === myId) continue;

          const isAdj =
            (x > 0 && owners[idx - 1] === myId) ||
            (x < MAP_W - 1 && owners[idx + 1] === myId) ||
            (y > 0 && owners[idx - MAP_W] === myId) ||
            (y < MAP_H - 1 && owners[idx + MAP_W] === myId);

          if (isAdj) {
            ctx.fillRect(x * scale, y * scale, Math.max(1, scale), Math.max(1, scale));
          }
        }
      }
    }

    // 5. Render Country Avatar Badges & Names (Guaranteeing image is ALWAYS visible even at 1 pixel!)
    const bounds = engine.countryBounds || engine.computeCountryBounds();

    for (const country of engine.countries) {
      if (country.landCount <= 0) continue;

      const b = bounds.get(country.id);
      let cx = country.capitalX;
      let cy = country.capitalY;
      if (b && b.count > 0) {
        cx = Math.round(b.sumX / b.count);
        cy = Math.round(b.sumY / b.count);
      }

      const sx = cx * scale;
      const sy = cy * scale;

      // Skip offscreen countries
      if (sx + originX < -80 || sx + originX > viewW + 80 || sy + originY < -80 || sy + originY > viewH + 80) {
        continue;
      }

      const isMe = country.id === engine.myCountryId;
      const badgeW = Math.max(22, Math.min(36, 7 * scale));
      const badgeH = Math.max(15, Math.min(24, 4.8 * scale));

      ctx.save();
      ctx.translate(sx, sy);

      // Outer glow for player's country
      if (isMe) {
        ctx.beginPath();
        ctx.arc(0, 0, badgeW * 0.7, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(251, 191, 36, 0.2)';
        ctx.fill();
      }

      // Draw country's complete uploaded image in an avatar badge
      const loadedImg = this.getOrLoadImage(country.flagDataUrl);
      if (loadedImg) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(-badgeW / 2, -badgeH / 2, badgeW, badgeH, 4);
        ctx.clip();
        ctx.drawImage(loadedImg, -badgeW / 2, -badgeH / 2, badgeW, badgeH);
        ctx.restore();
      } else {
        ctx.fillStyle = country.color || '#E11D48';
        ctx.beginPath();
        ctx.roundRect(-badgeW / 2, -badgeH / 2, badgeW, badgeH, 4);
        ctx.fill();
      }

      // Badge outline border
      ctx.strokeStyle = isMe ? '#FBBF24' : '#FFFFFF';
      ctx.lineWidth = isMe ? 2 : 1;
      ctx.beginPath();
      ctx.roundRect(-badgeW / 2, -badgeH / 2, badgeW, badgeH, 4);
      ctx.stroke();

      // Country Name & Troop Count Label
      if (scale > 1.2 || isMe) {
        const nameFontSize = Math.max(9, Math.min(13, 3.2 * scale));
        ctx.font = `900 ${Math.round(nameFontSize)}px Inter, sans-serif`;
        const label = `${country.name} (${Math.floor(country.troops)}/${country.capacity})`;
        const tw = ctx.measureText(label).width + 8;
        const th = nameFontSize + 4;

        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.strokeStyle = isMe ? '#FBBF24' : 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(-tw / 2, badgeH / 2 + 2, tw, th, 4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = isMe ? '#FEF08A' : '#F8FAFC';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, 0, badgeH / 2 + 2 + th / 2);
      }

      ctx.restore();
    }

    // 6. Interactive Hover Cursor & Founding Reticle
    if (hoveredMapPos) {
      const hx = Math.floor(hoveredMapPos.x) * scale;
      const hy = Math.floor(hoveredMapPos.y) * scale;
      const hIdx = Math.floor(hoveredMapPos.y) * MAP_W + Math.floor(hoveredMapPos.x);
      const isLand = this.worldData.isLand[hIdx] === 1;
      const cellOwner = engine.owners[hIdx];

      ctx.save();

      if (!myCountry) {
        // Player has no nation yet -> Show Founding Cursor
        if (isLand && cellOwner === 0) {
          const pulse = 1 + Math.sin(timeSec * 5) * 0.15;
          ctx.beginPath();
          ctx.arc(hx + scale / 2, hy + scale / 2, Math.max(12, 6 * scale) * pulse, 0, Math.PI * 2);
          ctx.strokeStyle = '#FBBF24';
          ctx.lineWidth = 2.5;
          ctx.stroke();
          ctx.fillStyle = 'rgba(251, 191, 36, 0.25)';
          ctx.fill();

          ctx.font = '900 12px Inter, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillStyle = '#FEF08A';
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 3;
          ctx.strokeText('★ Tıkla ve Devletini Kur', hx + scale / 2, hy - 14);
          ctx.fillText('★ Tıkla ve Devletini Kur', hx + scale / 2, hy - 14);
        }
      } else {
        // Player already has a country -> Show Conquest Reticle
        const check = engine.canExpandToPixel(myCountry.id, Math.floor(hoveredMapPos.x), Math.floor(hoveredMapPos.y));
        const cellSz = Math.max(2, scale);

        if (check.valid) {
          ctx.strokeStyle = check.isEnemy ? '#EF4444' : '#10B981';
          ctx.lineWidth = 2;
          ctx.strokeRect(hx, hy, cellSz, cellSz);

          if (scale > 2.0) {
            ctx.font = '800 11px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillStyle = check.isEnemy ? '#FCA5A5' : '#86EFAC';
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 3;
            const costStr = check.isEnemy ? '⚔️ Taarruz (2 Asker)' : '⚔️ Fethet (1 Asker)';
            ctx.strokeText(costStr, hx + cellSz / 2, hy - 8);
            ctx.fillText(costStr, hx + cellSz / 2, hy - 8);
          }
        } else {
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
          ctx.lineWidth = 1;
          ctx.strokeRect(hx, hy, cellSz, cellSz);
        }
      }

      ctx.restore();
    }

    ctx.restore();

    return { scale, originX, originY, mapScreenW, mapScreenH };
  }
}
