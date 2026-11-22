// Comprehensive World Conquest Engine (Faithful to Original Format, Military & World Scale)
// Turn-based or tactical soldier deployment, Drag & Click adjacent conquest,
// Terrain defense costs, Border fortifications, A* Naval fleets, Real City metropolises,
// RLE persistence, and NO AI BOTS.

import {
  MAP_W,
  MAP_H,
  TERRAIN_PLAINS,
  TERRAIN_FOREST,
  TERRAIN_DESERT,
  TERRAIN_MOUNTAIN,
  TERRAIN_TUNDRA,
  findNearestLand,
  findNearestWater,
  findOceanPath,
} from './worldRasterizer';

export const SAVE_KEY = 'sf_world_classic_v3';

// Terrain soldier cost to annex a single land cell
export const TERRAIN_TROOP_COST = {
  [TERRAIN_PLAINS]: 1,
  [TERRAIN_FOREST]: 2,
  [TERRAIN_DESERT]: 3,
  [TERRAIN_MOUNTAIN]: 5,
  [TERRAIN_TUNDRA]: 3,
};

export const WALL_BUILD_COST = 3;
export const ENEMY_WALL_BREACH_COST = 6;
export const ENEMY_TERRITORY_COST = 3;

// Calculate active player's economy and income
export function computePlayerTurnIncome(player, worldData) {
  const baseIncome = 12;
  const landIncome = Math.floor((player.landCount || 0) / 14);

  // Bonus income from conquered cities
  let cityIncome = 0;
  if (Array.isArray(player.conqueredCities) && worldData?.cities) {
    for (const cityId of player.conqueredCities) {
      const city = worldData.cities.find((c) => c.id === cityId);
      if (city) cityIncome += (city.incomeBonus || 4);
    }
  }

  const totalIncome = baseIncome + landIncome + cityIncome;
  const maxCapacity = Math.round(120 + (player.landCount || 0) * 1.8 + cityIncome * 15);

  return {
    totalIncome,
    baseIncome,
    landIncome,
    cityIncome,
    maxCapacity,
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
    this.walls = new Uint8Array(total); // 1 = fortified stone wall
    this.freshness = new Uint8Array(total);

    for (let i = 0; i < total; i++) {
      this.owners[i] = worldData.isLand[i] ? 0 : -1;
    }

    this.players = [];
    this.activePlayerIndex = 0;
    this.roundNumber = 1;

    // Active turn temporary move stack for Undo (Geri Al)
    this.turnMoves = [];
    this.turnTroopsSpent = 0;

    // Active sailing naval fleets
    this.fleets = [];
    this.nextFleetId = 1;

    // Animation / Particle effects
    this.particles = [];

    // Region bounding boxes for flag UV mapping
    this.regions = [];
    this.pixelRegion = new Int32Array(total);
    this.pixelRegion.fill(-1);

    this.dirtyRegions = true;
    this.dirtyPixels = true;
    this.winner = null;
  }

  getActivePlayer() {
    return this.players[this.activePlayerIndex] || null;
  }

  // Start fresh game with 1 (solo) or 2-4 (pass & play) players
  startNewGame({ playerSpecs }) {
    const total = MAP_W * MAP_H;
    for (let i = 0; i < total; i++) {
      this.owners[i] = this.worldData.isLand[i] ? 0 : -1;
      this.walls[i] = 0;
      this.freshness[i] = 0;
    }

    this.players = [];
    this.fleets = [];
    this.particles = [];
    this.turnMoves = [];
    this.turnTroopsSpent = 0;
    this.roundNumber = 1;
    this.activePlayerIndex = 0;
    this.winner = null;

    let nextId = 1;
    for (const spec of playerSpecs) {
      const landSpot = findNearestLand(spec.spawnX, spec.spawnY, this.worldData.isLand, 24) || {
        x: Math.round(MAP_W * 0.58),
        y: Math.round(MAP_H * 0.36),
      };

      const player = {
        id: nextId++,
        name: spec.name || `Oyuncu ${nextId - 1}`,
        color: spec.color || '#E30A17',
        flagCode: spec.flagCode || null,
        flagRgba: spec.flagRgba,
        flagDataUrl: spec.flagDataUrl,
        capitalX: landSpot.x,
        capitalY: landSpot.y,
        troops: 45, // Starter troop pool
        maxTroops: 120,
        landCount: 0,
        conqueredCities: [],
        wallsCount: 0,
        alive: true,
      };

      this.players.push(player);

      // Seed small starter outpost (around 9-14 cells)
      this._claimInitialCapitalPatch(player.id, landSpot.x, landSpot.y, 12);
    }

    this._recountAllLand();
    this.dirtyRegions = true;
    this.dirtyPixels = true;

    // Start Round 1 for Player 1
    this.startTurn();

    const p1 = this.getActivePlayer();
    this.onEvent(`🌍 ${p1.name} sefere başladı! Başkentinden etrafındaki toprakları fethet.`);
    this.saveToLocalStorage();
  }

  // Seed capital outpost
  _claimInitialCapitalPatch(playerId, cx, cy, count) {
    const total = MAP_W * MAP_H;
    const isLand = this.worldData.isLand;
    const queue = [{ x: cx, y: cy }];
    const visited = new Set();
    let claimed = 0;

    const dirs = [
      { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
      { dx: 1, dy: 1 }, { dx: -1, dy: 1 }, { dx: 1, dy: -1 }, { dx: -1, dy: -1 },
    ];

    while (queue.length > 0 && claimed < count) {
      const cur = queue.shift();
      const idx = cur.y * MAP_W + cur.x;
      if (visited.has(idx)) continue;
      visited.add(idx);

      if (isLand[idx] && (this.owners[idx] === 0 || this.owners[idx] === playerId)) {
        this.owners[idx] = playerId;
        this.freshness[idx] = 1;
        claimed++;

        for (const d of dirs) {
          const nx = cur.x + d.dx;
          const ny = cur.y + d.dy;
          if (nx >= 0 && nx < MAP_W && ny >= 0 && ny < MAP_H) {
            const nIdx = ny * MAP_W + nx;
            if (!visited.has(nIdx) && isLand[nIdx]) {
              queue.push({ x: nx, y: ny });
            }
          }
        }
      }
    }
  }

  // Start turn for current active player: deliver reinforcements
  startTurn() {
    this.turnMoves = [];
    this.turnTroopsSpent = 0;

    const player = this.getActivePlayer();
    if (!player) return;

    const eco = computePlayerTurnIncome(player, this.worldData);
    player.maxTroops = eco.maxCapacity;
    player.troops = Math.min(player.maxTroops, player.troops + eco.totalIncome);

    // Fade freshness
    const total = MAP_W * MAP_H;
    for (let i = 0; i < total; i++) {
      if (this.freshness[i] > 0) this.freshness[i]--;
    }

    this.onSound('turn');
  }

  // Check if cell (x, y) can be expanded into by active player
  canExpandToCell(playerId, x, y) {
    if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) {
      return { valid: false, reason: 'Harita dışı.' };
    }

    const idx = y * MAP_W + x;
    if (!this.worldData.isLand[idx]) {
      return { valid: false, reason: 'Deniz veya okyanus.' };
    }

    if (this.owners[idx] === playerId) {
      return { valid: false, reason: 'Zaten senin toprağın.' };
    }

    // Must be adjacent (4-way) to owned territory OR a pending cell claimed this turn
    const hasAdj =
      (x > 0 && this.owners[idx - 1] === playerId) ||
      (x < MAP_W - 1 && this.owners[idx + 1] === playerId) ||
      (y > 0 && this.owners[idx - MAP_W] === playerId) ||
      (y < MAP_H - 1 && this.owners[idx + MAP_W] === playerId);

    if (!hasAdj) {
      return { valid: false, reason: 'Sadece sınırındaki komşu topraklara ilerleyebilirsin!' };
    }

    // Calculate soldier cost based on terrain & walls
    const terrainType = this.worldData.terrain[idx] ?? TERRAIN_PLAINS;
    let cost = TERRAIN_TROOP_COST[terrainType] || 1;

    const hadWall = this.walls[idx] === 1;
    if (hadWall) {
      cost += ENEMY_WALL_BREACH_COST;
    }

    const targetOwner = this.owners[idx];
    const isEnemy = targetOwner > 0;
    if (isEnemy) {
      cost += ENEMY_TERRITORY_COST;
    }

    return {
      valid: true,
      cost,
      hadWall,
      isEnemy,
      targetOwner,
      terrainType,
    };
  }

  // Conquering a single cell (used by mouse/touch drag or click)
  conquerCell(playerId, x, y) {
    const player = this.getActivePlayer();
    if (!player || player.id !== playerId) return { ok: false, reason: 'Sıra sende değil!' };

    const check = this.canExpandToCell(playerId, x, y);
    if (!check.valid) return { ok: false, reason: check.reason };

    if (player.troops < check.cost) {
      return { ok: false, reason: `Yetersiz asker! (${check.cost} asker gerekiyor, sende ${player.troops} var)` };
    }

    const idx = y * MAP_W + x;
    const prevOwner = this.owners[idx];
    const hadWall = this.walls[idx] === 1;

    // Apply conquest
    player.troops -= check.cost;
    this.turnTroopsSpent += check.cost;
    this.owners[idx] = playerId;
    this.freshness[idx] = 4;
    if (hadWall) this.walls[idx] = 0;

    // Record for Undo
    const move = {
      type: 'EXPAND',
      idx,
      x,
      y,
      prevOwner,
      hadWall,
      cost: check.cost,
      conqueredCityId: null,
    };

    // Check if this move captured a real-world city!
    const newlyCapturedCity = this._checkCityCapture(playerId, idx);
    if (newlyCapturedCity) {
      move.conqueredCityId = newlyCapturedCity.id;
      player.conqueredCities.push(newlyCapturedCity.id);
      player.troops = Math.min(player.maxTroops + newlyCapturedCity.bonusTroops, player.troops + newlyCapturedCity.bonusTroops);
      this.onSound('celebration');
      this.onEvent(`🎉 ŞEHİR FETHEDİLDİ: ${newlyCapturedCity.name.toUpperCase()}! (+${newlyCapturedCity.bonusTroops} Asker Bonusu!)`);
    } else {
      this.onSound('pencil');
    }

    this.turnMoves.push(move);
    this.dirtyRegions = true;
    this.dirtyPixels = true;
    player.landCount++;

    if (prevOwner > 0) {
      const prevP = this.players.find((p) => p.id === prevOwner);
      if (prevP) prevP.landCount = Math.max(0, prevP.landCount - 1);
    }

    return { ok: true, cost: check.cost, newlyCapturedCity };
  }

  // Check if player now controls a city's area
  _checkCityCapture(playerId, latestIdx) {
    const cities = this.worldData.cities;
    if (!cities) return null;

    const player = this.getActivePlayer();
    if (!player) return null;

    for (const city of cities) {
      if (player.conqueredCities?.includes(city.id)) continue;
      if (!city.cellIndices.includes(latestIdx)) continue;

      // Count how many cells of this city belong to playerId
      let ownedCount = 0;
      for (const cIdx of city.cellIndices) {
        if (this.owners[cIdx] === playerId) ownedCount++;
      }

      // If at least 70% of city cells are controlled
      if (ownedCount >= Math.ceil(city.totalCells * 0.7)) {
        return city;
      }
    }
    return null;
  }

  // Check if cell can be fortified with a wall
  canBuildWall(playerId, x, y) {
    if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) return { valid: false };
    const idx = y * MAP_W + x;

    if (this.owners[idx] !== playerId) {
      return { valid: false, reason: 'Sadece kendi toprağına sur örebilirsin.' };
    }
    if (this.walls[idx] === 1) {
      return { valid: false, reason: 'Bu noktada zaten sur var.' };
    }

    // Must be on outer frontier (adjacent to neutral land, enemy, or water)
    const isBorder =
      x === 0 || x === MAP_W - 1 || y === 0 || y === MAP_H - 1 ||
      this.owners[idx - 1] !== playerId ||
      this.owners[idx + 1] !== playerId ||
      this.owners[idx - MAP_W] !== playerId ||
      this.owners[idx + MAP_W] !== playerId;

    if (!isBorder) {
      return { valid: false, reason: 'Sur sadece sınır hatlarına kurulabilir.' };
    }

    return { valid: true, cost: WALL_BUILD_COST };
  }

  // Build defensive wall
  buildWall(playerId, x, y) {
    const player = this.getActivePlayer();
    if (!player || player.id !== playerId) return { ok: false };

    const check = this.canBuildWall(playerId, x, y);
    if (!check.valid) return { ok: false, reason: check.reason };

    if (player.troops < check.cost) {
      return { ok: false, reason: `Sur için en az ${check.cost} asker gerekli!` };
    }

    const idx = y * MAP_W + x;
    player.troops -= check.cost;
    this.turnTroopsSpent += check.cost;
    this.walls[idx] = 1;
    player.wallsCount = (player.wallsCount || 0) + 1;

    this.turnMoves.push({
      type: 'WALL',
      idx,
      x,
      y,
      cost: check.cost,
    });

    this.onSound('tick');
    this.dirtyPixels = true;
    return { ok: true, cost: check.cost };
  }

  // Undo last move in active turn
  undoLastMove() {
    if (this.turnMoves.length === 0) return { ok: false, reason: 'Geri alınacak hamle yok.' };

    const move = this.turnMoves.pop();
    const player = this.getActivePlayer();

    if (move.type === 'EXPAND') {
      this.owners[move.idx] = move.prevOwner;
      if (move.hadWall) this.walls[move.idx] = 1;
      player.troops += move.cost;
      this.turnTroopsSpent = Math.max(0, this.turnTroopsSpent - move.cost);
      player.landCount = Math.max(0, player.landCount - 1);

      if (move.prevOwner > 0) {
        const prevP = this.players.find((p) => p.id === move.prevOwner);
        if (prevP) prevP.landCount++;
      }

      // If a city was completed this move, revert it
      if (move.conqueredCityId) {
        const city = this.worldData.cities?.find((c) => c.id === move.conqueredCityId);
        player.conqueredCities = player.conqueredCities.filter((cid) => cid !== move.conqueredCityId);
        if (city) {
          player.troops = Math.max(0, player.troops - city.bonusTroops);
        }
      }
    } else if (move.type === 'WALL') {
      this.walls[move.idx] = 0;
      player.troops += move.cost;
      this.turnTroopsSpent = Math.max(0, this.turnTroopsSpent - move.cost);
      player.wallsCount = Math.max(0, (player.wallsCount || 0) - 1);
    }

    this.onSound('tick');
    this.dirtyRegions = true;
    this.dirtyPixels = true;
    return { ok: true };
  }

  // Launch a naval fleet expedition across water to an overseas coastal target
  launchNavalFleet(playerId, fromX, fromY, toX, toY, troops) {
    const player = this.getActivePlayer();
    if (!player || player.id !== playerId) return { ok: false, reason: 'Sıra sende değil.' };

    if (troops < 15) return { ok: false, reason: 'Deniz seferi için en az 15 asker gerekli.' };
    if (player.troops < troops) return { ok: false, reason: 'Yeterli askerin yok.' };

    // Resolve land and water endpoints
    const fromLand = findNearestLand(fromX, fromY, this.worldData.isLand, 12);
    const toLand = findNearestLand(toX, toY, this.worldData.isLand, 16);
    if (!fromLand || !toLand) return { ok: false, reason: 'Geçerli kıyı bulunamadı.' };

    const fromWater = findNearestWater(fromLand.x, fromLand.y, this.worldData.isLand, 10);
    const toWater = findNearestWater(toLand.x, toLand.y, this.worldData.isLand, 10);
    if (!fromWater || !toWater) return { ok: false, reason: 'Kıyı noktası açık denize bağlı değil.' };

    const path = findOceanPath(fromWater.x, fromWater.y, toWater.x, toWater.y, this.worldData);
    if (!path || path.length < 2) return { ok: false, reason: 'Bu iki nokta arasında deniz yolu bulunamadı.' };

    player.troops -= troops;
    this.turnTroopsSpent += troops;

    const fleet = {
      id: this.nextFleetId++,
      playerId,
      troops,
      path,
      targetLand: toLand,
      step: 0,
      totalSteps: path.length,
      x: path[0].x,
      y: path[0].y,
    };

    this.fleets.push(fleet);
    this.onSound('turn');
    this.onEvent(`⚓ ${player.name} donanması denize açıldı! Hedef kıyıya çıkarma yapacak.`);
    return { ok: true, fleet };
  }

  // End turn: advance round, switch player, persist
  endTurn() {
    this.turnMoves = [];
    this.turnTroopsSpent = 0;

    // Advance fleet animations & landing
    this._advanceFleets();

    this._recountAllLand();
    this.dirtyRegions = true;
    this.dirtyPixels = true;

    // Switch to next player
    this.activePlayerIndex = (this.activePlayerIndex + 1) % this.players.length;
    if (this.activePlayerIndex === 0) {
      this.roundNumber++;
    }

    this.startTurn();
    this.saveToLocalStorage();

    const active = this.getActivePlayer();
    this.onEvent(`🚩 Tur ${this.roundNumber} başladı. Sıra: ${active.name}`);
    return { roundNumber: this.roundNumber, activePlayer: active };
  }

  _advanceFleets() {
    const remaining = [];
    for (const f of this.fleets) {
      // Advance by path segments
      f.step += 4;
      if (f.step >= f.totalSteps - 1) {
        // Landing reached! Claim beachhead
        this._claimInitialCapitalPatch(f.playerId, f.targetLand.x, f.targetLand.y, Math.min(20, Math.floor(f.troops / 2)));
        const p = this.players.find((pl) => pl.id === f.playerId);
        if (p) {
          p.troops += Math.floor(f.troops / 3);
        }
        this.onSound('celebration');
        this.onEvent(`⚓ ${p?.name || 'Donanma'} başarıyla karaya çıktı ve yeni bir koloni kurdu!`);
      } else {
        const pt = f.path[Math.min(f.step, f.path.length - 1)];
        f.x = pt.x;
        f.y = pt.y;
        remaining.push(f);
      }
    }
    this.fleets = remaining;
  }

  _recountAllLand() {
    for (const p of this.players) p.landCount = 0;
    const total = MAP_W * MAP_H;
    for (let i = 0; i < total; i++) {
      const o = this.owners[i];
      if (o > 0) {
        const p = this.players.find((pl) => pl.id === o);
        if (p) p.landCount++;
      }
    }
    for (const p of this.players) {
      p.alive = p.landCount > 0;
    }
  }

  // Precompute connected regions for flag texture mapping
  updateConnectedRegions() {
    if (!this.dirtyRegions) return;
    this.dirtyRegions = false;

    const total = MAP_W * MAP_H;
    const owners = this.owners;
    this.pixelRegion.fill(-1);
    this.regions = [];

    const visited = new Uint8Array(total);
    const q = new Int32Array(total);

    for (let y = 0; y < MAP_H; y++) {
      const row = y * MAP_W;
      for (let x = 0; x < MAP_W; x++) {
        const idx = row + x;
        const o = owners[idx];
        if (o <= 0 || visited[idx]) continue;

        let qHead = 0;
        let qTail = 0;
        q[qTail++] = idx;
        visited[idx] = 1;

        let minX = x; let maxX = x;
        let minY = y; let maxY = y;
        let count = 0;
        const regIdx = this.regions.length;

        while (qHead < qTail) {
          const cur = q[qHead++];
          this.pixelRegion[cur] = regIdx;
          count++;

          const cx = cur % MAP_W;
          const cy = (cur / MAP_W) | 0;

          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          if (cx > 0 && owners[cur - 1] === o && !visited[cur - 1]) {
            visited[cur - 1] = 1; q[qTail++] = cur - 1;
          }
          if (cx < MAP_W - 1 && owners[cur + 1] === o && !visited[cur + 1]) {
            visited[cur + 1] = 1; q[qTail++] = cur + 1;
          }
          if (cy > 0 && owners[cur - MAP_W] === o && !visited[cur - MAP_W]) {
            visited[cur - MAP_W] = 1; q[qTail++] = cur - MAP_W;
          }
          if (cy < MAP_H - 1 && owners[cur + MAP_W] === o && !visited[cur + MAP_W]) {
            visited[cur + MAP_W] = 1; q[qTail++] = cur + MAP_W;
          }
        }

        const w = Math.max(1, maxX - minX + 1);
        const h = Math.max(1, maxY - minY + 1);

        this.regions.push({
          ownerId: o,
          minX,
          minY,
          maxX,
          maxY,
          w,
          h,
          count,
        });
      }
    }
  }

  // Fast RLE encoding to save 500k cells in localStorage
  saveToLocalStorage() {
    try {
      const total = MAP_W * MAP_H;
      const rle = [];
      let curVal = this.owners[0];
      let runLen = 1;

      for (let i = 1; i < total; i++) {
        const v = this.owners[i];
        if (v === curVal && runLen < 65535) {
          runLen++;
        } else {
          rle.push(curVal, runLen);
          curVal = v;
          runLen = 1;
        }
      }
      rle.push(curVal, runLen);

      // Collect walls indices
      const wallIndices = [];
      for (let i = 0; i < total; i++) {
        if (this.walls[i]) wallIndices.push(i);
      }

      const payload = {
        v: 4,
        w: MAP_W,
        h: MAP_H,
        roundNumber: this.roundNumber,
        activePlayerIndex: this.activePlayerIndex,
        players: this.players.map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          flagCode: p.flagCode,
          flagDataUrl: p.flagDataUrl,
          capitalX: p.capitalX,
          capitalY: p.capitalY,
          troops: p.troops,
          maxTroops: p.maxTroops,
          landCount: p.landCount,
          conqueredCities: p.conqueredCities,
          wallsCount: p.wallsCount,
        })),
        rle,
        wallIndices,
      };

      localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('Failed to save world state:', e);
    }
  }

  // Load from localStorage
  loadFromLocalStorage() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (data.v !== 4 || data.w !== MAP_W || data.h !== MAP_H || !Array.isArray(data.rle)) {
        return false;
      }

      const total = MAP_W * MAP_H;
      let ptr = 0;
      for (let i = 0; i < data.rle.length; i += 2) {
        const val = data.rle[i];
        const len = data.rle[i + 1];
        for (let k = 0; k < len && ptr < total; k++) {
          this.owners[ptr++] = val;
        }
      }

      this.walls.fill(0);
      if (Array.isArray(data.wallIndices)) {
        for (const idx of data.wallIndices) {
          if (idx >= 0 && idx < total) this.walls[idx] = 1;
        }
      }

      this.roundNumber = data.roundNumber || 1;
      this.activePlayerIndex = data.activePlayerIndex || 0;
      this.players = (data.players || []).map((p) => ({
        ...p,
        alive: true,
      }));

      this.dirtyRegions = true;
      this.dirtyPixels = true;
      this._recountAllLand();
      return true;
    } catch (e) {
      console.warn('Failed to load world state:', e);
      return false;
    }
  }
}
