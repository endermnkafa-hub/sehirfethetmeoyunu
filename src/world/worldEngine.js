// Real-Time Shared World MMO Conquest Engine
// Hardcore logarithmic progression: every single pixel matters, zero snowballing, native high-DPI territory rendering
// 1 Device = 1 Nation, Max 2 Nations per IP, VPN/Proxy Detection, Cross-Tab Live Sync

import { MAP_W, MAP_H } from './worldRasterizer';
import { loadDataUrlToFlagBuffer } from './flagLibrary';
import { getOrCreateDeviceId, getMyCountryId, saveMyCountryId } from './networkSecurity';
import { SharedWorldSync } from './sharedWorldSync';

export const WORLD_SAVE_KEY = 'sf_shared_world_v8_clean';

export const UPGRADE_DEFINITIONS = [
  {
    key: 'mobilization',
    name: 'Seferberlik Hızı',
    icon: '⚡',
    desc: 'Saniye başı asker üretim hızını +%20 artırır.',
    baseCost: 30,
    costScale: 1.8,
    maxLevel: 5,
  },
  {
    key: 'weapons',
    name: 'Taarruz Doktrini',
    icon: '⚔️',
    desc: 'Ordunun saldırı gücünü +%25 artırır; düşman toprağı alırken daha az asker harcarsın.',
    baseCost: 35,
    costScale: 1.8,
    maxLevel: 5,
  },
  {
    key: 'fortification',
    name: 'Sınır Tahkimatı',
    icon: '🛡️',
    desc: 'Topraklarının savunma direncini +%30 artırır; rakipler senden piksel alırken ağır kayıp verir.',
    baseCost: 35,
    costScale: 1.8,
    maxLevel: 5,
  },
  {
    key: 'logistics',
    name: 'Ordu Kapasitesi',
    icon: '📦',
    desc: 'Biriktirebileceğin maksimum asker kapasitesini +%25 artırır.',
    baseCost: 30,
    costScale: 1.75,
    maxLevel: 5,
  },
  {
    key: 'economy',
    name: 'Halk & Vergi Reformu',
    icon: '💰',
    desc: 'Halkın büyüme hızını ve hazineye akan saniye başı altın gelirini +%25 artırır.',
    baseCost: 25,
    costScale: 1.7,
    maxLevel: 5,
  },
];

