import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  generateWorldMap,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  PRESET_FLAGS,
  calculateEmpireStats,
} from '../../utils/worldMapData';
import { soundManager } from '../../utils/audio';
import {
  Globe,
  Upload,
  Shield,
  Ship,
  Swords,
  Castle,
  Zap,
  RotateCcw,
  Home,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Crosshair,
  Award,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';

const AI_FACTIONS = [
  { id: 'ai_rome', name: 'Roma Lejyonu', color: '#dc2626', flagUrl: 'https://flagcdn.com/w320/it.png', startContinent: 'Avrupa' },
  { id: 'ai_samurai', name: 'Samuray Hanedanı', color: '#9333ea', flagUrl: 'https://flagcdn.com/w320/jp.png', startContinent: 'Asya' },
  { id: 'ai_viking', name: 'Viking Krallığı', color: '#2563eb', flagUrl: 'https://flagcdn.com/w320/no.png', startContinent: 'Kuzey Amerika' },
  { id: 'ai_pharaoh', name: 'Firavun İmparatorluğu', color: '#d97706', flagUrl: 'https://flagcdn.com/w320/eg.png', startContinent: 'Afrika' },
  { id: 'ai_incas', name: 'İnka Güneş Devleti', color: '#059669', flagUrl: 'https://flagcdn.com/w320/pe.png', startContinent: 'Güney Amerika' },
  { id: 'ai_outback', name: 'Kraliyet Donanması', color: '#0284c7', flagUrl: 'https://flagcdn.com/w320/gb.png', startContinent: 'Okyanusya' },
];

export default function WorldGame({ onReturnToModeSelect }) {
  // State: 'SETUP' | 'PLAYING'
  const [worldState, setWorldState] = useState(() => {
    return localStorage.getItem('sf_world_empire_state') ? 'PLAYING' : 'SETUP';
  });

  // Setup form
  const [empireName, setEmpireName] = useState('Büyük Türk Devleti');
  const [customFlagData, setCustomFlagData] = useState('https://flagcdn.com/w320/tr.png');
  const [empireColor, setEmpireColor] = useState('#e11d48');
  const [startContinent, setStartContinent] = useState('Avrupa');

  // Game data
  const [grid, setGrid] = useState([]);
  const [fleets, setFleets] = useState([]); // [{ id, ownerId, troops, fromX, fromY, toX, toY, curX, curY, shipType }]
  const [myTroops, setMyTroops] = useState(500);
  const [sendRatio, setSendRatio] = useState(50); // 20 | 50 | 100
  const [actionMode, setActionMode] = useState('EXPAND'); // 'EXPAND' | 'NAVAL' | 'FORTIFY'
  const [guardianActive, setGuardianActive] = useState(true);
  const [logMessages, setLogMessages] = useState([]);
  const [toastMessage, setToastMessage] = useState(null);

  // Zoom / Pan
  const [zoom, setZoom] = useState(1.0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

  // Canvas & Image cache
  const canvasRef = useRef(null);
  const imageCacheRef = useRef(new Map());

  // Cached pattern map: ownerId -> CanvasPattern
  const patternCacheRef = useRef(new Map());

  // Refs for loop
  const gridRef = useRef(grid);
  const fleetsRef = useRef(fleets);
  const myTroopsRef = useRef(myTroops);
  const guardianActiveRef = useRef(guardianActive);

  useEffect(() => { gridRef.current = grid; }, [grid]);
  useEffect(() => { fleetsRef.current = fleets; }, [fleets]);
  useEffect(() => { myTroopsRef.current = myTroops; }, [myTroops]);
  useEffect(() => { guardianActiveRef.current = guardianActive; }, [guardianActive]);

  const addLog = useCallback((text) => {
    setLogMessages((prev) => [text, ...prev.slice(0, 7)]);
  }, []);

  const showToast = useCallback((msg) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  }, []);

  // Preload an image URL into HTMLImageElement
  const getPreloadedImage = useCallback((url) => {
    if (!url) return null;
    if (imageCacheRef.current.has(url)) {
      return imageCacheRef.current.get(url);
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    img.onload = () => {
      imageCacheRef.current.set(url, img);
    };
    return img;
  }, []);

  // Handle custom image file upload
  const handleImageUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('Lütfen geçerli bir resim dosyası seçin (PNG, JPG, WebP)!');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target.result;
      setCustomFlagData(dataUrl);
      const img = new Image();
      img.src = dataUrl;
      img.onload = () => {
        imageCacheRef.current.set(dataUrl, img);
        patternCacheRef.current.clear(); // invalidate patterns
      };
      soundManager.playClick();
      showToast('Kendi görselin başarıyla yüklendi!');
    };
    reader.readAsDataURL(file);
  };

  // Initialize or restore game
  const initGame = useCallback((isNew = false) => {
    let saved = null;
    if (!isNew) {
      try {
        const raw = localStorage.getItem('sf_world_empire_state');
        if (raw) saved = JSON.parse(raw);
      } catch (e) {
        console.error('Error loading world state:', e);
      }
    }

    if (saved && !isNew) {
      setEmpireName(saved.empireName || 'Büyük Türk Devleti');
      setCustomFlagData(saved.customFlagData || 'https://flagcdn.com/w320/tr.png');
      setEmpireColor(saved.empireColor || '#e11d48');
      setGrid(saved.grid);
      setFleets(saved.fleets || []);
      setMyTroops(saved.myTroops || 500);
      setWorldState('PLAYING');
      showToast(`🛡️ Vekil Muhafız Raporu: Hoş geldin! Yokluğunda toprakların korundu.`);
      return;
    }

    // Generate fresh world map
    const newGrid = generateWorldMap();

    // Spawn player in chosen continent
    const playerCells = [];
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let x = 0; x < WORLD_WIDTH; x++) {
        if (newGrid[y][x].type === 'LAND' && newGrid[y][x].continent === startContinent) {
          playerCells.push({ x, y });
        }
      }
    }

    // Pick 3-5 contiguous cells for player capital
    if (playerCells.length > 0) {
      const startSeed = playerCells[Math.floor(playerCells.length / 2)];
      const radius = 2;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = startSeed.x + dx;
          const ny = startSeed.y + dy;
          if (nx >= 0 && nx < WORLD_WIDTH && ny >= 0 && ny < WORLD_HEIGHT) {
            if (newGrid[ny][nx].type === 'LAND') {
              newGrid[ny][nx].ownerId = 'player';
              newGrid[ny][nx].troops = 50;
            }
          }
        }
      }
    }

    // Spawn AI factions across other continents
    AI_FACTIONS.forEach((ai) => {
      const candidates = [];
      for (let y = 0; y < WORLD_HEIGHT; y++) {
        for (let x = 0; x < WORLD_WIDTH; x++) {
          if (newGrid[y][x].type === 'LAND' && newGrid[y][x].continent === ai.startContinent && !newGrid[y][x].ownerId) {
            candidates.push({ x, y });
          }
        }
      }
      if (candidates.length > 0) {
        const seed = candidates[Math.floor(candidates.length / 2)];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = seed.x + dx;
            const ny = seed.y + dy;
            if (nx >= 0 && nx < WORLD_WIDTH && ny >= 0 && ny < WORLD_HEIGHT) {
              if (newGrid[ny][nx].type === 'LAND') {
                newGrid[ny][nx].ownerId = ai.id;
                newGrid[ny][nx].troops = 40;
              }
            }
          }
        }
      }
    });

    setGrid(newGrid);
    setFleets([]);
    setMyTroops(600);
    setWorldState('PLAYING');
    showToast(`🌍 ${empireName} dünya sahnesine çıktı! Topraklarını fethet!`);
  }, [startContinent, empireName, showToast]);

  useEffect(() => {
    if (worldState === 'PLAYING' && grid.length === 0) {
      initGame(false);
    }
  }, [worldState, grid.length, initGame]);

  // Preload initial flags
  useEffect(() => {
    if (customFlagData) getPreloadedImage(customFlagData);
    AI_FACTIONS.forEach((ai) => getPreloadedImage(ai.flagUrl));
  }, [customFlagData, getPreloadedImage]);

  // Player Stats calculation
  const playerTerritoryCount = useMemo(() => {
    let count = 0;
    grid.forEach((row) => {
      row.forEach((cell) => {
        if (cell.ownerId === 'player') count++;
      });
    });
    return count;
  }, [grid]);

  const playerStats = useMemo(() => {
    return calculateEmpireStats(playerTerritoryCount);
  }, [playerTerritoryCount]);

  // Real-Time Game Engine Tick Loop (Every 1000ms)
  useEffect(() => {
    if (worldState !== 'PLAYING') return;

    const interval = setInterval(() => {
      const curGrid = gridRef.current;
      if (!curGrid || curGrid.length === 0) return;

      // 1. Troop Production Tick for Player
      setMyTroops((prev) => {
        const stats = calculateEmpireStats(playerTerritoryCount);
        const next = Math.min(stats.maxTroops, prev + stats.regenPerSec);
        return next;
      });

      // 2. AI Empires Logic & Expansion
      const updatedGrid = curGrid.map((row) => row.map((cell) => ({ ...cell })));
      let gridChanged = false;

      AI_FACTIONS.forEach((ai) => {
        // Collect AI borders
        const aiCells = [];
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          for (let x = 0; x < WORLD_WIDTH; x++) {
            if (updatedGrid[y][x].ownerId === ai.id) {
              aiCells.push({ x, y, troops: updatedGrid[y][x].troops });
            }
          }
        }

        if (aiCells.length === 0) return;

        // AI expansion chance (every few ticks)
        if (Math.random() < 0.6) {
          const source = aiCells[Math.floor(Math.random() * aiCells.length)];
          const dirs = [
            { dx: 1, dy: 0 },
            { dx: -1, dy: 0 },
            { dx: 0, dy: 1 },
            { dx: 0, dy: -1 },
          ];
          const dir = dirs[Math.floor(Math.random() * dirs.length)];
          const tx = source.x + dir.dx;
          const ty = source.y + dir.dy;

          if (tx >= 0 && tx < WORLD_WIDTH && ty >= 0 && ty < WORLD_HEIGHT) {
            const target = updatedGrid[ty][tx];
            if (target.type === 'LAND' && target.ownerId !== ai.id) {
              // Battle simulation
              const isPlayer = target.ownerId === 'player';
              let defenseBonus = target.fortLevel > 0 ? 1.8 : 1.0;
              if (isPlayer && guardianActiveRef.current) {
                defenseBonus *= 2.5; // Guardian AI heavy resistance!
              }

              const aiAttackPower = 20 + Math.floor(Math.random() * 25);
              const targetDefensePower = target.troops * defenseBonus;

              if (aiAttackPower > targetDefensePower) {
                // AI conquered cell
                target.ownerId = ai.id;
                target.troops = Math.max(10, Math.floor(aiAttackPower - targetDefensePower));
                target.fortLevel = 0;
                gridChanged = true;
                if (isPlayer) {
                  soundManager.playHit();
                  addLog(`⚠️ ${ai.name} sınırındaki bir toprağını ele geçirdi!`);
                }
              } else {
                target.troops = Math.max(5, Math.floor(target.troops - aiAttackPower / defenseBonus));
                gridChanged = true;
                if (isPlayer) {
                  addLog(`🛡️ Vekil Muhafız: ${ai.name} saldırısını püskürttü! Ağır kayıp verdiler.`);
                }
              }
            }
          }
        }
      });

      // 3. Move Naval Fleets
      setFleets((prevFleets) => {
        if (prevFleets.length === 0) return prevFleets;
        const remaining = [];

        prevFleets.forEach((fleet) => {
          const dx = fleet.toX - fleet.curX;
          const dy = fleet.toY - fleet.curY;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist <= 1.2) {
            // Fleet arrived at target!
            const targetCell = updatedGrid[fleet.toY][fleet.toX];
            if (targetCell.type === 'LAND') {
              if (targetCell.ownerId === fleet.ownerId) {
                // Friendly reinforcement
                targetCell.troops += fleet.troops;
                gridChanged = true;
                if (fleet.ownerId === 'player') {
                  addLog(`🚢 Donanman kıyıya ulaştı ve +${fleet.troops} asker takviye etti!`);
                }
              } else {
                // Amphibious Assault Battle!
                const defenseBonus = (targetCell.fortLevel > 0 ? 2.0 : 1.0) * (targetCell.ownerId === 'player' && guardianActiveRef.current ? 2.5 : 1.0);
                const effectiveDefense = targetCell.troops * defenseBonus;

                if (fleet.troops > effectiveDefense) {
                  // Conquered!
                  targetCell.ownerId = fleet.ownerId;
                  targetCell.troops = Math.max(15, Math.floor(fleet.troops - effectiveDefense));
                  targetCell.fortLevel = 0;
                  gridChanged = true;
                  soundManager.playCelebration();
                  if (fleet.ownerId === 'player') {
                    addLog(`🎉 ÇIKARMA BAŞARILI! ${targetCell.name || 'Kıyı'} toprakları ele geçirildi!`);
                  }
                } else {
                  targetCell.troops = Math.max(5, Math.floor(targetCell.troops - fleet.troops / defenseBonus));
                  gridChanged = true;
                  if (fleet.ownerId === 'player') {
                    addLog(`💀 Çıkarma başarısız oldu, donanma sahil savunmasını aşamadı.`);
                  }
                }
              }
            }
          } else {
            // Continue sailing
            const speed = fleet.shipType === 'DREADNOUGHT' ? 1.4 : 0.9;
            const stepX = (dx / dist) * speed;
            const stepY = (dy / dist) * speed;
            remaining.push({
              ...fleet,
              curX: fleet.curX + stepX,
              curY: fleet.curY + stepY,
            });
          }
        });

        return remaining;
      });

      if (gridChanged) {
        setGrid(updatedGrid);
      }

      // Auto-save state every 5 seconds
      try {
        localStorage.setItem(
          'sf_world_empire_state',
          JSON.stringify({
            empireName,
            customFlagData,
            empireColor,
            grid: updatedGrid,
            fleets: fleetsRef.current,
            myTroops: myTroopsRef.current,
            savedAt: Date.now(),
          })
        );
      } catch (e) {
        // storage quota ignored
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [worldState, playerTerritoryCount, empireName, customFlagData, empireColor, addLog]);

  // Handle Cell Clicks (Expand, Naval, Fortify)
  const handleCellClick = (x, y) => {
    if (worldState !== 'PLAYING') return;
    const curGrid = gridRef.current;
    if (!curGrid || !curGrid[y] || !curGrid[y][x]) return;

    const cell = curGrid[y][x];
    const troopsToSend = Math.max(15, Math.floor((myTroops * sendRatio) / 100));

    // 1. FORTIFY MODE
    if (actionMode === 'FORTIFY') {
      if (cell.ownerId !== 'player') {
        showToast('Sadece kendi topraklarına kale inşa edebilirsin!');
        return;
      }
      if (myTroops < 150) {
        showToast('Kale inşa etmek için en az 150 asker gerekli!');
        return;
      }
      setMyTroops((prev) => prev - 150);
      setGrid((prev) => {
        const next = prev.map((row) => [...row]);
        next[y][x] = { ...next[y][x], fortLevel: (next[y][x].fortLevel || 0) + 1 };
        return next;
      });
      soundManager.playPencil();
      showToast('🏰 Sınır kalesi inşa edildi! Savunma gücü 2 katına çıktı.');
      return;
    }

    // 2. NAVAL LAUNCH MODE
    if (actionMode === 'NAVAL') {
      // Must click on a coastal or water cell near player territory, or launch from player land to distant coast
      if (myTroops < 50) {
        showToast('Deniz seferi için en az 50 asker biriktirmelisin!');
        return;
      }

      // Find player nearest coastal cell to launch from
      let bestCoast = null;
      let minTargetDist = 9999;

      for (let py = 0; py < WORLD_HEIGHT; py++) {
        for (let px = 0; px < WORLD_WIDTH; px++) {
          if (curGrid[py][px].ownerId === 'player') {
            // Check if coastal (adjacent to water)
            const isCoastal = [
              { dx: 1, dy: 0 },
              { dx: -1, dy: 0 },
              { dx: 0, dy: 1 },
              { dx: 0, dy: -1 },
            ].some((d) => {
              const nx = px + d.dx;
              const ny = py + d.dy;
              return nx >= 0 && nx < WORLD_WIDTH && ny >= 0 && ny < WORLD_HEIGHT && curGrid[ny][nx].type === 'WATER';
            });

            if (isCoastal) {
              const dist = Math.hypot(px - x, py - y);
              if (dist < minTargetDist) {
                minTargetDist = dist;
                bestCoast = { x: px, y: py };
              }
            }
          }
        }
      }

      if (!bestCoast) {
        showToast('Denize kıyısı olan bir toprağın yok! Önce kıyıya doğru genişle.');
        return;
      }

      // Launch fleet
      setMyTroops((prev) => prev - troopsToSend);
      const newFleet = {
        id: `fleet_${Date.now()}_${Math.random()}`,
        ownerId: 'player',
        troops: troopsToSend,
        fromX: bestCoast.x,
        fromY: bestCoast.y,
        toX: x,
        toY: y,
        curX: bestCoast.x,
        curY: bestCoast.y,
        shipType: playerStats.shipType,
      };

      setFleets((prev) => [...prev, newFleet]);
      soundManager.playSpin();
      showToast(`🚢 ${troopsToSend} askerlik Donanma denize indi! Hedefe ilerliyor.`);
      setActionMode('EXPAND');
      return;
    }

    // 3. EXPAND / ATTACK MODE
    if (cell.type === 'WATER') {
      showToast('Deniz bölgesine doğrudan yürüyemezsin! "🚢 Donanma Seferi" modunu kullan.');
      return;
    }

    if (cell.ownerId === 'player') {
      showToast('Bu toprak zaten senin!');
      return;
    }

    // Check adjacency to player lands
    const isAdjacent = [
      { dx: 1, dy: 0 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 0, dy: -1 },
      { dx: 1, dy: 1 },
      { dx: -1, dy: -1 },
      { dx: 1, dy: -1 },
      { dx: -1, dy: 1 },
    ].some((d) => {
      const nx = x + d.dx;
      const ny = y + d.dy;
      return nx >= 0 && nx < WORLD_WIDTH && ny >= 0 && ny < WORLD_HEIGHT && curGrid[ny][nx].ownerId === 'player';
    });

    if (!isAdjacent) {
      showToast('Sadece sınır komşun olan topraklara saldırabilirsin! Uzak kıtalar için Donanma kullan.');
      return;
    }

    if (myTroops < 15) {
      showToast('Saldırmak için yeterli askerin yok!');
      return;
    }

    // Battle simulation
    setMyTroops((prev) => prev - troopsToSend);
    const defMultiplier = cell.fortLevel > 0 ? 2.0 : 1.0;
    const effectiveDefense = cell.troops * defMultiplier;

    if (troopsToSend > effectiveDefense) {
      // Conquered!
      setGrid((prev) => {
        const next = prev.map((row) => [...row]);
        next[y][x] = {
          ...next[y][x],
          ownerId: 'player',
          troops: Math.max(10, Math.floor(troopsToSend - effectiveDefense)),
          fortLevel: 0,
        };
        return next;
      });
      soundManager.playPencil();
      addLog(`⚔️ Zafer! ${cell.name || 'Toprak'} fethedildi ve bayrağın dikildi.`);
    } else {
      // Repelled
      setGrid((prev) => {
        const next = prev.map((row) => [...row]);
        next[y][x] = {
          ...next[y][x],
          troops: Math.max(5, Math.floor(cell.troops - troopsToSend / defMultiplier)),
        };
        return next;
      });
      soundManager.playHit();
      addLog(`💥 Saldırı püskürtüldü! Düşman savunması direnç gösterdi.`);
    }
  };

  // Render Canvas World Map
  useEffect(() => {
    if (worldState !== 'PLAYING') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Resize canvas to container
    const width = canvas.parentElement?.clientWidth || 800;
    const height = canvas.parentElement?.clientHeight || 600;
    canvas.width = width;
    canvas.height = height;

    const cellW = (width / WORLD_WIDTH) * zoom;
    const cellH = (height / WORLD_HEIGHT) * zoom;

    ctx.save();
    ctx.clearRect(0, 0, width, height);

    // Apply pan & zoom
    ctx.translate(pan.x, pan.y);

    // 1. Draw Deep Ocean Background with wave lines
    ctx.fillStyle = '#0a192f'; // Deep ocean blue
    ctx.fillRect(-pan.x, -pan.y, width * 2, height * 2);

    // 2. Prepare pattern for player
    let playerPattern = null;
    if (customFlagData && imageCacheRef.current.has(customFlagData)) {
      const img = imageCacheRef.current.get(customFlagData);
      if (img && img.complete && img.naturalWidth > 0) {
        if (!patternCacheRef.current.has('player')) {
          const pat = ctx.createPattern(img, 'repeat');
          patternCacheRef.current.set('player', pat);
        }
        playerPattern = patternCacheRef.current.get('player');
      }
    }

    // 3. Draw Grid Cells
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let x = 0; x < WORLD_WIDTH; x++) {
        const cell = grid[y]?.[x];
        if (!cell) continue;

        const px = x * cellW;
        const py = y * cellH;

        if (cell.type === 'WATER') {
          // Ocean cell with subtle shimmer
          ctx.fillStyle = '#0f2744';
          ctx.fillRect(px, py, cellW + 0.5, cellH + 0.5);
          ctx.strokeStyle = '#163b66';
          ctx.lineWidth = 0.3;
          ctx.strokeRect(px, py, cellW, cellH);
        } else {
          // LAND CELL
          if (!cell.ownerId) {
            // Neutral Wild Land
            ctx.fillStyle = '#2d3748'; // dark slate
            ctx.fillRect(px, py, cellW + 0.5, cellH + 0.5);
            ctx.strokeStyle = '#4a5568';
            ctx.lineWidth = 0.5;
            ctx.strokeRect(px, py, cellW, cellH);
          } else if (cell.ownerId === 'player') {
            // PLAYER OWNED TERRITORY - Pattern filled with custom flag!
            if (playerPattern) {
              ctx.fillStyle = playerPattern;
              ctx.fillRect(px, py, cellW + 0.5, cellH + 0.5);
              // Tint with player color
              ctx.fillStyle = `${empireColor}44`;
              ctx.fillRect(px, py, cellW + 0.5, cellH + 0.5);
            } else {
              ctx.fillStyle = empireColor;
              ctx.fillRect(px, py, cellW + 0.5, cellH + 0.5);
            }

            // Crisp golden empire border
            ctx.strokeStyle = '#fbbf24';
            ctx.lineWidth = 1;
            ctx.strokeRect(px, py, cellW, cellH);

            // Castle Fortification indicator
            if (cell.fortLevel > 0) {
              ctx.fillStyle = '#ffffff';
              ctx.font = `${Math.max(8, cellH * 0.7)}px sans-serif`;
              ctx.fillText('🏰', px + cellW * 0.1, py + cellH * 0.8);
            }
          } else {
            // AI FACTION TERRITORY
            const ai = AI_FACTIONS.find((f) => f.id === cell.ownerId);
            const aiImg = ai?.flagUrl ? imageCacheRef.current.get(ai.flagUrl) : null;

            if (aiImg && aiImg.complete) {
              if (!patternCacheRef.current.has(ai.id)) {
                patternCacheRef.current.set(ai.id, ctx.createPattern(aiImg, 'repeat'));
              }
              ctx.fillStyle = patternCacheRef.current.get(ai.id) || ai.color;
              ctx.fillRect(px, py, cellW + 0.5, cellH + 0.5);
              ctx.fillStyle = `${ai.color}55`;
              ctx.fillRect(px, py, cellW + 0.5, cellH + 0.5);
            } else {
              ctx.fillStyle = ai?.color || '#ef4444';
              ctx.fillRect(px, py, cellW + 0.5, cellH + 0.5);
            }

            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 0.8;
            ctx.strokeRect(px, py, cellW, cellH);
          }
        }
      }
    }

    // 4. Draw Sailing Fleets (Ships)
    fleets.forEach((fleet) => {
      const fx = fleet.curX * cellW;
      const fy = fleet.curY * cellH;

      // Ship wake trail
      ctx.strokeStyle = '#38bdf888';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(fleet.fromX * cellW + cellW / 2, fleet.fromY * cellH + cellH / 2);
      ctx.lineTo(fx + cellW / 2, fy + cellH / 2);
      ctx.stroke();

      // Ship icon / body
      ctx.fillStyle = fleet.ownerId === 'player' ? '#fbbf24' : '#ef4444';
      ctx.beginPath();
      ctx.arc(fx + cellW / 2, fy + cellH / 2, Math.max(6, cellW * 0.6), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Ship icon
      ctx.font = `${Math.max(10, cellW * 0.8)}px sans-serif`;
      ctx.fillText('🚢', fx, fy + cellH / 2);
    });

    ctx.restore();
  }, [worldState, grid, fleets, zoom, pan, customFlagData, empireColor]);

  // Touch & Mouse Drag to Pan
  const handlePointerDown = (e) => {
    isDraggingRef.current = true;
    dragStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handlePointerMove = (e) => {
    if (!isDraggingRef.current) return;
    setPan({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    });
  };

  const handlePointerUp = () => {
    isDraggingRef.current = false;
  };

  // Convert canvas click to grid coords
  const handleCanvasClick = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left - pan.x;
    const clickY = e.clientY - rect.top - pan.y;

    const cellW = (canvas.width / WORLD_WIDTH) * zoom;
    const cellH = (canvas.height / WORLD_HEIGHT) * zoom;

    const gx = Math.floor(clickX / cellW);
    const gy = Math.floor(clickY / cellH);

    if (gx >= 0 && gx < WORLD_WIDTH && gy >= 0 && gy < WORLD_HEIGHT) {
      handleCellClick(gx, gy);
    }
  };

  // --- RENDER 1: SETUP SCREEN (Empire Creation) ---
  if (worldState === 'SETUP') {
    return (
      <div className="min-h-screen w-full bg-slate-950 text-white flex flex-col items-center justify-center p-4 sm:p-6 select-none overflow-y-auto">
        <div className="max-w-xl w-full bg-stone-900/90 border border-amber-500/30 rounded-3xl p-6 sm:p-8 shadow-2xl space-y-6">
          <div className="flex items-center justify-between border-b border-stone-800 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-stone-950 shadow-md">
                <Globe size={28} />
              </div>
              <div>
                <h1 className="text-xl sm:text-2xl font-black text-white">Dev Dünya Haritası</h1>
                <p className="text-xs text-amber-400 font-semibold">İmparatorluğunu Kur & Savaşa Katıl</p>
              </div>
            </div>
            <button
              onClick={onReturnToModeSelect}
              className="p-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-400 hover:text-white transition"
              title="Geri Dön"
            >
              <Home size={18} />
            </button>
          </div>

          {/* Empire Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-black uppercase text-stone-300">Devlet / İmparatorluk İsmi</label>
            <input
              type="text"
              value={empireName}
              onChange={(e) => setEmpireName(e.target.value)}
              className="w-full px-4 py-3 bg-stone-800 border border-stone-700 rounded-xl text-white font-bold text-sm focus:outline-none focus:border-amber-400 transition"
              placeholder="Örn: Büyük Türk Devleti"
              maxLength={24}
            />
          </div>

          {/* Custom Flag / Image Upload */}
          <div className="space-y-2">
            <label className="text-xs font-black uppercase text-stone-300 flex items-center justify-between">
              <span>Devlet Bayrağı / Kendi Görselin</span>
              <span className="text-[10px] text-amber-400 font-bold">Toprakların bu görselle kaplanır!</span>
            </label>

            <div className="flex items-center gap-4 p-3 bg-stone-800/80 border border-stone-700 rounded-2xl">
              <div className="w-16 h-12 rounded-xl overflow-hidden border-2 border-amber-400 shadow-md bg-black shrink-0 flex items-center justify-center">
                {customFlagData ? (
                  <img src={customFlagData} alt="Bayrak" className="w-full h-full object-cover" />
                ) : (
                  <Globe size={24} className="text-stone-500" />
                )}
              </div>

              <div className="flex-1">
                <label className="inline-flex items-center gap-2 px-3.5 py-2 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-stone-950 font-black text-xs rounded-xl cursor-pointer shadow-md transition active:scale-95">
                  <Upload size={14} />
                  <span>Kendi Görselini Yükle</span>
                  <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
                </label>
                <p className="text-[10px] text-stone-400 mt-1">Galeriden veya bilgisayarından dilediğin resmi seç.</p>
              </div>
            </div>

            {/* Preset quick picks */}
            <div className="space-y-1 pt-1">
              <div className="text-[11px] font-bold text-stone-400">veya hazır ülke bayraklarından seç:</div>
              <div className="grid grid-cols-5 gap-1.5">
                {PRESET_FLAGS.map((flag) => (
                  <button
                    key={flag.id}
                    type="button"
                    onClick={() => {
                      setCustomFlagData(flag.url);
                      setEmpireColor(flag.color);
                      soundManager.playClick();
                    }}
                    className={`p-1.5 rounded-xl border flex flex-col items-center gap-1 transition ${
                      customFlagData === flag.url
                        ? 'bg-amber-500/20 border-amber-400 shadow-md'
                        : 'bg-stone-800/60 border-stone-700 hover:border-stone-500'
                    }`}
                  >
                    <span className="text-lg">{flag.emoji}</span>
                    <span className="text-[10px] font-bold truncate max-w-full">{flag.name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Starting Continent */}
          <div className="space-y-1.5">
            <label className="text-xs font-black uppercase text-stone-300">Başlangıç Kıtası</label>
            <div className="grid grid-cols-3 gap-2">
              {['Avrupa', 'Asya', 'Afrika', 'Kuzey Amerika', 'Güney Amerika', 'Okyanusya'].map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setStartContinent(c)}
                  className={`py-2 px-2.5 rounded-xl text-xs font-black border transition ${
                    startContinent === c
                      ? 'bg-amber-500 text-stone-950 border-amber-400 shadow-md'
                      : 'bg-stone-800 text-stone-300 border-stone-700 hover:border-stone-500'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          {/* Start Action Button */}
          <button
            type="button"
            onClick={() => initGame(true)}
            className="w-full py-4 bg-gradient-to-r from-amber-500 via-orange-500 to-red-600 hover:from-amber-400 hover:to-orange-400 text-stone-950 font-black text-base rounded-2xl shadow-xl transition active:scale-95 flex items-center justify-center gap-2"
          >
            <Swords size={20} />
            <span>Dünya Sahnesine Çık & Fethe Başla</span>
          </button>
        </div>
      </div>
    );
  }

  // --- RENDER 2: IN-GAME ACTIVE WORLD BATTLE ---
  return (
    <div className="h-screen w-screen bg-slate-950 text-white flex flex-col overflow-hidden select-none">
      {/* 1. Header Bar: Stats, Empire & Guardian AI */}
      <header className="bg-stone-900/95 border-b border-stone-800 px-3 py-2 z-20 flex items-center justify-between shadow-md shrink-0">
        
        {/* Left: Empire Flag, Name & Tier */}
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-8 rounded-lg overflow-hidden border border-amber-400 shadow-sm shrink-0 bg-black flex items-center justify-center">
            {customFlagData ? (
              <img src={customFlagData} alt="Bayrak" className="w-full h-full object-cover" />
            ) : (
              <Globe size={18} className="text-amber-400" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-black text-sm text-white truncate max-w-[140px] sm:max-w-[200px]">
                {empireName}
              </span>
              <span className="text-[10px] px-1.5 py-0.2 rounded-md bg-amber-500/20 text-amber-300 font-extrabold border border-amber-500/30">
                {playerStats.tierName}
              </span>
            </div>
            <div className="text-[10px] text-stone-400 flex items-center gap-2">
              <span>🗺️ {playerTerritoryCount} Toprak</span>
              <span>⚡ +{playerStats.regenPerSec} Asker/sn</span>
            </div>
          </div>
        </div>

        {/* Center: Troop Reserves Bar */}
        <div className="flex flex-col items-center max-w-[180px] sm:max-w-xs w-full px-2">
          <div className="flex items-center justify-between w-full text-[11px] font-black">
            <span className="text-amber-400 flex items-center gap-1">
              <Zap size={12} />
              {myTroops.toLocaleString()} Asker
            </span>
            <span className="text-stone-400">/ {playerStats.maxTroops.toLocaleString()}</span>
          </div>
          <div className="w-full h-2 bg-stone-800 rounded-full overflow-hidden mt-1 border border-stone-700">
            <div
              className="h-full bg-gradient-to-r from-amber-500 to-emerald-500 transition-all duration-300"
              style={{ width: `${Math.min(100, (myTroops / playerStats.maxTroops) * 100)}%` }}
            />
          </div>
        </div>

        {/* Right: Guardian Bot Toggle & Home */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          <button
            onClick={() => {
              setGuardianActive(!guardianActive);
              soundManager.playClick();
              showToast(
                !guardianActive
                  ? '🛡️ Vekil Muhafız Aktif: Çıksan bile toprakların kurnazca savunulacak!'
                  : '⚠️ Vekil Muhafız Devre Dışı: Toprakların pasif savunmaya geçti.'
              );
            }}
            className={`px-2.5 py-1.5 rounded-xl border text-xs font-black flex items-center gap-1.5 transition ${
              guardianActive
                ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300 shadow-sm'
                : 'bg-stone-800 border-stone-700 text-stone-400 hover:text-white'
            }`}
            title="Vekil Savunma Botu"
          >
            <Shield size={14} className={guardianActive ? 'text-emerald-400' : ''} />
            <span className="hidden sm:inline">Vekil Muhafız:</span>
            <span>{guardianActive ? 'Açık' : 'Kapalı'}</span>
          </button>

          <button
            onClick={() => {
              if (window.confirm('Mod seçimine dönmek istiyor musun? İmparatorluğun kaydedilecek ve vekil botun savunmaya devam edecek.')) {
                onReturnToModeSelect();
              }
            }}
            className="p-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-300 hover:text-white transition"
            title="Ana Menü / Mod Seçimi"
          >
            <Home size={18} />
          </button>
        </div>
      </header>

      {/* 2. Interactive Canvas World Board */}
      <main
        className="flex-1 relative overflow-hidden cursor-crosshair bg-slate-950"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onClick={handleCanvasClick}
      >
        <canvas ref={canvasRef} className="w-full h-full block" />

        {/* Floating Zoom & Reset Controls */}
        <div className="absolute top-3 right-3 flex flex-col gap-1.5 z-10 bg-stone-900/90 border border-stone-700 rounded-2xl p-1.5 shadow-xl backdrop-blur-md">
          <button
            onClick={() => setZoom((z) => Math.min(2.5, z + 0.25))}
            className="p-2 hover:bg-stone-800 rounded-xl text-stone-300 hover:text-white transition"
            title="Yakınlaştır"
          >
            <ZoomIn size={18} />
          </button>
          <button
            onClick={() => setZoom((z) => Math.max(0.7, z - 0.25))}
            className="p-2 hover:bg-stone-800 rounded-xl text-stone-300 hover:text-white transition"
            title="Uzaklaştır"
          >
            <ZoomOut size={18} />
          </button>
          <button
            onClick={() => {
              setZoom(1.0);
              setPan({ x: 0, y: 0 });
            }}
            className="p-2 hover:bg-stone-800 rounded-xl text-stone-300 hover:text-white transition"
            title="Merkeze Sıfırla"
          >
            <Crosshair size={18} />
          </button>
        </div>

        {/* Live War Feed (Ticker) */}
        <div className="absolute bottom-3 left-3 max-w-xs sm:max-w-sm pointer-events-none z-10 space-y-1">
          {logMessages.map((msg, i) => (
            <div
              key={i}
              className="text-[11px] font-bold px-2.5 py-1 rounded-xl bg-stone-900/90 text-stone-200 border border-stone-800 shadow-md backdrop-blur-md animate-in fade-in"
            >
              {msg}
            </div>
          ))}
        </div>

        {/* Notification Toast */}
        {toastMessage && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 px-4 py-2.5 bg-gradient-to-r from-amber-500 to-orange-600 text-stone-950 font-black text-xs sm:text-sm rounded-2xl shadow-2xl border border-amber-300 flex items-center gap-2 animate-in slide-in-from-top-3">
            <CheckCircle2 size={16} />
            <span>{toastMessage}</span>
          </div>
        )}
      </main>

      {/* 3. Bottom Command & Troop Deployment Bar */}
      <footer className="bg-stone-900/95 border-t border-stone-800 p-3 z-20 shrink-0 flex flex-wrap items-center justify-between gap-3 shadow-2xl">
        
        {/* Action Modes Selector */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setActionMode('EXPAND');
              soundManager.playClick();
            }}
            className={`px-3 py-2 rounded-xl text-xs font-black flex items-center gap-1.5 transition ${
              actionMode === 'EXPAND'
                ? 'bg-amber-500 text-stone-950 shadow-md'
                : 'bg-stone-800 text-stone-300 hover:bg-stone-700'
            }`}
          >
            <Swords size={15} />
            <span>Saldır / Genişle</span>
          </button>

          <button
            onClick={() => {
              setActionMode('NAVAL');
              soundManager.playClick();
              showToast('🚢 Donanma Modu: Kıyıdan okyanusa veya başka kıtaya tıkla!');
            }}
            className={`px-3 py-2 rounded-xl text-xs font-black flex items-center gap-1.5 transition ${
              actionMode === 'NAVAL'
                ? 'bg-blue-500 text-white shadow-md'
                : 'bg-stone-800 text-stone-300 hover:bg-stone-700'
            }`}
          >
            <Ship size={15} />
            <span>Donanma Seferi</span>
          </button>

          {playerStats.canBuildHeavyFort && (
            <button
              onClick={() => {
                setActionMode('FORTIFY');
                soundManager.playClick();
                showToast('🏰 Kale Modu: Sınır toprağına tıklayarak kale inşa et (150 Asker).');
              }}
              className={`px-3 py-2 rounded-xl text-xs font-black flex items-center gap-1.5 transition ${
                actionMode === 'FORTIFY'
                  ? 'bg-stone-200 text-stone-950 shadow-md'
                  : 'bg-stone-800 text-stone-300 hover:bg-stone-700'
              }`}
            >
              <Castle size={15} />
              <span>Sınır Kalesi</span>
            </button>
          )}
        </div>

        {/* Troop Percentage Dispatcher */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold text-stone-400 hidden sm:inline">Ordu Sevk:</span>
          {[20, 50, 100].map((pct) => (
            <button
              key={pct}
              onClick={() => {
                setSendRatio(pct);
                soundManager.playClick();
              }}
              className={`px-3 py-1.5 rounded-xl text-xs font-black border transition ${
                sendRatio === pct
                  ? 'bg-amber-400 text-stone-950 border-amber-300 shadow-md'
                  : 'bg-stone-800 text-stone-300 border-stone-700 hover:border-stone-500'
              }`}
            >
              %{pct} ({Math.max(15, Math.floor((myTroops * pct) / 100))} Asker)
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}
