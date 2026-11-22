// Real-Time Shared World MMO Conquest Engine — WorldBox Population, Economy, Conscription & Upgrade Edition
// Core Loop: Territory -> Population (Halk) -> Tax & Port Trade (Altın) -> Conscription (Asker) & Upgrades
// Enforces: 1 Device = 1 Country, Max 2 Countries per IP, VPN/Proxy Detection, Cross-Tab Live Sync

import { MAP_W, MAP_H } from './worldRasterizer';
import { loadDataUrlToFlagBuffer } from './flagLibrary';
import { getOrCreateDeviceId, getMyCountryId, saveMyCountryId } from './networkSecurity';
import { SharedWorldSync } from './sharedWorldSync';

export const WORLD_SAVE_KEY = 'sf_shared_world_v5_worldbox';

export const UPGRADE_DEFINITIONS = [
  {
    key: 'weapons',
    name: 'Süngü & Ateş Gücü',
    icon: '⚔️',
    desc: 'Ordunun taarruz gücünü +%25 artırır, fetihlerde asker kaybını azaltır.',
    baseCost: 45,
    costScale: 1.75,
    maxLevel: 5,
  },
  {
    key: 'fortification',
    name: 'Sınır Kaleleri & Siper',
    icon: '🛡️',
    desc: 'Topraklarının savunma direncini +%30 artırır; düşman 2-3 kat asker harcar.',
    baseCost: 40,
    costScale: 1.75,
    maxLevel: 5,
  },
  {
    key: 'housing',
    name: 'Tarım & Şehirleşme',
    icon: '🌾',
    desc: 'Halk kapasitesini ve doğum (nüfus artış) hızını +%30 artırır.',
    baseCost: 35,
    costScale: 1.65,
    maxLevel: 5,
  },
  {
    key: 'economy',
    name: 'Ticaret & Liman Ağı',
    icon: '💰',
    desc: 'Halkın vergi verimini ve deniz limanı ticaret gelirini +%25 artırır.',
    baseCost: 40,
    costScale: 1.7,
    maxLevel: 5,
  },
  {
    key: 'administration',
    name: 'İmparatorluk İdaresi',
    icon: '🏛️',
    desc: 'Büyük devletlerdeki yolsuzluğu azaltır, halkın sadakatini ve isyan direncini artırır.',
    baseCost: 50,
    costScale: 1.8,
    maxLevel: 5,
  },
  {
    key: 'logistics',
    name: 'Kışla & Lojistik',
    icon: '⛺',
    desc: 'Ordu kapasitesini +%30 artırır, askerlerin maaş/bakım masrafını %15 düşürür.',
    baseCost: 40,
    costScale: 1.7,
    maxLevel: 5,
  },
];