export const DEFAULT_UPGRADES = {
  mobilization: 0,
  weapons: 0,
  fortification: 0,
  logistics: 0,
  economy: 0,
};

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

    this.sync = new SharedWorldSync(this, () => {
      this.dirtyPixels = true;
      this.dirtyRegions = true;
    });

    this.loadState();
  }

  getMyCountry() {
    if (!this.myCountryId) {
      const storedId = getMyCountryId();
      if (storedId) {
        this.myCountryId = parseInt(storedId, 10);
      } else {
        const devCountry = this.countries.find((c) => c.deviceId === this.myDeviceId);
        if (devCountry) {
          this.myCountryId = devCountry.id;
          saveMyCountryId(devCountry.id);
        }
      }
    }
    return this.countryMap.get(this.myCountryId) || null;
  }

  _normalizeCountry(c) {
    c.upgrades = { ...DEFAULT_UPGRADES, ...(c.upgrades || {}) };
    c.landCount = Math.max(1, c.landCount || 1);
    c.population = typeof c.population === 'number' ? Math.max(10, c.population) : 10;
    c.gold = typeof c.gold === 'number' ? Math.max(0, c.gold) : 0;
    c.troops = typeof c.troops === 'number' ? Math.max(0, c.troops) : 1.0;
    this._recalculateDerivedStats(c);
    return c;
  }

  _recalculateDerivedStats(c) {
    const up = c.upgrades || DEFAULT_UPGRADES;

    // 1. Asker Kapasitesi = Toprak Sayısı * Lojistik Çarpanı
    // Büyük devletin ağırlığı: Biriktirebildiği maksimum ordu kapasitesidir!
    c.capacity = Math.max(1, Math.floor(c.landCount * (1 + up.logistics * 0.25)));

    // 2. Asker Üretim Hızı (Logaritmik Azalan Getiri Formülü):
    // - 1 piksel: ~0.033 asker/sn (30 saniyede 1 asker)
    // - 10 piksel: ~0.098 asker/sn (10 saniyede 1 asker)
    // - 100 piksel (Şehir): ~0.163 asker/sn (6 saniyede 1 asker)
    // - 1000 piksel (Büyük Devlet): ~0.229 asker/sn (4.3 saniyede 1 asker)
    // - 3500 piksel (Dev İmparatorluk): ~0.264 asker/sn (3.8 saniyede 1 asker)
    // Asla saniyede 5-10 asker basıp haritayı boyayamaz! Küçük devlet büyüğe yetişebilir.
    const baseRate = (1.0 + 0.85 * Math.log(Math.max(1, c.landCount))) / 30.0;
    c.productionRate = baseRate * (1 + up.mobilization * 0.20);

    // 3. Otomatik Halk (Nüfus) & Vergi (Altın) Üretimi
    c.maxPopulation = c.landCount * 15;
    c.popGrowthRate = (0.15 + 0.04 * Math.log(c.landCount + 1)) * (1 + up.economy * 0.25);

    // Saniye başı altın geliri (Upgradeler için birikir, 역시 logaritmik dengeli)
    c.goldIncome = (0.20 + 0.35 * Math.log(c.landCount + 1)) * (1 + up.economy * 0.25);

    // 4. Saldırı & Savunma Gücü (Küçük ülkelere +%35 Vatan Savunması direnci)
    c.attackPower = 1.0 + up.weapons * 0.25;
    const underdogBonus = c.landCount < 40 ? 0.35 : c.landCount < 100 ? 0.15 : 0;
    c.defensePower = 1.0 + up.fortification * 0.30 + underdogBonus;
  }

  // Real-time continuous simulation tick
  update(deltaTimeSec) {
    if (deltaTimeSec <= 0 || deltaTimeSec > 1.0) deltaTimeSec = 0.05;

    for (const c of this.countries) {
      if (c.landCount <= 0) continue;

      this._recalculateDerivedStats(c);

      // Continuous troop production up to capacity
      if (c.troops < c.capacity) {
        c.troops = Math.min(c.capacity, c.troops + c.productionRate * deltaTimeSec);
      }

      // Continuous background population growth
      if (c.population < c.maxPopulation) {
        c.population = Math.min(c.maxPopulation, c.population + c.popGrowthRate * deltaTimeSec);
      }

      // Continuous gold tax accumulation for upgrades
      c.gold += c.goldIncome * deltaTimeSec;
    }
  }

  // Purchase Technology / Upgrade with Gold
  buyUpgrade(countryId, upgradeKey) {
    const country = this.countryMap.get(countryId);
    if (!country) return { ok: false, reason: 'Devlet bulunamadı.' };

    const def = UPGRADE_DEFINITIONS.find((u) => u.key === upgradeKey);
    if (!def) return { ok: false, reason: 'Geliştirme bulunamadı.' };

    const currentLevel = country.upgrades?.[upgradeKey] || 0;
    if (currentLevel >= def.maxLevel) {
      return { ok: false, reason: 'Maksimum seviyeye ulaşıldı!' };
    }

    const cost = Math.round(def.baseCost * Math.pow(def.costScale, currentLevel));
    if (country.gold < cost) {
      return { ok: false, reason: `Yetersiz Altın! (${cost} Altın gerekli)` };
    }

    country.gold -= cost;
    country.upgrades[upgradeKey] = currentLevel + 1;
    this._recalculateDerivedStats(country);
    this.onSound('celebration');
    this.onEvent(`${def.icon} ${def.name} Seviye ${currentLevel + 1} oldu!`);
    this.saveState();

    this.sync.broadcast({
      type: 'SYNC_COUNTRY_STATS',
      countryId: country.id,
      stats: {
        gold: country.gold,
        population: country.population,
        troops: country.troops,
        upgrades: country.upgrades,
      },
    });

    return { ok: true, level: currentLevel + 1, cost };
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

    const attacker = this.countryMap.get(countryId);
    if (!attacker) return { valid: false, reason: 'Devlet bulunamadı.' };

    // Must be 4-way adjacent to a pixel currently owned by this country
    const isAdjacent =
      (x > 0 && this.owners[idx - 1] === countryId) ||
      (x < MAP_W - 1 && this.owners[idx + 1] === countryId) ||
      (y > 0 && this.owners[idx - MAP_W] === countryId) ||
      (y < MAP_H - 1 && this.owners[idx + MAP_W] === countryId);

    if (!isAdjacent) {
      return { valid: false, reason: 'Sadece sınırındaki komşu pikselleri fethedebilirsin.' };
    }

    const isEnemy = currentOwner > 0;
    let cost = 1.0;

    if (isEnemy) {
      const defender = this.countryMap.get(currentOwner);
      const defPower = defender ? (defender.defensePower || 1.0) : 1.0;
      const atkPower = attacker.attackPower || 1.0;
      cost = Math.max(1.0, Number(((2.0 * defPower) / atkPower).toFixed(2)));
    }

    return {
      valid: true,
      cost,
      isEnemy,
      targetOwnerId: currentOwner,
    };
  }

  // Conquer single pixel
  conquerPixel(countryId, x, y) {
    const country = this.countryMap.get(countryId);
    if (!country) return { ok: false, reason: 'Devlet bulunamadı.' };

    const check = this.canExpandToPixel(countryId, x, y);
    if (!check.valid) return { ok: false, reason: check.reason };

    if (country.troops < check.cost) {
      return {
        ok: false,
        reason: `Yetersiz asker! (${check.cost} asker gerekli, sende ${country.troops.toFixed(1)} var)`,
      };
    }

    const idx = y * MAP_W + x;
    const prevOwner = this.owners[idx];

    country.troops = Math.max(0, country.troops - check.cost);
    this.owners[idx] = countryId;
    country.landCount++;
    country.population += 5;

    if (prevOwner > 0) {
      const prevCountry = this.countryMap.get(prevOwner);
      if (prevCountry) {
        prevCountry.landCount = Math.max(0, prevCountry.landCount - 1);
        this._recalculateDerivedStats(prevCountry);
        if (prevCountry.troops > prevCountry.capacity) {
          prevCountry.troops = prevCountry.capacity;
        }
      }
    }

    this._recalculateDerivedStats(country);

    this.dirtyPixels = true;
    this.dirtyRegions = true;
    this.onSound('pencil');

    this.sync.broadcast({
      type: 'CONQUER_PIXEL',
      countryId,
      x,
      y,
      cost: check.cost,
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

    // 1 Device = 1 Country Enforcement
    const existingForDevice = this.countries.find((c) => c.deviceId === this.myDeviceId);
    if (existingForDevice && existingForDevice.landCount > 0) {
      return {
        ok: false,
        reason: `Bu cihazdan zaten bir ülke kurulmuş: "${existingForDevice.name}"! (1 Cihaz = 1 Ülke)`,
      };
    }

    const currentCountry = this.getMyCountry();
    if (currentCountry && currentCountry.landCount > 0) {
      return {
        ok: false,
        reason: `Zaten "${currentCountry.name}" adında bir ülken var!`,
      };
    }

    // IP Check: Max 2 countries per IP
    if (creatorIp) {
      const countForIp = this.countries.filter((c) => c.creatorIp === creatorIp && c.landCount > 0).length;
      if (countForIp >= 2) {
        return { ok: false, reason: 'Bu IP adresinden en fazla 2 ülke oluşturulabilir!' };
      }
    }

    let flagRgba = null;
    try {
      const decoded = await loadDataUrlToFlagBuffer(flagDataUrl);
      flagRgba = decoded.rgba;
    } catch {}

    const newId = this.countries.length > 0
      ? Math.max(...this.countries.map((c) => c.id)) + 1
      : 1;

    const country = this._normalizeCountry({
      id: newId,
      name: (name || 'Devletim').trim(),
      color: color || '#E11D48',
      flagDataUrl,
      flagRgba,
      capitalX,
      capitalY,
      landCount: 1,
      population: 15,
      gold: 0,
      troops: 1.0, // Starts with 1 pixel, capacity 1, and 1 soldier
      upgrades: { ...DEFAULT_UPGRADES },
      creatorIp: creatorIp || 'unknown',
      deviceId: this.myDeviceId,
      createdAt: Date.now(),
    });

    this.owners[idx] = newId;
    this.countries.push(country);
    this.countryMap.set(newId, country);

    this.myCountryId = newId;
    saveMyCountryId(newId);

    this.dirtyPixels = true;
    this.dirtyRegions = true;
    this.onSound('celebration');
    this.onEvent(`🌍 ${country.name} kuruldu!`);

    this.sync.broadcast({
      type: 'NEW_COUNTRY',
      country: {
        id: country.id,
        name: country.name,
        color: country.color,
        flagDataUrl: country.flagDataUrl,
        capitalX: country.capitalX,
        capitalY: country.capitalY,
        population: country.population,
        gold: country.gold,
        troops: country.troops,
        upgrades: country.upgrades,
        creatorIp: country.creatorIp,
        deviceId: country.deviceId,
        createdAt: country.createdAt,
      },
    });

    this.saveState();
    return { ok: true, country };
  }

  async handleRemoteNewCountry(remoteData) {
    if (this.countryMap.has(remoteData.id)) return;

    let flagRgba = null;
    if (remoteData.flagDataUrl) {
      try {
        const decoded = await loadDataUrlToFlagBuffer(remoteData.flagDataUrl);
        flagRgba = decoded.rgba;
      } catch {}
    }

    const country = this._normalizeCountry({
      ...remoteData,
      flagRgba,
      landCount: 1,
    });

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

  handleRemoteConquerPixel(countryId, x, y, cost = 1) {
    if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) return;
    const idx = y * MAP_W + x;
    const prevOwner = this.owners[idx];
    if (prevOwner === countryId) return;

    this.owners[idx] = countryId;

    const country = this.countryMap.get(countryId);
    if (country) {
      country.landCount++;
      country.troops = Math.max(0, country.troops - (cost || 1));
      this._recalculateDerivedStats(country);
    }

    if (prevOwner > 0) {
      const prevC = this.countryMap.get(prevOwner);
      if (prevC) {
        prevC.landCount = Math.max(0, prevC.landCount - 1);
        this._recalculateDerivedStats(prevC);
      }
    }

    this.dirtyPixels = true;
    this.dirtyRegions = true;
  }

  handleRemoteSyncCountryStats(countryId, stats) {
    const country = this.countryMap.get(countryId);
    if (!country || !stats) return;
    if (typeof stats.gold === 'number') country.gold = stats.gold;
    if (typeof stats.population === 'number') country.population = stats.population;
    if (typeof stats.troops === 'number') country.troops = stats.troops;
    if (stats.upgrades) country.upgrades = { ...DEFAULT_UPGRADES, ...stats.upgrades };
    this._recalculateDerivedStats(country);
  }

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
        v: 8,
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
          population: c.population,
          gold: c.gold,
          upgrades: c.upgrades,
          createdAt: c.createdAt,
        })),
        rle,
      };

      localStorage.setItem(WORLD_SAVE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('World save error:', e);
    }
  }

  loadState() {
    try {
      // One-time clean wipe for v8 hardcore balance
      if (!localStorage.getItem('sf_world_reset_v8_done')) {
        localStorage.removeItem('sf_shared_world_v4_data');
        localStorage.removeItem('sf_shared_world_v5_worldbox');
        localStorage.removeItem('sf_shared_world_v7_fresh');
        localStorage.removeItem('sf_my_country_id');
        localStorage.setItem('sf_world_reset_v8_done', '1');
        return false;
      }

      const raw = localStorage.getItem(WORLD_SAVE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (data.v !== 8 || data.w !== MAP_W || data.h !== MAP_H || !Array.isArray(data.rle)) {
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

      const landCounts = new Map();
      for (let i = 0; i < total; i++) {
        const o = this.owners[i];
        if (o > 0) {
          landCounts.set(o, (landCounts.get(o) || 0) + 1);
        }
      }

      for (const cd of data.countries || []) {
        const actualLand = landCounts.get(cd.id) ?? 0;
        if (actualLand <= 0) continue;

        const country = this._normalizeCountry({
          ...cd,
          landCount: actualLand,
        });

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
