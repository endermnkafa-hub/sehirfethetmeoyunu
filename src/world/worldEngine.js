// High-Performance Real-Time World Conquest Simulation Engine
// Runs at 20 ticks/sec with continuous organic wave expansion, A* naval fleets,
// Small-vs-Big empire balance, Diplomacy, Fortresses, Guardian AI, and RLE Persistence

import {
  MAP_W,
  MAP_H,
  TERRAIN_MOUNTAIN,
  TERRAIN_FOREST,
  lonLatToMapXY,
  findNearestLand,
  findNearestWater,
  findOceanPath,
} from './worldRasterizer';
import {
  WORLD_AI_NATIONS,
  getPresetFlag,
  loadDataUrlToFlagBuffer,
} from './flagLibrary';

export const SAVE_KEY = 'sf_world_v2_empire';

// Calculate balanced empire economy & military weight tier
export function computeNationEconomy(landCount, leaderLand = 1) {
  const safeLand = Math.max(1, landCount);
  const maxTroops = Math.round(1200 + safeLand * 24);

  // Percentage refill speed: Small states are nimble & fast, Great Empires are slower % but huge raw volume
  let basePctPerSec;
  if (safeLand < 140) {
    basePctPerSec = 0.056;
  } else if (safeLand < 450) {
    basePctPerSec = 0.038;
  } else if (safeLand < 1200) {
    basePctPerSec = 0.025;
  } else if (safeLand < 2800) {
    basePctPerSec = 0.016;
  } else {
    basePctPerSec = 0.011;
  }

  // Catch-up boost for smaller states when #1 leader is far ahead (Anti-snowballing)
  let catchUpMult = 1.0;
  if (leaderLand > safeLand * 2.5) {
    const gap = Math.min(10, leaderLand / safeLand);
    catchUpMult = 1.0 + Math.min(0.55, (gap - 2.5) * 0.075);
  }

  // Military Weight & Prestige Tier (Great Empire Advantages!)
  let tierName = 'Yeni Devlet';
  let tierLevel = 1;
  let shipType = 'BOAT';
  let shipLabel = 'Çıkarma Botu';
  let seaPowerMult = 1.0;
  let shipSpeed = 1.25;
  let maxForts = 1;

  if (safeLand >= 2500) {
    tierName = 'Kıtasal Süper Güç';
    tierLevel = 4;
    shipType = 'DREADNOUGHT';
    shipLabel = 'Zırhlı Armada';
    seaPowerMult = 2.15;
    shipSpeed = 1.75;
    maxForts = 10;
  } else if (safeLand >= 1000) {
    tierName = 'Büyük İmparatorluk';
    tierLevel = 3;
    shipType = 'DREADNOUGHT';
    shipLabel = 'Ağır Zırhlı';
    seaPowerMult = 1.8;
    shipSpeed = 1.6;
    maxForts = 6;
  } else if (safeLand >= 340) {
    tierName = 'Bölgesel Krallık';
    tierLevel = 2;
    shipType = 'FRIGATE';
    shipLabel = 'Savaş Fırkateyni';
    seaPowerMult = 1.4;
    shipSpeed = 1.45;
    maxForts = 3;
  } else if (safeLand >= 110) {
    tierName = 'Çevik Devlet';
    tierLevel = 1;
    shipType = 'BOAT';
    shipLabel = 'Hızlı Çıkarma Botu';
    seaPowerMult = 1.05;
    shipSpeed = 1.32;
    maxForts = 1;
  }

  return {
    maxTroops,
    basePctPerSec,
    catchUpMult,
    tierName,
    tierLevel,
    shipType,
    shipLabel,
    seaPowerMult,
    shipSpeed,
    maxForts,
  };
}

export function formatTroops(n) {
  const num = Math.floor(Math.max(0, n || 0));
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 10000) return `${(num / 1000).toFixed(1)}K`;
  if (num >= 1000) return `${(num / 1000).toFixed(2)}K`;
  return `${num}`;
}

export class WorldSimulationEngine {
  constructor(worldData, callbacks = {}) {
    this.worldData = worldData;
    this.onEvent = callbacks.onEvent || (() => {});
    this.onSound = callbacks.onSound || (() => {});

    const total = MAP_W * MAP_H;
    this.owners = new Int16Array(total);
    this.freshness = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      this.owners[i] = worldData.isLand[i] ? 0 : -1;
    }

    this.nations = []; // 1-indexed via nation.id; nations[0] unused or lookup via nationById Map
    this.nationMap = new Map();
    this.attacks = []; // Active continuous wave expansions / invasions
    this.fleets = []; // Sailing ships along A* water paths
    this.forts = []; // { id, ownerId, x, y }
    this.particles = []; // { x, y, vx, vy, color, life, maxLife, size }

    this.tickCount = 0;
    this.dirtyRegions = true;
    this.dirtyPixels = true;
    this.lastPlayerManualActionAt = Date.now();
    this.guardianActive = true;
    this.guardianDamagedBy = new Map(); // attackerId -> { count, lastX, lastY }
    this.nextAttackId = 1;
    this.nextFleetId = 1;
    this.nextFortId = 1;
    this.gameOverWinner = null;