export const DEFAULT_UPGRADES = {
  weapons: 0,
  fortification: 0,
  housing: 0,
  economy: 0,
  administration: 0,
  logistics: 0,
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
    this._saveTimer = 0;
    this._rebelCheckTimer = 0;

    // Real-time cross-tab and network synchronization layer
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

  // Helper to check if a land pixel borders ocean/water (Port / Liman pixel)
  isCoastalPixel(x, y) {
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

  // Ensure country has all WorldBox fields initialized
  _normalizeCountry(c) {
    c.upgrades = { ...DEFAULT_UPGRADES, ...(c.upgrades || {}) };
    c.landCount = Math.max(0, c.landCount || 1);
    c.coastalCount = typeof c.coastalCount === 'number' ? c.coastalCount : 0;
    c.population = typeof c.population === 'number' ? Math.max(5, c.population) : 25;
    c.gold = typeof c.gold === 'number' ? Math.max(0, c.gold) : 45;
    c.troops = typeof c.troops === 'number' ? Math.max(0, c.troops) : 3;
    c.loyalty = typeof c.loyalty === 'number' ? Math.min(100, Math.max(0, c.loyalty)) : 95;
    c.taxLevel = c.taxLevel || 'NORMAL'; // 'LOW' | 'NORMAL' | 'HIGH'
    c.settlements = Array.isArray(c.settlements) ? c.settlements : [];
    this._recalculateDerivedStats(c);
    return c;
  }

  _recalculateDerivedStats(c) {
    const up = c.upgrades || DEFAULT_UPGRADES;

    // 1. Max Population (Halk Barınma Kapasitesi)
    c.maxPopulation = Math.floor((30 + c.landCount * 10) * (1 + up.housing * 0.3));

    // 2. Max Army Capacity (Kışla Kapasitesi)
    c.capacity = Math.max(10, Math.floor((8 + c.landCount * 1.2) * (1 + up.logistics * 0.3)));

    // 3. Population Growth Rate (Doğum & Göç Hızı)
    const taxPopBonus = c.taxLevel === 'LOW' ? 1.35 : c.taxLevel === 'HIGH' ? 0.65 : 1.0;
    const loyaltyFactor = Math.max(0.2, c.loyalty / 100);
    const spaceFactor = c.population < c.maxPopulation
      ? Math.max(0.1, 1 - (c.population / c.maxPopulation) * 0.75)
      : 0;
    c.popGrowthRate =
      (0.30 + 0.06 * Math.sqrt(c.landCount)) *
      (1 + up.housing * 0.3) *
      taxPopBonus *
      loyaltyFactor *
      spaceFactor;

    // 4. Gold Income (Vergi + Liman Ticareti) & Administrative Efficiency
    // Large empires suffer administrative corruption unless they invest in Administration
    const overextension = Math.max(0, c.landCount - 120 * (1 + up.administration * 0.5));
    c.adminEfficiency = 1.0 / (1.0 + overextension / (900 * (1 + up.administration * 0.4)));

    const taxMult = c.taxLevel === 'LOW' ? 0.6 : c.taxLevel === 'HIGH' ? 1.55 : 1.0;
    const citizenTax = c.population * 0.024;
    const portTrade = (c.coastalCount || 0) * 0.085;
    c.goldIncome = (citizenTax + portTrade) * taxMult * c.adminEfficiency * (1 + up.economy * 0.25);

    // 5. Army Upkeep (Ordu Maaş & Bakım Gideri)
    const upkeepDiscount = Math.max(0.35, 1 - up.logistics * 0.14);
    c.armyUpkeep = c.troops * 0.032 * upkeepDiscount;

    c.netGoldRate = c.goldIncome - c.armyUpkeep;

    // 6. Combat Multipliers (Küçük Ülke Vatan Savunması vs Büyük İmparatorluk Gücü)
    c.attackPower = 1.0 + up.weapons * 0.25;
    const smallNationGuerrillaBonus = c.landCount < 60 ? 0.45 : c.landCount < 150 ? 0.20 : 0;
    c.defensePower = 1.0 + up.fortification * 0.30 + smallNationGuerrillaBonus;

    // 7. Passive Militia Trickle (Çok yavaş gönüllü katılım - Asıl ordu halktan parayla eğitilir!)
    if (c.gold > 3 && c.population > 15 && c.troops < c.capacity) {
      c.productionRate = (0.06 + 0.012 * Math.sqrt(c.landCount)) * loyaltyFactor;
    } else {
      c.productionRate = 0;
    }
  }

  // Real-time continuous WorldBox simulation tick
  update(deltaTimeSec) {
    if (deltaTimeSec <= 0 || deltaTimeSec > 1.0) deltaTimeSec = 0.05;

    this._saveTimer += deltaTimeSec;
    this._rebelCheckTimer += deltaTimeSec;

    for (const c of this.countries) {
      if (c.landCount <= 0) continue;

      this._recalculateDerivedStats(c);

      // 1. Population Growth
      if (c.population < c.maxPopulation) {
        c.population = Math.min(c.maxPopulation, c.population + c.popGrowthRate * deltaTimeSec);
      }

      // 2. Gold Treasury Update (Taxes + Ports - Army Upkeep)
      c.gold += c.netGoldRate * deltaTimeSec;

      // Handle Bankruptcy / Unpaid Army Desertion
      if (c.gold <= 0) {
        c.gold = 0;
        if (c.troops > 2) {
          // Soldiers desert back to civilian population when unpaid
          const deserted = Math.min(c.troops - 2, (0.4 + c.troops * 0.03) * deltaTimeSec);
          c.troops -= deserted;
          c.population = Math.min(c.maxPopulation, c.population + deserted);
          c.loyalty = Math.max(5, c.loyalty - 1.8 * deltaTimeSec);
        }
      }

      // 3. Slow Volunteer Militia Trickle (consumes citizens gradually)
      if (c.productionRate > 0 && c.troops < c.capacity && c.population > 12) {
        const militiaJoined = Math.min(
          c.capacity - c.troops,
          c.productionRate * deltaTimeSec
        );
        c.troops += militiaJoined;
        c.population = Math.max(10, c.population - militiaJoined * 0.5);
      }

      // 4. Loyalty & Happiness Dynamics
      const up = c.upgrades || DEFAULT_UPGRADES;
      // Distant borders create natural administrative strain in huge empires
      const sizeStrain = Math.max(0, (c.landCount - 100) * 0.018) / (1 + up.administration * 0.45);
      let targetLoyalty = Math.max(20, 96 - sizeStrain);
      if (c.taxLevel === 'LOW') targetLoyalty = Math.min(100, targetLoyalty + 15);
      if (c.taxLevel === 'HIGH') targetLoyalty = Math.max(5, targetLoyalty - 42);

      const loyaltyDiff = targetLoyalty - c.loyalty;
      const adjustSpeed = c.taxLevel === 'HIGH' ? 0.65 : 0.35;
      c.loyalty = Math.max(0, Math.min(100, c.loyalty + Math.sign(loyaltyDiff) * Math.min(Math.abs(loyaltyDiff), adjustSpeed * deltaTimeSec)));
    }

    // Check for WorldBox Rebellion in low-loyalty empires every 4 seconds
    if (this._rebelCheckTimer >= 4.0) {
      this._rebelCheckTimer = 0;
      for (const c of this.countries) {
        if (c.landCount >= 35 && c.loyalty <= 18) {
          if (Math.random() < 0.45) {
            this.triggerRebellion(c);
          }
        }
      }
    }
  }

  // WorldBox Conscription: Recruit Soldiers from Civilian Population using Gold
  recruitSoldiers(countryId, amount = 5) {
    const country = this.countryMap.get(countryId);
    if (!country) return { ok: false, reason: 'Devlet bulunamadı.' };

    this._recalculateDerivedStats(country);

    const availableSpace = Math.floor(country.capacity - country.troops);
    if (availableSpace <= 0) {
      return { ok: false, reason: 'Kışla kapasitesi dolu! Toprak fethet veya Kışla & Lojistik geliştir.' };
    }

    const actualAmount = Math.min(amount, availableSpace);
    const goldCostPerSoldier = 2.5;
    const totalGoldCost = Math.ceil(actualAmount * goldCostPerSoldier);

    if (country.gold < totalGoldCost) {
      return {
        ok: false,
        reason: `Yetersiz Altın! (${actualAmount} asker için ${totalGoldCost} Altın gerekli)`,
      };
    }

    // Must keep at least 10 core civilians in the country so economy doesn't hit 0
    const availableCivilians = Math.floor(country.population - 10);
    if (availableCivilians < actualAmount) {
      return {
        ok: false,
        reason: `Halk nüfusu yetersiz! En az 10 sivil halk geride kalmalı (Mevcut Halk: ${Math.floor(country.population)})`,
      };
    }

    country.gold -= totalGoldCost;
    country.population -= actualAmount;
    country.troops += actualAmount;
    // Heavy conscription slightly lowers public loyalty
    country.loyalty = Math.max(10, country.loyalty - Math.min(6, actualAmount * 0.12));

    this._recalculateDerivedStats(country);
    this.onSound('pencil');
    this.saveState();

    this.sync.broadcast({
      type: 'SYNC_COUNTRY_STATS',
      countryId: country.id,
      stats: {
        gold: country.gold,
        population: country.population,
        troops: country.troops,
        loyalty: country.loyalty,
        taxLevel: country.taxLevel,
        upgrades: country.upgrades,
      },
    });

    return {
      ok: true,
      recruited: actualAmount,
      goldSpent: totalGoldCost,
    };
  }

  // Demobilize Soldiers back into Civilian Population (Terhis Et)
  demobilizeSoldiers(countryId, amount = 5) {
    const country = this.countryMap.get(countryId);
    if (!country) return { ok: false, reason: 'Devlet bulunamadı.' };

    const availableTroops = Math.floor(country.troops - 1);
    if (availableTroops <= 0) {
      return { ok: false, reason: 'Terhis edilecek asker yok (En az 1 muhafız kalmalı).' };
    }

    const actual = Math.min(amount, availableTroops);
    country.troops -= actual;
    country.population = Math.min(country.maxPopulation, country.population + actual);
    country.loyalty = Math.min(100, country.loyalty + Math.min(4, actual * 0.1));

    this._recalculateDerivedStats(country);
    this.saveState();

    this.sync.broadcast({
      type: 'SYNC_COUNTRY_STATS',
      countryId: country.id,
      stats: {
        gold: country.gold,
        population: country.population,
        troops: country.troops,
        loyalty: country.loyalty,
        taxLevel: country.taxLevel,
        upgrades: country.upgrades,
      },
    });

    return { ok: true, demobilized: actual };
  }

  // Change Tax Level ('LOW' | 'NORMAL' | 'HIGH')
  setTaxLevel(countryId, taxLevel) {
    const country = this.countryMap.get(countryId);
    if (!country) return { ok: false };
    country.taxLevel = taxLevel;
    this._recalculateDerivedStats(country);
    this.saveState();

    this.sync.broadcast({
      type: 'SYNC_COUNTRY_STATS',
      countryId: country.id,
      stats: {
        gold: country.gold,
        population: country.population,
        troops: country.troops,
        loyalty: country.loyalty,
        taxLevel: country.taxLevel,
        upgrades: country.upgrades,
      },
    });

    return { ok: true };
  }

  // Purchase Technology / State Upgrade
  buyUpgrade(countryId, upgradeKey) {
    const country = this.countryMap.get(countryId);
    if (!country) return { ok: false, reason: 'Devlet bulunamadı.' };

    const def = UPGRADE_DEFINITIONS.find((u) => u.key === upgradeKey);
    if (!def) return { ok: false, reason: 'Geliştirme bulunamadı.' };

    const currentLevel = country.upgrades?.[upgradeKey] || 0;
    if (currentLevel >= def.maxLevel) {
      return { ok: false, reason: 'Bu geliştirme zaten maksimum seviyede!' };
    }

    const cost = Math.round(def.baseCost * Math.pow(def.costScale, currentLevel));
    if (country.gold < cost) {
      return { ok: false, reason: `Yetersiz Altın! (${cost} Altın gerekli)` };
    }

    country.gold -= cost;
    country.upgrades[upgradeKey] = currentLevel + 1;
    this._recalculateDerivedStats(country);
    this.onSound('celebration');
    this.onEvent(`${def.icon} ${def.name} Seviye ${currentLevel + 1} tamamlandı!`);
    this.saveState();

    this.sync.broadcast({
      type: 'SYNC_COUNTRY_STATS',
      countryId: country.id,
      stats: {
        gold: country.gold,
        population: country.population,
        troops: country.troops,
        loyalty: country.loyalty,
        taxLevel: country.taxLevel,
        upgrades: country.upgrades,
      },
    });

    return { ok: true, level: currentLevel + 1, cost };
  }

  // Trigger a WorldBox Rebellion in a distant province when loyalty collapses
  triggerRebellion(country) {
    // Find owned pixels furthest from capital
    const ownedPixels = [];
    for (let y = 0; y < MAP_H; y++) {
      const row = y * MAP_W;
      for (let x = 0; x < MAP_W; x++) {
        if (this.owners[row + x] === country.id) {
          const dist = Math.hypot(x - country.capitalX, y - country.capitalY);
          if (dist > 6) {
            ownedPixels.push({ x, y, idx: row + x, dist });
          }
        }
      }
    }

    if (ownedPixels.length < 10) return;
    ownedPixels.sort((a, b) => b.dist - a.dist);

    // Rebel cluster around the most distant pixel (15% of territory, up to 60 pixels)
    const epic = ownedPixels[0];
    const rebelCount = Math.min(60, Math.max(8, Math.floor(country.landCount * 0.15)));
    ownedPixels.sort(
      (a, b) => Math.hypot(a.x - epic.x, a.y - epic.y) - Math.hypot(b.x - epic.x, b.y - epic.y)
    );

    let lost = 0;
    for (let i = 0; i < Math.min(rebelCount, ownedPixels.length); i++) {
      const p = ownedPixels[i];
      if (p.x === country.capitalX && p.y === country.capitalY) continue;
      this.owners[p.idx] = 0; // Becomes independent neutral land
      if (this.isCoastalPixel(p.x, p.y)) {
        country.coastalCount = Math.max(0, (country.coastalCount || 0) - 1);
      }
      lost++;
    }

    if (lost > 0) {
      country.landCount = Math.max(1, country.landCount - lost);
      country.population = Math.max(15, country.population * 0.85);
      country.loyalty = Math.min(100, country.loyalty + 35); // Pressure released after rebellion
      this._recalculateDerivedStats(country);
      this.dirtyPixels = true;
      this.dirtyRegions = true;
      this.onEvent(`🔥 İSYAN! ${country.name} devletinde ağır vergi ve düşük sadakat yüzünden ${lost} piksel eyalet ayaklanıp koptu!`);
      this.saveState();
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

    if (!isEnemy) {
      // Neutral pixel expansion cost reduced slightly by weapons/logistics
      cost = Math.max(0.6, 1.0 / (1 + (attacker.upgrades?.weapons || 0) * 0.12));
    } else {
      const defender = this.countryMap.get(currentOwner);
      const defPower = defender ? (defender.defensePower || 1.0) : 1.0;
      const atkPower = attacker.attackPower || 1.0;

      // Capital Citadel Protection: pixels within radius 5 of enemy capital cost 2x more!
      let capitalBonus = 1.0;
      if (defender) {
        const distToCap = Math.hypot(x - defender.capitalX, y - defender.capitalY);
        if (distToCap <= 4) capitalBonus = 1.85;
      }

      cost = Math.max(0.8, (2.0 * defPower * capitalBonus) / atkPower);
    }

    cost = Number(cost.toFixed(2));

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
        reason: `Yetersiz asker! (${check.cost.toFixed(1)} asker gerekli, sende ${country.troops.toFixed(1)} var. Halktan asker eğit!)`,
      };
    }

    const idx = y * MAP_W + x;
    const prevOwner = this.owners[idx];
    const coastal = this.isCoastalPixel(x, y);

    // Deduct soldier cost
    country.troops = Math.max(0, country.troops - check.cost);
    this.owners[idx] = countryId;
    country.landCount++;
    if (coastal) country.coastalCount = (country.coastalCount || 0) + 1;

    // WorldBox Loot & Local Population Integration
    if (prevOwner === 0) {
      // Unclaimed land: local villagers join your realm + small exploration gold
      country.population = Math.min(country.maxPopulation + 10, country.population + 2);
      country.gold += coastal ? 2.5 : 1.0;
    } else if (prevOwner > 0) {
      // Enemy territory conquered: war plunder & refugee migration
      const prevCountry = this.countryMap.get(prevOwner);
      if (prevCountry) {
        prevCountry.landCount = Math.max(0, prevCountry.landCount - 1);
        if (coastal) prevCountry.coastalCount = Math.max(0, (prevCountry.coastalCount || 0) - 1);

        // Plunder gold from enemy treasury
        const plunder = Math.min(prevCountry.gold * 0.04, 12);
        prevCountry.gold = Math.max(0, prevCountry.gold - plunder);
        country.gold += plunder + 2.0;

        // Half of local citizens flee to defender's capital, some fall under new rule
        if (prevCountry.population > 12) {
          prevCountry.population = Math.max(10, prevCountry.population - 3);
          country.population = Math.min(country.maxPopulation, country.population + 2);
        }

        // If enemy capital was captured, relocate their capital or award massive war chest
        if (x === prevCountry.capitalX && y === prevCountry.capitalY && prevCountry.landCount > 0) {
          const capitalLoot = prevCountry.gold * 0.35;
          prevCountry.gold -= capitalLoot;
          country.gold += capitalLoot;
          this.onEvent(`👑 ${country.name}, ${prevCountry.name} başkentini ele geçirip ${Math.round(capitalLoot)} Altın hazine yağmaladı!`);
        }

        this._recalculateDerivedStats(prevCountry);
      }
    }

    // Automatically form a WorldBox Town / Port settlement milestone every 45 pixels
    if (country.landCount % 45 === 0 && country.settlements.length < 25) {
      country.settlements.push({
        x,
        y,
        type: coastal ? 'PORT' : 'TOWN',
        createdAt: Date.now(),
      });
    }

    this._recalculateDerivedStats(country);

    this.dirtyPixels = true;
    this.dirtyRegions = true;
    this.onSound('pencil');

    // Broadcast pixel conquest to all other players & tabs in real-time
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
    if (existingForDevice) {
      return {
        ok: false,
        reason: `Bu cihazdan zaten bir ülke kurulmuş: "${existingForDevice.name}"! (1 Cihaz = 1 Ülke kuralı)`,
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

    const coastal = this.isCoastalPixel(capitalX, capitalY);

    const country = this._normalizeCountry({
      id: newId,
      name: (name || 'Devletim').trim(),
      color: color || '#E11D48',
      flagDataUrl,
      flagRgba,
      capitalX,
      capitalY,
      landCount: 1,
      coastalCount: coastal ? 1 : 0,
      population: 30, // Start with 30 citizens
      gold: 50,       // Start with 50 Gold in treasury
      troops: 4.0,    // Start with 4 ready soldiers
      loyalty: 96,
      taxLevel: 'NORMAL',
      upgrades: { ...DEFAULT_UPGRADES },
      settlements: [],
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
    this.onEvent(`🌍 ${country.name} kuruldu! Halkın çalışmaya ve hazinen altın toplamaya başladı.`);

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
        coastalCount: country.coastalCount,
        population: country.population,
        gold: country.gold,
        troops: country.troops,
        loyalty: country.loyalty,
        taxLevel: country.taxLevel,
        upgrades: country.upgrades,
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

  // Handle remote pixel conquest by another player or tab
  handleRemoteConquerPixel(countryId, x, y, cost = 1) {
    if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) return;
    const idx = y * MAP_W + x;
    const prevOwner = this.owners[idx];
    if (prevOwner === countryId) return;

    const coastal = this.isCoastalPixel(x, y);
    this.owners[idx] = countryId;

    const country = this.countryMap.get(countryId);
    if (country) {
      country.landCount++;
      if (coastal) country.coastalCount = (country.coastalCount || 0) + 1;
      country.troops = Math.max(0, country.troops - (cost || 1));
      this._recalculateDerivedStats(country);
    }

    if (prevOwner > 0) {
      const prevC = this.countryMap.get(prevOwner);
      if (prevC) {
        prevC.landCount = Math.max(0, prevC.landCount - 1);
        if (coastal) prevC.coastalCount = Math.max(0, (prevC.coastalCount || 0) - 1);
        this._recalculateDerivedStats(prevC);
      }
    }

    this.dirtyPixels = true;
    this.dirtyRegions = true;
  }

  // Handle remote stats sync (conscription, tax changes, upgrades)
  handleRemoteSyncCountryStats(countryId, stats) {
    const country = this.countryMap.get(countryId);
    if (!country || !stats) return;
    if (typeof stats.gold === 'number') country.gold = stats.gold;
    if (typeof stats.population === 'number') country.population = stats.population;
    if (typeof stats.troops === 'number') country.troops = stats.troops;
    if (typeof stats.loyalty === 'number') country.loyalty = stats.loyalty;
    if (stats.taxLevel) country.taxLevel = stats.taxLevel;
    if (stats.upgrades) country.upgrades = { ...DEFAULT_UPGRADES, ...stats.upgrades };
    this._recalculateDerivedStats(country);
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
        v: 6,
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
          coastalCount: c.coastalCount,
          population: c.population,
          gold: c.gold,
          loyalty: c.loyalty,
          taxLevel: c.taxLevel,
          upgrades: c.upgrades,
          settlements: c.settlements,
          createdAt: c.createdAt,
        })),
        rle,
      };

      localStorage.setItem(WORLD_SAVE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('World save error:', e);
    }
  }

  // Load shared world state from localStorage (supports v6 and migrates v5 seamlessly)
  loadState() {
    try {
      const raw = localStorage.getItem(WORLD_SAVE_KEY) || localStorage.getItem('sf_shared_world_v4_data');
      if (!raw) return false;
      const data = JSON.parse(raw);
      if ((data.v !== 6 && data.v !== 5) || data.w !== MAP_W || data.h !== MAP_H || !Array.isArray(data.rle)) {
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

      // Count actual land and coastal pixels per country from owners array
      const landCounts = new Map();
      const coastalCounts = new Map();
      for (let y = 0; y < MAP_H; y++) {
        const row = y * MAP_W;
        for (let x = 0; x < MAP_W; x++) {
          const o = this.owners[row + x];
          if (o > 0) {
            landCounts.set(o, (landCounts.get(o) || 0) + 1);
            if (this.isCoastalPixel(x, y)) {
              coastalCounts.set(o, (coastalCounts.get(o) || 0) + 1);
            }
          }
        }
      }

      for (const cd of data.countries || []) {
        const actualLand = landCounts.get(cd.id) ?? (cd.landCount || 1);
        const actualCoastal = coastalCounts.get(cd.id) ?? (cd.coastalCount || 0);

        const country = this._normalizeCountry({
          ...cd,
          landCount: actualLand,
          coastalCount: actualCoastal,
          population: typeof cd.population === 'number' ? cd.population : Math.min(2500, 25 + actualLand * 4),
          gold: typeof cd.gold === 'number' ? cd.gold : 50,
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
