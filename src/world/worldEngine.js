// Real-Time Shared World MMO Conquest Engine
// Hardcore logarithmic progression, Naval Ship Expeditions across seas, 9 Upgrade Branches (Max Lv.25), Zero Emojis

import { MAP_W, MAP_H } from "./worldRasterizer";
import { loadDataUrlToFlagBuffer } from "./flagLibrary";
import {
  getOrCreateDeviceId,
  getMyCountryId,
  saveMyCountryId,
} from "./networkSecurity";
import { SharedWorldSync } from "./sharedWorldSync";

export const WORLD_SAVE_KEY = "sf_shared_world_v9_clean";

export const UPGRADE_DEFINITIONS = [
  {
    key: "mobilization",
    name: "Seferberlik Hızı",
    desc: "Her seviyede saniye başı asker üretim hızını +%5 artırır.",
    baseCost: 25,
    costScale: 1.38,
    maxLevel: 25,
  },
  {
    key: "weapons",
    name: "Taarruz Doktrini",
    desc: "Her seviyede ordunun saldırı gücünü +%6 artırır; düşman toprağı alırken daha az asker harcarsın.",
    baseCost: 30,
    costScale: 1.38,
    maxLevel: 25,
  },
  {
    key: "fortification",
    name: "Sınır Tahkimatı",
    desc: "Her seviyede topraklarının savunma direncini +%6 artırır; rakipler senden piksel alırken ağır kayıp verir.",
    baseCost: 30,
    costScale: 1.38,
    maxLevel: 25,
  },
  {
    key: "citadel",
    name: "Vatan Direnişi & Siper Ağı",
    desc: "Her seviyede tüm topraklarının işgal direncini +%8 artırır; toprağına saldıranlar çok daha fazla asker harcar.",
    baseCost: 35,
    costScale: 1.38,
    maxLevel: 25,
  },
  {
    key: "navy",
    name: "Donanma & Tersane",
    desc: "Her seviyede gemilerin deniz aşırı çıkarma menzilini +14 piksel ve gemi seyir hızını +%10 artırır.",
    baseCost: 30,
    costScale: 1.36,
    maxLevel: 25,
  },
  {
    key: "logistics",
    name: "Ordu Lojistiği",
    desc: "Her seviyede maksimum asker depolama kapasitesini +%8 artırır.",
    baseCost: 25,
    costScale: 1.35,
    maxLevel: 25,
  },
  {
    key: "economy",
    name: "Vergi & Hazine",
    desc: "Her seviyede halktan toplanan saniye başı altın gelirini +%6 artırır.",
    baseCost: 25,
    costScale: 1.35,
    maxLevel: 25,
  },
  {
    key: "housing",
    name: "İskan & Nüfus",
    desc: "Her seviyede halk kapasitesini ve nüfus artış hızını +%7 artırır (Ek vergi katkısı sağlar).",
    baseCost: 20,
    costScale: 1.33,
    maxLevel: 25,
  },
  {
    key: "siege",
    name: "Kuşatma & Harekat",
    desc: "Her seviyede sahipsiz gri toprakları fethetme asker maliyetini %2 düşürür.",
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
    this.onChat = callbacks.onChat || (() => {});

    const total = MAP_W * MAP_H;
    this.owners = new Int16Array(total);
    for (let i = 0; i < total; i++) {
      this.owners[i] = worldData.isLand[i] ? 0 : -1;
    }

    this.countries = [];
    this.countryMap = new Map();
    this.ships = []; // Active naval expeditions sailing across water
    this.chatMessages = [];
    this.undoStack = []; // 5-second undo stack for recent pixel conquests
    this.myDeviceId = getOrCreateDeviceId();
    this.myCountryId = null;

    this.dirtyPixels = true;
    this.dirtyRegions = true;

    // 100% Server-Backed Global World: purge any legacy localStorage world/chat caches
    this._clearLegacyLocalWorldCache();

    this.sync = new SharedWorldSync(this, () => {
      this.dirtyPixels = true;
      this.dirtyRegions = true;
    });
  }

  _clearLegacyLocalWorldCache() {
    try {
      localStorage.removeItem("sf_shared_world_v4_data");
      localStorage.removeItem("sf_shared_world_v5_worldbox");
      localStorage.removeItem("sf_shared_world_v7_fresh");
      localStorage.removeItem("sf_shared_world_v8_clean");
      localStorage.removeItem(WORLD_SAVE_KEY);
      localStorage.removeItem("sf_global_chat_v1");
    } catch {}
  }

  restoreMyCountryFromServer(clientIp = null) {
    const storedId = getMyCountryId();
    if (storedId) {
      const parsed = parseInt(storedId, 10);
      if (this.countryMap.has(parsed)) {
        const c = this.countryMap.get(parsed);
        if (c && c.landCount > 0) {
          this.myCountryId = parsed;
          c.deviceId = this.myDeviceId;
          return;
        }
      }
    }
    const devCountry = this.countries.find(
      (c) => c.deviceId === this.myDeviceId && c.landCount > 0,
    );
    if (devCountry) {
      this.myCountryId = devCountry.id;
      saveMyCountryId(devCountry.id);
      this.processOfflineProgress();
      return;
    }
    // Auto-recovery via IP address (if friend opened Chrome on mobile and cookies/localStorage were wiped)
    if (clientIp && clientIp !== "127.0.0.1" && clientIp !== "unknown") {
      const ipCountry = this.countries.find(
        (c) => c.creatorIp === clientIp && c.landCount > 0,
      );
      if (ipCountry) {
        this.myCountryId = ipCountry.id;
        ipCountry.deviceId = this.myDeviceId;
        saveMyCountryId(ipCountry.id);
        this.onEvent(
          `${ipCountry.name} devletinin yönetimi IP üzerinden Chrome'a otomatik bağlandı!`,
        );
        this.processOfflineProgress();
      }
    }
  }

  // Process continuous offline troop, gold & population earnings up to capacity!
  processOfflineProgress() {
    const c = this.getMyCountry();
    if (!c || c.landCount <= 0) return null;

    const now = Date.now();
    let lastTime = 0;
    try {
      const stored = localStorage.getItem(`sf_last_active_${c.id}`);
      if (stored) lastTime = parseInt(stored, 10);
    } catch {}

    if (!lastTime || Number.isNaN(lastTime)) {
      lastTime = c.lastActiveTime || c._lastStatsTime || c._lastSyncTime || now;
    }

    // Cap offline time calculation to 7 days
    const elapsedSec = Math.max(
      0,
      Math.min(3600 * 24 * 7, (now - lastTime) / 1000),
    );
    c.lastActiveTime = now;
    try {
      localStorage.setItem(`sf_last_active_${c.id}`, String(now));
    } catch {}

    if (elapsedSec < 15) return null; // Ignore brief page reloads under 15 seconds

    this._recalculateDerivedStats(c);

    // Calculate offline troops strictly up to capacity (Zero offline gold so economy remains balanced!)
    const availableCapacity = Math.max(0, c.capacity - c.troops);
    const troopsProduced = Math.min(
      availableCapacity,
      c.productionRate * elapsedSec,
    );
    const popSpace = Math.max(0, c.maxPopulation - c.population);
    const popGrown = Math.min(popSpace, c.popGrowthRate * elapsedSec);

    if (troopsProduced > 0.5) {
      c.troops = Math.min(
        c.capacity,
        Number((c.troops + troopsProduced).toFixed(1)),
      );
      c.population = Math.min(
        c.maxPopulation,
        Math.floor(c.population + popGrown),
      );

      const elapsedMin = Math.floor(elapsedSec / 60);
      const timeStr =
        elapsedMin >= 60
          ? `${Math.floor(elapsedMin / 60)} saat ${elapsedMin % 60} dk`
          : `${elapsedMin} dakika`;

      this.onSound("celebration");
      this.onEvent(
        `🎖️ Çevrimdışı Kışla Desteği (${timeStr}): Ordu kışlanda +${Math.floor(troopsProduced)} asker hazırlandı! (Asker: ${Math.floor(c.troops)}/${c.capacity})`,
      );

      this.sync.broadcast({
        type: "SYNC_COUNTRY_STATS",
        countryId: c.id,
        stats: {
          troops: Number(c.troops.toFixed(1)),
          gold: Math.floor(c.gold),
          population: Math.floor(c.population),
          color: c.color,
          upgrades: c.upgrades,
          lastActiveTime: now,
        },
      });

      return {
        troops: Math.floor(troopsProduced),
        elapsedSec,
        timeStr,
      };
    }
    return null;
  }

  loadChatMessages() {}

  saveChatMessages() {}

  handleRemoteChatMessage(chat) {
    if (!chat || !chat.id) return;
    if (this.chatMessages.some((m) => m.id === chat.id)) return;
    this.chatMessages.push(chat);
    if (this.chatMessages.length > 50) {
      this.chatMessages.shift();
    }
    this.onChat(this.chatMessages);
  }

  cleanupInactiveCountries() {
    const total = MAP_W * MAP_H;
    const activeIds = new Set();
    for (let i = 0; i < total; i++) {
      const o = this.owners[i];
      if (o > 0) activeIds.add(o);
    }
    const seenIds = new Set();
    const cleanList = [];
    for (const c of this.countries) {
      if (activeIds.has(c.id) && !seenIds.has(c.id)) {
        seenIds.add(c.id);
        cleanList.push(c);
      }
    }
    const beforeCount = this.countries.length;
    this.countries = cleanList;
    this.countryMap.clear();
    for (const c of this.countries) {
      this.countryMap.set(c.id, c);
    }
    if (this.countries.length !== beforeCount) {
      this.dirtyPixels = true;
      this.dirtyRegions = true;
    }
  }

  getMyCountry() {
    if (!this.myCountryId) {
      const storedId = getMyCountryId();
      if (storedId) {
        this.myCountryId = parseInt(storedId, 10);
      } else {
        const devCountry = this.countries.find(
          (c) => c.deviceId === this.myDeviceId,
        );
        if (devCountry) {
          this.myCountryId = devCountry.id;
          saveMyCountryId(devCountry.id);
        }
      }
    }
    return this.countryMap.get(this.myCountryId) || null;
  }

  // Cleanly abandon current country so the player can found a new one without auto-reattaching
  abandonMyCountry() {
    const c = this.getMyCountry();
    if (c) {
      c.deviceId = null;
      this.sync.broadcast({
        type: "SYNC_COUNTRY_STATS",
        countryId: c.id,
        stats: {
          troops: Number(c.troops.toFixed(1)),
          gold: Math.floor(c.gold),
          population: Math.floor(c.population),
          color: c.color,
          upgrades: c.upgrades,
        },
      });
    }
    this.myCountryId = null;
    try {
      localStorage.removeItem("sf_my_country_id");
    } catch {}
    this.saveState();
  }

  // Link this app/browser instance to an existing country created by the player (e.g. Web -> Android App)
  claimExistingCountry(countryId) {
    const c = this.countryMap.get(countryId);
    if (!c || c.landCount <= 0)
      return { ok: false, reason: "Devlet bulunamadı." };
    this.myCountryId = c.id;
    c.deviceId = this.myDeviceId;
    saveMyCountryId(c.id);
    this.scheduleSave();
    this.onEvent(`${c.name} devletinin yönetimi bu cihaza bağlandı!`);
    this.processOfflineProgress();
    return { ok: true, country: c };
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
    if (this.dirtyRegions || !this.countryBounds) {
      this.computeCountryBounds();
    }
    const b = this.countryBounds?.get(countryId);
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
    c.population =
      typeof c.population === "number" ? Math.max(10, c.population) : 10;
    c.gold = typeof c.gold === "number" ? Math.max(0, c.gold) : 0;
    c.troops = typeof c.troops === "number" ? Math.max(0, c.troops) : 1.0;
    this._recalculateDerivedStats(c);
    return c;
  }

  _recalculateDerivedStats(c) {
    const up = c.upgrades || DEFAULT_UPGRADES;

    // 1. Asker Kapasitesi = Toprak Sayısı * (1 + Lojistik * %8)
    c.capacity = Math.max(
      1,
      Math.floor(c.landCount * (1 + (up.logistics || 0) * 0.08)),
    );

    // 2. Asker Üretim Hızı (Logaritmik Azalan Getiri Formülü + Seferberlik * %5)
    const baseRate = (1.0 + 0.85 * Math.log(Math.max(1, c.landCount))) / 30.0;
    c.productionRate = baseRate * (1 + (up.mobilization || 0) * 0.05);

    // 3. Otomatik Halk (Nüfus) & Vergi (Altın) Üretimi
    c.maxPopulation = Math.floor(
      c.landCount * 15 * (1 + (up.housing || 0) * 0.07),
    );
    c.popGrowthRate =
      (0.12 + 0.03 * Math.log(c.landCount + 1)) *
      (1 + (up.housing || 0) * 0.07);

    const popBonus = 1 + Math.min(0.25, (c.population || 15) / 3500);
    c.goldIncome =
      (0.04 + 0.08 * Math.log(c.landCount + 1)) *
      (1 + (up.economy || 0) * 0.05) *
      popBonus;

    // 4. Saldırı & Savunma Gücü (Tüm topraklarda eşit savunma; Başkent ayrımı yoktur!)
    c.attackPower = 1.0 + (up.weapons || 0) * 0.06;
    const underdogBonus =
      c.landCount < 40 ? 0.35 : c.landCount < 100 ? 0.15 : 0;
    c.defensePower =
      1.0 +
      (up.fortification || 0) * 0.06 +
      (up.citadel || 0) * 0.08 +
      underdogBonus;

    // 5. Donanma Menzili & Gemi Hızı
    c.navalRange = 38 + (up.navy || 0) * 14;
    c.shipSpeed = 11 * (1 + (up.navy || 0) * 0.1);
  }

  getCountryCenter(countryId) {
    if (this.dirtyRegions || !this.countryBounds) {
      this.computeCountryBounds();
    }
    const bounds = this.countryBounds;
    const b = bounds ? bounds.get(countryId) : null;
    if (
      b &&
      b.count > 0 &&
      Number.isFinite(b.sumX) &&
      Number.isFinite(b.sumY)
    ) {
      return {
        x: Math.round(b.sumX / b.count),
        y: Math.round(b.sumY / b.count),
      };
    }
    const c = this.countryMap.get(countryId);
    const cx = c && Number.isFinite(c.capitalX) ? c.capitalX : MAP_W / 2;
    const cy = c && Number.isFinite(c.capitalY) ? c.capitalY : MAP_H / 2;
    return { x: cx, y: cy };
  }

  setCountryColor(countryId, newColor) {
    const country = this.countryMap.get(countryId);
    if (!country || !newColor) return { ok: false };
    country.color = newColor;
    this.dirtyPixels = true;
    this.saveState();

    this.sync.broadcast({
      type: "SYNC_COUNTRY_STATS",
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

      // Continuous troop production runs for both active and offline countries up to their capacity limit!
      if (c.troops < c.capacity) {
        c.troops = Math.min(
          c.capacity,
          c.troops + c.productionRate * deltaTimeSec,
        );
      }

      if (c.population < c.maxPopulation) {
        c.population = Math.min(
          c.maxPopulation,
          c.population + c.popGrowthRate * deltaTimeSec,
        );
      }

      const isMyCountry = c.id === this.myCountryId;
      if (isMyCountry) {
        c.gold += c.goldIncome * deltaTimeSec;
        c.lastActiveTime = Date.now();
        if (
          !this._lastActivePersist ||
          Date.now() - this._lastActivePersist > 8000
        ) {
          this._lastActivePersist = Date.now();
          try {
            localStorage.setItem(`sf_last_active_${c.id}`, String(Date.now()));
          } catch {}
        }
      }
    }

    // Update sailing ships across oceans/seas
    if (this.ships.length > 0) {
      const remainingShips = [];
      for (const ship of this.ships) {
        ship.progress +=
          (ship.speed * deltaTimeSec) / Math.max(1, ship.distance);
        ship.x =
          ship.fromX + (ship.toX - ship.fromX) * Math.min(1, ship.progress);
        ship.y =
          ship.fromY + (ship.toY - ship.fromY) * Math.min(1, ship.progress);

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

    if (ship.countryId === this.myCountryId) {
      this.onSound("celebration");
      this.onEvent(
        `Donanman karşı kıyıya çıkarma yaptı! (${ship.toX}, ${ship.toY})`,
      );
      this.sync.broadcast({
        type: "CONQUER_PIXEL",
        countryId: ship.countryId,
        x: ship.toX,
        y: ship.toY,
        cost: 0,
      });
    }

    this.scheduleSave();
  }

  buyUpgrade(countryId, upgradeKey) {
    const country = this.countryMap.get(countryId);
    if (!country) return { ok: false, reason: "Devlet bulunamadı." };

    const def = UPGRADE_DEFINITIONS.find((u) => u.key === upgradeKey);
    if (!def) return { ok: false, reason: "Geliştirme bulunamadı." };

    const currentLevel = country.upgrades?.[upgradeKey] || 0;
    if (currentLevel >= def.maxLevel) {
      return { ok: false, reason: "Maksimum seviyeye ulaşıldı!" };
    }

    const cost = Math.round(
      def.baseCost * Math.pow(def.costScale, currentLevel),
    );
    if (country.gold < cost) {
      return { ok: false, reason: `Yetersiz Altın! (${cost} Altın gerekli)` };
    }

    country.gold -= cost;
    country.upgrades[upgradeKey] = currentLevel + 1;
    this._recalculateDerivedStats(country);
    this.onSound("celebration");
    this.onEvent(`${def.name} Seviye ${currentLevel + 1} oldu!`);
    this.saveState();

    this.sync.broadcast({
      type: "SYNC_COUNTRY_STATS",
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

  // Check if country has any internal holes/cavities inside its bounding box
  hasInternalCavities(countryId) {
    const b = this.countryBounds ? this.countryBounds.get(countryId) : null;
    if (!b || b.count < 8) return false;
    const minX = Math.max(0, b.minX);
    const maxX = Math.min(MAP_W - 1, b.maxX);
    const minY = Math.max(0, b.minY);
    const maxY = Math.min(MAP_H - 1, b.maxY);

    for (let py = minY; py <= maxY; py++) {
      const row = py * MAP_W;
      for (let px = minX; px <= maxX; px++) {
        const idx = row + px;
        if (this.owners[idx] === 0 && this.worldData.isLand[idx]) {
          const ownedNeighbors =
            (px > 0 && this.owners[idx - 1] === countryId ? 1 : 0) +
            (px < MAP_W - 1 && this.owners[idx + 1] === countryId ? 1 : 0) +
            (py > 0 && this.owners[idx - MAP_W] === countryId ? 1 : 0) +
            (py < MAP_H - 1 && this.owners[idx + MAP_W] === countryId ? 1 : 0);
          if (ownedNeighbors >= 3) {
            return true;
          }
        }
      }
    }
    return false;
  }

  // Check if pixel (x, y) can be conquered by land OR by naval ship expedition
  canExpandToPixel(countryId, x, y) {
    if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) {
      return { valid: false, reason: "Harita dışı." };
    }

    const idx = y * MAP_W + x;
    if (!this.worldData.isLand[idx]) {
      return { valid: false, reason: "Deniz veya okyanus fethedilemez." };
    }

    const currentOwner = this.owners[idx];
    if (currentOwner === countryId) {
      return { valid: false, reason: "Zaten senin toprağın." };
    }

    const attacker = this.countryMap.get(countryId);
    if (!attacker) return { valid: false, reason: "Devlet bulunamadı." };

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
      const defPower = defender ? defender.defensePower || 1.0 : 1.0;
      const atkPower = attacker.attackPower || 1.0;
      baseCost = Math.max(
        1.0,
        Number(((2.0 * defPower) / atkPower).toFixed(2)),
      );
    }

    if (isAdjacent) {
      // Check if country has internal holes/cavities inside its territory
      // If (x, y) has < 3 owned neighbors (an outer border pixel), but the country has internal hollow holes with 3+ owned neighbors,
      // force the player to conquer their internal holes first so the country never has empty holes!
      const ownedNeighborsCount =
        (x > 0 && this.owners[idx - 1] === countryId ? 1 : 0) +
        (x < MAP_W - 1 && this.owners[idx + 1] === countryId ? 1 : 0) +
        (y > 0 && this.owners[idx - MAP_W] === countryId ? 1 : 0) +
        (y < MAP_H - 1 && this.owners[idx + MAP_W] === countryId ? 1 : 0);

      if (ownedNeighborsCount < 3 && this.hasInternalCavities(countryId)) {
        return {
          valid: false,
          reason:
            "Devletinin içinde boşluk varken dışarıya büyüyemezsin! Önce içteki boşluk piksellerini fethet.",
        };
      }

      if (this.isSnakingConquest(countryId, x, y)) {
        return {
          valid: false,
          reason:
            "Devletini yılan gibi tek piksel uzatamazsın! Sınırlarını kalınlaştırarak büyümelisin.",
        };
      }

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
        reason:
          "Sadece sınırındaki komşu pikselleri veya deniz aşırı kıyı şeritlerini (gemiyle) fethedebilirsin.",
      };
    }

    const nearestPort = this.findNearestOwnedPort(countryId, x, y);
    if (!nearestPort) {
      return {
        valid: false,
        reason:
          "Deniz aşırı gemi göndermek için önce denize kıyısı olan bir toprağa sahip olmalısın!",
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
        reason: "Gemi rotası deniz üzerinden geçmelidir.",
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

  // Prevent 1-pixel wide snaking across open land, while allowing natural solid expansion and naval beachheads to grow!
  isSnakingConquest(countryId, x, y) {
    const country = this.countryMap.get(countryId);
    if (!country || country.landCount < 6) return false;

    let ownedNeighbors = 0;
    let singleNeighbor = null;

    const dirs = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];

    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < MAP_W && ny >= 0 && ny < MAP_H) {
        if (this.owners[ny * MAP_W + nx] === countryId) {
          ownedNeighbors++;
          singleNeighbor = { x: nx, y: ny };
        }
      }
    }

    // Touching 2 or more owned cardinal neighbors thickens or connects borders (never snaking)
    if (ownedNeighbors >= 2) return false;
    if (ownedNeighbors === 0 || !singleNeighbor) return false;

    // Check diagonal neighbors around (x, y) belonging to country
    let diagonalOwned = 0;
    const diagDirs = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ];
    for (const [dx, dy] of diagDirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < MAP_W && ny >= 0 && ny < MAP_H) {
        if (this.owners[ny * MAP_W + nx] === countryId) {
          diagonalOwned++;
        }
      }
    }

    // If (x, y) touches at least 1 diagonal owned pixel in addition to the cardinal neighbor,
    // it's forming a 2x2 corner or solid block, which is allowed!
    if (diagonalOwned >= 1) return false;

    // (x, y) touches ONLY 1 single neighbor in its entire 3x3 neighborhood!
    // Check if that single neighbor itself is an isolated beachhead (< 6 connected pixels)
    const startIdx = singleNeighbor.y * MAP_W + singleNeighbor.x;
    const visited = new Set([startIdx]);
    const queue = [startIdx];
    let head = 0;
    while (head < queue.length && visited.size < 6) {
      const cur = queue[head++];
      const cx = cur % MAP_W;
      const cy = (cur / MAP_W) | 0;
      for (const [dx, dy] of dirs) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx >= 0 && nx < MAP_W && ny >= 0 && ny < MAP_H) {
          const nIdx = ny * MAP_W + nx;
          if (this.owners[nIdx] === countryId && !visited.has(nIdx)) {
            visited.add(nIdx);
            queue.push(nIdx);
          }
        }
      }
    }
    // If the entire connected island/beachhead has < 6 pixels, allow it to establish a foothold
    if (visited.size < 6) {
      return false;
    }

    // Check singleNeighbor's cardinal neighbors:
    let neighborCardinalOwned = 0;
    for (const [dx, dy] of dirs) {
      const nx = singleNeighbor.x + dx;
      const ny = singleNeighbor.y + dy;
      if (nx >= 0 && nx < MAP_W && ny >= 0 && ny < MAP_H) {
        if (this.owners[ny * MAP_W + nx] === countryId) {
          neighborCardinalOwned++;
        }
      }
    }

    // If singleNeighbor has <= 1 cardinal owned neighbor, singleNeighbor is already a 1-pixel tip!
    // Adding (x, y) to it would extend a 1-pixel snake line into the void. Block it!
    if (neighborCardinalOwned <= 1) {
      return true;
    }

    // Also check singleNeighbor's 3x3 support:
    let neighbor3x3Support = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const px = singleNeighbor.x + dx;
        const py = singleNeighbor.y + dy;
        if (px >= 0 && px < MAP_W && py >= 0 && py < MAP_H) {
          if (this.owners[py * MAP_W + px] === countryId) {
            neighbor3x3Support++;
          }
        }
      }
    }

    // In solid land, a valid border neighbor should have at least 3 owned pixels supporting it
    return neighbor3x3Support <= 2;
  }

  // Conquer single pixel (instant on adjacent land, or dispatches a sailing Ship across the sea!)
  conquerPixel(countryId, x, y) {
    const country = this.countryMap.get(countryId);
    if (!country) return { ok: false, reason: "Devlet bulunamadı." };

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
        (s) => s.countryId === countryId && s.toX === x && s.toY === y,
      );
      if (alreadySailing) {
        return {
          ok: false,
          reason: "Bu kıyıya zaten bir çıkarma gemisi ilerliyor!",
        };
      }

      country.troops = Math.max(0, country.troops - check.cost);
      const ship = {
        id: "ship_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
        countryId,
        color: country.color || "#38BDF8",
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
      this.onSound("pencil");
      this.onEvent(`Çıkarma gemisi denize açıldı! Hedef kıyıya ilerliyor...`);

      this.sync.broadcast({
        type: "LAUNCH_SHIP",
        ship,
      });

      this.saveState();
      return { ok: true, isNaval: true, ship, country };
    }

    // Adjacent Land Conquest
    const idx = y * MAP_W + x;
    const prevOwner = this.owners[idx];

    // Check if this move encloses any neutral cavity pockets
    const enclosed = this.findEnclosedCavitiesForMove(countryId, x, y);
    const siegeLevel = country.upgrades?.siege || 0;
    const costPerCavityPixel = Math.max(
      0.5,
      Number((1.0 - siegeLevel * 0.02).toFixed(2)),
    );
    const cavityTotalCost = Number(
      (enclosed.length * costPerCavityPixel).toFixed(2),
    );
    const totalCost = Number((check.cost + cavityTotalCost).toFixed(2));

    // Never auto-grant free pixels: ensure sufficient troops for every single pixel!
    // Prevent creating hollow gaps: if player doesn't have enough troops for the cavity, block the encirclement!
    if (country.troops < totalCost) {
      if (enclosed.length > 0) {
        return {
          ok: false,
          reason: `Devletinin içinde boşluk bırakamazsın! Çevrelenen ${enclosed.length} iç pikseli fethetmek için toplam ${totalCost.toFixed(1)} asker gerekiyor (Sende: ${country.troops.toFixed(1)} asker var).`,
        };
      }
      return {
        ok: false,
        reason: `Yetersiz asker! (${check.cost} asker gerekli, sende ${country.troops.toFixed(1)} var)`,
      };
    }

    // Deduct exact total troops for both the clicked border pixel + all enclosed cavity pixels
    country.troops = Math.max(0, country.troops - totalCost);
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
        this.dirtyRegions = true;
      }
    }
    this._expandCountryBound(countryId, x, y);

    const filledCavities = [];
    for (const cIdx of enclosed) {
      this.owners[cIdx] = countryId;
      const px = cIdx % MAP_W;
      const py = (cIdx / MAP_W) | 0;
      this._expandCountryBound(countryId, px, py);
      filledCavities.push({ x: px, y: py });
      country.landCount++;
      country.population += 3;

      this.sync.broadcast({
        type: "CONQUER_PIXEL",
        countryId,
        x: px,
        y: py,
        cost: costPerCavityPixel,
      });
    }

    // Record for 5-Second Undo if this was our own country (including any filled cavities)
    if (countryId === this.myCountryId) {
      this.undoStack.push({
        countryId,
        x,
        y,
        prevOwner,
        cost: check.cost,
        cavities: filledCavities,
        time: Date.now(),
      });
      const cutoff = Date.now() - 5000;
      this.undoStack = this.undoStack.filter((u) => u.time >= cutoff);
    }

    this._recalculateDerivedStats(country);

    this.dirtyPixels = true;
    this.onSound("pencil");

    if (filledCavities.length > 0) {
      this.onEvent(
        `Çevrelenen ${filledCavities.length} iç piksel ${cavityTotalCost.toFixed(1)} asker harcanarak fethedildi!`,
      );
    }

    this.sync.broadcast({
      type: "CONQUER_PIXEL",
      countryId,
      x,
      y,
      cost: check.cost,
    });

    this.scheduleSave();
    return { ok: true, isNaval: false, country };
  }

  // Detects any neutral land pockets that would become completely enclosed if (targetX, targetY) were conquered
  findEnclosedCavitiesForMove(countryId, targetX, targetY) {
    const origOwner = this.owners[targetY * MAP_W + targetX];
    this.owners[targetY * MAP_W + targetX] = countryId;

    const candidates = [];
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = targetX + dx;
        const ny = targetY + dy;
        if (nx >= 0 && nx < MAP_W && ny >= 0 && ny < MAP_H) {
          const idx = ny * MAP_W + nx;
          if (this.owners[idx] === 0 && this.worldData.isLand[idx]) {
            candidates.push(idx);
          }
        }
      }
    }

    const enclosedPixels = [];
    const visitedGlobal = new Set();

    for (const startIdx of candidates) {
      if (visitedGlobal.has(startIdx) || this.owners[startIdx] !== 0) continue;

      const queue = [startIdx];
      const component = [startIdx];
      visitedGlobal.add(startIdx);
      let isEnclosed = true;

      let qHead = 0;
      while (qHead < queue.length) {
        const cur = queue[qHead++];
        const cx = cur % MAP_W;
        const cy = (cur / MAP_W) | 0;

        const dirs = [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ];
        for (const [ddx, ddy] of dirs) {
          const adjX = cx + ddx;
          const adjY = cy + ddy;
          if (adjX < 0 || adjX >= MAP_W || adjY < 0 || adjY >= MAP_H) {
            isEnclosed = false;
            break;
          }
          const adjIdx = adjY * MAP_W + adjX;
          if (!this.worldData.isLand[adjIdx]) {
            // Water/ocean is a natural boundary
            continue;
          }
          const o = this.owners[adjIdx];
          if (o === countryId) {
            continue;
          }
          if (o !== 0) {
            isEnclosed = false;
            break;
          }
          if (!visitedGlobal.has(adjIdx)) {
            visitedGlobal.add(adjIdx);
            component.push(adjIdx);
            queue.push(adjIdx);
            if (component.length > 150) {
              isEnclosed = false;
              break;
            }
          }
        }
        if (!isEnclosed) break;
      }

      if (isEnclosed && component.length <= 150) {
        for (const idx of component) {
          enclosedPixels.push(idx);
        }
      }
    }

    // Restore simulated tile
    this.owners[targetY * MAP_W + targetX] = origOwner;

    return enclosedPixels;
  }

  // 5-Second Undo for mistakenly conquered pixels
  undoLastConquest() {
    const cutoff = Date.now() - 5000;
    this.undoStack = (this.undoStack || []).filter((u) => u.time >= cutoff);
    if (this.undoStack.length === 0) {
      return {
        ok: false,
        reason: "Geri alınabilecek son 5 saniye içinde fethedilmiş piksel yok.",
      };
    }

    const item = this.undoStack.pop();
    const country = this.countryMap.get(item.countryId);
    if (!country) return { ok: false, reason: "Devlet bulunamadı." };

    const idx = item.y * MAP_W + item.x;
    if (this.owners[idx] !== item.countryId) {
      return { ok: false, reason: "Bu piksel zaten başka bir işlem gördü." };
    }

    this.owners[idx] = item.prevOwner;
    let removedCount = 1;

    // Also revert any enclosed cavity pixels that were auto-filled by this conquest
    if (Array.isArray(item.cavities) && item.cavities.length > 0) {
      for (const cav of item.cavities) {
        const cIdx = cav.y * MAP_W + cav.x;
        if (this.owners[cIdx] === item.countryId) {
          this.owners[cIdx] = 0;
          removedCount++;
          this.sync.broadcast({
            type: "UNDO_PIXEL",
            countryId: item.countryId,
            x: cav.x,
            y: cav.y,
            prevOwner: 0,
            cost: 0,
          });
        }
      }
    }

    country.landCount = Math.max(1, country.landCount - removedCount);
    country.population = Math.max(
      15,
      country.population - 5 - (removedCount - 1) * 3,
    );
    this._recalculateDerivedStats(country);
    country.troops = Math.min(
      country.capacity,
      Number((country.troops + item.cost).toFixed(1)),
    );

    if (item.prevOwner > 0) {
      const prevC = this.countryMap.get(item.prevOwner);
      if (prevC) {
        prevC.landCount++;
        this._recalculateDerivedStats(prevC);
      }
    }

    this.computeCountryBounds();
    this.dirtyPixels = true;
    this.dirtyRegions = false;
    this.saveState();

    this.sync.broadcast({
      type: "UNDO_PIXEL",
      countryId: item.countryId,
      x: item.x,
      y: item.y,
      prevOwner: item.prevOwner,
      cost: item.cost,
    });
    this.sync.publishMyCountrySnapshot();

    this.onEvent("Son fethedilen piksel geri alındı ve askerin iade edildi!");
    return {
      ok: true,
      x: item.x,
      y: item.y,
      remainingUndos: this.undoStack.length,
    };
  }

  handleRemoteUndoPixel(countryId, x, y, prevOwner, batchMode = false) {
    if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) return;
    const idx = y * MAP_W + x;
    this.owners[idx] = prevOwner;
    const c = this.countryMap.get(countryId);
    if (c) {
      c.landCount = Math.max(0, c.landCount - 1);
      this._recalculateDerivedStats(c);
    }
    if (prevOwner > 0) {
      const pc = this.countryMap.get(prevOwner);
      if (pc) {
        pc.landCount++;
        this._recalculateDerivedStats(pc);
      }
    }
    if (!batchMode) {
      this.computeCountryBounds();
      this.dirtyPixels = true;
      this.dirtyRegions = false;
    }
  }

  // O(1) incremental bounding box expansion when conquering a pixel
  _expandCountryBound(countryId, x, y) {
    if (!this.countryBounds) {
      this.computeCountryBounds();
      return;
    }
    let b = this.countryBounds.get(countryId);
    if (!b) {
      b = { minX: x, maxX: x, minY: y, maxY: y, count: 1, sumX: x, sumY: y };
      this.countryBounds.set(countryId, b);
      return;
    }
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
    b.count++;
    b.sumX += x;
    b.sumY += y;
  }

  // Smart Mobile Touch-Snap: If finger touches within radius of a valid border pixel, snap to nearest valid border pixel!
  findSmartExpandTarget(countryId, tapX, tapY, radius = 4) {
    const exact = this.canExpandToPixel(countryId, tapX, tapY);
    if (exact.valid) {
      return { x: tapX, y: tapY, check: exact };
    }

    let best = null;
    let bestDist = Infinity;

    for (let dy = -radius; dy <= radius; dy++) {
      const ny = tapY + dy;
      if (ny < 0 || ny >= MAP_H) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = tapX + dx;
        if (nx < 0 || nx >= MAP_W) continue;
        const d = dx * dx + dy * dy;
        if (d >= bestDist) continue;
        const chk = this.canExpandToPixel(countryId, nx, ny);
        if (chk.valid && !chk.isNaval) {
          bestDist = d;
          best = { x: nx, y: ny, check: chk };
        }
      }
    }
    return best;
  }

  // One-Tap Mobile Quick Expand: Automatically conquers the closest available adjacent border pixel!
  conquerNextBorderPixel(countryId) {
    const country = this.countryMap.get(countryId);
    if (!country) return { ok: false, reason: "Devlet bulunamadı." };

    if (this.dirtyRegions || !this.countryBounds) {
      this.computeCountryBounds();
    }
    const b = this.countryBounds.get(countryId);
    if (!b || b.count === 0) return { ok: false, reason: "Toprak bulunamadı." };

    const centerX = b.sumX / b.count;
    const centerY = b.sumY / b.count;

    const minX = Math.max(0, b.minX - 1);
    const maxX = Math.min(MAP_W - 1, b.maxX + 1);
    const minY = Math.max(0, b.minY - 1);
    const maxY = Math.min(MAP_H - 1, b.maxY + 1);

    let bestCandidate = null;
    let bestScore = Infinity;

    for (let y = minY; y <= maxY; y++) {
      const row = y * MAP_W;
      for (let x = minX; x <= maxX; x++) {
        const idx = row + x;
        if (!this.worldData.isLand[idx] || this.owners[idx] === countryId)
          continue;
        const ownedNeighbors =
          (x > 0 && this.owners[idx - 1] === countryId ? 1 : 0) +
          (x < MAP_W - 1 && this.owners[idx + 1] === countryId ? 1 : 0) +
          (y > 0 && this.owners[idx - MAP_W] === countryId ? 1 : 0) +
          (y < MAP_H - 1 && this.owners[idx + MAP_W] === countryId ? 1 : 0);
        if (ownedNeighbors === 0) continue;
        if (this.isSnakingConquest(countryId, x, y)) continue;

        // Massive priority bonus to fill internal holes (3 or 4 owned neighbors) first before expanding outward!
        const cavityBonus =
          ownedNeighbors >= 3 ? -300 : ownedNeighbors === 2 ? -75 : 0;
        const isEnemy = this.owners[idx] > 0;
        const dist =
          Math.hypot(x - centerX, y - centerY) +
          (isEnemy ? 25 : 0) +
          cavityBonus;
        if (dist < bestScore) {
          bestScore = dist;
          bestCandidate = { x, y };
        }
      }
    }

    if (!bestCandidate) {
      return {
        ok: false,
        reason: "Komşu kara sınırı kalmadı! Karşı kıyılara gemi gönder.",
      };
    }

    return this.conquerPixel(countryId, bestCandidate.x, bestCandidate.y);
  }

  async foundCountry({
    name,
    color,
    flagDataUrl,
    capitalX,
    capitalY,
    creatorIp,
  }) {
    const idx = capitalY * MAP_W + capitalX;
    if (!this.worldData.isLand[idx]) {
      return { ok: false, reason: "Denize devlet kurulamaz!" };
    }
    if (this.owners[idx] !== 0) {
      return { ok: false, reason: "Bu piksel zaten başka bir devlete ait!" };
    }

    const existingForDevice = this.countries.find(
      (c) => c.deviceId === this.myDeviceId,
    );
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

    if (creatorIp && creatorIp !== "unknown" && creatorIp !== "127.0.0.1") {
      const countForIp = this.countries.filter(
        (c) => c.creatorIp === creatorIp && c.landCount > 0,
      ).length;
      if (countForIp >= 2) {
        return {
          ok: false,
          reason: "Bu IP adresinden en fazla 2 ülke oluşturulabilir!",
        };
      }
    }

    let flagRgba = null;
    let finalFlagDataUrl = flagDataUrl;
    try {
      const decoded = await loadDataUrlToFlagBuffer(flagDataUrl);
      flagRgba = decoded.rgba;
      if (decoded.dataUrl) {
        finalFlagDataUrl = decoded.dataUrl;
      }
    } catch {}

    // Unique 15-bit integer ID (10..32000) so countries created on different devices (Phone vs PC) never collide
    let newId = 10 + Math.floor(Math.random() * 31900);
    while (this.countryMap.has(newId)) {
      newId = 10 + Math.floor(Math.random() * 31900);
    }

    const country = this._normalizeCountry({
      id: newId,
      name: (name || "Devletim").trim(),
      color: color || "#E11D48",
      flagDataUrl: finalFlagDataUrl || flagDataUrl,
      flagRgba,
      capitalX,
      capitalY,
      landCount: 1,
      population: 15,
      gold: 0,
      troops: 1.0,
      upgrades: { ...DEFAULT_UPGRADES },
      creatorIp: creatorIp || "unknown",
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
    this.onSound("celebration");
    this.onEvent(`${country.name} kuruldu!`);

    this.sync.broadcast({
      type: "NEW_COUNTRY",
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

  _generateFallbackFlagUrl(name, color) {
    if (typeof document === "undefined") return null;
    try {
      const cv = document.createElement("canvas");
      cv.width = 64;
      cv.height = 40;
      const cctx = cv.getContext("2d");
      cctx.fillStyle = color || "#E11D48";
      cctx.fillRect(0, 0, 64, 40);
      cctx.fillStyle = "#FFFFFF";
      cctx.font = "900 20px Inter, sans-serif";
      cctx.textAlign = "center";
      cctx.textBaseline = "middle";
      const initial = (name || "D").trim().charAt(0).toUpperCase();
      cctx.fillText(initial, 32, 20);
      return cv.toDataURL("image/jpeg", 0.7);
    } catch {
      return null;
    }
  }

  handleRemoteNewCountry(remoteData) {
    if (!remoteData || !remoteData.id || this.countryMap.has(remoteData.id))
      return;

    const flagUrl =
      remoteData.flagDataUrl ||
      this._generateFallbackFlagUrl(remoteData.name, remoteData.color);
    const country = this._normalizeCountry({
      ...remoteData,
      flagDataUrl: flagUrl,
      flagRgba: null,
      landCount: 1,
    });

    const idx = country.capitalY * MAP_W + country.capitalX;
    if (this.worldData.isLand[idx]) {
      this.owners[idx] = country.id;
    }

    this.countries.push(country);
    this.countryMap.set(country.id, country);
    this._expandCountryBound(country.id, country.capitalX, country.capitalY);
    this.dirtyPixels = true;
    this.scheduleSave();

    if (flagUrl) {
      loadDataUrlToFlagBuffer(flagUrl)
        .then((decoded) => {
          country.flagRgba = decoded.rgba;
          this.dirtyPixels = true;
        })
        .catch(() => {});
    }
  }

  // Export up to maxPts [x1, y1, x2, y2...] coordinates for a country (used by cloud sync)
  getCountryPixelCoords(countryId, maxPts = 3000) {
    if (this.dirtyRegions || !this.countryBounds) {
      this.computeCountryBounds();
    }
    const b = this.countryBounds?.get(countryId);
    if (!b || b.count === 0) return [];
    const pts = [];
    for (let y = b.minY; y <= b.maxY; y++) {
      const row = y * MAP_W;
      for (let x = b.minX; x <= b.maxX; x++) {
        if (this.owners[row + x] === countryId) {
          pts.push(x, y);
          if (pts.length >= maxPts * 2) return pts;
        }
      }
    }
    return pts;
  }

  // Ultra-compact Horizontal RLE encoding: [y, xStart, length, ...]
  // Compresses 500+ pixels into ~250 bytes so packets NEVER exceed the 4 KB server limit!
  getCountryRleSpans(countryId) {
    if (this.dirtyRegions || !this.countryBounds) {
      this.computeCountryBounds();
    }
    const b = this.countryBounds?.get(countryId);
    if (!b || b.count === 0) return [];
    const spans = [];
    for (let y = b.minY; y <= b.maxY; y++) {
      const row = y * MAP_W;
      let x = b.minX;
      while (x <= b.maxX) {
        if (this.owners[row + x] === countryId) {
          const startX = x;
          while (x <= b.maxX && this.owners[row + x] === countryId) {
            x++;
          }
          spans.push(y, startX, x - startX);
        } else {
          x++;
        }
      }
    }
    return spans;
  }

  // Handle remote country + territory sync packet from cloud (Phone <-> PC) — 100% SYNCHRONOUS to avoid async race overwrites!
  handleRemoteCountrySyncPacket(
    remoteCountry,
    pts,
    packetTime = 0,
    batchMode = false,
    rleSpans = null,
  ) {
    if (!remoteCountry || !remoteCountry.id) return;

    let country = this.countryMap.get(remoteCountry.id);
    if (
      country &&
      packetTime > 0 &&
      country._lastSyncTime &&
      packetTime < country._lastSyncTime
    ) {
      // Ignore stale out-of-order history packet older than what we already applied!
      return;
    }

    if (!country) {
      const flagUrl =
        remoteCountry.flagDataUrl ||
        this._generateFallbackFlagUrl(remoteCountry.name, remoteCountry.color);
      country = this._normalizeCountry({
        ...remoteCountry,
        flagDataUrl: flagUrl,
        flagRgba: null,
      });
      country._lastSyncTime = packetTime || Date.now();
      if (!this.countries.some((c) => c.id === country.id)) {
        this.countries.push(country);
      }
      this.countryMap.set(country.id, country);
      if (flagUrl) {
        loadDataUrlToFlagBuffer(flagUrl)
          .then((decoded) => {
            country.flagRgba = decoded.rgba;
            this.dirtyPixels = true;
          })
          .catch(() => {});
      }
    } else {
      if (packetTime > 0) country._lastSyncTime = packetTime;
      if (remoteCountry.color) country.color = remoteCountry.color;
      if (remoteCountry.flagDataUrl && !country.flagRgba) {
        country.flagDataUrl = remoteCountry.flagDataUrl;
        loadDataUrlToFlagBuffer(remoteCountry.flagDataUrl)
          .then((res) => {
            country.flagRgba = res.rgba;
            this.dirtyPixels = true;
          })
          .catch(() => {});
      }
      if (remoteCountry.upgrades) {
        country.upgrades = { ...DEFAULT_UPGRADES, ...remoteCountry.upgrades };
      }
    }

    if (batchMode || country.id !== this.myCountryId) {
      if (typeof remoteCountry.troops === "number")
        country.troops = remoteCountry.troops;
      if (typeof remoteCountry.gold === "number")
        country.gold = remoteCountry.gold;
      if (typeof remoteCountry.population === "number")
        country.population = remoteCountry.population;
    }

    const idxCap = country.capitalY * MAP_W + country.capitalX;
    if (this.worldData.isLand[idxCap] && this.owners[idxCap] === 0) {
      this.owners[idxCap] = country.id;
    }

    const hasRle = Array.isArray(rleSpans) && rleSpans.length >= 3;
    const hasPts = Array.isArray(pts) && pts.length >= 2;
    if (hasRle || hasPts) {
      const validPtsSet = new Set();
      if (hasRle) {
        for (let i = 0; i < rleSpans.length; i += 3) {
          const py = rleSpans[i];
          const xStart = rleSpans[i + 1];
          const len = rleSpans[i + 2];
          if (py >= 0 && py < MAP_H) {
            const row = py * MAP_W;
            const endX = Math.min(MAP_W, xStart + len);
            for (let px = Math.max(0, xStart); px < endX; px++) {
              validPtsSet.add(row + px);
            }
          }
        }
      } else {
        for (let i = 0; i < pts.length; i += 2) {
          const px = pts[i];
          const py = pts[i + 1];
          if (px >= 0 && px < MAP_W && py >= 0 && py < MAP_H) {
            validPtsSet.add(py * MAP_W + px);
          }
        }
      }

      // Synchronize territory exactly with the authoritative pts
      if (
        (batchMode || country.id !== this.myCountryId) &&
        validPtsSet.size > 0
      ) {
        if (!batchMode) {
          // Clear any old/orphaned pixels that this country no longer owns across the entire map
          const total = MAP_W * MAP_H;
          for (let idx = 0; idx < total; idx++) {
            if (this.owners[idx] === country.id && !validPtsSet.has(idx)) {
              this.owners[idx] = 0;
            }
          }
        }

        // Set all authoritative pixels
        for (const idx of validPtsSet) {
          if (this.worldData.isLand[idx]) {
            this.owners[idx] = country.id;
          }
        }
      } else if (country.id === this.myCountryId) {
        for (const idx of validPtsSet) {
          if (this.worldData.isLand[idx] && this.owners[idx] === 0) {
            this.owners[idx] = country.id;
          }
        }
      }
    }

    if (!batchMode) {
      // Immediately recompute full country bounds & stats so rendering and territory size are 100% exact!
      this.computeCountryBounds();
      this.dirtyRegions = false;
      this.dirtyPixels = true;
    }
    this._recalculateDerivedStats(country);
  }

  handleRemoteConquerPixel(countryId, x, y, cost = 1) {
    if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) return;
    const country = this.countryMap.get(countryId);
    if (!country) return; // Ignore orphaned pixel packets for unknown countries

    const idx = y * MAP_W + x;
    const prevOwner = this.owners[idx];
    if (prevOwner === countryId) return;

    this.owners[idx] = countryId;

    country.landCount++;
    country.troops = Math.max(0, country.troops - (cost || 0));
    this._recalculateDerivedStats(country);

    if (prevOwner > 0) {
      const prevC = this.countryMap.get(prevOwner);
      if (prevC) {
        prevC.landCount = Math.max(0, prevC.landCount - 1);
        this._recalculateDerivedStats(prevC);
      }
      this.dirtyRegions = true;
    }
    this._expandCountryBound(countryId, x, y);

    this.dirtyPixels = true;
  }

  // Server-backed mode: world state lives on the cloud server, not in browser localStorage/cookies!
  scheduleSave() {}

  handleRemoteLaunchShip(remoteShip) {
    if (!remoteShip || !remoteShip.id) return;
    if (this.ships.some((s) => s.id === remoteShip.id)) return;
    this.ships.push({ ...remoteShip });
  }

  handleRemoteSyncCountryStats(
    countryId,
    stats,
    packetTime = 0,
    forceInit = false,
  ) {
    if (!forceInit && countryId === this.myCountryId) return;
    const country = this.countryMap.get(countryId);
    if (!country || !stats) return;
    if (
      packetTime > 0 &&
      country._lastStatsTime &&
      packetTime < country._lastStatsTime
    )
      return;
    if (packetTime > 0) country._lastStatsTime = packetTime;
    if (stats.color) {
      country.color = stats.color;
      this.dirtyPixels = true;
    }
    if (typeof stats.gold === "number") country.gold = stats.gold;
    if (typeof stats.population === "number")
      country.population = stats.population;
    if (typeof stats.troops === "number") country.troops = stats.troops;
    if (stats.upgrades)
      country.upgrades = { ...DEFAULT_UPGRADES, ...stats.upgrades };
    this._recalculateDerivedStats(country);
  }

  // ===== ADMIN POWERS (AUTHORIZED BY ADMIN IP ONLY) =====
  adminGiveResources(countryId, troopsDelta = 50, goldDelta = 5000) {
    const c = this.countryMap.get(countryId);
    if (!c) return { ok: false, reason: "Önce haritada bir devletin olmalı." };
    c.gold = Math.max(0, (c.gold || 0) + goldDelta);
    c.troops = Math.min(
      Math.max(c.capacity, c.troops + troopsDelta),
      c.troops + troopsDelta,
    );
    this._recalculateDerivedStats(c);
    this.sync.broadcast({
      type: "SYNC_COUNTRY_STATS",
      countryId: c.id,
      stats: {
        troops: Number(c.troops.toFixed(1)),
        gold: Math.floor(c.gold),
        population: Math.floor(c.population),
        color: c.color,
        upgrades: c.upgrades,
      },
    });
    this.onEvent(
      `[ADMIN] +${troopsDelta} Asker & +${goldDelta} Altın eklendi!`,
    );
    return { ok: true };
  }

  adminMaxUpgrades(countryId) {
    const c = this.countryMap.get(countryId);
    if (!c) return { ok: false, reason: "Önce haritada bir devletin olmalı." };
    for (const def of UPGRADE_DEFINITIONS) {
      c.upgrades[def.key] = def.maxLevel;
    }
    this._recalculateDerivedStats(c);
    this.sync.broadcast({
      type: "SYNC_COUNTRY_STATS",
      countryId: c.id,
      stats: {
        troops: Number(c.troops.toFixed(1)),
        gold: Math.floor(c.gold),
        population: Math.floor(c.population),
        color: c.color,
        upgrades: c.upgrades,
      },
    });
    this.onSound("celebration");
    this.onEvent("[ADMIN] Tüm geliştirmeler Maksimum Sv.25 yapıldı!");
    return { ok: true };
  }

  adminDeleteCountry(countryId, broadcast = true) {
    const c = this.countryMap.get(countryId);
    const total = MAP_W * MAP_H;
    for (let i = 0; i < total; i++) {
      if (this.owners[i] === countryId) {
        this.owners[i] = 0;
      }
    }
    this.countries = this.countries.filter((x) => x.id !== countryId);
    this.countryMap.delete(countryId);
    this.ships = this.ships.filter((s) => s.countryId !== countryId);
    if (this.myCountryId === countryId) {
      this.myCountryId = null;
      try {
        localStorage.removeItem("sf_my_country_id");
      } catch {}
    }
    this.computeCountryBounds();
    this.dirtyRegions = false;
    this.dirtyPixels = true;

    if (broadcast) {
      this.sync.broadcast({
        type: "ADMIN_DELETE_COUNTRY",
        countryId,
      });
      this.onEvent(`[ADMIN] ${c?.name || "Devlet"} haritadan silindi!`);
    }
  }

  adminClearChat(broadcast = true) {
    this.chatMessages = [];
    this.onChat([]);
    if (broadcast) {
      this.sync.broadcast({ type: "ADMIN_CLEAR_CHAT" });
      this.onEvent("[ADMIN] Global Sohbet temizlendi!");
    }
  }

  adminResetWorld(broadcast = true) {
    const total = MAP_W * MAP_H;
    for (let i = 0; i < total; i++) {
      this.owners[i] = this.worldData.isLand[i] ? 0 : -1;
    }
    this.countries = [];
    this.countryMap.clear();
    this.ships = [];
    this.chatMessages = [];
    this.undoStack = [];
    this.myCountryId = null;
    try {
      localStorage.removeItem("sf_my_country_id");
    } catch {}
    this.computeCountryBounds();
    this.dirtyRegions = false;
    this.dirtyPixels = true;
    this.onChat([]);

    if (broadcast) {
      this.sync.broadcast({ type: "ADMIN_RESET_WORLD" });
      this.onEvent("[ADMIN] Tüm Dünya Haritası sıfırlandı!");
    }
  }

  // Export compact world snapshot for cross-device WebRTC synchronization (Phone <-> PC)
  exportSnapshot() {
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

      return {
        v: 9,
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
    } catch {
      return null;
    }
  }

  // Merge remote device's world snapshot into local shared world (Phone <-> PC)
  mergeRemoteSnapshot(data) {
    if (!data || !Array.isArray(data.countries) || !Array.isArray(data.rle))
      return;

    let changed = false;

    for (const rc of data.countries) {
      if (!rc || !rc.id) continue;
      const existing = this.countryMap.get(rc.id);
      if (!existing) {
        const country = this._normalizeCountry({ ...rc });
        if (rc.flagDataUrl) {
          loadDataUrlToFlagBuffer(rc.flagDataUrl)
            .then((res) => {
              country.flagRgba = res.rgba;
              this.dirtyPixels = true;
            })
            .catch(() => {});
        }
        this.countries.push(country);
        this.countryMap.set(country.id, country);
        if (rc.deviceId === this.myDeviceId && !this.myCountryId) {
          this.myCountryId = country.id;
          saveMyCountryId(country.id);
        }
        changed = true;
      } else {
        // Merge upgrades if remote has higher upgrade levels
        if (rc.upgrades) {
          for (const k of Object.keys(DEFAULT_UPGRADES)) {
            if ((rc.upgrades[k] || 0) > (existing.upgrades[k] || 0)) {
              existing.upgrades[k] = rc.upgrades[k];
              changed = true;
            }
          }
        }
      }
    }

    // Merge claimed pixels from remote RLE
    const total = MAP_W * MAP_H;
    let ptr = 0;
    for (let i = 0; i < data.rle.length; i += 2) {
      const val = data.rle[i];
      const count = data.rle[i + 1];
      for (let k = 0; k < count && ptr < total; k++) {
        if (val > 0 && this.worldData.isLand[ptr] && this.countryMap.has(val)) {
          if (this.owners[ptr] === 0) {
            this.owners[ptr] = val;
            changed = true;
          }
        }
        ptr++;
      }
    }

    if (changed) {
      // Recount land per country accurately
      const landCounts = new Map();
      for (let i = 0; i < total; i++) {
        const o = this.owners[i];
        if (o > 0) {
          landCounts.set(o, (landCounts.get(o) || 0) + 1);
        }
      }
      for (const c of this.countries) {
        c.landCount = landCounts.get(c.id) || 0;
        this._recalculateDerivedStats(c);
      }

      this.dirtyPixels = true;
      this.dirtyRegions = true;
      this.saveState();
    }
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

    // Synchronize landCount with actual pixel count and prune 0-pixel ghost countries
    let hasZeroLand = false;
    for (const c of this.countries) {
      const b = bounds.get(c.id);
      const cnt = b ? b.count : 0;
      c.landCount = cnt;
      if (cnt === 0) hasZeroLand = true;
    }
    if (hasZeroLand) {
      this.cleanupInactiveCountries();
    }

    return bounds;
  }

  // 100% Server-Authoritative Mode: World map, countries, stats & chat are stored on the cloud server (never in localStorage/cookies)
  saveState() {}

  loadState() {
    return false;
  }
}
