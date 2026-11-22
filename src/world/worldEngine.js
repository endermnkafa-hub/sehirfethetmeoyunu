// Real-Time Shared World MMO Conquest Engine
// Hardcore logarithmic progression, Naval Ship Expeditions across seas, 9 Upgrade Branches (Max Lv.25), Zero Emojis

import { MAP_W, MAP_H } from './worldRasterizer';
import { loadDataUrlToFlagBuffer } from './flagLibrary';
import { getOrCreateDeviceId, getMyCountryId, saveMyCountryId } from './networkSecurity';
import { SharedWorldSync } from './sharedWorldSync';

export const WORLD_SAVE_KEY = 'sf_shared_world_v9_clean';

export const UPGRADE_DEFINITIONS = [
  {
    key: 'mobilization',
    name: 'Seferberlik Hızı',
    desc: 'Her seviyede saniye başı asker üretim hızını +%5 artırır.',
    baseCost: 25,
    costScale: 1.38,
    maxLevel: 25,
  },
  {
    key: 'weapons',
    name: 'Taarruz Doktrini',
    desc: 'Her seviyede ordunun saldırı gücünü +%6 artırır; düşman toprağı alırken daha az asker harcarsın.',
    baseCost: 30,
    costScale: 1.38,
    maxLevel: 25,
  },
  {
    key: 'fortification',
    name: 'Sınır Tahkimatı',
    desc: 'Her seviyede topraklarının savunma direncini +%6 artırır; rakipler senden piksel alırken ağır kayıp verir.',
    baseCost: 30,
    costScale: 1.38,
    maxLevel: 25,
  },
  {
    key: 'citadel',
    name: 'Vatan Direnişi & Siper Ağı',
    desc: 'Her seviyede tüm topraklarının işgal direncini +%8 artırır; toprağına saldıranlar çok daha fazla asker harcar.',
    baseCost: 35,
    costScale: 1.38,
    maxLevel: 25,
  },
  {
    key: 'navy',
    name: 'Donanma & Tersane',
    desc: 'Her seviyede gemilerin deniz aşırı çıkarma menzilini +14 piksel ve gemi seyir hızını +%10 artırır.',
    baseCost: 30,
    costScale: 1.36,
    maxLevel: 25,
  },
  {
    key: 'logistics',
    name: 'Ordu Lojistiği',
    desc: 'Her seviyede maksimum asker depolama kapasitesini +%8 artırır.',
    baseCost: 25,
    costScale: 1.35,
    maxLevel: 25,
  },
  {
    key: 'economy',
    name: 'Vergi & Hazine',
    desc: 'Her seviyede halktan toplanan saniye başı altın gelirini +%6 artırır.',
    baseCost: 25,
    costScale: 1.35,
    maxLevel: 25,
  },
  {
    key: 'housing',
    name: 'İskan & Nüfus',
    desc: 'Her seviyede halk kapasitesini ve nüfus artış hızını +%7 artırır (Ek vergi katkısı sağlar).',
    baseCost: 20,
    costScale: 1.33,
    maxLevel: 25,
  },
  {
    key: 'siege',
    name: 'Kuşatma & Harekat',
    desc: 'Her seviyede sahipsiz gri toprakları fethetme asker maliyetini %2 düşürür.',
    baseCost: 40,
    costScale: 1.42,
    maxLevel: 25,
  },
];

