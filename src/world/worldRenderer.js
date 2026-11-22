// High-DPI 60 FPS Cartographic Renderer for Massive Minimalist Grey Earth Map
// Native screen-resolution image projection directly inside territory pixels (100% visible even at 1 pixel!)
// Zero floating sticker clutter, zero tacky emojis, razor-sharp borders

import { MAP_W, MAP_H } from './worldRasterizer';

export class WorldMapRenderer {
  constructor(worldData) {
    this.worldData = worldData;

    // Offscreen 1000x500 buffer canvas for the base Grey Earth map
    this.baseCanvas = document.createElement('canvas');
    this.baseCanvas.width = MAP_W;
    this.baseCanvas.height = MAP_H;
    this.baseCtx = this.baseCanvas.getContext('2d');
    const imgData = this.baseCtx.createImageData(MAP_W, MAP_H);
    imgData.data.set(worldData.baseMapRgba);
    this.baseCtx.putImageData(imgData, 0, 0);

    // Offscreen buffer for distant zoom (< 2.5x) fast pixel rendering
    this.farCanvas = document.createElement('canvas');
    this.farCanvas.width = MAP_W;
    this.farCanvas.height = MAP_H;
    this.farCtx = this.farCanvas.getContext('2d');
    this.farImageData = this.farCtx.createImageData(MAP_W, MAP_H);

    // Image cache for HTMLImageElements
    this.imgCache = new Map();

    // Cached per-country pixel lists & Path2D in map coordinates (1 unit = 1 map pixel)
    this.countryPaths = new Map(); // countryId -> { fillPath: Path2D, borderPath: Path2D }
  }

