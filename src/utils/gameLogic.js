// Game Logic & Algorithms for City / Territory Conquest Game

export const PLAYER_COLORS = [
  { id: 1, name: 'Mavi', hex: '#2563eb', bg: '#dbeafe', border: '#1d4ed8', pen: '#1e40af' },
  { id: 2, name: 'Kırmızı', hex: '#dc2626', bg: '#fee2e2', border: '#b91c1c', pen: '#991b1b' },
  { id: 3, name: 'Yeşil', hex: '#16a34a', bg: '#dcfce7', border: '#15803d', pen: '#166534' },
  { id: 4, name: 'Turuncu', hex: '#d97706', bg: '#fef3c7', border: '#b45309', pen: '#92400e' },
  { id: 5, name: 'Mor', hex: '#9333ea', bg: '#f3e8ff', border: '#7e22ce', pen: '#6b21a8' },
  { id: 6, name: 'Pembe', hex: '#db2777', bg: '#fce7f3', border: '#be185d', pen: '#9d174d' },
  { id: 7, name: 'Camgöbeği', hex: '#0891b2', bg: '#cffafe', border: '#0e7490', pen: '#155e75' },
  { id: 8, name: 'Limon', hex: '#65a30d', bg: '#ecfccb', border: '#4d7c0f', pen: '#3f6212' },
];

/**
 * Calculates the maximum safe number S in [1, 9] a player can choose
 * so that in the worst case (Wheel R = S - 1), Loss = S * (S - 1),
 * remaining territory stays >= 1 (never drops to <= 0).
 * Formula: S * (S - 1) < currentArea
 */
export function calculateMaxSafeNumber(currentArea) {
  if (currentArea <= 1) return 1;
  let maxS = 1;
  for (let s = 1; s <= 9; s++) {
    const worstCaseLoss = s * (s - 1);
    if (worstCaseLoss < currentArea) {
      maxS = s;
    } else {
      break;
    }
  }
  return Math.min(9, maxS);
}

/**
 * Creates empty grid of size width x height (filled with 0: unowned)
 */
export function createEmptyGrid(width, height) {
  const grid = [];
  for (let y = 0; y < height; y++) {
    grid.push(new Array(width).fill(0));
  }
  return grid;
}

/**
 * Returns starting positions for up to 8 players on a grid
 */
export function getStartingPositions(gridWidth, gridHeight, playerCount, startSize) {
  const positions = [];

  // 1. Top-Left Corner
  positions.push({ x: 0, y: 0 });
  // 2. Top-Right Corner
  positions.push({ x: gridWidth - startSize, y: 0 });
  // 3. Bottom-Right Corner
  positions.push({ x: gridWidth - startSize, y: gridHeight - startSize });
  // 4. Bottom-Left Corner
  positions.push({ x: 0, y: gridHeight - startSize });

  // 5. Top-Center Edge
  const midX = Math.floor((gridWidth - startSize) / 2);
  const midY = Math.floor((gridHeight - startSize) / 2);
  positions.push({ x: midX, y: 0 });
  // 6. Right-Center Edge
  positions.push({ x: gridWidth - startSize, y: midY });
  // 7. Bottom-Center Edge
  positions.push({ x: midX, y: gridHeight - startSize });
  // 8. Left-Center Edge
  positions.push({ x: 0, y: midY });

  return positions.slice(0, playerCount);
}

/**
 * Places initial territory for all players
 */
export function initializeBoardTerritories(gridWidth, gridHeight, players, startSize) {
  const grid = createEmptyGrid(gridWidth, gridHeight);
  const startPositions = getStartingPositions(gridWidth, gridHeight, players.length, startSize);

  players.forEach((player, idx) => {
    const pos = startPositions[idx];
    for (let dy = 0; dy < startSize; dy++) {
      for (let dx = 0; dx < startSize; dx++) {
        const x = pos.x + dx;
        const y = pos.y + dy;
        if (x >= 0 && x < gridWidth && y >= 0 && y < gridHeight) {
          grid[y][x] = player.id;
        }
      }
    }
  });

  return grid;
}

/**
 * Counts total territory per player
 */
export function countPlayerTerritories(grid, players) {
  const counts = {};
  players.forEach(p => counts[p.id] = 0);

  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[0].length; x++) {
      const pid = grid[y][x];
      if (pid > 0 && counts[pid] !== undefined) {
        counts[pid]++;
      }
    }
  }
  return counts;
}

/**
 * Counts the number of connected components for a player's territory
 * (Uses 8-connectivity: diagonal touch is considered connected, unless blocked by cross rules)
 */