export const DEFAULT_UPGRADES = {
  mobilization: 0,
  weapons: 0,
  fortification: 0,
  citadel: 0,
  navy: 0,
  logistics: 0,
  economy: 0,
  housing: 0,
  siege: 0,
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
    this.ships = []; // Active naval expeditions sailing across water
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

  // Check if a land pixel (x, y) borders sea/ocean
  isCoastalPixel(x, y) {
    if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) return false;
    const isLand = this.worldData.isLand;
    const idx = y * MAP_W + x;
    if (!isLand[idx]) return false;
    return (
      (x > 0 && !isLand[idx - 1]) ||
      (x < MAP_W - 1 && !isLand[idx + 1]) ||
      (y > 0 && !isLand[idx - MAP_W]) ||
      (y < MAP_H - 1 && !isLand[idx + MAP_W])
    );
  }

  // Check if straight line between (x0, y0) and (x1, y1) crosses sea/water and minimal land
  hasWaterPath(x0, y0, x1, y1) {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(4, Math.ceil(dist));
    let waterSamples = 0;
    const isLand = this.worldData.isLand;

    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const sx = Math.round(x0 + (x1 - x0) * t);
      const sy = Math.round(y0 + (y1 - y0) * t);
      if (sx >= 0 && sx < MAP_W && sy >= 0 && sy < MAP_H) {
        if (!isLand[sy * MAP_W + sx]) {
          waterSamples++;
        }
      }
    }
    // Must traverse at least 45% water cells along the route
    return waterSamples >= Math.max(1, Math.floor((steps - 1) * 0.45));
  }

  // Find nearest owned coastal pixel (port) to launch a ship toward (targetX, targetY)
  findNearestOwnedPort(countryId, targetX, targetY) {
    const b = (this.countryBounds || this.computeCountryBounds()).get(countryId);
    if (!b || b.count === 0) return null;

    let bestPort = null;
    let bestDist = Infinity;

    for (let y = b.minY; y <= b.maxY; y++) {
      const row = y * MAP_W;
      for (let x = b.minX; x <= b.maxX; x++) {
        if (this.owners[row + x] === countryId && this.isCoastalPixel(x, y)) {
          const d = Math.hypot(targetX - x, targetY - y);
          if (d < bestDist) {
            bestDist = d;
            bestPort = { x, y, distance: d };
          }
        }
      }
    }
    return bestPort;
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

    // 1. Asker Kapasitesi = Toprak Sayısı * (1 + Lojistik * %8)
    c.capacity = Math.max(1, Math.floor(c.landCount * (1 + (up.logistics || 0) * 0.08)));

    // 2. Asker Üretim Hızı (Logaritmik Azalan Getiri Formülü + Seferberlik * %5)
    const baseRate = (1.0 + 0.85 * Math.log(Math.max(1, c.landCount))) / 30.0;
    c.productionRate = baseRate * (1 + (up.mobilization || 0) * 0.05);

    // 3. Otomatik Halk (Nüfus) & Vergi (Altın) Üretimi
    c.maxPopulation = Math.floor(c.landCount * 15 * (1 + (up.housing || 0) * 0.07));
    c.popGrowthRate = (0.12 + 0.03 * Math.log(c.landCount + 1)) * (1 + (up.housing || 0) * 0.07);

    const popBonus = 1 + Math.min(0.5, (c.population || 15) / 2500);
    c.goldIncome =
      (0.08 + 0.14 * Math.log(c.landCount + 1)) *
      (1 + (up.economy || 0) * 0.06) *
      popBonus;

    // 4. Saldırı & Savunma Gücü (Tüm topraklarda eşit savunma; Başkent ayrımı yoktur!)
    c.attackPower = 1.0 + (up.weapons || 0) * 0.06;
    const underdogBonus = c.landCount < 40 ? 0.35 : c.landCount < 100 ? 0.15 : 0;
    c.defensePower =
      1.0 +
      (up.fortification || 0) * 0.06 +
      (up.citadel || 0) * 0.08 +
      underdogBonus;

    // 5. Donanma Menzili & Gemi Hızı
    c.navalRange = 38 + (up.navy || 0) * 14;
    c.shipSpeed = 11 * (1 + (up.navy || 0) * 0.10);
  }

  getCountryCenter(countryId) {
    const bounds = this.countryBounds || this.computeCountryBounds();
    const b = bounds.get(countryId);
    if (b && b.count > 0) {
      return {
        x: Math.round(b.sumX / b.count),
        y: Math.round(b.sumY / b.count),
      };
    }
    const c = this.countryMap.get(countryId);
    return c ? { x: c.capitalX, y: c.capitalY } : { x: MAP_W / 2, y: MAP_H / 2 };
  }

  setCountryColor(countryId, newColor) {
    const country = this.countryMap.get(countryId);
    if (!country || !newColor) return { ok: false };
    country.color = newColor;
    this.dirtyPixels = true;
    this.saveState();

    this.sync.broadcast({
      type: 'SYNC_COUNTRY_STATS',
      countryId: country.id,
      stats: {
        color: country.color,
        gold: country.gold,
        population: country.population,
        troops: country.troops,
        upgrades: country.upgrades,
      },
    });
    return { ok: true };
  }

  // Real-time continuous simulation tick (Troops, Population, Gold & Naval Ships)
  update(deltaTimeSec) {
    if (deltaTimeSec <= 0 || deltaTimeSec > 1.0) deltaTimeSec = 0.05;

    for (const c of this.countries) {
      if (c.landCount <= 0) continue;

      this._recalculateDerivedStats(c);

      if (c.troops < c.capacity) {
        c.troops = Math.min(c.capacity, c.troops + c.productionRate * deltaTimeSec);
      }

      if (c.population < c.maxPopulation) {
        c.population = Math.min(c.maxPopulation, c.population + c.popGrowthRate * deltaTimeSec);
      }

      c.gold += c.goldIncome * deltaTimeSec;
    }

    // Update sailing ships across oceans/seas
    if (this.ships.length > 0) {
      const remainingShips = [];
      for (const ship of this.ships) {
        ship.progress += (ship.speed * deltaTimeSec) / Math.max(1, ship.distance);
        ship.x = ship.fromX + (ship.toX - ship.fromX) * Math.min(1, ship.progress);
        ship.y = ship.fromY + (ship.toY - ship.fromY) * Math.min(1, ship.progress);

        if (ship.progress >= 1.0) {
          // Ship has arrived at target shore -> execute amphibious landing!
          this._completeNavalLanding(ship);
        } else {
          remainingShips.push(ship);
        }
      }
      this.ships = remainingShips;
    }
  }

  _completeNavalLanding(ship) {
    const country = this.countryMap.get(ship.countryId);
    if (!country || country.landCount <= 0) return;

    const idx = ship.toY * MAP_W + ship.toX;
    const prevOwner = this.owners[idx];
    if (prevOwner === ship.countryId) return;

    this.owners[idx] = ship.countryId;
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
    this.onSound('celebration');
    if (ship.countryId === this.myCountryId) {
      this.onEvent(`Donanman karşı kıyıya çıkarma yaptı! (${ship.toX}, ${ship.toY})`);
    }

    this.sync.broadcast({
      type: 'CONQUER_PIXEL',
      countryId: ship.countryId,
      x: ship.toX,
      y: ship.toY,
      cost: 0,
    });

    this.saveState();
  }

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
    this.onEvent(`${def.name} Seviye ${currentLevel + 1} oldu!`);
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

  // Check if pixel (x, y) can be conquered by land OR by naval ship expedition
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

    // 1. Check 4-way land adjacency
    const isAdjacent =
      (x > 0 && this.owners[idx - 1] === countryId) ||
      (x < MAP_W - 1 && this.owners[idx + 1] === countryId) ||
      (y > 0 && this.owners[idx - MAP_W] === countryId) ||
      (y < MAP_H - 1 && this.owners[idx + MAP_W] === countryId);

    const isEnemy = currentOwner > 0;
    let baseCost = 1.0;

    if (!isEnemy) {
      const siegeLevel = attacker.upgrades?.siege || 0;
      baseCost = Math.max(0.5, Number((1.0 - siegeLevel * 0.02).toFixed(2)));
    } else {
      const defender = this.countryMap.get(currentOwner);
      const defPower = defender ? (defender.defensePower || 1.0) : 1.0;
      const atkPower = attacker.attackPower || 1.0;
      baseCost = Math.max(1.0, Number(((2.0 * defPower) / atkPower).toFixed(2)));
    }

    if (isAdjacent) {
      return {
        valid: true,
        isNaval: false,
        cost: baseCost,
        isEnemy,
        targetOwnerId: currentOwner,
      };
    }

    // 2. Not adjacent on land -> Check if reachable across water via Naval Ship Expedition!
    if (!this.isCoastalPixel(x, y)) {
      return {
        valid: false,
        reason: 'Sadece sınırındaki komşu pikselleri veya deniz aşırı kıyı şeritlerini (gemiyle) fethedebilirsin.',
      };
    }

    const nearestPort = this.findNearestOwnedPort(countryId, x, y);
    if (!nearestPort) {
      return {
        valid: false,
        reason: 'Deniz aşırı gemi göndermek için önce denize kıyısı olan bir toprağa sahip olmalısın!',
      };
    }

    const maxRange = attacker.navalRange || 38;
    if (nearestPort.distance > maxRange) {
      return {
        valid: false,
        reason: `Hedef kıyı donanma menzili dışında! (Mesafe: ${Math.round(nearestPort.distance)}, Menzil: ${maxRange} • Donanma geliştir)`,
      };
    }

    if (!this.hasWaterPath(nearestPort.x, nearestPort.y, x, y)) {
      return {
        valid: false,
        reason: 'Gemi rotası deniz üzerinden geçmelidir.',
      };
    }

    const navalCost = Number((baseCost + 1.0).toFixed(2));

    return {
      valid: true,
      isNaval: true,
      portX: nearestPort.x,
      portY: nearestPort.y,
      distance: nearestPort.distance,
      cost: navalCost,
      isEnemy,
      targetOwnerId: currentOwner,
    };
  }

  // Conquer single pixel (instant on adjacent land, or dispatches a sailing Ship across the sea!)
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

    // Naval Ship Expedition across sea/ocean
    if (check.isNaval) {
      // Prevent duplicate ship to same target pixel
      const alreadySailing = this.ships.some(
        (s) => s.countryId === countryId && s.toX === x && s.toY === y
      );
      if (alreadySailing) {
        return { ok: false, reason: 'Bu kıyıya zaten bir çıkarma gemisi ilerliyor!' };
      }

      country.troops = Math.max(0, country.troops - check.cost);
      const ship = {
        id: 'ship_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        countryId,
        color: country.color || '#38BDF8',
        fromX: check.portX,
        fromY: check.portY,
        toX: x,
        toY: y,
        x: check.portX,
        y: check.portY,
        distance: check.distance,
        speed: country.shipSpeed || 11,
        progress: 0,
      };
      this.ships.push(ship);
      this.onSound('pencil');
      this.onEvent(`Çıkarma gemisi denize açıldı! Hedef kıyıya ilerliyor...`);
      this.saveState();
      return { ok: true, isNaval: true, ship, country };
    }

    // Adjacent Land Conquest
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
    return { ok: true, isNaval: false, country };
  }

  async foundCountry({ name, color, flagDataUrl, capitalX, capitalY, creatorIp }) {
    const idx = capitalY * MAP_W + capitalX;
    if (!this.worldData.isLand[idx]) {
      return { ok: false, reason: 'Denize devlet kurulamaz!' };
    }
    if (this.owners[idx] !== 0) {
      return { ok: false, reason: 'Bu piksel zaten başka bir devlete ait!' };
    }

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
      troops: 1.0,
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
    this.onEvent(`${country.name} kuruldu!`);

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
      country.troops = Math.max(0, country.troops - (cost || 0));
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
    if (stats.color) {
      country.color = stats.color;
      this.dirtyPixels = true;
    }
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
        v: 9,
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
      if (!localStorage.getItem('sf_world_reset_v9_done')) {
        localStorage.removeItem('sf_shared_world_v4_data');
        localStorage.removeItem('sf_shared_world_v5_worldbox');
        localStorage.removeItem('sf_shared_world_v7_fresh');
        localStorage.removeItem('sf_shared_world_v8_clean');
        localStorage.removeItem('sf_my_country_id');
        localStorage.setItem('sf_world_reset_v9_done', '1');
        return false;
      }

      const raw = localStorage.getItem(WORLD_SAVE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (data.v !== 9 || data.w !== MAP_W || data.h !== MAP_H || !Array.isArray(data.rle)) {
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