  getOrLoadImage(dataUrl, onLoadCallback) {
    if (!dataUrl) return null;
    let img = this.imgCache.get(dataUrl);
    if (!img) {
      img = new Image();
      if (onLoadCallback) {
        img.onload = onLoadCallback;
      }
      img.src = dataUrl;
      this.imgCache.set(dataUrl, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  // Rebuild vector Path2D in map-pixel space for each country so images render at full screen DPI!
  rebuildTerritoryGeometry(engine) {
    const owners = engine.owners;
    const dst = this.farImageData.data;
    dst.set(this.worldData.baseMapRgba);

    engine.computeCountryBounds();
    this.countryPaths.clear();

    // Group horizontal spans per country for ultra-fast Path2D construction
    const fillPaths = new Map();
    const borderPaths = new Map();

    for (const c of engine.countries) {
      if (c.landCount > 0) {
        fillPaths.set(c.id, new Path2D());
        borderPaths.set(c.id, new Path2D());
      }
    }

    for (let y = 0; y < MAP_H; y++) {
      const row = y * MAP_W;
      let x = 0;
      while (x < MAP_W) {
        const o = owners[row + x];
        if (o <= 0) {
          x++;
          continue;
        }

        // Find horizontal run of same owner
        let runEnd = x + 1;
        while (runEnd < MAP_W && owners[row + runEnd] === o) {
          runEnd++;
        }

        const fp = fillPaths.get(o);
        if (fp) {
          fp.rect(x, y, runEnd - x, 1);
        }

        const bp = borderPaths.get(o);
        const country = engine.countryMap.get(o);

        // Process per-pixel border edges & far-zoom fallback buffer
        for (let px = x; px < runEnd; px++) {
          const idx = row + px;
          const p4 = idx * 4;

          if (country) {
            // Solid fallback color for macro zoom
            dst[p4] = 225;
            dst[p4 + 1] = 29;
            dst[p4 + 2] = 72;
            dst[p4 + 3] = 255;
          }

          if (bp) {
            // Top edge
            if (y === 0 || owners[idx - MAP_W] !== o) {
              bp.moveTo(px, y);
              bp.lineTo(px + 1, y);
            }
            // Bottom edge
            if (y === MAP_H - 1 || owners[idx + MAP_W] !== o) {
              bp.moveTo(px, y + 1);
              bp.lineTo(px + 1, y + 1);
            }
            // Left edge
            if (px === 0 || owners[idx - 1] !== o) {
              bp.moveTo(px, y);
              bp.lineTo(px, y + 1);
            }
            // Right edge
            if (px === MAP_W - 1 || owners[idx + 1] !== o) {
              bp.moveTo(px + 1, y);
              bp.lineTo(px + 1, y + 1);
            }
          }
        }

        x = runEnd;
      }
    }

    for (const c of engine.countries) {
      if (c.landCount > 0) {
        this.countryPaths.set(c.id, {
          fillPath: fillPaths.get(c.id),
          borderPath: borderPaths.get(c.id),
        });
      }
    }

    this.farCtx.putImageData(this.farImageData, 0, 0);
  }

  // Draw 60 FPS viewport frame
  renderFrame(ctx, viewW, viewH, camera, engine, uiState = {}) {
    const { hoveredMapPos = null, timeSec = 0 } = uiState;

    if (engine.dirtyRegions || engine.dirtyPixels) {
      this.rebuildTerritoryGeometry(engine);
      engine.dirtyPixels = false;
      engine.dirtyRegions = false;
    }

    // 1. Deep ocean background
    ctx.fillStyle = '#090d16';
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

    // 2. Render crisp Grey Earth base map
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.baseCanvas, 0, 0, mapScreenW, mapScreenH);

    // 3. Render Each Country's Uploaded Image Directly Inside Its Exact Territory Pixels at Full Screen Resolution!
    const bounds = engine.countryBounds || engine.computeCountryBounds();

    ctx.save();
    ctx.scale(scale, scale);

    for (const country of engine.countries) {
      if (country.landCount <= 0) continue;
      const paths = this.countryPaths.get(country.id);
      const b = bounds.get(country.id);
      if (!paths || !b || b.count === 0) continue;

      const bw = Math.max(1, b.maxX - b.minX + 1);
      const bh = Math.max(1, b.maxY - b.minY + 1);

      // Draw full uploaded image clipped to the exact pixel silhouette of the country
      const img = this.getOrLoadImage(country.flagDataUrl, () => {
        engine.dirtyPixels = true;
      });

      ctx.save();
      ctx.clip(paths.fillPath);

      if (img) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, b.minX, b.minY, bw, bh);
      } else {
        ctx.fillStyle = country.color || '#E11D48';
        ctx.fillRect(b.minX, b.minY, bw, bh);
      }
      ctx.restore();

      // Crisp territory perimeter border using the country's chosen border color!
      const isMe = country.id === engine.myCountryId;
      const borderColor = country.color || (isMe ? '#FBBF24' : '#FFFFFF');
      ctx.save();
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = Math.max(0.12, (isMe ? 2.4 : 1.8) / scale);
      ctx.shadowColor = borderColor;
      ctx.shadowBlur = isMe ? 6 : 3;
      ctx.stroke(paths.borderPath);
      ctx.restore();
    }

    ctx.restore();

    // 4. Subtle cartographic frame border
    ctx.strokeStyle = 'rgba(71, 85, 105, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, mapScreenW, mapScreenH);

    const myCountry = engine.getMyCountry();

    // 5. Subtle frontier highlight only when player has >= 1 full soldier ready to conquer
    if (myCountry && myCountry.troops >= 1.0 && scale >= 2.0) {
      const owners = engine.owners;
      const isLand = this.worldData.isLand;
      const myId = myCountry.id;

      const minX = Math.max(0, Math.floor(-originX / scale));
      const maxX = Math.min(MAP_W - 1, Math.ceil((viewW - originX) / scale));
      const minY = Math.max(0, Math.floor(-originY / scale));
      const maxY = Math.min(MAP_H - 1, Math.ceil((viewH - originY) / scale));

      ctx.fillStyle = 'rgba(251, 191, 36, 0.16)';
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
            ctx.fillRect(x * scale, y * scale, scale, scale);
          }
        }
      }
    }

    // 6. Render Active Naval Ships Sailing Across Seas/Oceans (Vector Warship & Wake Trail)
    if (Array.isArray(engine.ships) && engine.ships.length > 0) {
      for (const ship of engine.ships) {
        const fromSx = (ship.fromX + 0.5) * scale;
        const fromSy = (ship.fromY + 0.5) * scale;
        const toSx = (ship.toX + 0.5) * scale;
        const toSy = (ship.toY + 0.5) * scale;
        const curSx = (ship.x + 0.5) * scale;
        const curSy = (ship.y + 0.5) * scale;

        ctx.save();
        // Dashed sea route line
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(fromSx, fromSy);
        ctx.lineTo(toSx, toSy);
        ctx.stroke();
        ctx.setLineDash([]);

        // Wake trail behind ship
        ctx.strokeStyle = 'rgba(186, 230, 253, 0.75)';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(fromSx, fromSy);
        ctx.lineTo(curSx, curSy);
        ctx.stroke();

        // Vector Warship Icon
        const sz = Math.max(9, Math.min(18, scale * 2.2));
        ctx.translate(curSx, curSy);

        // Outer beacon ring
        ctx.beginPath();
        ctx.arc(0, 0, sz * 0.85, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(8, 47, 73, 0.85)';
        ctx.fill();
        ctx.strokeStyle = ship.color || '#38BDF8';
        ctx.lineWidth = 1.6;
        ctx.stroke();

        // Ship Hull
        ctx.fillStyle = ship.color || '#38BDF8';
        ctx.beginPath();
        ctx.moveTo(-sz * 0.55, sz * 0.15);
        ctx.lineTo(sz * 0.55, sz * 0.15);
        ctx.lineTo(sz * 0.35, sz * 0.48);
        ctx.lineTo(-sz * 0.35, sz * 0.48);
        ctx.closePath();
        ctx.fill();

        // Ship Sails
        ctx.fillStyle = '#F8FAFC';
        ctx.beginPath();
        ctx.moveTo(0, -sz * 0.52);
        ctx.lineTo(sz * 0.45, sz * 0.08);
        ctx.lineTo(0, sz * 0.08);
        ctx.closePath();
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(-sz * 0.06, -sz * 0.38);
        ctx.lineTo(-sz * 0.42, sz * 0.08);
        ctx.lineTo(-sz * 0.06, sz * 0.08);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
      }
    }

    // 7. Clean, Non-Intrusive Country Name Label (Positioned ABOVE the country's top boundary so it never covers the pixels!)
    for (const country of engine.countries) {
      if (country.landCount <= 0) continue;
      const b = bounds.get(country.id);
      if (!b || b.count === 0) continue;

      const centerX = ((b.minX + b.maxX + 1) / 2) * scale;
      const topY = b.minY * scale;

      if (
        centerX + originX < -100 ||
        centerX + originX > viewW + 100 ||
        topY + originY < -60 ||
        topY + originY > viewH + 60
      ) {
        continue;
      }

      const isMe = country.id === engine.myCountryId;
      if (scale < 1.4 && !isMe) continue;

      ctx.save();
      const fontSize = Math.max(10, Math.min(13, 2.2 * Math.sqrt(scale) + 7));
      ctx.font = `800 ${Math.round(fontSize)}px Inter, system-ui, sans-serif`;
      const label = `${country.name} (${Math.floor(country.troops)})`;
      const flagThumbW = 16;
      const flagThumbH = 11;
      const textW = ctx.measureText(label).width;
      const tw = textW + flagThumbW + 16;
      const th = Math.max(flagThumbH + 6, fontSize + 7);
      const labelY = topY - th - 5;
      const pillX = centerX - tw / 2;

      // Subtle pill above territory with country's chosen border color
      const pillBorderColor = country.color || (isMe ? '#FBBF24' : 'rgba(255, 255, 255, 0.35)');
      ctx.fillStyle = 'rgba(9, 13, 22, 0.90)';
      ctx.strokeStyle = pillBorderColor;
      ctx.lineWidth = isMe ? 1.8 : 1.3;
      ctx.beginPath();
      ctx.roundRect(pillX, labelY, tw, th, 6);
      ctx.fill();
      ctx.stroke();

      // Full uploaded flag thumbnail inside the pill so it's 100% visible even at 1 pixel from any zoom
      const img = this.getOrLoadImage(country.flagDataUrl);
      const thumbX = pillX + 5;
      const thumbY = labelY + (th - flagThumbH) / 2;
      if (img) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(thumbX, thumbY, flagThumbW, flagThumbH, 2);
        ctx.clip();
        ctx.drawImage(img, thumbX, thumbY, flagThumbW, flagThumbH);
        ctx.restore();
      } else {
        ctx.fillStyle = country.color || '#E11D48';
        ctx.fillRect(thumbX, thumbY, flagThumbW, flagThumbH);
      }

      ctx.fillStyle = isMe ? '#FDE68A' : '#F1F5F9';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, thumbX + flagThumbW + 5, labelY + th / 2);
      ctx.restore();
    }

    // 7. Crisp Hover Reticle on Target Pixel
    if (hoveredMapPos) {
      const mx = Math.floor(hoveredMapPos.x);
      const my = Math.floor(hoveredMapPos.y);
      if (mx >= 0 && mx < MAP_W && my >= 0 && my < MAP_H) {
        const hx = mx * scale;
        const hy = my * scale;
        const hIdx = my * MAP_W + mx;
        const isLand = this.worldData.isLand[hIdx] === 1;
        const cellOwner = engine.owners[hIdx];

        ctx.save();
        if (!myCountry) {
          if (isLand && cellOwner === 0) {
            const pulse = 1 + Math.sin(timeSec * 5) * 0.12;
            ctx.strokeStyle = '#FBBF24';
            ctx.lineWidth = 2;
            ctx.strokeRect(hx, hy, Math.max(2, scale), Math.max(2, scale));

            ctx.beginPath();
            ctx.arc(hx + scale / 2, hy + scale / 2, Math.max(10, 3 * scale) * pulse, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(251, 191, 36, 0.7)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        } else {
          const check = engine.canExpandToPixel(myCountry.id, mx, my);
          const cellSz = Math.max(1.5, scale);
          if (check.valid) {
            if (check.isNaval) {
              // Draw dashed sea expedition route preview from nearest port to target coast
              const pSx = (check.portX + 0.5) * scale;
              const pSy = (check.portY + 0.5) * scale;
              const tSx = hx + cellSz / 2;
              const tSy = hy + cellSz / 2;
              ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
              ctx.lineWidth = 1.6;
              ctx.setLineDash([5, 4]);
              ctx.beginPath();
              ctx.moveTo(pSx, pSy);
              ctx.lineTo(tSx, tSy);
              ctx.stroke();
              ctx.setLineDash([]);

              ctx.strokeStyle = '#38BDF8';
              ctx.lineWidth = 2;
              ctx.strokeRect(hx, hy, cellSz, cellSz);
            } else {
              ctx.strokeStyle = check.isEnemy ? '#F43F5E' : '#10B981';
              ctx.lineWidth = 1.8;
              ctx.strokeRect(hx, hy, cellSz, cellSz);
            }
          } else if (isLand) {
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
            ctx.lineWidth = 1;
            ctx.strokeRect(hx, hy, cellSz, cellSz);
          }
        }
        ctx.restore();
      }
    }

    ctx.restore();

    return { scale, originX, originY, mapScreenW, mapScreenH };
  }
}