export function countCountryComponents(grid, playerId, excludedSet = new Set()) {
  const height = grid.length;
  const width = grid[0].length;
  const visited = new Set();
  let components = 0;

  const dirs = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
    { dx: 1, dy: 1 },
    { dx: 1, dy: -1 },
    { dx: -1, dy: 1 },
    { dx: -1, dy: -1 },
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (excludedSet.has(`${x},${y}`)) continue;
      if (grid[y][x] === playerId) {
        const key = `${x},${y}`;
        if (!visited.has(key)) {
          components++;
          const queue = [{ x, y }];
          visited.add(key);

          while (queue.length > 0) {
            const curr = queue.shift();
            for (const d of dirs) {
              const nx = curr.x + d.dx;
              const ny = curr.y + d.dy;
              if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                if (excludedSet.has(`${nx},${ny}`)) continue;
                if (grid[ny][nx] === playerId) {
                  const nkey = `${nx},${ny}`;
                  if (!visited.has(nkey)) {
                    visited.add(nkey);
                    queue.push({ x: nx, y: ny });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return components;
}

/**
 * Checks if a player's territory remains a single connected component (4-connected)
 * excluding all cells in the excludedSet.
 */
export function isCountryConnectedMulti(grid, playerId, excludedSet = new Set()) {
  return countCountryComponents(grid, playerId, excludedSet) <= 1;
}

export function isCountryConnected(grid, playerId, excludeX = -1, excludeY = -1) {
  const set = new Set();
  if (excludeX >= 0 && excludeY >= 0) {
    set.add(`${excludeX},${excludeY}`);
  }
  return isCountryConnectedMulti(grid, playerId, set);
}

/**
 * Checks whether placing candidate (tx, ty) would create an enclosed hole
 * or an empty pocket/cavity against the game boundary.
 */
export function wouldCreateTrappedPocket(grid, activePlayerId, tx, ty, pendingCells = []) {
  const height = grid.length;
  const width = grid[0].length;

  const dirs = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];

  const isPlayerCell = (x, y) => {
    if (x === tx && y === ty) return true;
    if (pendingCells.some(c => c.x === x && c.y === y && !c.isWallBreachOnly && (c.playerId === activePlayerId || !c.playerId))) return true;
    if (x >= 0 && x < width && y >= 0 && y < height) {
      return grid[y][x] === activePlayerId;
    }
    return false;
  };

  for (const dir of dirs) {
    const startX = tx + dir.dx;
    const startY = ty + dir.dy;

    if (startX < 0 || startX >= width || startY < 0 || startY >= height) continue;
    if (isPlayerCell(startX, startY)) continue;
    if (grid[startY][startX] !== 0) continue;

    const visited = new Set();
    const queue = [{ x: startX, y: startY }];
    visited.add(`${startX},${startY}`);

    let isSealedOff = true;
    let cellCount = 0;
    const maxSearch = Math.max(400, Math.min(1600, Math.floor(width * height * 0.4)));

    while (queue.length > 0) {
      const { x, y } = queue.shift();
      cellCount++;

      if (cellCount > maxSearch) {
        isSealedOff = false;
        break;
      }

      for (const d of dirs) {
        const nx = x + d.dx;
        const ny = y + d.dy;

        if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
          continue;
        }

        if (isPlayerCell(nx, ny)) {
          continue;
        }

        if (grid[ny][nx] !== 0 && grid[ny][nx] !== activePlayerId) {
          isSealedOff = false;
          break;
        }

        const key = `${nx},${ny}`;
        if (!visited.has(key)) {
          visited.add(key);
          queue.push({ x: nx, y: ny });
        }
      }

      if (!isSealedOff) break;
    }

    if (isSealedOff) {
      return { trapped: true };
    }
  }

  return { trapped: false };
}

/**
 * Prevents 2x2 checkerboard cross interlocks ("ülkeler iç içe giriyormuş gibi"):
 * Disallows placing a cell if it creates a 2x2 grid where two diagonally opposite cells
 * belong to activePlayer and the other two belong to enemy players (both sides occupied).
 */
export function wouldCreateCheckerboardCross(grid, activePlayerId, tx, ty, pendingCells = []) {
  const height = grid.length;
  const width = grid[0].length;

  const getOwner = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return 0;
    if (x === tx && y === ty) return activePlayerId;
    const pending = pendingCells.find(c => c.x === x && c.y === y);
    if (pending) {
      if (pending.isWallBreachOnly) {
        return grid[y][x];
      }
      return pending.playerId || activePlayerId;
    }
    return grid[y][x];
  };

  const offsets = [
    { ox: 0, oy: 0 },
    { ox: -1, oy: 0 },
    { ox: 0, oy: -1 },
    { ox: -1, oy: -1 },
  ];

  for (const { ox, oy } of offsets) {
    const x0 = tx + ox;
    const y0 = ty + oy;
    const x1 = x0 + 1;
    const y1 = y0 + 1;

    if (x0 < 0 || x1 >= width || y0 < 0 || y1 >= height) continue;

    const p00 = getOwner(x0, y0);
    const p10 = getOwner(x1, y0);
    const p01 = getOwner(x0, y1);
    const p11 = getOwner(x1, y1);

    // Diagonal 1: (x0, y0) and (x1, y1) are activePlayer
    if (p00 === activePlayerId && p11 === activePlayerId) {
      if (p10 > 0 && p01 > 0 && p10 !== activePlayerId && p01 !== activePlayerId) {
        return {
          cross: true,
          reason: 'İki tarafında da rakip varken çaprazdan iç içe geçilemez! Önce aradaki rakip toprağı fethetmelisin.'
        };
      }
    }

    // Diagonal 2: (x1, y0) and (x0, y1) are activePlayer
    if (p10 === activePlayerId && p01 === activePlayerId) {
      if (p00 > 0 && p11 > 0 && p00 !== activePlayerId && p11 !== activePlayerId) {
        return {
          cross: true,
          reason: 'İki tarafında da rakip varken çaprazdan iç içe geçilemez! Önce aradaki rakip toprağı fethetmelisin.'
        };
      }
    }
  }

  return { cross: false };
}

/**
 * Returns whether target cell (tx, ty) can be expanded into by activePlayer.
 */
export function canExpandToCell(grid, activePlayerId, tx, ty, pendingCells = [], alliances = [], allowFreeConquest = true) {
  const height = grid.length;
  const width = grid[0].length;

  if (tx < 0 || tx >= width || ty < 0 || ty >= height) return { valid: false, reason: 'Harita dışı' };

  if (grid[ty][tx] === activePlayerId) return { valid: false, reason: 'Zaten senin toprağın' };
  if (pendingCells.some(c => c.x === tx && c.y === ty)) return { valid: false, reason: 'Bu turda zaten seçtin' };

  const dirs = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];

  let isAdjacent = false;
  for (const dir of dirs) {
    const nx = tx + dir.dx;
    const ny = ty + dir.dy;
    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
      if (
        grid[ny][nx] === activePlayerId ||
        pendingCells.some(c => c.x === nx && c.y === ny && !c.isWallBreachOnly && (c.playerId === activePlayerId || (!c.playerId && grid[ny][nx] === activePlayerId)))
      ) {
        isAdjacent = true;
        break;
      }
    }
  }

  if (!isAdjacent) {
    return { valid: false, reason: 'Kendi sınırına bitişik bir kare seçmelisin' };
  }

  // Prevent 2x2 checkerboard cross (interlocking borders)
  const crossCheck = wouldCreateCheckerboardCross(grid, activePlayerId, tx, ty, pendingCells);
  if (crossCheck.cross) {
    return { valid: false, reason: crossCheck.reason };
  }

  const targetOwner = grid[ty][tx];

  // 1. Expanding into empty/neutral cell (0): Must not create an empty hole
  if (targetOwner === 0) {
    const trappedCheck = wouldCreateTrappedPocket(grid, activePlayerId, tx, ty, pendingCells);
    if (trappedCheck.trapped) {
      return {
        valid: false,
        reason: 'Sınırla veya ülkenle arada boşluk (delik) bırakamazsın! Önce aradaki boşlukları doldurmalısın.',
      };
    }
    return { valid: true, isAttack: false };
  }

  // 2. Target is an enemy cell (ATTACK):
  if (targetOwner > 0) {
    const hasAlliance = alliances.some(a => 
      a.status === 'active' && 
      ((a.player1Id === activePlayerId && a.player2Id === targetOwner) ||
       (a.player2Id === activePlayerId && a.player1Id === targetOwner))
    );

    // Count target owner's total territory on map
    let targetArea = 0;
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        if (grid[r][c] === targetOwner) targetArea++;
      }
    }

    // ELIMINATION & ENDGAME RULE:
    // If target has 12 or fewer cells, or if allowFreeConquest is enabled (default true):
    // ALWAYS ALLOW ATTACKING! No split-protection when executing or eliminating an enemy!
    if (allowFreeConquest || targetArea <= 12) {
      return { 
        valid: true, 
        isAttack: true, 
        targetOwner,
        isAllianceAttack: hasAlliance 
      };
    }

    const baseExcluded = new Set();
    pendingCells.forEach(c => {
      if (grid[c.y][c.x] === targetOwner) {
        baseExcluded.add(`${c.x},${c.y}`);
      }
    });

    const componentsBefore = countCountryComponents(grid, targetOwner, baseExcluded);
    const newExcluded = new Set(baseExcluded);
    newExcluded.add(`${tx},${ty}`);
    const componentsAfter = countCountryComponents(grid, targetOwner, newExcluded);

    // If components increase, this cell was a bridge/cut-set.
    if (componentsAfter > componentsBefore) {
      return { 
        valid: false, 
        reason: 'Bu kareyi alamazsın! Rakibin ülkesi ikiye bölünür (çapraz bağ da bölünme sayılır).' 
      };
    }

    return { 
      valid: true, 
      isAttack: true, 
      targetOwner,
      isAllianceAttack: hasAlliance 
    };
  }

  return { valid: true, isAttack: false };
}

