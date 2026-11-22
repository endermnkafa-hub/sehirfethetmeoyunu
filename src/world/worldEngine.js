// Real-Time Shared World MMO Conquest Engine (Continuous Seconds-Based Economy, No Turns, Custom Images)
// Formula: Capacity = landCount, Production = landCount / 60 troops/sec.
// 1 Device = 1 Nation, Max 2 Nations per IP, VPN/Proxy Detection.

import { MAP_W, MAP_H, findNearestLand } from './worldRasterizer';
import { loadDataUrlToFlagBuffer } from './flagLibrary';
import { getOrCreateDeviceId, getMyCountryId, saveMyCountryId } from './networkSecurity';
import { SharedWorldSync } from './sharedWorldSync';

export const WORLD_SAVE_KEY = 'sf_shared_world_v4_data';

export class WorldSimulationEngine {
  constructor(worldData, callbacks = {}) {
    this.worldData = worldData;
    this.onEvent = callbacks.onEvent || (() => {});
    this.onSound = callbacks.onSound || (() => {});

    const total = MAP_W * MAP_H;
    this.owners = new Int16Array(total);
    for (let i = 0; i < total; i++) {
      this.owners[i] = worldData.isLand[i] ? 0 : -1;
    }

    this.countries = [];
    this.countryMap = new Map();
    this.myDeviceId = getOrCreateDeviceId();
    this.myCountryId = null;

    this.dirtyPixels = true;
    this.dirtyRegions = true;

    // Real-time synchronization layer
    this.sync = new SharedWorldSync(this, () => {
      this.dirtyPixels = true;
      this.dirtyRegions = true;
    });

    // Try loading existing shared world registry from localStorage
    this.loadState();
  }

  getMyCountry() {
    if (!this.myCountryId) {
      const storedId = getMyCountryId();
      if (storedId) this.myCountryId = parseInt(storedId, 10);
    }
    return this.countryMap.get(this.myCountryId) || null;
  }

  // Real-time continuous production tick (called at 60 FPS or 10 FPS with deltaTime in seconds)
  update(deltaTimeSec) {
    if (deltaTimeSec <= 0 || deltaTimeSec > 1.0) deltaTimeSec = 0.05;

    for (const c of this.countries) {
      if (c.landCount <= 0) continue;

      // Exact user formula:
      // Kapasite = toprak sayisi
      // Uretim hizi = toprak sayisi / 60 asker/saniye
      c.capacity = Math.max(1, c.landCount);
      const ratePerSec = c.landCount / 60.0;

      c.troops = Math.min(c.capacity, c.troops + ratePerSec * deltaTimeSec);
    }
  }

  // Check if pixel (x, y) can be expanded into by countryId
  canExpandToPixel(countryId, x, y) {
    if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) {
      return { valid: false, reason: 'Harita dışı.' };
    }

    const idx = y * MAP_W + x;
    if (!this.worldData.isLand[idx]) {
      return { valid: false, reason: 'Deniz veya okyanus fethedilemez.' };
    }

    const currentOwner = this.owners[idx];
    if (currentOwner === countryId) {
      return { valid: false, reason: 'Zaten senin toprağın.' };
    }

    // Must be 4-way adjacent to a pixel currently owned by this country
    const isAdjacent =
      (x > 0 && this.owners[idx - 1] === countryId) ||
      (x < MAP_W - 1 && this.owners[idx + 1] === countryId) ||
      (y > 0 && this.owners[idx - MAP_W] === countryId) ||
      (y < MAP_H - 1 && this.owners[idx + MAP_W] === countryId);

    if (!isAdjacent) {
      return { valid: false, reason: 'Sadece sınırındaki komşu pikselleri fethedebilirsin.' };
    }

    // Cost: 1 soldier for neutral pixel, 2 soldiers for attacking an enemy pixel
    const isEnemy = currentOwner > 0;
    const cost = isEnemy ? 2 : 1;

