import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  MAP_W,
  MAP_H,
  getWorldRasterData,
  TERRAIN_PLAINS,
  TERRAIN_FOREST,
  TERRAIN_DESERT,
  TERRAIN_MOUNTAIN,
  TERRAIN_TUNDRA,
} from '../../world/worldRasterizer';
import {
  PRESET_PLAYER_FLAGS,
  getPresetFlag,
  loadDataUrlToFlagBuffer,
} from '../../world/flagLibrary';
import {
  WorldSimulationEngine,
  computePlayerTurnIncome,
  formatTroops,
  TERRAIN_TROOP_COST,
  SAVE_KEY,
} from '../../world/worldEngine';
import { WorldMapRenderer } from '../../world/worldRenderer';
import { soundManager } from '../../utils/audio';
import confetti from 'canvas-confetti';
import {
  Globe,
  Upload,
  Shield,
  Swords,
  Anchor,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  Compass,
  ArrowLeft,
  Users,
  User,
  Check,
  AlertCircle,
  Sparkles,
  Volume2,
  VolumeX,
  HelpCircle,
  X,
  CheckCircle2,
} from 'lucide-react';

export default function WorldGame({ onReturnToModeSelect, startInSetup = false }) {
  // Raster world data (real Natural Earth geometry)
  const worldData = useMemo(() => getWorldRasterData(), []);

  // Check if save exists
  const initialHasSave = useMemo(() => {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      return parsed && parsed.v === 4 && parsed.w === MAP_W && parsed.h === MAP_H;
    } catch {
      return false;
    }
  }, []);

  // UI Phase: 'SETUP' | 'SPAWN_PICK' | 'PLAYING'
  const [phase, setPhase] = useState(startInSetup || !initialHasSave ? 'SETUP' : 'PLAYING');

  // Setup Form State
  const [gameModeType, setGameModeType] = useState('SOLO'); // 'SOLO' | 'PASS_PLAY'
  const [playerCount, setPlayerCount] = useState(2); // For PASS_PLAY

  // Player 1 Setup
  const defaultFlag = useMemo(() => getPresetFlag('tr'), []);
  const [p1Name, setP1Name] = useState('Büyük Türk Devleti');
  const [p1Color, setP1Color] = useState('#E30A17');
  const [p1FlagPreset, setP1FlagPreset] = useState('tr');
  const [p1FlagDataUrl, setP1FlagDataUrl] = useState(defaultFlag.dataUrl);
  const p1FlagRgbaRef = useRef(defaultFlag.rgba);

  // Capital choice
  const [capitalChoice, setCapitalChoice] = useState('istanbul'); // city ID or 'CUSTOM'

  // Multiplayer Player 2-4 setups
  const [extraPlayers, setExtraPlayers] = useState([
    { name: 'Roma İmparatorluğu', color: '#3B82F6', flagPreset: 'it', capital: 'rome' },
    { name: 'Britanya Krallığı', color: '#10B981', flagPreset: 'gb', capital: 'london' },
    { name: 'Japon Hanedanı', color: '#F59E0B', flagPreset: 'jp', capital: 'tokyo' },
  ]);

  // In-Game Interaction State
  const [placingMode, setPlacingMode] = useState('EXPAND'); // 'EXPAND' | 'WALL' | 'NAVAL'
  const [navalStartCell, setNavalStartCell] = useState(null);
  const [navalTroops, setNavalTroops] = useState(25);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [showRules, setShowRules] = useState(false);
  const [celebrationModal, setCelebrationModal] = useState(null); // { city, bonus }
  const [toastMessage, setToastMessage] = useState(null);

  // Synchronized Engine & Renderer Refs
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const rendererRef = useRef(null);
  const fileInputRef = useRef(null);

  // Camera Ref: panX, panY, zoom
  const cameraRef = useRef({ zoom: 1.0, panX: 0, panY: 0 });

  // HUD State (synced from engine on events / turns)
  const [hud, setHud] = useState({
    roundNumber: 1,
    activePlayer: null,
    turnMovesCount: 0,
    players: [],
    conqueredCitiesCount: 0,
    hoveredCellInfo: null,
  });

  // Track dragging & painting
  const isMouseDownRef = useRef(false);
  const isPaintingRef = useRef(false);
  const lastCellRef = useRef(null);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const pointersRef = useRef(new Map());
  const pinchStartDistRef = useRef(0);
  const pinchStartZoomRef = useRef(1);
  const hoveredPosRef = useRef(null);

  // Helper to show transient toast
  const showToast = useCallback((msg) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3200);
  }, []);

  // Initialize Engine & Renderer singleton
  if (!rendererRef.current) {
    rendererRef.current = new WorldMapRenderer(worldData);
  }
  if (!engineRef.current) {
    engineRef.current = new WorldSimulationEngine(worldData, {
      onEvent: (msg) => showToast(msg),
      onSound: (sound) => {
        if (!soundEnabled) return;
        if (sound === 'pencil') soundManager.playPencil();
        else if (sound === 'celebration') {
          soundManager.playCelebration();
          try {
            confetti({ particleCount: 70, spread: 80, origin: { y: 0.6 } });
          } catch {}
        } else if (sound === 'turn') soundManager.playClick();
        else if (sound === 'tick') soundManager.playHit();
      },
    });

    if (initialHasSave) {
      engineRef.current.loadFromLocalStorage();
    }
  }

  // Update HUD from engine
  const refreshHud = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    const active = eng.getActivePlayer();
    setHud({
      roundNumber: eng.roundNumber,
      activePlayer: active ? { ...active } : null,
      turnMovesCount: eng.turnMoves.length,
      players: eng.players.map((p) => ({ ...p })),
      conqueredCitiesCount: active?.conqueredCities?.length || 0,
      hoveredCellInfo: null,
    });
  }, []);

  // On mount or save load, refresh HUD & center camera
  useEffect(() => {
    if (initialHasSave && engineRef.current) {
      refreshHud();
      const p = engineRef.current.getActivePlayer();
      if (p) {
        centerOnCoords(p.capitalX, p.capitalY, 3.5);
      }
    }
  }, [initialHasSave, refreshHud]);

  // Center camera on specific map cell without coordinate drift
  const centerOnCoords = useCallback((cx, cy, targetZoom = 3.5) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const viewW = canvas.clientWidth || window.innerWidth;
    const viewH = canvas.clientHeight || window.innerHeight;
    const baseScale = Math.min(viewW / MAP_W, viewH / MAP_H);
    const scale = baseScale * targetZoom;

    cameraRef.current = {
      zoom: targetZoom,
      panX: (MAP_W / 2 - cx) * scale,
      panY: (MAP_H / 2 - cy) * scale,
    };
  }, []);

  // Zoom relative to current viewport center without drift
  const handleZoom = useCallback((factor) => {
    const oldZoom = cameraRef.current.zoom;
    const newZoom = Math.max(0.6, Math.min(32.0, oldZoom * factor));
    const ratio = newZoom / oldZoom;
    cameraRef.current.zoom = newZoom;
    cameraRef.current.panX *= ratio;
    cameraRef.current.panY *= ratio;
  }, []);

  // Handle Custom Flag Upload
  const handleFlagUpload = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const dataUrl = ev.target.result;
        const result = await loadDataUrlToFlagBuffer(dataUrl);
        setP1FlagDataUrl(result.dataUrl);
        p1FlagRgbaRef.current = result.rgba;
        setP1FlagPreset(null);
        showToast('✅ Özel bayrak/resim başarıyla yüklendi!');
      } catch (err) {
        showToast('⚠️ Resim yüklenirken hata oluştu.');
      }
    };
    reader.readAsDataURL(file);
  }, [showToast]);

  // Start new game from setup
  const handleStartGame = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;

    // Resolve Capital Coordinates
    let p1Spawn = { x: Math.round(MAP_W * 0.58), y: Math.round(MAP_H * 0.36) }; // Default Istanbul approx
    if (capitalChoice !== 'CUSTOM') {
      const city = worldData.cities?.find((c) => c.id === capitalChoice);
      if (city) {
        p1Spawn = { x: city.x, y: city.y };
      }
    }

    const playerSpecs = [
      {
        name: p1Name || 'İmparatorluk',
        color: p1Color,
        flagCode: p1FlagPreset,
        flagRgba: p1FlagRgbaRef.current,
        flagDataUrl: p1FlagDataUrl,
        spawnX: p1Spawn.x,
        spawnY: p1Spawn.y,
      },
    ];

    if (gameModeType === 'PASS_PLAY') {
      for (let i = 0; i < playerCount - 1; i++) {
        const extra = extraPlayers[i];
        const flag = getPresetFlag(extra.flagPreset);
        const city = worldData.cities?.find((c) => c.id === extra.capital);
        playerSpecs.push({
          name: extra.name,
          color: extra.color,
          flagCode: extra.flagPreset,
          flagRgba: flag.rgba,
          flagDataUrl: flag.dataUrl,
          spawnX: city ? city.x : 200 + i * 150,
          spawnY: city ? city.y : 150 + i * 50,
        });
      }
    }

    eng.startNewGame({ playerSpecs });
    refreshHud();
    setPhase('PLAYING');

    const p = eng.getActivePlayer();
    if (p) {
      centerOnCoords(p.capitalX, p.capitalY, 3.8);
    }
  }, [gameModeType, playerCount, p1Name, p1Color, p1FlagPreset, p1FlagDataUrl, capitalChoice, extraPlayers, worldData, refreshHud, centerOnCoords]);

  // End active player's turn
  const handleEndTurn = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;

    const res = eng.endTurn();
    refreshHud();

    // Center camera on newly active player's capital/territory
    if (res.activePlayer) {
      centerOnCoords(res.activePlayer.capitalX, res.activePlayer.capitalY, cameraRef.current.zoom);
    }
  }, [refreshHud, centerOnCoords]);

  // Undo move
  const handleUndo = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    const res = eng.undoLastMove();
    if (!res.ok) {
      showToast(res.reason || 'Geri alınamadı.');
    } else {
      refreshHud();
    }
  }, [refreshHud, showToast]);

  // Bresenham line painting for smooth zero-latency dragging
  const paintLine = useCallback((x0, y0, x1, y1) => {
    const eng = engineRef.current;
    if (!eng) return;
    const active = eng.getActivePlayer();
    if (!active || active.troops <= 0) return;

    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    let cx = x0;
    let cy = y0;

    while (true) {
      if (placingMode === 'EXPAND') {
        const res = eng.conquerCell(active.id, cx, cy);
        if (res.ok && res.newlyCapturedCity) {
          setCelebrationModal(res.newlyCapturedCity);
        }
      } else if (placingMode === 'WALL') {
        eng.buildWall(active.id, cx, cy);
      }

      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx) { err += dx; cy += sy; }
    }

    refreshHud();
  }, [placingMode, refreshHud]);

  // Mouse & Touch Interaction Handlers
  const getMapCoords = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const vx = clientX - rect.left;
    const vy = clientY - rect.top;

    const viewW = canvas.clientWidth || rect.width;
    const viewH = canvas.clientHeight || rect.height;
    const baseScale = Math.min(viewW / MAP_W, viewH / MAP_H);
    const scale = baseScale * cameraRef.current.zoom;
    const mapScreenW = MAP_W * scale;
    const mapScreenH = MAP_H * scale;
    const originX = (viewW - mapScreenW) / 2 + cameraRef.current.panX;
    const originY = (viewH - mapScreenH) / 2 + cameraRef.current.panY;

    const mapX = (vx - originX) / scale;
    const mapY = (vy - originY) / scale;

    return {
      x: Math.floor(mapX),
      y: Math.floor(mapY),
      rawX: mapX,
      rawY: mapY,
    };
  }, []);

  const handlePointerDown = useCallback((e) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    isMouseDownRef.current = true;
    dragStartRef.current = { x: e.clientX, y: e.clientY };

    // Right-click or middle-click or PAN mode always triggers smooth camera pan
    if (e.button === 2 || e.button === 1 || placingMode === 'PAN') {
      isPaintingRef.current = false;
      return;
    }

    if (pointersRef.current.size === 1) {
      const pos = getMapCoords(e.clientX, e.clientY);
      if (pos && pos.x >= 0 && pos.x < MAP_W && pos.y >= 0 && pos.y < MAP_H) {
        lastCellRef.current = { x: pos.x, y: pos.y };

        if (phase === 'SPAWN_PICK') {
          // Select capital here
          if (worldData.isLand[pos.y * MAP_W + pos.x]) {
            setCapitalChoice('CUSTOM');
            setP1Name((prev) => (prev ? prev : 'Özgür Devlet'));
            setPhase('SETUP');
            showToast(`★ Başkent seçildi: Koordinat (${pos.x}, ${pos.y})`);
          } else {
            showToast('⚠️ Deniz veya okyanusa başkent kurulamaz!');
          }
          return;
        }

        if (placingMode === 'NAVAL') {
          const eng = engineRef.current;
          const active = eng?.getActivePlayer();
          if (!active) return;

          if (!navalStartCell) {
            // Pick start port
            const idx = pos.y * MAP_W + pos.x;
            if (eng.owners[idx] === active.id) {
              setNavalStartCell({ x: pos.x, y: pos.y });
              showToast('⚓ Liman seçildi! Şimdi çıkarma yapılacak karşı kıyıya tıkla.');
            } else {
              showToast('⚠️ Önce kendi kıyındaki bir liman toprağını seç.');
            }
          } else {
            // Pick destination
            const res = eng.launchNavalFleet(active.id, navalStartCell.x, navalStartCell.y, pos.x, pos.y, navalTroops);
            if (res.ok) {
              setNavalStartCell(null);
              setPlacingMode('EXPAND');
              refreshHud();
            } else {
              showToast(res.reason || 'Deniz seferi başlatılamadı.');
            }
          }
          return;
        }

        // For EXPAND or WALL: check if cell is near player territory
        const eng = engineRef.current;
        const active = eng?.getActivePlayer();
        const idx = pos.y * MAP_W + pos.x;
        const isNearOwned =
          eng && active &&
          (eng.owners[idx] === active.id ||
            (pos.x > 0 && eng.owners[idx - 1] === active.id) ||
            (pos.x < MAP_W - 1 && eng.owners[idx + 1] === active.id) ||
            (pos.y > 0 && eng.owners[idx - MAP_W] === active.id) ||
            (pos.y < MAP_H - 1 && eng.owners[idx + MAP_W] === active.id));

        if (isNearOwned && (placingMode === 'EXPAND' || placingMode === 'WALL')) {
          isPaintingRef.current = true;
          paintLine(pos.x, pos.y, pos.x, pos.y);
        } else {
          // Dragging elsewhere on map pans the camera smoothly!
          isPaintingRef.current = false;
        }
      } else {
        isPaintingRef.current = false;
      }
    } else if (pointersRef.current.size === 2) {
      isPaintingRef.current = false;
      const pts = Array.from(pointersRef.current.values());
      pinchStartDistRef.current = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchStartZoomRef.current = cameraRef.current.zoom;
    }
  }, [getMapCoords, phase, placingMode, worldData, navalStartCell, navalTroops, paintLine, refreshHud, showToast]);

  const handlePointerMove = useCallback((e) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const pos = getMapCoords(e.clientX, e.clientY);
    hoveredPosRef.current = pos;

    if (pointersRef.current.size === 1) {
      if (isPaintingRef.current && pos && lastCellRef.current) {
        if (pos.x !== lastCellRef.current.x || pos.y !== lastCellRef.current.y) {
          paintLine(lastCellRef.current.x, lastCellRef.current.y, pos.x, pos.y);
          lastCellRef.current = { x: pos.x, y: pos.y };
        }
      } else if (isMouseDownRef.current && !isPaintingRef.current) {
        // Pan camera
        const dx = e.clientX - dragStartRef.current.x;
        const dy = e.clientY - dragStartRef.current.y;
        cameraRef.current.panX += dx;
        cameraRef.current.panY += dy;
        dragStartRef.current = { x: e.clientX, y: e.clientY };
      }
    } else if (pointersRef.current.size === 2) {
      // Pinch to zoom
      const pts = Array.from(pointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (pinchStartDistRef.current > 0) {
        const ratio = dist / pinchStartDistRef.current;
        const newZoom = Math.max(0.6, Math.min(28.0, pinchStartZoomRef.current * ratio));
        cameraRef.current.zoom = newZoom;
      }
    }
  }, [getMapCoords, paintLine]);

  const handlePointerUp = useCallback((e) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size === 0) {
      isMouseDownRef.current = false;
      isPaintingRef.current = false;
      lastCellRef.current = null;
    }
  }, []);

  // Canvas Non-Passive Wheel & Contextmenu setup
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.2 : 0.83;
      handleZoom(zoomFactor);
    };

    const preventContext = (e) => e.preventDefault();

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', preventContext);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', preventContext);
    };
  }, [handleZoom]);

  // Canvas 60 FPS Render Loop
  useEffect(() => {
    let animId;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: false });

    const render = () => {
      const viewW = canvas.clientWidth || window.innerWidth;
      const viewH = canvas.clientHeight || window.innerHeight;

      // Handle high-DPI
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== viewW * dpr || canvas.height !== viewH * dpr) {
        canvas.width = viewW * dpr;
        canvas.height = viewH * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      if (rendererRef.current && engineRef.current) {
        rendererRef.current.renderFrame(ctx, viewW, viewH, cameraRef.current, engineRef.current, {
          phase,
          hoveredMapPos: hoveredPosRef.current,
          placingMode,
          timeSec: performance.now() / 1000,
        });
      }

      ctx.restore();
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [phase, placingMode]);

  return (
    <div className="relative w-full h-screen overflow-hidden bg-slate-950 text-white select-none">
      {/* Hidden File Input for Custom Flag/Image */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFlagUpload}
        className="hidden"
      />

      {/* SETUP PHASE SCREEN */}
      {phase === 'SETUP' && (
        <div className="absolute inset-0 z-30 bg-gradient-to-br from-slate-950 via-stone-900 to-zinc-950 flex flex-col items-center justify-between p-4 sm:p-6 overflow-y-auto">
          {/* Top Bar */}
          <div className="w-full max-w-4xl flex items-center justify-between">
            <button
              onClick={onReturnToModeSelect}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-stone-800/80 hover:bg-stone-700 text-stone-300 font-bold text-xs sm:text-sm border border-stone-700 transition"
            >
              <ArrowLeft size={16} />
              <span>Harita Seçimine Dön</span>
            </button>
            <div className="flex items-center gap-1.5 text-xs text-amber-400 font-bold bg-amber-500/10 px-3 py-1.5 rounded-xl border border-amber-500/30">
              <Sparkles size={14} />
              <span>Dev Dünya Haritası Seferi</span>
            </div>
          </div>

          {/* Setup Card */}
          <div className="w-full max-w-2xl bg-stone-900/95 border-2 border-amber-500/30 rounded-3xl p-5 sm:p-7 shadow-2xl my-auto">
            <div className="text-center mb-6">
              <h2 className="text-2xl sm:text-3xl font-black text-white">
                DÜNYA FETHİ <span className="text-amber-400">KURULUMU</span>
              </h2>
              <p className="text-xs sm:text-sm text-stone-400 mt-1">
                Kendi bayrağını veya istediğin resmi yükle, başkentini seç ve dünya sahnesine çık!
              </p>
            </div>

            {/* Game Mode Choice: Solo vs Pass & Play */}
            <div className="grid grid-cols-2 gap-3 mb-6">
              <button
                type="button"
                onClick={() => setGameModeType('SOLO')}
                className={`p-3.5 rounded-2xl border-2 flex items-center gap-3 transition ${
                  gameModeType === 'SOLO'
                    ? 'border-amber-400 bg-amber-500/15 text-white shadow-lg'
                    : 'border-stone-700 bg-stone-800/60 text-stone-400 hover:border-stone-600'
                }`}
              >
                <div className="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center font-black">
                  <User size={20} />
                </div>
                <div className="text-left">
                  <div className="text-sm font-black">Tek Kişilik Sefer</div>
                  <div className="text-[11px] text-stone-400">Tüm dünyayı adım adım fethet</div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setGameModeType('PASS_PLAY')}
                className={`p-3.5 rounded-2xl border-2 flex items-center gap-3 transition ${
                  gameModeType === 'PASS_PLAY'
                    ? 'border-amber-400 bg-amber-500/15 text-white shadow-lg'
                    : 'border-stone-700 bg-stone-800/60 text-stone-400 hover:border-stone-600'
                }`}
              >
                <div className="w-10 h-10 rounded-xl bg-blue-500/20 text-blue-400 flex items-center justify-center font-black">
                  <Users size={20} />
                </div>
                <div className="text-left">
                  <div className="text-sm font-black">Yerel Çok Oyunculu</div>
                  <div className="text-[11px] text-stone-400">Arkadaşlarınla tek ekrandan kapış</div>
                </div>
              </button>
            </div>

            {/* Player 1 Settings */}
            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-xs font-bold text-stone-300 mb-1.5 uppercase">
                  İmparatorluk / Devlet Adı
                </label>
                <input
                  type="text"
                  value={p1Name}
                  onChange={(e) => setP1Name(e.target.value)}
                  placeholder="Devlet Adı Girin"
                  className="w-full px-4 py-2.5 rounded-xl bg-stone-800 border border-stone-700 text-white font-bold text-sm focus:outline-none focus:border-amber-400"
                />
              </div>

              {/* Flag / Custom Image Selection */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-stone-300 uppercase">
                    Bayrak / Özel Toprak Resmi
                  </label>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-stone-950 font-black text-xs transition shadow-md"
                  >
                    <Upload size={13} />
                    <span>Fotoğraf Yükle</span>
                  </button>
                </div>

                <div className="flex items-center gap-3 p-3 rounded-2xl bg-stone-800/70 border border-stone-700">
                  <div className="w-16 h-10 rounded-lg overflow-hidden border border-amber-400/50 shadow shrink-0 bg-stone-900">
                    <img src={p1FlagDataUrl} alt="Bayrak" className="w-full h-full object-cover" />
                  </div>
                  <div className="flex-1 overflow-x-auto flex gap-2 py-1 scrollbar-none">
                    {PRESET_PLAYER_FLAGS.map((f) => (
                      <button
                        key={f.code}
                        type="button"
                        onClick={() => {
                          const flag = getPresetFlag(f.code);
                          setP1FlagPreset(f.code);
                          setP1FlagDataUrl(flag.dataUrl);
                          p1FlagRgbaRef.current = flag.rgba;
                          setP1Color(f.color);
                        }}
                        className={`px-2.5 py-1 rounded-lg text-xs font-bold shrink-0 border transition ${
                          p1FlagPreset === f.code
                            ? 'border-amber-400 bg-amber-500/20 text-white'
                            : 'border-stone-700 bg-stone-800 text-stone-400 hover:border-stone-600'
                        }`}
                      >
                        {f.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Capital City Selection */}
              <div>
                <label className="block text-xs font-bold text-stone-300 mb-1.5 uppercase">
                  Başlangıç Başkenti
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { id: 'istanbul', name: 'İstanbul 🇹🇷', desc: 'Boğazlar & Köprü' },
                    { id: 'ankara', name: 'Ankara 🇹🇷', desc: 'Anadolu Kalesi' },
                    { id: 'rome', name: 'Roma 🇮🇹', desc: 'Akdeniz İmparatorluğu' },
                    { id: 'paris', name: 'Paris 🇫🇷', desc: 'Avrupa Kalbi' },
                    { id: 'london', name: 'Londra 🇬🇧', desc: 'Ada & Donanma' },
                    { id: 'tokyo', name: 'Tokyo 🇯🇵', desc: 'Doğu Metropolü' },
                    { id: 'cairo', name: 'Kahire 🇪🇬', desc: 'Nil & Piramitler' },
                    { id: 'new_york', name: 'New York 🇺🇸', desc: 'Atlantik Kıyısı' },
                  ].map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setCapitalChoice(c.id)}
                      className={`p-2.5 rounded-xl border text-left transition ${
                        capitalChoice === c.id
                          ? 'border-amber-400 bg-amber-500/20 text-white font-bold'
                          : 'border-stone-700 bg-stone-800/60 text-stone-400 hover:border-stone-600'
                      }`}
                    >
                      <div className="text-xs font-black">{c.name}</div>
                      <div className="text-[10px] text-stone-500">{c.desc}</div>
                    </button>
                  ))}
                </div>

                <div className="mt-2 text-center">
                  <button
                    type="button"
                    onClick={() => setPhase('SPAWN_PICK')}
                    className="text-xs text-amber-400 hover:underline font-bold inline-flex items-center gap-1"
                  >
                    <span>🗺️ Veya dev dünya haritasında istediğin noktaya tıkla!</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Launch Game Button */}
            <div className="flex gap-3">
              {initialHasSave && (
                <button
                  type="button"
                  onClick={() => {
                    engineRef.current?.loadFromLocalStorage();
                    refreshHud();
                    setPhase('PLAYING');
                  }}
                  className="flex-1 py-3.5 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm tracking-wide transition shadow-lg flex items-center justify-center gap-2"
                >
                  <RotateCcw size={16} />
                  <span>Kaldığın Yerden Devam Et</span>
                </button>
              )}
              <button
                type="button"
                onClick={handleStartGame}
                className="flex-1 py-3.5 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-stone-950 font-black text-sm tracking-wide transition shadow-xl flex items-center justify-center gap-2"
              >
                <Globe size={18} />
                <span>Dünya Seferine Başla ➔</span>
              </button>
            </div>
          </div>

          <div className="text-xs text-stone-500 text-center pb-2">
            Şehir & Toprak Fethi v2.0 • Gerçek Dünya Atlası
          </div>
        </div>
      )}

      {/* SPAWN PICK PHASE BANNER */}
      {phase === 'SPAWN_PICK' && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 bg-stone-900/90 border border-amber-400/50 px-4 py-2.5 rounded-2xl shadow-2xl flex items-center gap-3">
          <Globe className="text-amber-400 animate-spin" size={20} />
          <div>
            <div className="text-xs font-black text-white">Haritadan Başkentini Seç</div>
            <div className="text-[11px] text-stone-400">Dünya üzerinde istediğin bir kara noktasına tıkla.</div>
          </div>
          <button
            onClick={() => setPhase('SETUP')}
            className="px-2.5 py-1 rounded-lg bg-stone-800 text-xs font-bold text-stone-300 hover:bg-stone-700"
          >
            İptal
          </button>
        </div>
      )}

      {/* FULLSCREEN VIEWPORT CANVAS */}
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="w-full h-full cursor-crosshair touch-none"
      />

      {/* PLAYING PHASE HUD & INTERFACE */}
      {phase === 'PLAYING' && (
        <>
          {/* Top Bar: Empire Status & Turn Info */}
          <div className="absolute top-3 left-3 right-3 sm:left-6 sm:right-6 flex items-center justify-between pointer-events-none z-10">
            {/* Active Player Card */}
            <div className="pointer-events-auto bg-stone-900/90 border border-stone-700/80 backdrop-blur-md rounded-2xl p-2 sm:p-2.5 shadow-2xl flex items-center gap-2.5">
              <button
                onClick={onReturnToModeSelect}
                className="p-1.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-300 transition"
                title="Ana Menüye Dön"
              >
                <ArrowLeft size={16} />
              </button>

              {hud.activePlayer && (
                <>
                  <div className="w-10 h-7 rounded-md overflow-hidden border border-amber-400/40 shadow shrink-0 bg-stone-950">
                    {hud.activePlayer.flagDataUrl && (
                      <img
                        src={hud.activePlayer.flagDataUrl}
                        alt="Flag"
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>

                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs sm:text-sm font-black text-white">
                        {hud.activePlayer.name}
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/40 text-[10px] font-black text-amber-400">
                        Tur {hud.roundNumber}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-stone-300 font-bold mt-0.5">
                      <span className="text-amber-400">
                        ⚔️ {hud.activePlayer.troops} Asker
                      </span>
                      <span>
                        📍 {hud.activePlayer.landCount} Piksel
                      </span>
                      {hud.activePlayer.conqueredCities?.length > 0 && (
                        <span className="text-emerald-400">
                          🏛️ {hud.activePlayer.conqueredCities.length} Şehir
                        </span>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Top Right Utilities */}
            <div className="pointer-events-auto flex items-center gap-2">
              <button
                onClick={() => setPhase('SETUP')}
                className="px-2.5 py-1.5 rounded-xl bg-stone-900/80 border border-stone-700 text-amber-400 hover:bg-stone-800 text-xs font-bold transition shadow flex items-center gap-1.5"
                title="Yeni Sefer Başlat"
              >
                <RotateCcw size={14} />
                <span className="hidden sm:inline">Yeni Sefer</span>
              </button>

              <button
                onClick={() => setSoundEnabled((prev) => !prev)}
                className="w-9 h-9 rounded-xl bg-stone-900/80 border border-stone-700 text-stone-300 flex items-center justify-center hover:bg-stone-800 transition shadow"
                title={soundEnabled ? 'Sesi Kapat' : 'Sesi Aç'}
              >
                {soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
              </button>

              <button
                onClick={() => setShowRules(true)}
                className="w-9 h-9 rounded-xl bg-stone-900/80 border border-stone-700 text-stone-300 flex items-center justify-center hover:bg-stone-800 transition shadow"
                title="Nasıl Oynanır?"
              >
                <HelpCircle size={16} />
              </button>
            </div>
          </div>

          {/* Floating Camera Controls (Right Side) */}
          <div className="absolute right-3 sm:right-6 top-20 flex flex-col gap-2 z-10">
            <button
              onClick={() => handleZoom(1.35)}
              className="w-10 h-10 rounded-2xl bg-stone-900/90 border border-stone-700 text-stone-200 flex items-center justify-center hover:bg-stone-800 shadow-xl transition"
              title="Yakınlaştır"
            >
              <ZoomIn size={18} />
            </button>
            <button
              onClick={() => handleZoom(0.75)}
              className="w-10 h-10 rounded-2xl bg-stone-900/90 border border-stone-700 text-stone-200 flex items-center justify-center hover:bg-stone-800 shadow-xl transition"
              title="Uzaklaştır"
            >
              <ZoomOut size={18} />
            </button>
            <button
              onClick={() => {
                const p = hud.activePlayer;
                if (p) centerOnCoords(p.capitalX, p.capitalY, 3.8);
              }}
              className="w-10 h-10 rounded-2xl bg-stone-900/90 border border-stone-700 text-amber-400 flex items-center justify-center hover:bg-stone-800 shadow-xl transition"
              title="Başkente Odaklan"
            >
              <Compass size={18} />
            </button>
          </div>

          {/* Bottom Action Controls (Exact Original Format Adapted to Soldiers) */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 w-full max-w-xl px-4 pointer-events-none">
            <div className="pointer-events-auto bg-stone-900/95 border border-stone-700/80 backdrop-blur-lg rounded-3xl p-2.5 sm:p-3 shadow-2xl flex items-center justify-between gap-1.5 sm:gap-2">
              {/* Kaydır (Pan/Drag) */}
              <button
                onClick={() => {
                  setPlacingMode('PAN');
                  setNavalStartCell(null);
                }}
                className={`py-2 px-2.5 sm:px-3 rounded-2xl font-black text-xs sm:text-sm flex items-center justify-center gap-1 transition ${
                  placingMode === 'PAN'
                    ? 'bg-indigo-500 text-white shadow-lg'
                    : 'bg-stone-800/80 text-stone-300 hover:bg-stone-800'
                }`}
                title="Haritada serbestçe gezin"
              >
                <span>🖐️</span>
                <span className="hidden sm:inline">Kaydır</span>
              </button>

              {/* Fetih Modu (Expand/Paint) */}
              <button
                onClick={() => {
                  setPlacingMode('EXPAND');
                  setNavalStartCell(null);
                }}
                className={`flex-1 py-2 px-2.5 sm:px-3 rounded-2xl font-black text-xs sm:text-sm flex items-center justify-center gap-1.5 transition ${
                  placingMode === 'EXPAND'
                    ? 'bg-amber-500 text-stone-950 shadow-lg'
                    : 'bg-stone-800/80 text-stone-300 hover:bg-stone-800'
                }`}
              >
                <Swords size={16} />
                <span>Fethet</span>
              </button>

              {/* Sur / Duvar Ör (Wall) */}
              <button
                onClick={() => {
                  setPlacingMode('WALL');
                  setNavalStartCell(null);
                }}
                className={`flex-1 py-2 px-2.5 sm:px-3 rounded-2xl font-black text-xs sm:text-sm flex items-center justify-center gap-1.5 transition ${
                  placingMode === 'WALL'
                    ? 'bg-slate-300 text-stone-950 shadow-lg'
                    : 'bg-stone-800/80 text-stone-300 hover:bg-stone-800'
                }`}
                title="Sınır surları ör (3 Asker)"
              >
                <Shield size={16} />
                <span>Sur Kur</span>
              </button>

              {/* Donanma / Deniz Çıkarması (Naval Fleet) */}
              <button
                onClick={() => setPlacingMode('NAVAL')}
                className={`flex-1 py-2 px-2.5 sm:px-3 rounded-2xl font-black text-xs sm:text-sm flex items-center justify-center gap-1.5 transition ${
                  placingMode === 'NAVAL'
                    ? 'bg-sky-400 text-stone-950 shadow-lg'
                    : 'bg-stone-800/80 text-stone-300 hover:bg-stone-800'
                }`}
                title="Donanmayla karşı kıyılara çıkarma yap"
              >
                <Anchor size={16} />
                <span>Donanma</span>
              </button>

              {/* Geri Al (Undo) */}
              <button
                onClick={handleUndo}
                disabled={hud.turnMovesCount === 0}
                className={`p-2.5 rounded-2xl font-black text-xs flex items-center justify-center transition ${
                  hud.turnMovesCount > 0
                    ? 'bg-stone-800 text-stone-200 hover:bg-stone-700'
                    : 'bg-stone-800/40 text-stone-600 cursor-not-allowed'
                }`}
                title="Son hamleyi geri al"
              >
                <RotateCcw size={16} />
              </button>

              {/* Turu Bitir (End Turn) */}
              <button
                onClick={handleEndTurn}
                className="py-2.5 px-4 rounded-2xl bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-400 hover:to-green-500 text-white font-black text-xs sm:text-sm shadow-xl flex items-center gap-1.5 transition"
              >
                <Check size={16} />
                <span>Turu Bitir</span>
              </button>
            </div>
          </div>
        </>
      )}

      {/* TOAST MESSAGE */}
      {toastMessage && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-40 bg-stone-900/95 border border-amber-400/50 text-white px-4 py-2 rounded-2xl shadow-2xl text-xs sm:text-sm font-bold flex items-center gap-2 animate-bounce">
          <Sparkles size={16} className="text-amber-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* CITY CAPTURE CELEBRATION MODAL */}
      {celebrationModal && (
        <div className="absolute inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-gradient-to-b from-stone-900 to-zinc-950 border-2 border-amber-400 rounded-3xl p-6 shadow-2xl text-center animate-in zoom-in-95 duration-200">
            <div className="w-16 h-16 rounded-3xl bg-amber-500/20 text-amber-400 flex items-center justify-center text-3xl mx-auto mb-3 shadow-inner">
              {celebrationModal.icon || '🏛️'}
            </div>
            <h3 className="text-xl font-black text-white">
              ŞEHİR FETHEDİLDİ!
            </h3>
            <div className="text-2xl font-black text-amber-400 mt-1">
              {celebrationModal.name.toUpperCase()}
            </div>
            <p className="text-xs text-stone-400 mt-1">
              {celebrationModal.country} • {celebrationModal.tier}
            </p>

            <div className="my-4 p-3 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-xs font-bold text-amber-300 space-y-1">
              <div>🎁 +{celebrationModal.bonusTroops} Asker Anında Orduna Katıldı!</div>
              <div>⚡ Her Tur +{celebrationModal.incomeBonus} Asker Ekstra Üretim!</div>
            </div>

            <button
              onClick={() => setCelebrationModal(null)}
              className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 font-black text-sm transition shadow-lg"
            >
              Fethe Devam Et!
            </button>
          </div>
        </div>
      )}

      {/* RULES / HELP MODAL */}
      {showRules && (
        <div className="absolute inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-stone-900 border border-stone-700 rounded-3xl p-6 shadow-2xl text-white">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-black text-amber-400">Dev Dünya Haritası Nasıl Oynanır?</h3>
              <button
                onClick={() => setShowRules(false)}
                className="p-1 rounded-lg text-stone-400 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-3 text-xs text-stone-300 leading-relaxed max-h-[60vh] overflow-y-auto pr-1">
              <div className="p-2.5 rounded-xl bg-stone-800/80 border border-stone-700">
                <div className="font-black text-white text-sm mb-1">⚔️ Asker ve Fetih Sistemi</div>
                <div>
                  Çark şansı yoktur. Her tur topraklarından ve fethettiğin şehirlerden asker üretirsin. Komşu topraklara parmağınla veya farenle sürükleyerek fetih yapabilirsin.
                </div>
              </div>

              <div className="p-2.5 rounded-xl bg-stone-800/80 border border-stone-700">
                <div className="font-black text-white text-sm mb-1">🏔️ Arazi Zorlukları</div>
                <div className="space-y-0.5 mt-1">
                  <div>🌾 <strong>Ova:</strong> 1 Asker</div>
                  <div>🌲 <strong>Orman:</strong> 2 Asker</div>
                  <div>🏜️ <strong>Çöl:</strong> 3 Asker</div>
                  <div>⛰️ <strong>Dağ:</strong> 5 Asker</div>
                </div>
              </div>

              <div className="p-2.5 rounded-xl bg-stone-800/80 border border-stone-700">
                <div className="font-black text-white text-sm mb-1">🏛️ Dünya Metropolleri</div>
                <div>
                  İstanbul, Ankara, Roma, Paris, Londra gibi dünya şehirlerini ele geçirdiğinde büyük asker bonusları ve kalıcı tur geliri kazanırsın.
                </div>
              </div>

              <div className="p-2.5 rounded-xl bg-stone-800/80 border border-stone-700">
                <div className="font-black text-white text-sm mb-1">⚓ Donanma Çıkarmaları</div>
                <div>
                  Denizleri ve okyanusları aşmak için donanma seferi başlatabilir, karşı kıyılarda yeni koloniler kurabilirsin.
                </div>
              </div>
            </div>

            <button
              onClick={() => setShowRules(false)}
              className="w-full mt-5 py-2.5 rounded-xl bg-amber-500 text-stone-950 font-black text-xs hover:bg-amber-400 transition"
            >
              Anladım, Kapat
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