/**
 * Checks whether active player can build a Wall/Sur on (x, y)
 * - Must be owned by player (or pending)
 * - Must not already have a wall
 * - Must be on the outer border
 */
export function canBuildWallOnCell(grid, activePlayerId, x, y, walls = {}, pendingCells = []) {
  const height = grid.length;
  const width = grid[0].length;
  const key = `${x},${y}`;

  if (walls[key]) return { valid: false, reason: 'Burada zaten duvar var' };

  // Must be owned
  const isOwned = grid[y][x] === activePlayerId || pendingCells.some(c => c.x === x && c.y === y && !c.isWallBreachOnly && (c.playerId === activePlayerId || !c.playerId));
  if (!isOwned) return { valid: false, reason: 'Sadece kendi sınırlarına duvar örebilirsin' };

  // Must touch an external tile
  const dirs = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
  let hasExternalBorder = false;

  for (const d of dirs) {
    const nx = x + d.dx;
    const ny = y + d.dy;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
      hasExternalBorder = true; // map boundary
      break;
    }
    const neighborOwner = grid[ny][nx];
    const isPendingOwned = pendingCells.some(c => c.x === nx && c.y === ny && !c.isWallBreachOnly && (c.playerId === activePlayerId || !c.playerId));
    if (neighborOwner !== activePlayerId && !isPendingOwned) {
      hasExternalBorder = true;
      break;
    }
  }

  if (!hasExternalBorder) {
    return { valid: false, reason: 'Duvar sadece dış sınırdaki karelere örülebilir' };
  }

  return { valid: true };
}

