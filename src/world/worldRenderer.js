// High-DPI 60 FPS Cartographic Renderer for Massive Minimalist Grey Earth Map
// Ultra-Fast Mobile Edition: Zero per-frame Path2D clip/stroke tessellation!
// Territories are composited onto offscreen bufferCanvas ONLY when a pixel changes; panning & zooming is 1 single drawImage call (60 FPS on all phones)

import { MAP_W, MAP_H } from "./worldRasterizer";
import { FLAG_W, FLAG_H } from "./flagLibrary";

export class WorldMapRenderer {
  constructor(worldData) {
    this.worldData = worldData;

    // Offscreen 1000x500 buffer canvas (holds Grey Earth + all painted country territories)
    this.bufferCanvas = document.createElement("canvas");
    this.bufferCanvas.width = MAP_W;
    this.bufferCanvas.height = MAP_H;
    this.bufferCtx = this.bufferCanvas.getContext("2d");
    this.imageData = this.bufferCtx.createImageData(MAP_W, MAP_H);
    this.imageData.data.set(worldData.baseMapRgba);
    this.bufferCtx.putImageData(this.imageData, 0, 0);

    // Image cache for HTMLImageElements
    this.imgCache = new Map();
  }

  getBaseScale(viewW, viewH) {
    // On portrait mobile screens, prevent the map from shrinking into a tiny 180px horizontal ribbon
    return Math.max(viewW / MAP_W, (viewH * 0.68) / MAP_H);
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

  _hexToRgb(hex) {
    if (!hex || typeof hex !== "string") return [251, 191, 36];
    const clean = hex.replace("#", "");
    if (clean.length === 6) {
      const num = parseInt(clean, 16);
      if (!Number.isNaN(num)) {
        return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
      }
    }
    return [251, 191, 36];
  }

  // Fast offscreen buffer update: only updates country bounding boxes when a pixel is conquered!
  updateTerritoryBuffer(engine) {
    const dst = this.imageData.data;
    const base = this.worldData.baseMapRgba;
    const owners = engine.owners;
    const bounds = engine.countryBounds || engine.computeCountryBounds();

    // Reset base grey map
    dst.set(base);

    for (const country of engine.countries) {
      if (country.landCount <= 0) continue;
      const cid = country.id;
      const b = bounds.get(cid);
      if (!b || b.count === 0 || b.maxX < b.minX) continue;

      const minX = Math.max(0, b.minX);
      const maxX = Math.min(MAP_W - 1, b.maxX);
      const minY = Math.max(0, b.minY);
      const maxY = Math.min(MAP_H - 1, b.maxY);
      const bw = Math.max(1, maxX - minX + 1);
      const bh = Math.max(1, maxY - minY + 1);

      const [br, bg, bb] = this._hexToRgb(country.color);
      const flagRgba = country.flagRgba;

      for (let y = minY; y <= maxY; y++) {
        const row = y * MAP_W;
        for (let x = minX; x <= maxX; x++) {
          const idx = row + x;
          if (owners[idx] !== cid) continue;

          const p4 = idx * 4;
          const isBorder =
            x === 0 ||
            x === MAP_W - 1 ||
            y === 0 ||
            y === MAP_H - 1 ||
            owners[idx - 1] !== cid ||
            owners[idx + 1] !== cid ||
            owners[idx - MAP_W] !== cid ||
            owners[idx + MAP_W] !== cid;

          if (isBorder && bw > 2 && bh > 2) {
            dst[p4] = br;
            dst[p4 + 1] = bg;
            dst[p4 + 2] = bb;
            dst[p4 + 3] = 255;
          } else if (flagRgba && bw <= 28 && bh <= 20) {
            // For smaller/starter territory, fit the flag pattern cleanly
            const flagAspect = FLAG_W / FLAG_H;
            const boxAspect = bw / bh;
            let normU = (x - minX + 0.5) / bw;
            let normV = (y - minY + 0.5) / bh;
            if (boxAspect > flagAspect) {
              const scaleFactor = boxAspect / flagAspect;
              normU = (normU - 0.5) * scaleFactor + 0.5;
            } else {
              const scaleFactor = flagAspect / boxAspect;
              normV = (normV - 0.5) * scaleFactor + 0.5;
            }
            normU = Math.max(0, Math.min(0.999, normU));
            normV = Math.max(0, Math.min(0.999, normV));
            const fx = (normU * FLAG_W) | 0;
            const fy = (normV * FLAG_H) | 0;

            const fp = (fy * FLAG_W + fx) * 4;
            dst[p4] = (flagRgba[fp] * 0.85 + br * 0.15) | 0;
            dst[p4 + 1] = (flagRgba[fp + 1] * 0.85 + bg * 0.15) | 0;
            dst[p4 + 2] = (flagRgba[fp + 2] * 0.85 + bb * 0.15) | 0;
            dst[p4 + 3] = 255;
          } else {
            // Large/expanding empire territory: Clean, solid, beautiful national territory color
            // (The high-resolution crisp emblem banner is prominently rendered at the capital/core!)
            dst[p4] = (br * 0.90) | 0;
            dst[p4 + 1] = (bg * 0.90) | 0;
            dst[p4 + 2] = (bb * 0.90) | 0;
            dst[p4 + 3] = 255;
          }
        }
      }
    }

    this.bufferCtx.putImageData(this.imageData, 0, 0);
  }

  // Draw 60 FPS viewport frame (Zero Path2D clipping during pan/zoom!)
  renderFrame(ctx, viewW, viewH, camera, engine) {
    if (!ctx || !engine) return null;

    // Sanitize camera to prevent any NaN poisoning that causes black screen
    if (!camera || !Number.isFinite(camera.zoom) || camera.zoom <= 0) {
      if (camera) camera.zoom = 1.0;
    }
    if (!camera || !Number.isFinite(camera.panX)) {
      if (camera) camera.panX = 0;
    }
    if (!camera || !Number.isFinite(camera.panY)) {
      if (camera) camera.panY = 0;
    }

    try {
      if (engine.dirtyRegions) {
        engine.computeCountryBounds();
      }
      if (engine.dirtyPixels) {
        this.updateTerritoryBuffer(engine);
        engine.dirtyPixels = false;
      }

      // 1. Deep ocean background
      ctx.fillStyle = "#090d16";
      ctx.fillRect(0, 0, viewW, viewH);

      // World transform
      const baseScale = this.getBaseScale(viewW, viewH) || 1.0;
      const safeZoom =
        Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1.0;
      const scale = baseScale * safeZoom;
      const mapScreenW = MAP_W * scale;
      const mapScreenH = MAP_H * scale;
      const originX =
        (viewW - mapScreenW) / 2 +
        (Number.isFinite(camera.panX) ? camera.panX : 0);
      const originY =
        (viewH - mapScreenH) / 2 +
        (Number.isFinite(camera.panY) ? camera.panY : 0);

      ctx.save();
      ctx.translate(originX, originY);

      // 2. Single hardware-accelerated drawImage call for the entire map + territories!
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.bufferCanvas, 0, 0, mapScreenW, mapScreenH);

      const bounds = engine.countryBounds || engine.computeCountryBounds();

      // 3. Crisp High-Resolution Country Crest / Emblem Banner in Territory
      // Displays the player's full uncompressed, anti-aliased image / flag right at their capital or core territory!
      for (const country of engine.countries) {
        if (country.landCount <= 0) continue;
        const b = bounds.get(country.id);
        if (!b || b.count === 0) continue;

        // For large countries (>50 px), center the crest squarely in the heart of their territory
        // For small countries, place it at the capital
        let crestX = country.capitalX;
        let crestY = country.capitalY;
        const capIdx = crestY * MAP_W + crestX;
        const needsCentroid =
          country.landCount > 50 ||
          crestX == null ||
          crestY == null ||
          engine.owners[capIdx] !== country.id ||
          !this.worldData.isLand[capIdx];

        if (needsCentroid) {
          const targetX = Math.round(b.sumX / b.count);
          const targetY = Math.round(b.sumY / b.count);
          let bestDist = Infinity;
          let bestX = b.minX;
          let bestY = b.minY;

          for (let cy = b.minY; cy <= b.maxY; cy++) {
            const row = cy * MAP_W;
            for (let cx = b.minX; cx <= b.maxX; cx++) {
              if (engine.owners[row + cx] === country.id) {
                const dist = (cx - targetX) ** 2 + (cy - targetY) ** 2;
                if (dist < bestDist) {
                  bestDist = dist;
                  bestX = cx;
                  bestY = cy;
                }
              }
            }
          }
          crestX = bestX;
          crestY = bestY;
        }

        const sx = (crestX + 0.5) * scale;
        const sy = (crestY + 0.5) * scale;

        // Viewport culling
        if (
          sx + originX < -120 ||
          sx + originX > viewW + 120 ||
          sy + originY < -120 ||
          sy + originY > viewH + 120
        ) {
          continue;
        }

        const isMe = country.id === engine.myCountryId;
        const img = this.getOrLoadImage(country.flagDataUrl, () => {
          engine.dirtyPixels = true;
        });

        // Compute crest dimensions based on country size and camera scale
        const landFactor = Math.sqrt(country.landCount);
        // Proportional scale: small country ~20px, medium ~45px, massive empire ~90-120px
        const baseW = Math.max(18, Math.min(100, 14 + landFactor * 0.9));
        // Screen width: smoothly clamped between 30px and 150px so it's always majestic and visible
        const screenW = Math.max(30, Math.min(150, Math.round(baseW * Math.max(0.65, Math.min(1.8, scale)))));
        const screenH = Math.round(screenW * (FLAG_H / FLAG_W));

        ctx.save();
        ctx.translate(sx, sy);

        // Elegant drop shadow
        ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
        ctx.shadowBlur = Math.min(10, 4 + scale);
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 2;

        const halfW = screenW / 2;
        const halfH = screenH / 2;
        const radius = Math.max(3, Math.min(6, screenW * 0.12));

        // Base rounded rect
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(-halfW, -halfH, screenW, screenH, radius);
        } else {
          ctx.rect(-halfW, -halfH, screenW, screenH);
        }
        ctx.fillStyle = "#090d16";
        ctx.fill();

        const crestBorderColor = country.color || (isMe ? "#FBBF24" : "#94A3B8");
        ctx.strokeStyle = crestBorderColor;
        ctx.lineWidth = isMe ? 2.2 : 1.6;
        ctx.stroke();

        // Clip & draw high-resolution image with anti-aliasing
        ctx.save();
        ctx.shadowColor = "transparent";
        ctx.clip();
        if (img) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, -halfW, -halfH, screenW, screenH);
        } else {
          // Stylish fallback emblem so it's NEVER an invisible flat color box!
          const grad = ctx.createLinearGradient(-halfW, -halfH, halfW, halfH);
          grad.addColorStop(0, "#1e293b");
          grad.addColorStop(1, "#0f172a");
          ctx.fillStyle = grad;
          ctx.fillRect(-halfW, -halfH, screenW, screenH);

          // Country Initials
          ctx.fillStyle = country.color || "#FBBF24";
          ctx.font = `900 ${Math.max(9, Math.min(18, Math.round(screenH * 0.52)))}px Inter, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const initials = (country.name || "D").slice(0, 3).toUpperCase();
          ctx.fillText(initials, 0, 1);
        }
        ctx.restore();

        // Overlay border stroke for razor-sharp edge
        ctx.shadowColor = "transparent";
        ctx.strokeStyle = crestBorderColor;
        ctx.lineWidth = isMe ? 2.2 : 1.6;
        ctx.stroke();

        // Capital indicator badge (small star in top-left)
        if (country.capitalX === crestX && country.capitalY === crestY) {
          const starR = Math.max(3, Math.min(6, screenW * 0.11));
          ctx.fillStyle = "#FBBF24";
          ctx.strokeStyle = "#0f172a";
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(-halfW + starR + 2, -halfH + starR + 2, starR, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }

        ctx.restore();
      }

      const myCountry = engine.getMyCountry();

      // 4. Fast Frontier Highlight (Only when zoomed in and country bounding box is small)
      if (myCountry && myCountry.troops >= 1.0 && scale >= 4.0) {
        const myB = bounds.get(myCountry.id);
        if (myB && myB.count > 0 && myB.maxX - myB.minX < 80) {
          const owners = engine.owners;
          const isLand = this.worldData.isLand;
          const myId = myCountry.id;

          const minX = Math.max(0, myB.minX - 1);
          const maxX = Math.min(MAP_W - 1, myB.maxX + 1);
          const minY = Math.max(0, myB.minY - 1);
          const maxY = Math.min(MAP_H - 1, myB.maxY + 1);

          ctx.fillStyle = "rgba(251, 191, 36, 0.22)";
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

      // 5. Render Active Naval Ships Sailing Across Seas
      if (Array.isArray(engine.ships) && engine.ships.length > 0) {
        for (const ship of engine.ships) {
          const fromSx = (ship.fromX + 0.5) * scale;
          const fromSy = (ship.fromY + 0.5) * scale;
          const toSx = (ship.toX + 0.5) * scale;
          const toSy = (ship.toY + 0.5) * scale;
          const curSx = (ship.x + 0.5) * scale;
          const curSy = (ship.y + 0.5) * scale;

          ctx.save();
          ctx.strokeStyle = "rgba(56, 189, 248, 0.65)";
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.moveTo(fromSx, fromSy);
          ctx.lineTo(toSx, toSy);
          ctx.stroke();

          const sz = Math.max(10, Math.min(18, scale * 1.8));
          ctx.translate(curSx, curSy);

          ctx.beginPath();
          ctx.arc(0, 0, sz * 0.85, 0, Math.PI * 2);
          ctx.fillStyle = "#082F49";
          ctx.fill();
          ctx.strokeStyle = ship.color || "#38BDF8";
          ctx.lineWidth = 1.6;
          ctx.stroke();

          ctx.fillStyle = "#F8FAFC";
          ctx.beginPath();
          ctx.moveTo(0, -sz * 0.5);
          ctx.lineTo(sz * 0.45, sz * 0.15);
          ctx.lineTo(-sz * 0.45, sz * 0.15);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }

      // 6. Clean Country Name & Flag Pill Above Territory
      for (const country of engine.countries) {
        if (country.landCount <= 0) continue;
        const b = bounds.get(country.id);
        if (!b || b.count === 0) continue;

        const centerX = ((b.minX + b.maxX + 1) / 2) * scale;
        const topY = b.minY * scale;

        if (
          centerX + originX < -100 ||
          centerX + originX > viewW + 100 ||
          topY + originY < -50 ||
          topY + originY > viewH + 50
        ) {
          continue;
        }

        const isMe = country.id === engine.myCountryId;
        ctx.save();
        const fontSize = 11;
        ctx.font = "800 11px Inter, system-ui, sans-serif";
        const label = `${country.name} (${country.landCount} px · 🎖️${Math.floor(country.troops)})`;
        const flagThumbW = 20;
        const flagThumbH = 13;
        const textW = ctx.measureText(label).width;
        const tw = textW + flagThumbW + 18;
        const th = 22;
        const labelY = topY - th - 6;
        const pillX = centerX - tw / 2;

        const pillBorderColor = country.color || (isMe ? "#FBBF24" : "#94A3B8");
        ctx.fillStyle = "rgba(9, 13, 22, 0.92)";
        ctx.strokeStyle = pillBorderColor;
        ctx.lineWidth = isMe ? 1.8 : 1.3;
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(pillX, labelY, tw, th, 6);
        } else {
          ctx.rect(pillX, labelY, tw, th);
        }
        ctx.fill();
        ctx.stroke();

        const img = this.getOrLoadImage(country.flagDataUrl);
        const thumbX = pillX + 5;
        const thumbY = labelY + (th - flagThumbH) / 2;
        if (img) {
          ctx.save();
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(thumbX, thumbY, flagThumbW, flagThumbH, 2.5);
          } else {
            ctx.rect(thumbX, thumbY, flagThumbW, flagThumbH);
          }
          ctx.clip();
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(img, thumbX, thumbY, flagThumbW, flagThumbH);
          ctx.restore();
        } else {
          ctx.fillStyle = country.color || "#E11D48";
          ctx.fillRect(thumbX, thumbY, flagThumbW, flagThumbH);
        }

        ctx.fillStyle = isMe ? "#FDE68A" : "#F1F5F9";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, thumbX + flagThumbW + 6, labelY + th / 2);
        ctx.restore();
      }

      ctx.restore();

      return { scale, originX, originY, mapScreenW, mapScreenH };
    } catch (err) {
      console.error("[WorldRenderer] renderFrame error:", err);
      try {
        ctx.restore();
      } catch {}
      return null;
    }
  }
}