    return {
      valid: true,
      cost,
      isEnemy,
      targetOwnerId: currentOwner,
    };
  }

  // Conquer single pixel (called on click or mouse/touch drag)
  conquerPixel(countryId, x, y) {
    const country = this.countryMap.get(countryId);
    if (!country) return { ok: false, reason: 'Devlet bulunamadı.' };

    const check = this.canExpandToPixel(countryId, x, y);
    if (!check.valid) return { ok: false, reason: check.reason };

    if (country.troops < check.cost) {
      return {
        ok: false,
        reason: `Yetersiz asker! (${check.cost} asker gerekli, sende ${Math.floor(country.troops)} var)`,
      };
    }

    const idx = y * MAP_W + x;
    const prevOwner = this.owners[idx];

    // Deduct soldier cost
    country.troops -= check.cost;
    this.owners[idx] = countryId;
    country.landCount++;
    country.capacity = country.landCount;

    // Handle previous enemy owner loss
    if (prevOwner > 0) {
      const prevCountry = this.countryMap.get(prevOwner);
      if (prevCountry) {
        prevCountry.landCount = Math.max(0, prevCountry.landCount - 1);
        prevCountry.capacity = Math.max(1, prevCountry.landCount);
        if (prevCountry.troops > prevCountry.capacity) {
          prevCountry.troops = prevCountry.capacity;
        }
      }
    }

    this.dirtyPixels = true;
    this.dirtyRegions = true;
    this.onSound('pencil');

    // Broadcast pixel conquest to all other players in real-time
    this.sync.broadcast({
      type: 'CONQUER_PIXEL',
      countryId,
      x,
      y,
    });

    this.saveState();
    return { ok: true, country };
  }

  // Found a brand new country on an unclaimed neutral land pixel
  async foundCountry({ name, color, flagDataUrl, capitalX, capitalY, creatorIp }) {
    const idx = capitalY * MAP_W + capitalX;
    if (!this.worldData.isLand[idx]) {
      return { ok: false, reason: 'Denize devlet kurulamaz!' };
    }
    if (this.owners[idx] !== 0) {
      return { ok: false, reason: 'Bu piksel zaten başka bir devlete ait!' };
    }

    // IP Check: Max 2 countries per IP
    if (creatorIp) {
      const countForIp = this.countries.filter((c) => c.creatorIp === creatorIp).length;
      if (countForIp >= 2) {
        return { ok: false, reason: 'Bu IP adresinden en fazla 2 ülke oluşturulabilir!' };
      }
    }

    // Decode custom image into RGBA buffer
    let flagRgba = null;
    try {
      const decoded = await loadDataUrlToFlagBuffer(flagDataUrl);
      flagRgba = decoded.rgba;
    } catch (e) {
      console.warn('Flag buffer decode fallback:', e);
    }

    const newId = this.countries.length > 0
      ? Math.max(...this.countries.map((c) => c.id)) + 1
      : 1;

    const country = {
      id: newId,
      name: (name || 'Devletim').trim(),
      color: color || '#E11D48',
      flagDataUrl,
      flagRgba,
      capitalX,
      capitalY,
      landCount: 1,
      troops: 1.0, // Start with 1 full soldier so player can make their 1st expansion immediately
      capacity: 1,
      creatorIp: creatorIp || 'unknown',
      deviceId: this.myDeviceId,
      createdAt: Date.now(),
    };

    this.owners[idx] = newId;
    this.countries.push(country);
    this.countryMap.set(newId, country);

    this.myCountryId = newId;
    saveMyCountryId(newId);

    this.dirtyPixels = true;
    this.dirtyRegions = true;
    this.onSound('celebration');
    this.onEvent(`🌍 ${country.name} dünya sahnesine çıktı!`);

    // Broadcast new nation creation to all other players in real-time
    this.sync.broadcast({
      type: 'NEW_COUNTRY',
      country: {
        id: country.id,
        name: country.name,
        color: country.color,
        flagDataUrl: country.flagDataUrl,
        capitalX: country.capitalX,
        capitalY: country.capitalY,
        creatorIp: country.creatorIp,
        deviceId: country.deviceId,
        createdAt: country.createdAt,
      },
    });

    this.saveState();
    return { ok: true, country };
  }

  // Handle remote country created by another player
  async handleRemoteNewCountry(remoteData) {
    if (this.countryMap.has(remoteData.id)) return;

    let flagRgba = null;
    if (remoteData.flagDataUrl) {
      try {
        const decoded = await loadDataUrlToFlagBuffer(remoteData.flagDataUrl);
        flagRgba = decoded.rgba;
      } catch {}
    }

    const country = {
      ...remoteData,
      flagRgba,
      landCount: 1,
      troops: 1.0,
      capacity: 1,
    };

    const idx = country.capitalY * MAP_W + country.capitalX;
    if (this.worldData.isLand[idx]) {
      this.owners[idx] = country.id;
    }

    this.countries.push(country);
    this.countryMap.set(country.id, country);
    this.dirtyPixels = true;
    this.dirtyRegions = true;
    this.saveState();
  }

  // Handle remote pixel conquest by another player
  handleRemoteConquerPixel(countryId, x, y) {
    if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) return;
    const idx = y * MAP_W + x;
    const prevOwner = this.owners[idx];
    if (prevOwner === countryId) return;

    this.owners[idx] = countryId;

    const country = this.countryMap.get(countryId);
    if (country) {
      country.landCount++;
      country.capacity = country.landCount;
    }

    if (prevOwner > 0) {
      const prevC = this.countryMap.get(prevOwner);
      if (prevC) {
        prevC.landCount = Math.max(0, prevC.landCount - 1);
        prevC.capacity = Math.max(1, prevC.landCount);
      }
    }

    this.dirtyPixels = true;
    this.dirtyRegions = true;
  }

  // Compute bounding boxes of countries for custom image UV projection
  computeCountryBounds() {
    const bounds = new Map();
    for (const c of this.countries) {
      bounds.set(c.id, {
        minX: MAP_W,
        minY: MAP_H,
        maxX: 0,
        maxY: 0,
        count: 0,
        sumX: 0,
        sumY: 0,
      });
    }

    for (let y = 0; y < MAP_H; y++) {
      const row = y * MAP_W;
      for (let x = 0; x < MAP_W; x++) {
        const o = this.owners[row + x];
        if (o <= 0) continue;
        const b = bounds.get(o);
        if (b) {
          if (x < b.minX) b.minX = x;
          if (x > b.maxX) b.maxX = x;
          if (y < b.minY) b.minY = y;
          if (y > b.maxY) b.maxY = y;
          b.count++;
          b.sumX += x;
          b.sumY += y;
        }
      }
    }

    this.countryBounds = bounds;
    this.dirtyRegions = false;
    return bounds;
  }

  // Persist shared world to localStorage
  saveState() {
    try {
      const total = MAP_W * MAP_H;
      const rle = [];
      let cur = this.owners[0];
      let len = 1;

      for (let i = 1; i < total; i++) {
        const v = this.owners[i];
        if (v === cur && len < 65535) {
          len++;
        } else {
          rle.push(cur, len);
          cur = v;
          len = 1;
        }
      }
      rle.push(cur, len);

      const payload = {
        v: 5,
        w: MAP_W,
        h: MAP_H,
        countries: this.countries.map((c) => ({
          id: c.id,
          name: c.name,
          color: c.color,
          flagDataUrl: c.flagDataUrl,
          capitalX: c.capitalX,
          capitalY: c.capitalY,
          creatorIp: c.creatorIp,
          deviceId: c.deviceId,
          troops: c.troops,
          landCount: c.landCount,
          createdAt: c.createdAt,
        })),
        rle,
      };

      localStorage.setItem(WORLD_SAVE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('World save error:', e);
    }
  }

  // Load shared world state from localStorage
  loadState() {
    try {
      const raw = localStorage.getItem(WORLD_SAVE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (data.v !== 5 || data.w !== MAP_W || data.h !== MAP_H || !Array.isArray(data.rle)) {
        return false;
      }

      const total = MAP_W * MAP_H;
      let ptr = 0;
      for (let i = 0; i < data.rle.length; i += 2) {
        const val = data.rle[i];
        const count = data.rle[i + 1];
        for (let k = 0; k < count && ptr < total; k++) {
          this.owners[ptr++] = val;
        }
      }

      this.countries = [];
      this.countryMap.clear();

      for (const cd of data.countries || []) {
        const country = {
          ...cd,
          capacity: Math.max(1, cd.landCount || 1),
          troops: Math.min(Math.max(1, cd.landCount || 1), cd.troops || 1),
        };

        if (cd.flagDataUrl) {
          loadDataUrlToFlagBuffer(cd.flagDataUrl)
            .then((res) => {
              country.flagRgba = res.rgba;
              this.dirtyPixels = true;
            })
            .catch(() => {});
        }

        this.countries.push(country);
        this.countryMap.set(country.id, country);
      }

      this.myCountryId = getMyCountryId() ? parseInt(getMyCountryId(), 10) : null;
      this.dirtyPixels = true;
      this.dirtyRegions = true;
      return true;
    } catch (e) {
      console.warn('World load error:', e);
      return false;
    }
  }
}