/**
 * Checks if activePlayer has at least one valid expansion or wall-building move remaining.
 * Prevents soft-locking when the map is full or no valid moves remain.
 */
export function hasAnyValidPlacingMove(grid, activePlayerId, pendingCells = [], pendingWalls = [], walls = {}, alliances = [], gameMode = 'KLASIK') {
  if (!grid || grid.length === 0) return false;
  const height = grid.length;
  const width = grid[0].length;
  const dirs = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
  const checkedExpand = new Set();

  // 1. Check if any adjacent cell can be expanded into (or breached wall conquered)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (grid[y][x] === activePlayerId) {
        for (const d of dirs) {
          const nx = x + d.dx;
          const ny = y + d.dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const key = `${nx},${ny}`;
            if (!checkedExpand.has(key)) {
              checkedExpand.add(key);
              if (canExpandToCell(grid, activePlayerId, nx, ny, pendingCells, alliances).valid) {
                return true;
              }
            }
          }
        }
      }
    }
  }

  for (const cell of pendingCells) {
    if (cell.isWallBreachOnly) {
      // Can conquer breached wall cell
      return true;
    }
    if (cell.playerId && cell.playerId !== activePlayerId) continue;
    for (const d of dirs) {
      const nx = cell.x + d.dx;
      const ny = cell.y + d.dy;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const key = `${nx},${ny}`;
        if (!checkedExpand.has(key)) {
          checkedExpand.add(key);
          if (canExpandToCell(grid, activePlayerId, nx, ny, pendingCells, alliances).valid) {
            return true;
          }
        }
      }
    }
  }

  // 2. In Modern Mode, also check if any valid wall can still be built
  if (gameMode === 'MODERN') {
    const currentWallsMap = { ...walls };
    pendingWalls.forEach(w => { currentWallsMap[`${w.x},${w.y}`] = true; });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (grid[y][x] === activePlayerId) {
          if (canBuildWallOnCell(grid, activePlayerId, x, y, currentWallsMap, pendingCells).valid) {
            return true;
          }
        }
      }
    }
    for (const cell of pendingCells) {
      if (!cell.isWallBreachOnly && (!cell.playerId || cell.playerId === activePlayerId)) {
        if (canBuildWallOnCell(grid, activePlayerId, cell.x, cell.y, currentWallsMap, pendingCells).valid) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Intelligent country shrink algorithm
 * Safely handles countries that are already split into multiple components so no player becomes immune to penalties.
 */
export function shrinkCountrySmart(grid, playerId, amount, walls = {}) {
  const height = grid.length;
  const width = grid[0].length;
  const newGrid = grid.map(row => [...row]);
  const newWalls = { ...walls };
  const removedCells = [];

  const dirs = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];

  for (let step = 0; step < amount; step++) {
    const candidates = [];
    const fallbackCandidates = [];
    const componentsBefore = countCountryComponents(newGrid, playerId);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (newGrid[y][x] === playerId) {
          let externalBorders = 0;
          for (const dir of dirs) {
            const nx = x + dir.dx;
            const ny = y + dir.dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height || newGrid[ny][nx] !== playerId) {
              externalBorders++;
            }
          }

          if (externalBorders > 0) {
            fallbackCandidates.push({ x, y, externalBorders });
            const componentsAfter = countCountryComponents(newGrid, playerId, new Set([`${x},${y}`]));
            if (componentsAfter <= componentsBefore) {
              candidates.push({ x, y, externalBorders });
            }
          }
        }
      }
    }

    const pool = candidates.length > 0 ? candidates : fallbackCandidates;
    if (pool.length === 0) break;

    pool.sort((a, b) => b.externalBorders - a.externalBorders);
    const chosen = pool[0];

    newGrid[chosen.y][chosen.x] = 0;
    delete newWalls[`${chosen.x},${chosen.y}`];
    removedCells.push(chosen);
  }

  return { newGrid, newWalls, removedCells };
}

