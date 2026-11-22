// High-DPI 60 FPS Cartographic Renderer for Massive Minimalist Grey Earth Map
// Mobile-Optimized: Bounding-box O(k) Path2D construction (0ms rebuilds, zero 500k full-map scans, zero shadowBlur lag)

import { MAP_W, MAP_H } from './worldRasterizer';

export class WorldMapRenderer {
  constructor(worldData) {
    this.worldData = worldData;

    // Offscreen 1000x500 buffer canvas for the base Grey Earth map (drawn once at startup)
    this.baseCanvas = document.createElement('canvas');
    this.baseCanvas.width = MAP_W;
    this.baseCanvas.height = MAP_H;
    this.baseCtx = this.baseCanvas.getContext('2d');
    const imgData = this.baseCtx.createImageData(MAP_W, MAP_H);
    imgData.data.set(worldData.baseMapRgba);
    this.baseCtx.putImageData(imgData, 0, 0);

    // Image cache for HTMLImageElements
    this.imgCache = new Map();

    // Cached per-country Path2D in map coordinates
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

  // Ultra-fast O(bounding_box) Path2D rebuild — only scans each country's bounding box instead of 500,000 Earth pixels!
  rebuildTerritoryGeometry(engine) {
    const owners = engine.owners;
    const bounds = engine.countryBounds || engine.computeCountryBounds();
    this.countryPaths.clear();

    for (const c of engine.countries) {
      if (c.landCount <= 0) continue;
      const b = bounds.get(c.id);
      if (!b || b.count === 0 || b.maxX < b.minX) continue;

      const fp = new Path2D();
      const bp = new Path2D();
      const cid = c.id;

      const minY = Math.max(0, b.minY);
      const maxY = Math.min(MAP_H - 1, b.maxY);
      const minX = Math.max(0, b.minX);
      const maxX = Math.min(MAP_W - 1, b.maxX);

      for (let y = minY; y <= maxY; y++) {
        const row = y * MAP_W;
        let x = minX;
        while (x <= maxX) {
          if (owners[row + x] !== cid) {
            x++;
            continue;
          }

          let runEnd = x + 1;
          while (runEnd <= maxX && owners[row + runEnd] === cid) {
            runEnd++;
          }

          fp.rect(x, y, runEnd - x, 1);

          for (let px = x; px < runEnd; px++) {
            const idx = row + px;
            if (y === 0 || owners[idx - MAP_W] !== cid) {
              bp.moveTo(px, y);
              bp.lineTo(px + 1, y);
            }
            if (y === MAP_H - 1 || owners[idx + MAP_W] !== cid) {
              bp.moveTo(px, y + 1);
              bp.lineTo(px + 1, y + 1);
            }
            if (px === 0 || owners[idx - 1] !== cid) {
              bp.moveTo(px, y);
              bp.lineTo(px, y + 1);
            }
            if (px === MAP_W - 1 || owners[idx + 1] !== cid) {
              bp.moveTo(px + 1, y);
              bp.lineTo(px + 1, y + 1);
            }
          }

          x = runEnd;
        }
      }

      this.countryPaths.set(cid, {
        fillPath: fp,
        borderPath: bp,
      });
    }
  }

  // Draw 60 FPS viewport frame
  renderFrame(ctx, viewW, viewH, camera, engine, uiState = {}) {
    const { hoveredMapPos = null, timeSec = 0 } = uiState;

    if (engine.dirtyRegions) {
      engine.computeCountryBounds();
    }
    if (engine.dirtyPixels) {
      this.rebuildTerritoryGeometry(engine);
      engine.dirtyPixels = false;
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

    // 3. Render Each Country's Uploaded Image Directly Inside Its Exact Territory Pixels
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

      const img = this.getOrLoadImage(country.flagDataUrl, () => {
        engine.dirtyPixels = true;
      });

      ctx.save();
      ctx.clip(paths.fillPath);

      if (img) {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(img, b.minX, b.minY, bw, bh);
      } else {
        ctx.fillStyle = country.color || '#E11D48';
        ctx.fillRect(b.minX, b.minY, bw, bh);
      }
      ctx.restore();

      // Crisp territory perimeter border (zero shadowBlur for 60 FPS mobile speed)
      const isMe = country.id === engine.myCountryId;
      const borderColor = country.color || (isMe ? '#FBBF24' : '#FFFFFF');
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = Math.max(0.14, (isMe ? 2.2 : 1.6) / scale);
      ctx.stroke(paths.borderPath);
    }

    ctx.restore();

    // 4. Subtle cartographic frame border
    ctx.strokeStyle = 'rgba(71, 85, 105, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, mapScreenW, mapScreenH);

    const myCountry = engine.getMyCountry();

    // 5. Fast O(bounding_box) Frontier Highlight (Only scans player's own country bounding box + 1px margin!)
    if (myCountry && myCountry.troops >= 1.0 && scale >= 2.0) {
      const myB = bounds.get(myCountry.id);
      if (myB && myB.count > 0 && myB.maxX - myB.minX < 180) {
        const owners = engine.owners;
        const isLand = this.worldData.isLand;
        const myId = myCountry.id;

        const minX = Math.max(0, myB.minX - 1);
        const maxX = Math.min(MAP_W - 1, myB.maxX + 1);
        const minY = Math.max(0, myB.minY - 1);
        const maxY = Math.min(MAP_H - 1, myB.maxY + 1);

        ctx.fillStyle = 'rgba(251, 191, 36, 0.18)';
        for (let y = minY; y <= maxY; y++) {
          const row = y * MAP_W;
          for (let x = minX; x <= maxX; x++) {
            const idx = row + x;
            if (!isLand[idx] || owners[idx] === myId) continue;

            if (
              (x > 0 && owners[idx - 1] === myId) ||
              (x < MAP_W - 1 && owners[idx + 1] === myId) ||
              (y > 0 && owners[idx - MAP_W] === myId) ||
              (y < MAP_H - 1 && owners[idx + MAP_W] === myId)
            ) {
              ctx.fillRect(x * scale, y * scale, scale, scale);
            }
          }
        }
      }
    }

    // 6. Render Active Naval Ships Sailing Across Seas/Oceans
    if (Array.isArray(engine.ships) && engine.ships.length > 0) {
      for (const ship of engine.ships) {
        const fromSx = (ship.fromX + 0.5) * scale;
        const fromSy = (ship.fromY + 0.5) * scale;
        const toSx = (ship.toX + 0.5) * scale;
        const toSy = (ship.toY + 0.5) * scale;
        const curSx = (ship.x + 0.5) * scale;
        const curSy = (ship.y + 0.5) * scale;

        ctx.save();
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(fromSx, fromSy);
        ctx.lineTo(toSx, toSy);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = 'rgba(186, 230, 253, 0.75)';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(fromSx, fromSy);
        ctx.lineTo(curSx, curSy);
        ctx.stroke();

        const sz = Math.max(9, Math.min(18, scale * 2.2));
        ctx.translate(curSx, curSy);

        ctx.beginPath();
        ctx.arc(0, 0, sz * 0.85, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(8, 47, 73, 0.85)';
        ctx.fill();
        ctx.strokeStyle = ship.color || '#38BDF8';
        ctx.lineWidth = 1.6;
        ctx.stroke();

        ctx.fillStyle = ship.color || '#38BDF8';
        ctx.beginPath();
        ctx.moveTo(-sz * 0.55, sz * 0.15);
        ctx.lineTo(sz * 0.55, sz * 0.15);
        ctx.lineTo(sz * 0.35, sz * 0.48);
        ctx.lineTo(-sz * 0.35, sz * 0.48);
        ctx.closePath();
        ctx.fill();

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

    // 7. Clean, Non-Intrusive Country Name Label (Positioned ABOVE the country's top boundary)
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
      if (scale < 1.3 && !isMe) continue;

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

      const pillBorderColor = country.color || (isMe ? '#FBBF24' : 'rgba(255, 255, 255, 0.35)');
      ctx.fillStyle = 'rgba(9, 13, 22, 0.90)';
      ctx.strokeStyle = pillBorderColor;
      ctx.lineWidth = isMe ? 1.8 : 1.3;
      ctx.beginPath();
      ctx.roundRect(pillX, labelY, tw, th, 6);
      ctx.fill();
      ctx.stroke();

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

    // 8. Crisp Hover Reticle on Target Pixel
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