    // Region bounding boxes computed by renderer/engine for seamless flag fill
    this.regions = [];
    this.pixelRegion = new Int32Array(total);
    this.pixelRegion.fill(-1);
  }

  // Spawn Player at chosen (px, py) and populate world with ~28 AI nations
  startNewWorld({ playerName, playerColor, flagRgba, flagDataUrl, spawnX, spawnY }) {
    const total = MAP_W * MAP_H;
    for (let i = 0; i < total; i++) {
      this.owners[i] = this.worldData.isLand[i] ? 0 : -1;
      this.freshness[i] = 0;
    }

    this.nations = [];
    this.nationMap.clear();
    this.attacks = [];
    this.fleets = [];
    this.forts = [];
    this.particles = [];
    this.guardianDamagedBy.clear();
    this.tickCount = 0;
    this.gameOverWinner = null;

    // Find valid land near player's click
    const pStart = findNearestLand(spawnX, spawnY, this.worldData.isLand, 20) || { x: 270, y: 80 };

    const player = this._createNation({
      id: 1,
      name: playerName || 'İmparatorluğum',
      isPlayer: true,
      color: playerColor || '#E30A17',
      flagRgba,
      flagDataUrl,
      capitalX: pStart.x,
      capitalY: pStart.y,
      personality: 'PLAYER',
    });

    this._claimInitialPatch(player.id, pStart.x, pStart.y, 82);

    // Spawn AI nations across the globe, avoiding overlapping player's immediate capital
    let nextId = 2;
    for (const spec of WORLD_AI_NATIONS) {
      const [rawX, rawY] = lonLatToMapXY(spec.lon, spec.lat);
      const landSpot = findNearestLand(rawX, rawY, this.worldData.isLand, 16);
      if (!landSpot) continue;

      // Ensure comfortable breathing room around the player's capital
      const distToPlayer = Math.hypot(landSpot.x - pStart.x, landSpot.y - pStart.y);
      if (distToPlayer < 26) continue;

      // Ensure not overlapping already claimed territory
      if (this.owners[landSpot.y * MAP_W + landSpot.x] !== 0) continue;

      const flag = getPresetFlag(spec.key);
      const ai = this._createNation({
        id: nextId++,
        name: spec.name,
        isPlayer: false,
        color: spec.color,
        flagCode: spec.key,
        flagRgba: flag.rgba,
        flagDataUrl: flag.dataUrl,
        capitalX: landSpot.x,
        capitalY: landSpot.y,
        personality: spec.personality,
      });

      this._claimInitialPatch(ai.id, landSpot.x, landSpot.y, 64 + Math.floor(Math.random() * 22));
    }

    this._recountAllLand();
    this.dirtyRegions = true;
    this.dirtyPixels = true;
    this.lastPlayerManualActionAt = Date.now();
    this.onEvent(`🌍 ${player.name} dünya sahnesine çıktı! Topraklarını fethet.`);
  }

  _createNation({ id, name, isPlayer, color, flagCode = null, flagRgba, flagDataUrl, capitalX, capitalY, personality }) {
    const nation = {
      id,
      name,
      isPlayer,
      alive: true,
      color,
      flagCode,
      flagRgba,
      flagDataUrl,
      capitalX,
      capitalY,
      landCount: 0,
      troops: isPlayer ? 1400 : 1050 + Math.floor(Math.random() * 350),
      maxTroops: 2800,
      incomePerSec: 120,
      personality,
      alliedWithPlayer: false,
      vassalOfPlayer: false,
      truceUntilTick: 0,
      aiCooldown: 20 + Math.floor(Math.random() * 50),
    };
    this.nations.push(nation);
    this.nationMap.set(id, nation);
    return nation;
  }

  // Organic rounded circular blob claim for starting homelands (hugs real coastlines & country contours)
  _claimInitialPatch(nationId, startX, startY, targetPixels) {
    const startIdx = startY * MAP_W + startX;
    const startCid = this.worldData.countryMask[startIdx];
    const buckets = new Map();
    buckets.set(0, [startIdx]);
    const visited = new Set([startIdx]);
    let curBucket = 0;
    let claimed = 0;
    const dirs8 = [
      [-1, 0, 10], [1, 0, 10], [0, -1, 10], [0, 1, 10],
      [-1, -1, 14], [1, -1, 14], [-1, 1, 14], [1, 1, 14],
    ];

    while (claimed < targetPixels && curBucket < 400) {
      const list = buckets.get(curBucket);
      if (!list || list.length === 0) {
        curBucket++;
        continue;
      }
      const pick = (Math.random() * list.length) | 0;
      const idx = list[pick];
      list[pick] = list[list.length - 1];
      list.pop();

      if (this.owners[idx] !== 0) continue;
      this.owners[idx] = nationId;
      this.freshness[idx] = 160;
      claimed++;

      const x = idx % MAP_W;
      const y = (idx / MAP_W) | 0;
      for (let d = 0; d < 8; d++) {
        const nx = x + dirs8[d][0];
        const ny = y + dirs8[d][1];
        if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) continue;
        const nIdx = ny * MAP_W + nx;
        if (!visited.has(nIdx) && this.owners[nIdx] === 0) {
          visited.add(nIdx);
          const sameCountryBonus = this.worldData.countryMask[nIdx] === startCid ? -2 : 2;
          const nb = curBucket + dirs8[d][2] + ((Math.random() * 5) | 0) + sameCountryBonus;
          let arr = buckets.get(nb);
          if (!arr) { arr = []; buckets.set(nb, arr); }
          arr.push(nIdx);
        }
      }
    }
  }

  _recountAllLand() {
    for (const n of this.nations) n.landCount = 0;
    const total = MAP_W * MAP_H;
    for (let i = 0; i < total; i++) {
      const o = this.owners[i];
      if (o > 0) {
        const n = this.nationMap.get(o);
        if (n) n.landCount++;
      }
    }
    let leaderLand = 1;
    for (const n of this.nations) {
      if (n.landCount > leaderLand) leaderLand = n.landCount;
    }
    for (const n of this.nations) {
      n.alive = n.landCount > 0;
      const eco = computeNationEconomy(n.landCount, leaderLand);
      n.maxTroops = eco.maxTroops;
      if (n.troops > n.maxTroops) n.troops = n.maxTroops;
    }
  }

  getPlayer() {
    return this.nationMap.get(1);
  }

  getLeaderLand() {
    let max = 1;
    for (const n of this.nations) {
      if (n.alive && n.landCount > max) max = n.landCount;
    }
    return max;
  }

  // Check if attacker nation shares at least one border pixel with targetOwnerId (0 = neutral, >0 = enemy)
  findBorderFrontier(attackerId, targetOwnerId, focusX = null, focusY = null) {
    const frontier = [];
    const seen = new Set();
    const owners = this.owners;

    for (let y = 0; y < MAP_H; y++) {
      const row = y * MAP_W;
      for (let x = 0; x < MAP_W; x++) {
        const idx = row + x;
        if (owners[idx] !== attackerId) continue;

        if (x > 0 && owners[idx - 1] === targetOwnerId && !seen.has(idx - 1)) {
          seen.add(idx - 1);
          frontier.push(idx - 1);
        }
        if (x < MAP_W - 1 && owners[idx + 1] === targetOwnerId && !seen.has(idx + 1)) {
          seen.add(idx + 1);
          frontier.push(idx + 1);
        }
        if (y > 0 && owners[idx - MAP_W] === targetOwnerId && !seen.has(idx - MAP_W)) {
          seen.add(idx - MAP_W);
          frontier.push(idx - MAP_W);
        }
        if (y < MAP_H - 1 && owners[idx + MAP_W] === targetOwnerId && !seen.has(idx + MAP_W)) {
          seen.add(idx + MAP_W);
          frontier.push(idx + MAP_W);
        }
      }
    }

    // For neutral land expansion or targeted strikes, sort frontier by distance to clicked focus point
    if (focusX !== null && focusY !== null && frontier.length > 0) {
      frontier.sort((a, b) => {
        const ax = a % MAP_W; const ay = (a / MAP_W) | 0;
        const bx = b % MAP_W; const by = (b / MAP_W) | 0;
        const da = (ax - focusX) * (ax - focusX) + (ay - focusY) * (ay - focusY);
        const db = (bx - focusX) * (bx - focusX) + (by - focusY) * (by - focusY);
        return da - db;
      });
    }

    return frontier;
  }

  // Find attacker's coastal water pixel closest to target (tx, ty)
  findNearestCoastalPort(nationId, tx, ty) {
    const owners = this.owners;
    const isLand = this.worldData.isLand;
    let best = null;
    let bestDist = Infinity;

    for (let y = 1; y < MAP_H - 1; y++) {
      const row = y * MAP_W;
      for (let x = 1; x < MAP_W - 1; x++) {
        const idx = row + x;
        if (owners[idx] !== nationId) continue;
        // Check if adjacent to water
        let wx = -1; let wy = -1;
        if (!isLand[idx - 1]) { wx = x - 1; wy = y; }
        else if (!isLand[idx + 1]) { wx = x + 1; wy = y; }
        else if (!isLand[idx - MAP_W]) { wx = x; wy = y - 1; }
        else if (!isLand[idx + MAP_W]) { wx = x; wy = y + 1; }
        if (wx === -1) continue;

        const d = (wx - tx) * (wx - tx) + (wy - ty) * (wy - ty);
        if (d < bestDist) {
          bestDist = d;
          best = { x: wx, y: wy };
        }
      }
    }
    return best;
  }

  // Launch a continuous land expansion / invasion wave
  launchAttack(attackerId, targetOwnerId, ratioPct, focusX = null, focusY = null, explicitTroops = null) {
    const attacker = this.nationMap.get(attackerId);
    if (!attacker || !attacker.alive) return { ok: false, reason: 'Devlet aktif değil.' };
    if (attackerId === targetOwnerId) return { ok: false, reason: 'Kendi toprağına saldıramazsın.' };

    // Prevent attacking player's own ally unless broken
    if (targetOwnerId > 0) {
      const target = this.nationMap.get(targetOwnerId);
      if (!target || !target.alive) return { ok: false, reason: 'Hedef devlet bulunamadı.' };
      if (
        (attacker.isPlayer && target.alliedWithPlayer) ||
        (target.isPlayer && attacker.alliedWithPlayer)
      ) {
        return { ok: false, reason: `${target.name} ile barış ittifakın var! Önce diplomasiden ittifakı boz.` };
      }
    }

    const troopsToSend = explicitTroops !== null
      ? Math.min(attacker.troops, explicitTroops)
      : Math.floor((attacker.troops * Math.max(5, Math.min(95, ratioPct))) / 100);

    if (troopsToSend < 30) {
      return { ok: false, reason: 'Taarruz için en az 30 asker gerekli!' };
    }

    const frontier = this.findBorderFrontier(attackerId, targetOwnerId, focusX, focusY);
    if (frontier.length === 0) {
      return { ok: false, reason: 'NO_BORDER' };
    }

    // If player already has an active attack against same target, reinforce it!
    const existing = this.attacks.find(
      (a) => a.attackerId === attackerId && a.targetOwnerId === targetOwnerId
    );
    if (existing) {
      attacker.troops -= troopsToSend;
      existing.troops += troopsToSend;
      existing.focusX = focusX ?? existing.focusX;
      existing.focusY = focusY ?? existing.focusY;
      // Inject fresh border pixels around latest click into current bucket
      const toInject = frontier.slice(0, 140);
      let arr = existing.buckets.get(existing.curBucket);
      if (!arr) { arr = []; existing.buckets.set(existing.curBucket, arr); }
      for (let i = 0; i < toInject.length; i++) {
        if (!existing.inQueue.has(toInject[i])) {
          existing.inQueue.add(toInject[i]);
          arr.push(toInject[i]);
          existing.queuedCount++;
        }
      }
      if (attacker.isPlayer) {
        this.lastPlayerManualActionAt = Date.now();
        this.onSound('tick');
      }
      return { ok: true, reinforced: true, troopsSent: troopsToSend };
    }

    attacker.troops -= troopsToSend;
    const initialLayer =
      targetOwnerId === 0 && focusX !== null && frontier.length > 75
        ? frontier.slice(0, Math.min(frontier.length, Math.max(75, Math.floor(frontier.length * 0.58))))
        : frontier.slice();
    const inQueue = new Set(initialLayer);
    const buckets = new Map();
    buckets.set(0, initialLayer);

    this.attacks.push({
      id: this.nextAttackId++,
      attackerId,
      targetOwnerId,
      troops: troopsToSend,
      initialTroops: troopsToSend,
      buckets,
      curBucket: 0,
      maxBucket: 0,
      queuedCount: initialLayer.length,
      inQueue,
      focusX,
      focusY,
      stalledTicks: 0,
    });

    if (attacker.isPlayer) {
      this.lastPlayerManualActionAt = Date.now();
      this.onSound('pencil');
      if (targetOwnerId > 0) {
        const target = this.nationMap.get(targetOwnerId);
        this.onEvent(`⚔️ ${target?.name} sınırına ${formatTroops(troopsToSend)} askerle taarruz başlatıldı!`);
      }
    }

    return { ok: true, troopsSent: troopsToSend };
  }

  // Launch an A*-routed Naval Invasion Fleet from nearest coastal port to target shore
  launchNavalInvasion(attackerId, targetX, targetY, ratioPct) {
    const attacker = this.nationMap.get(attackerId);
    if (!attacker || !attacker.alive) return { ok: false, reason: 'Devlet aktif değil.' };

    const troopsToSend = Math.floor((attacker.troops * Math.max(10, Math.min(90, ratioPct))) / 100);
    if (troopsToSend < 120) {
      return { ok: false, reason: 'Donanma çıkarması için en az 120 asker gerekli!' };
    }

    // Resolve landing land pixel & adjacent entry water pixel
    const landingLand = findNearestLand(targetX, targetY, this.worldData.isLand, 16);
    if (!landingLand) {
      return { ok: false, reason: 'Hedefin yakınında çıkarma yapılabilecek kıyı bulunamadı!' };
    }
    const targetOwnerId = this.owners[landingLand.y * MAP_W + landingLand.x];
    if (targetOwnerId > 0) {
      const targetNation = this.nationMap.get(targetOwnerId);
      if (
        targetNation &&
        ((attacker.isPlayer && targetNation.alliedWithPlayer) ||
          (targetNation.isPlayer && attacker.alliedWithPlayer))
      ) {
        return { ok: false, reason: `${targetNation.name} müttefikin! Önce ittifakı bozmalısın.` };
      }
    }

    const landingWater = findNearestWater(landingLand.x, landingLand.y, this.worldData.isLand, 10);
    if (!landingWater) {
      return { ok: false, reason: 'Hedef bölge tamamen karayla çevrili, denizden ulaşılamıyor!' };
    }

    const port = this.findNearestCoastalPort(attackerId, landingWater.x, landingWater.y);
    if (!port) {
      return { ok: false, reason: 'Denize kıyın yok! Önce bir sahile ulaşmalısın.' };
    }

    const path = findOceanPath(port.x, port.y, landingWater.x, landingWater.y, this.worldData);
    if (!path || path.length < 2) {
      return { ok: false, reason: 'Bu iki nokta arasında geçilebilir deniz rotası bulunamadı!' };
    }

    attacker.troops -= troopsToSend;
    const eco = computeNationEconomy(attacker.landCount, this.getLeaderLand());

    this.fleets.push({
      id: this.nextFleetId++,
      ownerId: attackerId,
      troops: troopsToSend,
      shipType: eco.shipType,
      seaPowerMult: eco.seaPowerMult,
      speed: eco.shipSpeed,
      path,
      waypointIdx: 1,
      x: port.x,
      y: port.y,
      angle: Math.atan2(path[1].y - port.y, path[1].x - port.x),
      landingX: landingLand.x,
      landingY: landingLand.y,
      targetOwnerId,
      trail: [{ x: port.x, y: port.y }],
    });

    if (attacker.isPlayer) {
      this.lastPlayerManualActionAt = Date.now();
      this.onSound('spin');
      this.onEvent(`🚢 ${formatTroops(troopsToSend)} askerlik ${eco.shipLabel} denize açıldı!`);
    }

    return { ok: true, troopsSent: troopsToSend };
  }

  // Build a Fortified Citadel on owned land (Great Empire & Strategic Chokepoint mechanic)
  buildFort(nationId, x, y) {
    const nation = this.nationMap.get(nationId);
    if (!nation || !nation.alive) return { ok: false, reason: 'Devlet aktif değil.' };

    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || ix >= MAP_W || iy < 0 || iy >= MAP_H) return { ok: false, reason: 'Geçersiz konum.' };
    if (this.owners[iy * MAP_W + ix] !== nationId) {
      return { ok: false, reason: 'Kaleyi sadece kendi topraklarına inşa edebilirsin!' };
    }

    const eco = computeNationEconomy(nation.landCount, this.getLeaderLand());
    const myForts = this.forts.filter((f) => f.ownerId === nationId);
    if (myForts.length >= eco.maxForts) {
      return { ok: false, reason: `Mevcut seviyende en fazla ${eco.maxForts} kale kurabilirsin. Büyüdükçe limit artar!` };
    }

    if (myForts.some((f) => Math.hypot(f.x - ix, f.y - iy) < 12)) {
      return { ok: false, reason: 'Yakınında zaten bir kale bulunuyor!' };
    }

    const cost = 1200;
    if (nation.troops < cost) {
      return { ok: false, reason: `Kale inşası için ${formatTroops(cost)} asker gerekli!` };
    }

    nation.troops -= cost;
    this.forts.push({ id: this.nextFortId++, ownerId: nationId, x: ix, y: iy });
    this._spawnBurst(ix, iy, '#fbbf24', 10);
    if (nation.isPlayer) {
      this.lastPlayerManualActionAt = Date.now();
      this.onSound('pencil');
      this.onEvent(`🏰 Stratejik Sınır Kalesi kuruldu! Çevresinde 2.2x savunma sağlar.`);
    }
    return { ok: true };
  }

  // Smart click dispatcher from Canvas UI
  handlePlayerMapClick(mapX, mapY, actionMode, sendRatioPct) {
    const player = this.getPlayer();
    if (!player || !player.alive) return { ok: false, reason: 'Devletin yok oldu!' };

    const ix = Math.max(0, Math.min(MAP_W - 1, Math.floor(mapX)));
    const iy = Math.max(0, Math.min(MAP_H - 1, Math.floor(mapY)));
    const idx = iy * MAP_W + ix;
    const ownerAtClick = this.owners[idx];

    // 1. Fortify mode
    if (actionMode === 'FORTIFY') {
      return this.buildFort(player.id, ix, iy);
    }

    // 2. Explicit Naval Mode
    if (actionMode === 'NAVAL') {
      return this.launchNavalInvasion(player.id, ix, iy, sendRatioPct);
    }

    // 3. Auto / Land Conquest Mode
    if (ownerAtClick === -1) {
      // Clicked ocean -> auto naval invasion toward nearest coast!
      return this.launchNavalInvasion(player.id, ix, iy, sendRatioPct);
    }

    if (ownerAtClick === player.id) {
      return { ok: true, action: 'SELF_CLICK' };
    }

    // Try land wave expansion/attack first
    const landResult = this.launchAttack(player.id, ownerAtClick, sendRatioPct, ix, iy);
    if (!landResult.ok && landResult.reason === 'NO_BORDER') {
      // No land border -> automatically launch a naval invasion across the sea!
      return this.launchNavalInvasion(player.id, ix, iy, sendRatioPct);
    }
    return landResult;
  }

  // Diplomacy Actions
  proposeAlliance(targetId) {
    const player = this.getPlayer();
    const target = this.nationMap.get(targetId);
    if (!player || !target || !target.alive || target.isPlayer) return { ok: false, msg: 'Geçersiz hedef.' };
    if (target.alliedWithPlayer) return { ok: false, msg: 'Zaten müttefiksiniz!' };

    const leaderLand = this.getLeaderLand();
    const ratio = player.landCount / Math.max(1, target.landCount);
    // Higher chance if reasonable balance or common threat exists
    const acceptChance =
      leaderLand > target.landCount * 2.5 ? 0.85 : ratio > 0.45 && ratio < 3.5 ? 0.72 : 0.45;

    if (Math.random() < acceptChance) {
      target.alliedWithPlayer = true;
      // Cancel any ongoing battles between them
      this.attacks = this.attacks.filter(
        (a) =>
          !(
            (a.attackerId === player.id && a.targetOwnerId === target.id) ||
            (a.attackerId === target.id && a.targetOwnerId === player.id)
          )
      );
      this.onSound('win');
      this.onEvent(`🤝 ${target.name} ile Saldırmazlık İttifakı imzalandı!`);
      return { ok: true, msg: `${target.name} ittifak teklifini kabul etti!` };
    }
    this.onSound('hit');
    return { ok: false, msg: `${target.name} ittifak teklifini reddetti.` };
  }

  breakAlliance(targetId) {
    const target = this.nationMap.get(targetId);
    if (!target) return { ok: false, msg: 'Geçersiz hedef.' };
    target.alliedWithPlayer = false;
    target.vassalOfPlayer = false;
    this.onSound('hit');
    this.onEvent(`💔 ${target.name} ile ittifak bozuldu! Sınırlar artık açık.`);
    return { ok: true, msg: `${target.name} ile anlaşma feshedildi.` };
  }

  demandTribute(targetId) {
    const player = this.getPlayer();
    const target = this.nationMap.get(targetId);
    if (!player || !target || !target.alive) return { ok: false, msg: 'Geçersiz hedef.' };
    if (target.vassalOfPlayer) return { ok: false, msg: 'Zaten sana haraç ödüyor!' };

    const powerRatio = (player.landCount + player.troops * 0.02) / Math.max(1, target.landCount + target.troops * 0.02);
    if (powerRatio < 1.8) {
      return { ok: false, msg: `Haraç istemek için ${target.name} devletinden en az 2 kat güçlü olmalısın!` };
    }

    if (Math.random() < Math.min(0.92, 0.45 + (powerRatio - 1.8) * 0.25)) {
      target.vassalOfPlayer = true;
      target.alliedWithPlayer = true;
      const instantTribute = Math.floor(target.troops * 0.25);
      target.troops -= instantTribute;
      player.troops = Math.min(player.maxTroops, player.troops + instantTribute);
      this.onSound('win');
      this.onEvent(`👑 ${target.name} gücüne boyun eğdi! Vasalın oldu ve +${formatTroops(instantTribute)} asker haraç ödedi!`);
      return { ok: true, msg: `${target.name} himayeni kabul etti! Düzenli asker haracı ödeyecek.` };
    }
    this.onSound('hit');
    return { ok: false, msg: `${target.name} haraç talebini reddedip meydan okudu!` };
  }

  // Check if (x, y) is inside a defending nation's fort defense aura
  _isProtectedByFort(ownerId, x, y) {
    for (let i = 0; i < this.forts.length; i++) {
      const f = this.forts[i];
      if (f.ownerId === ownerId) {
        const dx = f.x - x;
        const dy = f.y - y;
        if (dx * dx + dy * dy <= 324) return true; // radius 18px on 600x300 map
      }
    }
    return false;
  }

  _spawnBurst(x, y, color, count = 6) {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 0.4 + Math.random() * 1.4;
      this.particles.push({
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        color,
        life: 16 + Math.floor(Math.random() * 14),
        maxLife: 30,
        size: 1.5 + Math.random() * 2,
      });
    }
  }

  // Main 20 Hz simulation tick
  tick() {
    this.tickCount++;
    const dt = 0.05; // 50ms per tick
    const leaderLand = this.getLeaderLand();

    // 1. Decay frontline freshness glow
    if (this.tickCount % 2 === 0) {
      const fresh = this.freshness;
      let anyFresh = false;
      for (let i = 0; i < fresh.length; i++) {
        if (fresh[i] > 0) {
          fresh[i] = fresh[i] > 18 ? fresh[i] - 18 : 0;
          anyFresh = true;
        }
      }
      if (anyFresh) this.dirtyPixels = true;
    }

    // 2. Troop production & interest economy + vassal tribute
    const player = this.getPlayer();
    for (let i = 0; i < this.nations.length; i++) {
      const n = this.nations[i];
      if (!n.alive) continue;

      const eco = computeNationEconomy(n.landCount, leaderLand);
      n.maxTroops = eco.maxTroops;

      const fillRatio = Math.min(1, n.troops / Math.max(1, n.maxTroops));
      // Territorial-style sweet-spot growth curve (fastest around 25-75% fullness)
      const interestMult = 0.58 + 0.72 * Math.sin(Math.max(0.08, fillRatio) * Math.PI);
      const perSec = n.maxTroops * eco.basePctPerSec * eco.catchUpMult * interestMult;
      n.incomePerSec = Math.round(perSec);

      let gain = perSec * dt;
      // Vassal sends 14% of its income to player!
      if (n.vassalOfPlayer && player && player.alive) {
        const tribute = gain * 0.14;
        gain -= tribute;
        player.troops = Math.min(player.maxTroops, player.troops + tribute);
      }

      n.troops = Math.min(n.maxTroops, n.troops + gain);
    }

    // 3. Process continuous expansion & invasion waves
    this._stepAttacks();

    // 4. Process sailing fleets, sea battles, and beachhead landings
    this._stepFleets();

    // 5. Step AI nations + Guardian AI counter-defense
    if (this.tickCount % 10 === 0) {
      this._stepAINations(leaderLand);
      this._stepGuardianDefense();
    }

    // 6. Step visual battle particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.92;
      p.vy *= 0.92;
      p.life--;
      if (p.life <= 0) this.particles.splice(i, 1);
    }

    // 7. Recompute connected regions periodically when borders changed
    if (this.dirtyRegions && this.tickCount % 6 === 0) {
      this.recomputeRegions();
      this.dirtyRegions = false;
      this.dirtyPixels = true;
    }

    // 8. Check world domination victory (>75% of Earth)
    if (!this.gameOverWinner && this.tickCount % 40 === 0) {
      const winThreshold = this.worldData.totalLandPixels * 0.72;
      for (const n of this.nations) {
        if (n.alive && n.landCount >= winThreshold) {
          this.gameOverWinner = n;
          this.onSound('win');
          this.onEvent(`🏆 ${n.name} DÜNYA HAKİMİYETİNİ İLAN ETTİ!`);
          break;
        }
      }
    }
  }

  _stepAttacks() {
    const owners = this.owners;
    const terrain = this.worldData.terrain;
    const fresh = this.freshness;

    for (let aIdx = this.attacks.length - 1; aIdx >= 0; aIdx--) {
      const atk = this.attacks[aIdx];
      const attacker = this.nationMap.get(atk.attackerId);
      if (!attacker || !attacker.alive || atk.troops < 2) {
        this.attacks.splice(aIdx, 1);
        continue;
      }

      const defender = atk.targetOwnerId > 0 ? this.nationMap.get(atk.targetOwnerId) : null;
      if (atk.targetOwnerId > 0 && (!defender || !defender.alive)) {
        // Defender eliminated! Return surviving expeditionary troops home
        attacker.troops = Math.min(attacker.maxTroops, attacker.troops + atk.troops);
        this.attacks.splice(aIdx, 1);
        continue;
      }

      // Compute defender resistance per pixel
      let baseCost = 2.4; // Neutral land base
      let defenderLossPerPixel = 0;

      if (defender) {
        const defDensity = defender.troops / Math.max(18, defender.landCount);
        baseCost = 3.2 + defDensity * 0.42;

        // Great Empire Blitz / Overwhelm Bonus: if attacker army massively outnumbers defender
        if (atk.troops > defender.troops * 2.2) {
          baseCost *= 0.68;
        }

        // Guardian AI Fortified Resistance when player is attacked!
        if (defender.isPlayer && this.guardianActive) {
          baseCost *= 1.85;
        }

        defenderLossPerPixel = Math.max(1.2, defDensity * 0.36);
      }

      // Advance wave via Dial's 8-Neighbor Euclidean + Organic Terrain + Country-Contour Buckets
      // (Produces natural rounded borders that hug real mountains & country contours — zero stripes, zero 45° diamonds!)
      const batchLimit = Math.min(
        115,
        Math.max(14, Math.floor(Math.sqrt(atk.troops) * 0.8))
      );
      const countryMask = this.worldData.countryMask;
      const dirs8 = [
        [-1, 0, 10], [1, 0, 10], [0, -1, 10], [0, 1, 10],
        [-1, -1, 14], [1, -1, 14], [-1, 1, 14], [1, 1, 14],
      ];

      let conqueredThisTick = 0;
      let attempts = 0;

      while (
        atk.queuedCount > 0 &&
        conqueredThisTick < batchLimit &&
        atk.troops >= 2 &&
        attempts < batchLimit * 6
      ) {
        // Advance curBucket to next non-empty priority bucket
        let curArr = atk.buckets.get(atk.curBucket);
        while ((!curArr || curArr.length === 0) && atk.curBucket <= atk.maxBucket) {
          atk.buckets.delete(atk.curBucket);
          atk.curBucket++;
          curArr = atk.buckets.get(atk.curBucket);
        }
        if (!curArr || curArr.length === 0) {
          atk.queuedCount = 0;
          break;
        }

        attempts++;
        const pickIdx = (Math.random() * curArr.length) | 0;
        const idx = curArr[pickIdx];
        curArr[pickIdx] = curArr[curArr.length - 1];
        curArr.pop();
        atk.queuedCount--;
        atk.inQueue.delete(idx);

        if (owners[idx] !== atk.targetOwnerId) continue;

        const x = idx % MAP_W;
        const y = (idx / MAP_W) | 0;

        // Require 4-neighbor cardinal adjacency so territories remain 100% solid with zero diagonal speckles
        const adjToAtk =
          (x > 0 && owners[idx - 1] === atk.attackerId) ||
          (x < MAP_W - 1 && owners[idx + 1] === atk.attackerId) ||
          (y > 0 && owners[idx - MAP_W] === atk.attackerId) ||
          (y < MAP_H - 1 && owners[idx + MAP_W] === atk.attackerId);
        if (!adjToAtk) continue;

        // Compute exact pixel cost (terrain + fort aura)
        let cost = baseCost;
        const t = terrain[idx];
        if (t === TERRAIN_MOUNTAIN) cost *= 1.5;
        else if (t === TERRAIN_FOREST) cost *= 1.15;

        if (defender && this._isProtectedByFort(defender.id, x, y)) {
          cost *= 2.15;
        }

        if (atk.troops < cost) {
          atk.troops = 0;
          break;
        }

        // Capture pixel!
        atk.troops -= cost;
        owners[idx] = atk.attackerId;
        fresh[idx] = 255;
        attacker.landCount++;
        conqueredThisTick++;

        if (defender) {
          defender.landCount = Math.max(0, defender.landCount - 1);
          defender.troops = Math.max(0, defender.troops - defenderLossPerPixel);

          if (defender.isPlayer) {
            const rec = this.guardianDamagedBy.get(atk.attackerId) || { count: 0, lastX: x, lastY: y };
            rec.count++;
            rec.lastX = x;
            rec.lastY = y;
            this.guardianDamagedBy.set(atk.attackerId, rec);
          }

          for (let fi = this.forts.length - 1; fi >= 0; fi--) {
            const f = this.forts[fi];
            if (f.ownerId === defender.id && Math.abs(f.x - x) <= 1 && Math.abs(f.y - y) <= 1) {
              this.forts.splice(fi, 1);
              this._spawnBurst(f.x, f.y, '#ef4444', 12);
              if (attacker.isPlayer) {
                this.onEvent(`💥 ${defender.name} kalesi yıkıldı!`);
              }
            }
          }

          if (conqueredThisTick % 12 === 0) {
            this._spawnBurst(x, y, '#fbbf24', 2);
          }
        }

        // Push 8-neighbors with Euclidean distance + organic noise + terrain + country contour bias!
        const myCid = countryMask[idx];
        for (let d = 0; d < 8; d++) {
          const nx = x + dirs8[d][0];
          const ny = y + dirs8[d][1];
          if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) continue;
          const nIdx = ny * MAP_W + nx;
          if (owners[nIdx] === atk.targetOwnerId && !atk.inQueue.has(nIdx)) {
            const nt = terrain[nIdx];
            const terrainPen = nt === TERRAIN_MOUNTAIN ? 8 : nt === TERRAIN_FOREST ? 2 : 0;
            const contourBias = countryMask[nIdx] === myCid ? -1 : 3;
            const nb = Math.max(
              atk.curBucket + 1,
              atk.curBucket + dirs8[d][2] + ((Math.random() * 6) | 0) + terrainPen + contourBias
            );
            let arr = atk.buckets.get(nb);
            if (!arr) { arr = []; atk.buckets.set(nb, arr); }
            arr.push(nIdx);
            atk.inQueue.add(nIdx);
            atk.queuedCount++;
            if (nb > atk.maxBucket) atk.maxBucket = nb;
          }
        }
      }

      if (conqueredThisTick > 0) {
        this.dirtyPixels = true;
        this.dirtyRegions = true;
        atk.stalledTicks = 0;
      } else {
        atk.stalledTicks++;
      }

      // Check defender defeat
      if (defender && defender.landCount <= 0) {
        defender.alive = false;
        defender.troops = 0;
        this.forts = this.forts.filter((f) => f.ownerId !== defender.id);
        this.fleets = this.fleets.filter((fl) => fl.ownerId !== defender.id);
        if (attacker.isPlayer) {
          this.onSound('win');
          this.onEvent(`🏆 ${defender.name} tamamen fethedildi ve haritadan silindi!`);
        } else if (defender.isPlayer) {
          this.onSound('lose');
          this.onEvent(`💀 İmparatorluğun ${attacker.name} tarafından fethedildi!`);
        }
      }

      // Finish stalled or exhausted wave and return leftover troops
      if (atk.queuedCount <= 0 || atk.stalledTicks > 10 || atk.troops < 2) {
        if (atk.troops > 2) {
          attacker.troops = Math.min(attacker.maxTroops, attacker.troops + atk.troops);
        }
        this.attacks.splice(aIdx, 1);
      }
    }
  }

  _stepFleets() {
    // 1. Move sailing ships along A* waypoints
    for (let i = this.fleets.length - 1; i >= 0; i--) {
      const fl = this.fleets[i];
      const owner = this.nationMap.get(fl.ownerId);
      if (!owner || !owner.alive || fl.troops <= 0) {
        this.fleets.splice(i, 1);
        continue;
      }

      const wp = fl.path[fl.waypointIdx];
      if (!wp) {
        this._executeBeachLanding(fl);
        this.fleets.splice(i, 1);
        continue;
      }

      const dx = wp.x - fl.x;
      const dy = wp.y - fl.y;
      const dist = Math.hypot(dx, dy);
      const step = fl.speed * 0.58;

      if (dist <= step) {
        fl.x = wp.x;
        fl.y = wp.y;
        fl.waypointIdx++;
        if (fl.waypointIdx >= fl.path.length) {
          this._executeBeachLanding(fl);
          this.fleets.splice(i, 1);
          continue;
        }
      } else {
        fl.angle = Math.atan2(dy, dx);
        fl.x += (dx / dist) * step;
        fl.y += (dy / dist) * step;
      }

      // Record foam wake trail
      if (this.tickCount % 3 === 0) {
        fl.trail.push({ x: fl.x, y: fl.y });
        if (fl.trail.length > 18) fl.trail.shift();
      }
    }

    // 2. Real-time Naval Combat between hostile ships crossing paths at sea!
    for (let i = 0; i < this.fleets.length; i++) {
      const a = this.fleets[i];
      if (!a || a.troops <= 0) continue;
      for (let j = i + 1; j < this.fleets.length; j++) {
        const b = this.fleets[j];
        if (!b || b.troops <= 0 || a.ownerId === b.ownerId) continue;

        const na = this.nationMap.get(a.ownerId);
        const nb = this.nationMap.get(b.ownerId);
        if ((na?.isPlayer && nb?.alliedWithPlayer) || (nb?.isPlayer && na?.alliedWithPlayer)) continue;

        if (Math.hypot(a.x - b.x, a.y - b.y) < 7) {
          const powerA = a.troops * a.seaPowerMult;
          const powerB = b.troops * b.seaPowerMult;
          this._spawnBurst((a.x + b.x) / 2, (a.y + b.y) / 2, '#f97316', 14);

          if (powerA >= powerB) {
            const ratio = powerB / Math.max(1, powerA);
            a.troops = Math.max(10, Math.floor(a.troops * (1 - ratio * 0.85)));
            b.troops = 0;
            if (na?.isPlayer) {
              this.onSound('win');
              this.onEvent(`⚓ Deniz Zaferi! ${nb?.name} filosunu okyanusta batırdın!`);
            } else if (nb?.isPlayer) {
              this.onSound('hit');
              this.onEvent(`💥 Donanman deniz savaşında ${na?.name} gemilerine yenildi!`);
            }
          } else {
            const ratio = powerA / Math.max(1, powerB);
            b.troops = Math.max(10, Math.floor(b.troops * (1 - ratio * 0.85)));
            a.troops = 0;
            if (nb?.isPlayer) {
              this.onSound('win');
              this.onEvent(`⚓ Deniz Zaferi! ${na?.name} filosunu batırdın!`);
            } else if (na?.isPlayer) {
              this.onSound('hit');
              this.onEvent(`💥 Donanman açık denizde ${nb?.name} tarafından batırıldı!`);
            }
          }
        }
      }
    }
    this.fleets = this.fleets.filter((fl) => fl.troops > 0);
  }

  _executeBeachLanding(fleet) {
    const attacker = this.nationMap.get(fleet.ownerId);
    if (!attacker || !attacker.alive) return;

    const lx = fleet.landingX;
    const ly = fleet.landingY;
    const idx = ly * MAP_W + lx;
    const currentOwner = this.owners[idx];

    if (currentOwner === fleet.ownerId) {
      // Friendly port reinforcement
      attacker.troops = Math.min(attacker.maxTroops, attacker.troops + fleet.troops);
      return;
    }

    // Establish beachhead (up to 6 coastal pixels)
    let defender = currentOwner > 0 ? this.nationMap.get(currentOwner) : null;
    let landingPower = fleet.troops * (fleet.shipType === 'DREADNOUGHT' ? 1.25 : 1.0);
    let costToBreach = defender ? Math.max(40, (defender.troops / Math.max(20, defender.landCount)) * 4.5) : 20;

    if (defender?.isPlayer && this.guardianActive) {
      costToBreach *= 1.85;
    }

    this._spawnBurst(lx, ly, '#38bdf8', 12);

    if (landingPower <= costToBreach) {
      if (defender) defender.troops = Math.max(0, defender.troops - landingPower * 0.4);
      if (attacker.isPlayer) {
        this.onSound('hit');
        this.onEvent(`🌊 Amfibi çıkarma kıyı savunmasına takıldı!`);
      } else if (defender?.isPlayer) {
        this.onEvent(`🛡️ Kıyı savunman ${attacker.name} deniz çıkarmasını püskürttü!`);
      }
      return;
    }

    // Beachhead succeeded! Claim beach pixel + neighbors and trigger inland invasion wave
    const remaining = Math.floor(landingPower - costToBreach);
    this.owners[idx] = attacker.id;
    this.freshness[idx] = 255;
    attacker.landCount++;
    if (defender) defender.landCount = Math.max(0, defender.landCount - 1);

    // Claim immediate beachhead radius
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = lx + dx;
        const ny = ly + dy;
        if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) continue;
        const nIdx = ny * MAP_W + nx;
        if (this.owners[nIdx] === currentOwner) {
          this.owners[nIdx] = attacker.id;
          this.freshness[nIdx] = 255;
          attacker.landCount++;
          if (defender) defender.landCount = Math.max(0, defender.landCount - 1);
        }
      }
    }

    this.dirtyPixels = true;
    this.dirtyRegions = true;

    if (attacker.isPlayer) {
      this.onSound('win');
      this.onEvent(`🏖️ ÇIKARMA BAŞARILI! Kıyı köprübaşı kuruldu, ordu iç kesimlere ilerliyor!`);
    } else if (defender?.isPlayer) {
      this.onSound('hit');
      this.onEvent(`🚨 ALARM! ${attacker.name} kıyılarına denizden çıkarma yaptı!`);
    }

    if (remaining > 25) {
      this.launchAttack(attacker.id, currentOwner, 0, lx, ly, remaining);
    }
  }

  // Smart Guardian AI: defends player's borders & launches surgical counter-pushes when idle
  _stepGuardianDefense() {
    if (!this.guardianActive) return;
    const player = this.getPlayer();
    if (!player || !player.alive) return;

    const idleMs = Date.now() - this.lastPlayerManualActionAt;
    if (idleMs < 7000) return; // Don't interfere while player is actively clicking

    // Only counter-attack nations that recently stole player border pixels
    for (const [attackerId, rec] of this.guardianDamagedBy.entries()) {
      if (rec.count < 4) continue;
      const enemy = this.nationMap.get(attackerId);
      if (!enemy || !enemy.alive || enemy.alliedWithPlayer) {
        this.guardianDamagedBy.delete(attackerId);
        continue;
      }

      // Only spend a safe conservative 22% reserve to reclaim lost land cleanly
      if (player.troops > player.maxTroops * 0.36) {
        const res = this.launchAttack(player.id, attackerId, 22, rec.lastX, rec.lastY);
        if (res.ok) {
          this.onEvent(`🛡️ Vekil Muhafız: ${enemy.name} ihlaline karşı nokta atışı karşı taarruz başlattı!`);
          rec.count = 0;
        }
      }
    }
  }

  // Dynamic AI Nation Brain (Expansion, Opportunistic Wars, Anti-Leader Coalitions, Naval Raids)
  _stepAINations(leaderLand) {
    const owners = this.owners;
    const leader = this.nations.reduce(
      (best, n) => (n.alive && n.landCount > (best?.landCount || 0) ? n : best),
      null
    );

    for (let i = 0; i < this.nations.length; i++) {
      const ai = this.nations[i];
      if (!ai.alive || ai.isPlayer) continue;

      ai.aiCooldown -= 10;
      if (ai.aiCooldown > 0) continue;

      // Reset thinking cooldown (smooth strategic pacing!)
      ai.aiCooldown = 50 + Math.floor(Math.random() * 65);

      // Keep healthy reserve before attacking (so AI doesn't suicide to 0)
      const minFullness = ai.personality === 'EXPANSIONIST' ? 0.48 : ai.personality === 'DEFENSIVE' ? 0.68 : 0.56;
      if (ai.troops < ai.maxTroops * minFullness) continue;

      // Scan a fast random sample of borders to discover neutral land & neighbors
      const neighborSet = new Set();
      let hasNeutralNeighbor = false;
      let neutralFocus = null;

      // Sample step 2 for speed
      for (let y = 1; y < MAP_H - 1; y += 2) {
        const row = y * MAP_W;
        for (let x = 1; x < MAP_W - 1; x += 2) {
          const idx = row + x;
          if (owners[idx] !== ai.id) continue;

          const checks = [idx - 1, idx + 1, idx - MAP_W, idx + MAP_W];
          for (let c = 0; c < 4; c++) {
            const o = owners[checks[c]];
            if (o === 0) {
              hasNeutralNeighbor = true;
              if (!neutralFocus || Math.random() < 0.05) {
                neutralFocus = { x, y };
              }
            } else if (o > 0 && o !== ai.id) {
              neighborSet.add(o);
            }
          }
        }
      }

      // Priority 1: Expand into rich neutral land first!
      if (hasNeutralNeighbor && Math.random() < 0.8) {
        this.launchAttack(ai.id, 0, 32, neutralFocus?.x ?? null, neutralFocus?.y ?? null);
        continue;
      }

      // Priority 2: Evaluate neighbor wars (or coalition against #1 superpower)
      const candidates = [];
      for (const nid of neighborSet) {
        const target = this.nationMap.get(nid);
        if (!target || !target.alive) continue;
        if (target.isPlayer && ai.alliedWithPlayer) continue;

        let score = 0;
        // Prefer attacking weaker or overextended neighbors
        if (ai.troops > target.troops * 1.25) {
          score += 50 + (ai.troops / Math.max(100, target.troops)) * 20;
        }
        // Coalition pressure against runaway #1 superpower!
        if (leader && target.id === leader.id && leaderLand > this.worldData.totalLandPixels * 0.14) {
          score += 40;
        }
        // Avoid dogpiling player during the early expansion grace period (~50s)
        if (target.isPlayer && this.tickCount < 1000) {
          score -= 90;
        }
        if (score > 20) {
          candidates.push({ target, score });
        }
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => b.score - a.score);
        const chosen = candidates[0].target;
        this.launchAttack(ai.id, chosen.id, 38);
        continue;
      }

      // Priority 3: Naval AI (Britanya, Japonya, Avustralya, İspanya, Endonezya) launches sea expeditions!
      if (
        (ai.personality === 'NAVAL' || !hasNeutralNeighbor) &&
        this.fleets.filter((f) => f.ownerId === ai.id).length < 1 &&
        ai.troops > ai.maxTroops * 0.6 &&
        Math.random() < 0.35
      ) {
        // Pick a random distant neutral or weak coastal land pixel
        for (let tries = 0; tries < 10; tries++) {
          const rx = 20 + Math.floor(Math.random() * (MAP_W - 40));
          const ry = 20 + Math.floor(Math.random() * (MAP_H - 40));
          const ro = owners[ry * MAP_W + rx];
          if (ro === 0) {
            const res = this.launchNavalInvasion(ai.id, rx, ry, 30);
            if (res.ok) break;
          }
        }
      }
    }
  }

  // Fast connected-component flood fill for seamless per-region flag bounding boxes & label anchors
  recomputeRegions() {
    const owners = this.owners;
    const total = MAP_W * MAP_H;
    const pixReg = this.pixelRegion;
    pixReg.fill(-1);

    const regions = [];
    const queue = new Int32Array(total);

    for (let i = 0; i < total; i++) {
      const o = owners[i];
      if (o <= 0 || pixReg[i] !== -1) continue;

      const regId = regions.length;
      let qHead = 0;
      let qTail = 0;
      queue[qTail++] = i;
      pixReg[i] = regId;

      let minX = MAP_W;
      let minY = MAP_H;
      let maxX = 0;
      let maxY = 0;
      let sumX = 0;
      let sumY = 0;
      let count = 0;

      while (qHead < qTail) {
        const cur = queue[qHead++];
        const x = cur % MAP_W;
        const y = (cur / MAP_W) | 0;

        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        sumX += x;
        sumY += y;
        count++;

        if (x > 0 && owners[cur - 1] === o && pixReg[cur - 1] === -1) {
          pixReg[cur - 1] = regId;
          queue[qTail++] = cur - 1;
        }
        if (x < MAP_W - 1 && owners[cur + 1] === o && pixReg[cur + 1] === -1) {
          pixReg[cur + 1] = regId;
          queue[qTail++] = cur + 1;
        }
        if (y > 0 && owners[cur - MAP_W] === o && pixReg[cur - MAP_W] === -1) {
          pixReg[cur - MAP_W] = regId;
          queue[qTail++] = cur - MAP_W;
        }
        if (y < MAP_H - 1 && owners[cur + MAP_W] === o && pixReg[cur + MAP_W] === -1) {
          pixReg[cur + MAP_W] = regId;
          queue[qTail++] = cur + MAP_W;
        }
      }

      regions.push({
        regId,
        ownerId: o,
        minX,
        minY,
        maxX,
        maxY,
        w: Math.max(1, maxX - minX + 1),
        h: Math.max(1, maxY - minY + 1),
        cx: sumX / count,
        cy: sumY / count,
        count,
      });
    }

    this.regions = regions;
  }

  // Compact RLE Serialization for instant localStorage persistence
  serializeState() {
    const owners = this.owners;
    const rle = [];
    let curVal = owners[0];
    let curLen = 1;
    for (let i = 1; i < owners.length; i++) {
      if (owners[i] === curVal) {
        curLen++;
      } else {
        rle.push(curVal, curLen);
        curVal = owners[i];
        curLen = 1;
      }
    }
    rle.push(curVal, curLen);

    const player = this.getPlayer();
    const nationsMeta = this.nations.map((n) => ({
      id: n.id,
      name: n.name,
      isPlayer: n.isPlayer,
      alive: n.alive,
      color: n.color,
      flagCode: n.flagCode,
      // Only store custom dataURL for player (AI flags regenerate locally from flagCode in 0ms)
      flagDataUrl: n.isPlayer ? n.flagDataUrl : null,
      capitalX: n.capitalX,
      capitalY: n.capitalY,
      troops: Math.floor(n.troops),
      personality: n.personality,
      alliedWithPlayer: n.alliedWithPlayer,
      vassalOfPlayer: n.vassalOfPlayer,
    }));

    return {
      v: 3,
      w: MAP_W,
      h: MAP_H,
      savedAt: Date.now(),
      empireName: player?.name || 'İmparatorluğum',
      guardianActive: this.guardianActive,
      rle,
      nations: nationsMeta,
      forts: this.forts,
    };
  }

  async restoreState(saved) {
    if (!saved || saved.v !== 3 || saved.w !== MAP_W || saved.h !== MAP_H || !Array.isArray(saved.rle)) return null;

    // Decode RLE owners
    let pos = 0;
    for (let i = 0; i < saved.rle.length; i += 2) {
      const val = saved.rle[i];
      const len = saved.rle[i + 1];
      for (let k = 0; k < len && pos < this.owners.length; k++) {
        this.owners[pos++] = val;
      }
    }

    this.freshness.fill(0);
    this.nations = [];
    this.nationMap.clear();
    this.attacks = [];
    this.fleets = [];
    this.particles = [];
    this.forts = Array.isArray(saved.forts) ? saved.forts : [];
    this.guardianActive = saved.guardianActive !== false;

    for (const nm of saved.nations) {
      let flagObj;
      if (nm.isPlayer && nm.flagDataUrl) {
        try {
          flagObj = await loadDataUrlToFlagBuffer(nm.flagDataUrl);
        } catch {
          flagObj = getPresetFlag('tr');
        }
      } else {
        flagObj = getPresetFlag(nm.flagCode || 'tr');
      }

      const nation = this._createNation({
        id: nm.id,
        name: nm.name,
        isPlayer: nm.isPlayer,
        color: nm.color,
        flagCode: nm.flagCode,
        flagRgba: flagObj.rgba,
        flagDataUrl: flagObj.dataUrl,
        capitalX: nm.capitalX,
        capitalY: nm.capitalY,
        personality: nm.personality,
      });
      nation.troops = nm.troops || 500;
      nation.alliedWithPlayer = !!nm.alliedWithPlayer;
      nation.vassalOfPlayer = !!nm.vassalOfPlayer;
    }

    this._recountAllLand();
    this.recomputeRegions();
    this.dirtyRegions = false;
    this.dirtyPixels = true;

    // Simulate Guardian AI offline elapsed time report
    const elapsedSec = Math.max(0, Math.min(7200, (Date.now() - (saved.savedAt || Date.now())) / 1000));
    const player = this.getPlayer();
    let offlineReport = null;

    if (player && player.alive && elapsedSec >= 12) {
      const eco = computeNationEconomy(player.landCount, this.getLeaderLand());
      const produced = Math.floor(Math.min(eco.maxTroops - player.troops, eco.maxTroops * eco.basePctPerSec * elapsedSec * 0.45));
      if (produced > 0) {
        player.troops = Math.min(eco.maxTroops, player.troops + produced);
      }
      const raidsRepelled = this.guardianActive ? Math.max(1, Math.floor(elapsedSec / 65)) : 0;
      const enemyCasualties = raidsRepelled * Math.floor(380 + player.landCount * 3.5);
      offlineReport = {
        elapsedMinutes: Math.max(1, Math.round(elapsedSec / 60)),
        producedTroops: Math.max(0, produced),
        raidsRepelled,
        enemyCasualties,
        guardianWasOn: this.guardianActive,
      };
    }

    return offlineReport;
  }

  getLeaderboard() {
    const totalLand = Math.max(1, this.worldData.totalLandPixels);
    return this.nations
      .filter((n) => n.alive)
      .sort((a, b) => b.landCount - a.landCount)
      .map((n, idx) => ({
        rank: idx + 1,
        id: n.id,
        name: n.name,
        isPlayer: n.isPlayer,
        color: n.color,
        flagDataUrl: n.flagDataUrl,
        landCount: n.landCount,
        pct: ((n.landCount / totalLand) * 100).toFixed(1),
        troops: Math.floor(n.troops),
        alliedWithPlayer: n.alliedWithPlayer,
        vassalOfPlayer: n.vassalOfPlayer,
      }));
  }
}