export function applyBreachPenalty(grid, violatorPlayerId, count, walls = {}) {
  return shrinkCountrySmart(grid, violatorPlayerId, count, walls);
}

/**
 * Transfers 'amount' border cells from fromPlayerId to toPlayerId
 */
export function transferTerritory(grid, fromPlayerId, toPlayerId, amount, walls = {}) {
  const height = grid.length;
  const width = grid[0].length;
  const newGrid = grid.map(row => [...row]);
  const newWalls = { ...walls };
  const transferred = [];

  const dirs = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];

  for (let step = 0; step < amount; step++) {
    const candidates = [];
    const fallbackCandidates = [];
    const componentsBefore = countCountryComponents(newGrid, fromPlayerId);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (newGrid[y][x] === fromPlayerId) {
          // Check if it touches toPlayerId
          let touchesTarget = false;
          for (const d of dirs) {
            const nx = x + d.dx;
            const ny = y + d.dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              if (newGrid[ny][nx] === toPlayerId) {
                touchesTarget = true;
                break;
              }
            }
          }

          if (touchesTarget) {
            fallbackCandidates.push({ x, y });
            const componentsAfter = countCountryComponents(newGrid, fromPlayerId, new Set([`${x},${y}`]));
            if (componentsAfter <= componentsBefore) {
              candidates.push({ x, y });
            }
          }
        }
      }
    }

    const pool = candidates.length > 0 ? candidates : fallbackCandidates;
    if (pool.length === 0) break;

    const chosen = pool[0];
    newGrid[chosen.y][chosen.x] = toPlayerId;
    delete newWalls[`${chosen.x},${chosen.y}`];
    transferred.push(chosen);
  }

  return { newGrid, newWalls, transferred };
}

/**
 * Instantly expand player territory for debug/testing
 */
export function expandPlayerInstant(grid, playerId, amount) {
  const height = grid.length;
  const width = grid[0].length;
  const newGrid = grid.map(row => [...row]);
  const dirs = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
  let added = 0;

  for (let step = 0; step < amount; step++) {
    const candidates = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (newGrid[y][x] === 0) {
          const touches = dirs.some(d => {
            const nx = x + d.dx;
            const ny = y + d.dy;
            return nx >= 0 && nx < width && ny >= 0 && ny < height && newGrid[ny][nx] === playerId;
          });
          if (touches) candidates.push({ x, y });
        }
      }
    }
    if (candidates.length === 0) break;
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    newGrid[chosen.y][chosen.x] = playerId;
    added++;
  }

  return { newGrid, added };
}

