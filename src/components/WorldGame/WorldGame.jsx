import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  MAP_W,
  MAP_H,
  lonLatToMapXY,
  getWorldRasterData,
} from '../../world/worldRasterizer';
import {
  PRESET_PLAYER_FLAGS,
  getPresetFlag,
  loadDataUrlToFlagBuffer,
} from '../../world/flagLibrary';
import {
  WorldSimulationEngine,
  computeNationEconomy,
  formatTroops,
  SAVE_KEY,
} from '../../world/worldEngine';
import { WorldMapRenderer } from '../../world/worldRenderer';
import { soundManager } from '../../utils/audio';
import {
  Globe,
  Upload,
  Shield,
  Swords,
  Castle,
  Handshake,
  Crown,
  Home,
  ZoomIn,
  ZoomOut,
  Crosshair,
  Maximize2,
  RotateCcw,
  Sparkles,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Shuffle,
  X,
  CheckCircle2,
  AlertTriangle,
  Trophy,
  Anchor,
} from 'lucide-react';

export default function WorldGame({ onReturnToModeSelect }) {
  // Singleton world raster data (cached, real Natural Earth geography)
  const worldData = useMemo(() => getWorldRasterData(), []);

  // Check if a v2 saved empire exists
  const initialHasSave = useMemo(() => {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      return parsed && parsed.v === 3 && parsed.w === MAP_W && parsed.h === MAP_H && Array.isArray(parsed.rle);
    } catch {
      return false;
    }
  }, []);

  // Phases: 'SETUP' | 'SPAWN' | 'PLAYING'
  const [phase, setPhase] = useState(initialHasSave ? 'PLAYING' : 'SETUP');

  // Setup state
  const defaultFlag = useMemo(() => getPresetFlag('tr'), []);
  const [empireName, setEmpireName] = useState('Büyük Türk Devleti');
  const [empireColor, setEmpireColor] = useState('#E30A17');
  const [selectedPresetCode, setSelectedPresetCode] = useState('tr');
  const [flagDataUrl, setFlagDataUrl] = useState(defaultFlag.dataUrl);
  const flagRgbaRef = useRef(defaultFlag.rgba);

  // Controls & HUD state (synced at ~6 Hz from 20 Hz engine so React never lags!)
  const [actionMode, setActionMode] = useState('AUTO'); // 'AUTO' | 'NAVAL' | 'FORTIFY' | 'DIPLOMACY'
  const [sendRatio, setSendRatio] = useState(40);
  const [guardianActive, setGuardianActive] = useState(true);
  const [showLeaderboard, setShowLeaderboard] = useState(true);
  const [selectedNationId, setSelectedNationId] = useState(0);
  const [hoveredInfo, setHoveredInfo] = useState(null);
  const [events, setEvents] = useState([]);
  const [toast, setToast] = useState(null);
  const [offlineReport, setOfflineReport] = useState(null);

  // HUD snapshot from engine
  const [hud, setHud] = useState({
    troops: 1400,
    maxTroops: 2800,
    incomePerSec: 120,
    landCount: 44,
    landPct: '0.2',
    tierName: 'Yeni Devlet',
    shipLabel: 'Çıkarma Botu',
    fortCount: 0,
    maxForts: 1,
    catchUpPct: 0,
    alive: true,
    leaderboard: [],
    winner: null,
  });

  // Engine, Renderer, Canvas & Camera Refs
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const rendererRef = useRef(null);
  const cameraRef = useRef({ zoom: 1.05, panX: 0, panY: 0 });
  const transformRef = useRef({ scale: 1, originX: 0, originY: 0 });

  // Pointer & Pinch Zoom tracking
  const pointersRef = useRef(new Map());
  const dragStateRef = useRef({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
    pinchStartDist: 0,
    pinchStartZoom: 1,
  });
  const hoveredMapPosRef = useRef(null);
  const hoveredNationIdRef = useRef(0);
  const phaseRef = useRef(phase);
  const actionModeRef = useRef(actionMode);
  const sendRatioRef = useRef(sendRatio);
  const selectedNationIdRef = useRef(selectedNationId);
  const toastTimerRef = useRef(null);

  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { actionModeRef.current = actionMode; }, [actionMode]);
  useEffect(() => { sendRatioRef.current = sendRatio; }, [sendRatio]);
  useEffect(() => { selectedNationIdRef.current = selectedNationId; }, [selectedNationId]);

  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3400);
  }, []);

  const pushEvent = useCallback((text) => {
    setEvents((prev) => [{ id: Date.now() + Math.random(), text }, ...prev.slice(0, 4)]);
  }, []);

  // Create Engine & Renderer once
  if (!rendererRef.current) {
    rendererRef.current = new WorldMapRenderer(worldData);
  }
  if (!engineRef.current) {
    engineRef.current = new WorldSimulationEngine(worldData, {
      onEvent: (msg) => pushEvent(msg),
      onSound: (kind) => {
        if (kind === 'win') soundManager.playWin();
        else if (kind === 'lose') soundManager.playLose();
        else if (kind === 'hit') soundManager.playHit();
        else if (kind === 'spin') soundManager.playSpin();
        else if (kind === 'pencil') soundManager.playPencil();
        else soundManager.playTick();
      },
    });
  }

  // Helper: smoothly center camera on a map coordinate
  const focusCameraOn = useCallback((mapX, mapY, targetZoom = 2.4) => {
    const canvas = canvasRef.current;
    const viewW = canvas ? canvas.clientWidth : window.innerWidth;
    const viewH = canvas ? canvas.clientHeight : window.innerHeight;
    const baseScale = Math.min(viewW / MAP_W, viewH / MAP_H);
    const z = Math.max(0.9, Math.min(5.5, targetZoom));
    const scale = baseScale * z;
    const panX = (MAP_W / 2 - mapX) * scale;
    const panY = (MAP_H / 2 - mapY) * scale;
    cameraRef.current = { zoom: z, panX, panY };
  }, []);

  const resetCamera = useCallback(() => {
    cameraRef.current = { zoom: 1.04, panX: 0, panY: 0 };
  }, []);

  // Restore saved empire if initialHasSave
  useEffect(() => {
    if (!initialHasSave) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = localStorage.getItem(SAVE_KEY);
        if (!raw) {
          setPhase('SETUP');
          return;
        }
        const saved = JSON.parse(raw);
        const report = await engineRef.current.restoreState(saved);
        if (cancelled) return;
        const player = engineRef.current.getPlayer();
        if (player) {
          setEmpireName(player.name);
          setEmpireColor(player.color);
          if (player.flagDataUrl) setFlagDataUrl(player.flagDataUrl);
          setGuardianActive(engineRef.current.guardianActive);
          focusCameraOn(player.capitalX, player.capitalY, 2.2);
        }
        if (report) {
          setOfflineReport(report);
        }
      } catch (e) {
        console.error('Failed to restore world save:', e);
        setPhase('SETUP');
      }
    })();
    return () => { cancelled = true; };
  }, [initialHasSave, focusCameraOn]);

  // Save helper
  const saveNow = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || phaseRef.current !== 'PLAYING') return;
    const player = engine.getPlayer();
    if (!player || !player.alive) return;
    try {
      const payload = engine.serializeState();
      localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore quota errors
    }
  }, []);

  // Save on tab hide / unload
  useEffect(() => {
    const onHide = () => saveNow();
    window.addEventListener('beforeunload', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('beforeunload', onHide);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [saveNow]);

  // 20 Hz Simulation Loop + 6 Hz HUD Sync + Auto-save every 6s
  useEffect(() => {
    if (phase !== 'PLAYING') return;

    const simTimer = setInterval(() => {
      const engine = engineRef.current;
      if (!engine) return;
      engine.tick();

      // Sync React HUD every 3 ticks (~6.6 Hz)
      if (engine.tickCount % 3 === 0) {
        const player = engine.getPlayer();
        const leaderLand = engine.getLeaderLand();
        if (player) {
          const eco = computeNationEconomy(player.landCount, leaderLand);
          const myForts = engine.forts.filter((f) => f.ownerId === player.id).length;
          setHud({
            troops: Math.floor(player.troops),
            maxTroops: eco.maxTroops,
            incomePerSec: player.incomePerSec || 0,
            landCount: player.landCount,
            landPct: ((player.landCount / Math.max(1, worldData.totalLandPixels)) * 100).toFixed(1),
            tierName: eco.tierName,
            shipLabel: eco.shipLabel,
            fortCount: myForts,
            maxForts: eco.maxForts,
            catchUpPct: Math.round((eco.catchUpMult - 1) * 100),
            alive: player.alive,
            leaderboard: engine.getLeaderboard().slice(0, 6),
            winner: engine.gameOverWinner,
          });
        }
      }

      // Auto-save every 120 ticks (~6 seconds)
      if (engine.tickCount % 120 === 0) {
        saveNow();
      }
    }, 50);

    return () => clearInterval(simTimer);
  }, [phase, worldData.totalLandPixels, saveNow]);

  // 60 FPS High-DPI Render Loop (active in SPAWN & PLAYING, plus background preview in SETUP!)
  useEffect(() => {
    let rafId;
    const startTime = performance.now();

    const loop = (now) => {
      const canvas = canvasRef.current;
      if (canvas && rendererRef.current && engineRef.current) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewW = canvas.clientWidth || window.innerWidth;
        const viewH = canvas.clientHeight || window.innerHeight;
        const targetW = Math.floor(viewW * dpr);
        const targetH = Math.floor(viewH * dpr);

        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }

        const ctx = canvas.getContext('2d');
        ctx.save();
        ctx.scale(dpr, dpr);

        const tf = rendererRef.current.renderFrame(
          ctx,
          viewW,
          viewH,
          cameraRef.current,
          engineRef.current,
          {
            phase: phaseRef.current,
            hoveredMapPos: hoveredMapPosRef.current,
            hoveredNationId: hoveredNationIdRef.current,
            selectedNationId: selectedNationIdRef.current,
            actionMode: actionModeRef.current,
            timeSec: (now - startTime) / 1000,
          }
        );
        transformRef.current = tf;
        ctx.restore();
      }
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // Convert client screen coordinates to Map (0..MAP_W, 0..MAP_H)
  const screenToMap = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const { scale, originX, originY } = transformRef.current;
    if (!scale) return null;
    const mx = (sx - originX) / scale;
    const my = (sy - originY) / scale;
    return { x: mx, y: my };
  }, []);

  // Custom Flag Image Upload Handler
  const handleImageUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('Lütfen geçerli bir resim dosyası seçin (PNG, JPG, WebP)!', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const { rgba, dataUrl } = await loadDataUrlToFlagBuffer(ev.target.result);
        flagRgbaRef.current = rgba;
        setFlagDataUrl(dataUrl);
        setSelectedPresetCode(null);
        soundManager.playClick();
        showToast('🖼️ Kendi bayrağın başarıyla yüklendi!', 'success');
      } catch {
        showToast('Resim işlenemedi, başka bir görsel dene.', 'error');
      }
    };
    reader.readAsDataURL(file);
  };

  // Start spawn phase from Setup
  const handleProceedToSpawn = () => {
    soundManager.playClick();
    // Reset engine canvas to clean topographic neutral Earth for Spawn selection
    const engine = engineRef.current;
    const total = MAP_W * MAP_H;
    for (let i = 0; i < total; i++) {
      engine.owners[i] = worldData.isLand[i] ? 0 : -1;
      engine.freshness[i] = 0;
    }
    engine.nations = [];
    engine.nationMap.clear();
    engine.attacks = [];
    engine.fleets = [];
    engine.forts = [];
    engine.regions = [];
    engine.dirtyPixels = true;
    resetCamera();
    setPhase('SPAWN');
  };

  // Actually start the world at chosen (mx, my)
  const spawnEmpireAt = useCallback((mx, my) => {
    const engine = engineRef.current;
    engine.guardianActive = guardianActive;
    engine.startNewWorld({
      playerName: empireName.trim() || 'İmparatorluğum',
      playerColor: empireColor,
      flagRgba: flagRgbaRef.current,
      flagDataUrl,
      spawnX: mx,
      spawnY: my,
    });
    engine.recomputeRegions();
    engine.dirtyRegions = false;
    engine.dirtyPixels = true;

    const player = engine.getPlayer();
    setPhase('PLAYING');
    setSelectedNationId(0);
    setEvents([]);
    if (player) {
      focusCameraOn(player.capitalX, player.capitalY, 2.3);
    }
    soundManager.playWin();
    showToast(`⚔️ ${empireName.trim() || 'İmparatorluğun'} kuruldu! Sınırlarına tıklayarak yayılmaya başla!`, 'success');
    setTimeout(() => saveNow(), 250);
  }, [empireName, empireColor, flagDataUrl, guardianActive, focusCameraOn, showToast, saveNow]);

  // Random fertile spawn spot (real geographic coordinates!)
  const handleRandomSpawn = () => {
    const candidates = [
      [34.0, 39.2],   // Anatolia / Turkey
      [12.5, 48.0],   // Central Europe
      [-51.0, -14.0], // Brazil
      [-95.0, 39.0],  // USA
      [78.5, 22.0],   // India
      [138.0, 36.2],  // Japan
      [134.0, -25.0], // Australia
      [30.5, 26.8],   // Egypt / Nile
    ];
    const [lon, lat] = candidates[Math.floor(Math.random() * candidates.length)];
    const [mx, my] = lonLatToMapXY(lon, lat);
    spawnEmpireAt(Math.round(mx), Math.round(my));
  };

  // Handle verified map tap/click (distinct from camera pan drag!)
  const handleMapTap = useCallback((clientX, clientY, isRightClick = false) => {
    const pos = screenToMap(clientX, clientY);
    if (!pos) return;
    if (pos.x < 0 || pos.x >= MAP_W || pos.y < 0 || pos.y >= MAP_H) return;

    const ix = Math.floor(pos.x);
    const iy = Math.floor(pos.y);

    // SPAWN PHASE: Click any land on Earth to drop your capital!
    if (phaseRef.current === 'SPAWN') {
      if (!worldData.isLand[iy * MAP_W + ix]) {
        showToast('Başkent kurmak için bir kara parçasına (kıtaya veya adaya) tıkla!', 'error');
        return;
      }
      spawnEmpireAt(ix, iy);
      return;
    }

    if (phaseRef.current !== 'PLAYING') return;

    const engine = engineRef.current;
    const clickedOwner = engine.owners[iy * MAP_W + ix];

    // Right-click OR Diplomacy mode -> inspect nation & open Diplomacy Card
    if (isRightClick || actionModeRef.current === 'DIPLOMACY') {
      if (clickedOwner > 1) {
        setSelectedNationId(clickedOwner);
        soundManager.playClick();
      } else {
        setSelectedNationId(0);
      }
      return;
    }

    // Close diplomacy drawer if open when issuing direct attack
    if (selectedNationIdRef.current) setSelectedNationId(0);

    // Execute Land Wave / Auto Naval / Fortify command
    const res = engine.handlePlayerMapClick(ix, iy, actionModeRef.current, sendRatioRef.current);
    if (!res.ok) {
      if (res.reason) showToast(res.reason, 'error');
      soundManager.playHit();
    } else if (actionModeRef.current === 'FORTIFY' || actionModeRef.current === 'NAVAL') {
      // Return smoothly to AUTO mode after placing fort or launching explicit naval strike
      setActionMode('AUTO');
    }
  }, [screenToMap, worldData.isLand, spawnEmpireAt, showToast]);

  // Smooth Wheel Zoom anchored to mouse cursor
  const handleWheel = useCallback((e) => {
    if (phaseRef.current === 'SETUP') return;
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const cam = cameraRef.current;
    const oldZoom = cam.zoom;
    const factor = e.deltaY < 0 ? 1.16 : 0.86;
    const newZoom = Math.max(0.85, Math.min(6.0, oldZoom * factor));
    const ratio = newZoom / oldZoom;

    const viewW = rect.width;
    const viewH = rect.height;
    const cx = mx - viewW / 2;
    const cy = my - viewH / 2;

    cam.panX = cx - (cx - cam.panX) * ratio;
    cam.panY = cy - (cy - cam.panY) * ratio;
    cam.zoom = newZoom;
  }, []);

  // Pointer Events (Pan + 2-Finger Pinch Zoom + Click separation)
  const handlePointerDown = (e) => {
    if (phaseRef.current === 'SETUP') return;
    if (e.button === 2) {
      handleMapTap(e.clientX, e.clientY, true);
      return;
    }

    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 1) {
      dragStateRef.current = {
        active: true,
        moved: false,
        startX: e.clientX,
        startY: e.clientY,
        startPanX: cameraRef.current.panX,
        startPanY: cameraRef.current.panY,
        pinchStartDist: 0,
        pinchStartZoom: cameraRef.current.zoom,
      };
    } else if (pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      dragStateRef.current.moved = true;
      dragStateRef.current.pinchStartDist = Math.max(10, dist);
      dragStateRef.current.pinchStartZoom = cameraRef.current.zoom;
    }
  };

  const handlePointerMove = (e) => {
    if (phaseRef.current === 'SETUP') return;

    // Update hover tracking
    const pos = screenToMap(e.clientX, e.clientY);
    if (pos && pos.x >= 0 && pos.x < MAP_W && pos.y >= 0 && pos.y < MAP_H) {
      hoveredMapPosRef.current = pos;
      const idx = Math.floor(pos.y) * MAP_W + Math.floor(pos.x);
      const engine = engineRef.current;
      const o = engine.owners[idx];
      hoveredNationIdRef.current = o > 0 ? o : 0;

      if (phaseRef.current === 'PLAYING') {
        if (o > 0) {
          const n = engine.nationMap.get(o);
          setHoveredInfo(n ? { name: n.name, troops: Math.floor(n.troops), isPlayer: n.isPlayer, ally: n.alliedWithPlayer, vassal: n.vassalOfPlayer } : null);
        } else if (o === 0) {
          const cid = worldData.countryMask[idx];
          const cname = worldData.countryList[cid]?.name || 'Tarafsız Toprak';
          setHoveredInfo({ name: `${cname} (Tarafsız)`, troops: null, neutral: true });
        } else {
          setHoveredInfo(null);
        }
      }
    } else {
      hoveredMapPosRef.current = null;
      hoveredNationIdRef.current = 0;
      setHoveredInfo(null);
    }

    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // 2-Finger Pinch Zoom
    if (pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const scaleFactor = dist / dragStateRef.current.pinchStartDist;
      cameraRef.current.zoom = Math.max(0.85, Math.min(6.0, dragStateRef.current.pinchStartZoom * scaleFactor));
      return;
    }

    // 1-Finger / Mouse Pan (with 7px deadzone so taps never turn into drags!)
    if (dragStateRef.current.active) {
      const dx = e.clientX - dragStateRef.current.startX;
      const dy = e.clientY - dragStateRef.current.startY;
      if (!dragStateRef.current.moved && Math.hypot(dx, dy) > 7) {
        dragStateRef.current.moved = true;
      }
      if (dragStateRef.current.moved) {
        cameraRef.current.panX = dragStateRef.current.startPanX + dx;
        cameraRef.current.panY = dragStateRef.current.startPanY + dy;
      }
    }
  };

  const handlePointerUp = (e) => {
    const wasMoved = dragStateRef.current.moved;
    const wasActive = dragStateRef.current.active && pointersRef.current.size === 1;
    pointersRef.current.delete(e.pointerId);

    if (pointersRef.current.size === 0) {
      dragStateRef.current.active = false;
      dragStateRef.current.moved = false;
      if (wasActive && !wasMoved) {
        handleMapTap(e.clientX, e.clientY, false);
      }
    }
  };

  // Attach non-passive wheel listener for clean preventDefault
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Selected Nation data for Diplomacy Inspector
  const inspectedNation = useMemo(() => {
    if (!selectedNationId || !engineRef.current) return null;
    const n = engineRef.current.nationMap.get(selectedNationId);
    if (!n || !n.alive) return null;
    return {
      ...n,
      troops: Math.floor(n.troops),
      pct: ((n.landCount / Math.max(1, worldData.totalLandPixels)) * 100).toFixed(1),
    };
  }, [selectedNationId, hud.leaderboard, worldData.totalLandPixels]);

  const troopsToDeploy = Math.floor((hud.troops * sendRatio) / 100);

  return (
    <div
      className="relative h-screen w-screen overflow-hidden bg-[#061529] text-white select-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Full-Bleed Live Real-Earth World Map Canvas */}
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className={`block w-full h-full touch-none ${
          phase === 'SPAWN'
            ? 'cursor-crosshair'
            : actionMode === 'FORTIFY' || actionMode === 'NAVAL'
            ? 'cursor-crosshair'
            : actionMode === 'DIPLOMACY'
            ? 'cursor-pointer'
            : 'cursor-grab active:cursor-grabbing'
        }`}
      />

      {/* ==================== PHASE 1: SETUP MODAL OVER LIVE EARTH ==================== */}
      {phase === 'SETUP' && (
        <div className="absolute inset-0 z-30 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6 overflow-y-auto">
          <div className="max-w-xl w-full bg-slate-900/95 border border-amber-500/35 rounded-3xl p-5 sm:p-7 shadow-2xl space-y-5 my-auto animate-in fade-in zoom-in-95">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 pb-3.5">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-600 flex items-center justify-center text-slate-950 shadow-lg">
                  <Globe size={26} />
                </div>
                <div>
                  <h1 className="text-xl sm:text-2xl font-black tracking-tight">Dev Dünya Haritası</h1>
                  <p className="text-xs text-amber-300/90 font-semibold">
                    Gerçek Dünya • Kendi Bayrağın • Deniz & Kara Fethi
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  soundManager.playClick();
                  onReturnToModeSelect();
                }}
                className="p-2 rounded-xl bg-white/5 hover:bg-white/15 text-slate-300 hover:text-white transition cursor-pointer"
                title="Mod Seçimine Dön"
              >
                <Home size={18} />
              </button>
            </div>

            {/* Empire Name */}
            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-wider text-slate-300">
                İmparatorluk İsmi
              </label>
              <input
                type="text"
                value={empireName}
                onChange={(e) => setEmpireName(e.target.value)}
                maxLength={22}
                placeholder="Örn: Büyük Türk Devleti"
                className="w-full px-4 py-3 bg-slate-800/90 border border-white/15 focus:border-amber-400 rounded-xl text-white font-bold text-sm focus:outline-none transition"
              />
            </div>

            {/* Custom Flag Upload + Live Preview */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-black uppercase tracking-wider text-slate-300">
                  Bayrağın / Özel Görselin
                </label>
                <span className="text-[10px] text-amber-400 font-bold">
                  Fethettiğin tüm topraklar bu görselle kaplanır!
                </span>
              </div>

              <div className="flex items-center gap-4 p-3.5 bg-slate-800/75 border border-white/10 rounded-2xl">
                <div className="relative w-24 h-16 shrink-0 rounded-xl overflow-hidden border-2 border-amber-400 shadow-lg bg-slate-950">
                  <img
                    src={flagDataUrl}
                    alt="Bayrak Önizleme"
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute bottom-0.5 right-1 px-1 rounded bg-black/70 text-[9px] font-black text-amber-300">
                    ÖNİZLEME
                  </div>
                </div>

                <div className="flex-1 space-y-1.5">
                  <label className="inline-flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-amber-400 to-orange-500 hover:from-amber-300 hover:to-orange-400 text-slate-950 font-black text-xs rounded-xl cursor-pointer shadow-lg transition active:scale-95">
                    <Upload size={15} />
                    <span>Kendi Görselini Yükle</span>
                    <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
                  </label>
                  <p className="text-[11px] text-slate-400 leading-snug">
                    Galerinden istediğin bayrağı, logoyu veya resmi yükle. Sınırların büyüdükçe görselin kıtalara yayılır!
                  </p>
                </div>
              </div>

              {/* Preset Crisp Offline Flags */}
              <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5 pt-0.5">
                {PRESET_PLAYER_FLAGS.map((pf) => {
                  const flagObj = getPresetFlag(pf.code);
                  const active = selectedPresetCode === pf.code;
                  return (
                    <button
                      key={pf.code}
                      type="button"
                      onClick={() => {
                        soundManager.playClick();
                        setSelectedPresetCode(pf.code);
                        setFlagDataUrl(flagObj.dataUrl);
                        flagRgbaRef.current = flagObj.rgba;
                        setEmpireColor(pf.color);
                      }}
                      className={`p-1.5 rounded-xl border transition flex flex-col items-center gap-1 cursor-pointer ${
                        active
                          ? 'bg-amber-500/25 border-amber-400 ring-1 ring-amber-400/50'
                          : 'bg-slate-800/60 border-white/10 hover:border-white/30'
                      }`}
                    >
                      <img
                        src={flagObj.dataUrl}
                        alt={pf.name}
                        className="w-9 h-6 object-cover rounded shadow-sm"
                      />
                      <span className="text-[10px] font-bold text-slate-200 truncate max-w-full">
                        {pf.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Balance & Rules Summary Strip */}
            <div className="grid grid-cols-3 gap-2 text-[10px] text-slate-300">
              <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
                <div className="font-black text-amber-400 mb-0.5">⚖️ Akıllı Denge</div>
                Küçükler hızla toparlanır; büyükler dev ordu & zırhlı armada kurar.
              </div>
              <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
                <div className="font-black text-sky-400 mb-0.5">🚢 Gerçek Deniz</div>
                Gemiler kıtaların etrafından, boğazlardan geçip çıkarma yapar.
              </div>
              <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
                <div className="font-black text-emerald-400 mb-0.5">🛡️ Vekil Bot</div>
                Çıksan bile devletin kaydedilir ve muhafız botun savunur.
              </div>
            </div>

            {/* Proceed Button */}
            <button
              type="button"
              onClick={handleProceedToSpawn}
              className="w-full py-3.5 bg-gradient-to-r from-amber-400 via-orange-500 to-red-500 hover:from-amber-300 hover:to-orange-400 text-slate-950 font-black text-sm sm:text-base rounded-2xl shadow-xl transition active:scale-[0.98] flex items-center justify-center gap-2 cursor-pointer"
            >
              <span>Haritada Başlangıç Noktanı Seç</span>
              <ChevronRight size={20} />
            </button>
          </div>
        </div>
      )}

      {/* ==================== PHASE 2: INTERACTIVE SPAWN OVERLAY ==================== */}
      {phase === 'SPAWN' && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 max-w-xl w-[94%] bg-slate-900/90 backdrop-blur-md border border-amber-400/50 rounded-2xl px-4 py-3 shadow-2xl flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <img src={flagDataUrl} alt="" className="w-10 h-7 rounded-lg object-cover border border-amber-400" />
            <div>
              <div className="text-sm font-black text-amber-300 flex items-center gap-1.5">
                <Sparkles size={15} />
                <span>Başkentini Kurmak İstediğin Yere Tıkla!</span>
              </div>
              <div className="text-[11px] text-slate-300">
                Anadolu, Avrupa, Amerika, Japonya... Dünya üzerinde herhangi bir karayı seç.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRandomSpawn}
              className="px-3 py-2 bg-amber-400 hover:bg-amber-300 text-slate-950 font-black text-xs rounded-xl shadow flex items-center gap-1.5 transition cursor-pointer"
            >
              <Shuffle size={14} />
              <span>Rastgele</span>
            </button>
            <button
              type="button"
              onClick={() => setPhase('SETUP')}
              className="px-3 py-2 bg-white/10 hover:bg-white/20 text-white font-bold text-xs rounded-xl transition cursor-pointer"
            >
              Geri
            </button>
          </div>
        </div>
      )}

      {/* ==================== PHASE 3: LIVE PLAYING FLOATING HUD ==================== */}
      {phase === 'PLAYING' && (
        <>
          {/* TOP-LEFT: Empire Stats & Capacity Bar */}
          <div className="absolute top-3 left-3 z-20 flex flex-col gap-2 max-w-[72vw] sm:max-w-sm">
            <div className="bg-slate-900/85 backdrop-blur-md border border-white/15 rounded-2xl p-2.5 sm:p-3 shadow-2xl">
              <div className="flex items-center gap-2.5">
                <img
                  src={flagDataUrl}
                  alt="Bayrak"
                  className="w-11 h-8 rounded-lg object-cover border border-amber-400 shadow shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-black text-sm text-white truncate max-w-[140px] sm:max-w-[190px]">
                      {empireName}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-500/20 border border-amber-400/40 text-amber-300 font-black">
                      {hud.tierName}
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-300 flex items-center gap-2 mt-0.5 font-semibold flex-wrap">
                    <span>🌍 %{hud.landPct}</span>
                    <span className="text-emerald-400 font-black">+{formatTroops(hud.incomePerSec)}/sn</span>
                    <span className="text-sky-300 hidden sm:inline">🚢 {hud.shipLabel}</span>
                    {hud.catchUpPct > 0 && (
                      <span className="text-amber-300 font-black">⚡ +{hud.catchUpPct}% Yetişme</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Troop Reserve Progress Bar */}
              <div className="mt-2">
                <div className="flex items-center justify-between text-[11px] font-black mb-1">
                  <span className="text-amber-300">⚔️ {formatTroops(hud.troops)} Asker</span>
                  <span className="text-slate-400">Kapasite: {formatTroops(hud.maxTroops)}</span>
                </div>
                <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden border border-white/10">
                  <div
                    className="h-full bg-gradient-to-r from-amber-500 via-yellow-400 to-emerald-400 transition-all duration-150"
                    style={{ width: `${Math.min(100, (hud.troops / Math.max(1, hud.maxTroops)) * 100)}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Hovered Territory Subtle Pill */}
            {hoveredInfo && (
              <div className="self-start bg-slate-900/80 backdrop-blur-md border border-white/10 rounded-xl px-2.5 py-1 text-[11px] font-bold text-slate-200 shadow-lg flex items-center gap-2 pointer-events-none">
                <span>{hoveredInfo.name}</span>
                {hoveredInfo.troops !== null && (
                  <span className="text-amber-300 font-black">⚔️ {formatTroops(hoveredInfo.troops)}</span>
                )}
                {hoveredInfo.ally && <span className="text-emerald-400">🛡️ Müttefik</span>}
                {hoveredInfo.vassal && <span className="text-purple-400">👑 Vasal</span>}
              </div>
            )}
          </div>

          {/* TOP-RIGHT: Controls + Live Leaderboard */}
          <div className="absolute top-3 right-3 z-20 flex flex-col items-end gap-2">
            {/* Quick Action Bar */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  const next = !guardianActive;
                  setGuardianActive(next);
                  engineRef.current.guardianActive = next;
                  soundManager.playClick();
                  showToast(
                    next
                      ? '🛡️ Vekil Muhafız AÇIK: Sınırlarında 1.85x direnç + AFK iken otomatik savunma!'
                      : '⚠️ Vekil Muhafız KAPALI.',
                    next ? 'success' : 'info'
                  );
                }}
                className={`px-2.5 py-2 rounded-xl border text-[11px] font-black flex items-center gap-1.5 backdrop-blur-md shadow-lg transition cursor-pointer ${
                  guardianActive
                    ? 'bg-emerald-500/25 border-emerald-400/60 text-emerald-200'
                    : 'bg-slate-900/80 border-white/15 text-slate-400 hover:text-white'
                }`}
                title="Vekil Muhafız Botu (Savunma AI)"
              >
                <Shield size={14} className={guardianActive ? 'text-emerald-400' : ''} />
                <span className="hidden md:inline">Vekil Bot:</span>
                <span>{guardianActive ? 'Açık' : 'Kapalı'}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Mevcut dünyayı sıfırlayıp yeni bir dünya başlatmak istiyor musun?')) {
                    localStorage.removeItem(SAVE_KEY);
                    setSelectedNationId(0);
                    setPhase('SETUP');
                  }
                }}
                className="p-2 rounded-xl bg-slate-900/80 hover:bg-slate-800 border border-white/15 text-slate-300 hover:text-amber-300 backdrop-blur-md shadow-lg transition cursor-pointer"
                title="Yeni Dünya Başlat"
              >
                <RotateCcw size={16} />
              </button>

              <button
                type="button"
                onClick={() => {
                  saveNow();
                  soundManager.playClick();
                  onReturnToModeSelect();
                }}
                className="p-2 rounded-xl bg-slate-900/80 hover:bg-slate-800 border border-white/15 text-slate-300 hover:text-white backdrop-blur-md shadow-lg transition cursor-pointer"
                title="Kaydet ve Mod Seçimine Dön"
              >
                <Home size={16} />
              </button>
            </div>

            {/* Live World Leaderboard */}
            <div className="bg-slate-900/82 backdrop-blur-md border border-white/12 rounded-2xl shadow-2xl overflow-hidden w-48 sm:w-56">
              <button
                type="button"
                onClick={() => setShowLeaderboard((v) => !v)}
                className="w-full px-3 py-2 flex items-center justify-between text-[11px] font-black uppercase tracking-wider text-amber-300 hover:bg-white/5 transition cursor-pointer"
              >
                <span className="flex items-center gap-1.5">
                  <Crown size={13} />
                  Dünya Liderleri
                </span>
                {showLeaderboard ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>

              {showLeaderboard && (
                <div className="px-2 pb-2 space-y-1">
                  {hud.leaderboard.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      onClick={() => {
                        const n = engineRef.current.nationMap.get(row.id);
                        if (!n) return;
                        const regs = engineRef.current.regions.filter((r) => r.ownerId === row.id);
                        const main = regs.sort((a, b) => b.count - a.count)[0];
                        if (main) focusCameraOn(main.cx, main.cy, 2.3);
                        else focusCameraOn(n.capitalX, n.capitalY, 2.3);
                        if (!row.isPlayer) setSelectedNationId(row.id);
                        soundManager.playClick();
                      }}
                      className={`w-full flex items-center gap-2 px-2 py-1 rounded-xl text-left text-[11px] transition cursor-pointer ${
                        row.isPlayer
                          ? 'bg-amber-500/25 border border-amber-400/50 text-amber-200 font-black'
                          : 'hover:bg-white/10 text-slate-200 font-semibold'
                      }`}
                    >
                      <span className="w-3.5 text-[10px] font-black text-slate-400">
                        {row.rank === 1 ? '👑' : `${row.rank}.`}
                      </span>
                      <img src={row.flagDataUrl} alt="" className="w-5 h-3.5 rounded-sm object-cover shrink-0" />
                      <span className="truncate flex-1">{row.name}</span>
                      <span className="text-[10px] font-black text-amber-300/90">%{row.pct}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* RIGHT-MIDDLE: Floating Camera Controls */}
          <div className="absolute right-3 bottom-28 sm:bottom-24 z-20 flex flex-col gap-1.5 bg-slate-900/80 backdrop-blur-md border border-white/12 rounded-2xl p-1.5 shadow-xl">
            <button
              type="button"
              onClick={() => {
                cameraRef.current.zoom = Math.min(6.0, cameraRef.current.zoom * 1.3);
              }}
              className="p-2 hover:bg-white/10 rounded-xl text-slate-200 transition cursor-pointer"
              title="Yakınlaştır"
            >
              <ZoomIn size={17} />
            </button>
            <button
              type="button"
              onClick={() => {
                cameraRef.current.zoom = Math.max(0.85, cameraRef.current.zoom * 0.77);
              }}
              className="p-2 hover:bg-white/10 rounded-xl text-slate-200 transition cursor-pointer"
              title="Uzaklaştır"
            >
              <ZoomOut size={17} />
            </button>
            <button
              type="button"
              onClick={() => {
                const p = engineRef.current.getPlayer();
                if (!p) return;
                const regs = engineRef.current.regions.filter((r) => r.ownerId === p.id);
                const main = regs.sort((a, b) => b.count - a.count)[0];
                if (main) focusCameraOn(main.cx, main.cy, 2.3);
                else focusCameraOn(p.capitalX, p.capitalY, 2.3);
              }}
              className="p-2 hover:bg-white/10 rounded-xl text-amber-300 transition cursor-pointer"
              title="Başkentime Odaklan"
            >
              <Crosshair size={17} />
            </button>
            <button
              type="button"
              onClick={resetCamera}
              className="p-2 hover:bg-white/10 rounded-xl text-sky-300 transition cursor-pointer"
              title="Tüm Dünya Haritası"
            >
              <Maximize2 size={16} />
            </button>
          </div>

          {/* BOTTOM-LEFT: Live War Ticker */}
          <div className="hidden sm:flex flex-col gap-1 absolute bottom-24 left-3 z-10 max-w-xs pointer-events-none">
            {events.map((ev) => (
              <div
                key={ev.id}
                className="px-2.5 py-1 rounded-xl bg-slate-900/75 backdrop-blur-md border border-white/10 text-[11px] font-semibold text-slate-200 shadow animate-in fade-in"
              >
                {ev.text}
              </div>
            ))}
          </div>

          {/* FLOATING NATION DIPLOMACY & INTEL CARD */}
          {inspectedNation && (
            <div className="absolute bottom-24 left-1/2 -translate-x-1/2 sm:left-auto sm:translate-x-0 sm:right-16 z-30 w-[92vw] max-w-xs bg-slate-900/95 backdrop-blur-lg border border-amber-400/40 rounded-2xl p-4 shadow-2xl space-y-3 animate-in zoom-in-95">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <img
                    src={inspectedNation.flagDataUrl}
                    alt=""
                    className="w-11 h-7 rounded-lg object-cover border border-white/25 shrink-0"
                  />
                  <div className="min-w-0">
                    <div className="font-black text-sm text-white truncate">{inspectedNation.name}</div>
                    <div className="text-[11px] text-slate-300 flex items-center gap-2">
                      <span>🌍 %{inspectedNation.pct}</span>
                      <span className="text-amber-300 font-bold">⚔️ {formatTroops(inspectedNation.troops)}</span>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedNationId(0)}
                  className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-slate-300 cursor-pointer"
                >
                  <X size={15} />
                </button>
              </div>

              {inspectedNation.vassalOfPlayer && (
                <div className="text-[11px] px-2.5 py-1.5 rounded-xl bg-purple-500/20 border border-purple-400/40 text-purple-200 font-bold">
                  👑 Senin Vasalın! Üretiminin %14&apos;ünü haraç olarak gönderiyor.
                </div>
              )}
              {inspectedNation.alliedWithPlayer && !inspectedNation.vassalOfPlayer && (
                <div className="text-[11px] px-2.5 py-1.5 rounded-xl bg-emerald-500/20 border border-emerald-400/40 text-emerald-200 font-bold">
                  🛡️ Saldırmazlık İttifakı Aktif
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                {!inspectedNation.alliedWithPlayer ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        const res = engineRef.current.launchAttack(1, inspectedNation.id, sendRatio);
                        if (!res.ok && res.reason === 'NO_BORDER') {
                          const nRes = engineRef.current.launchNavalInvasion(1, inspectedNation.capitalX, inspectedNation.capitalY, sendRatio);
                          if (!nRes.ok) showToast(nRes.reason, 'error');
                          else showToast(`🚢 ${inspectedNation.name} kıyısına donanma gönderildi!`, 'success');
                        } else if (!res.ok) {
                          showToast(res.reason, 'error');
                        }
                        setSelectedNationId(0);
                      }}
                      className="py-2 px-3 bg-red-600 hover:bg-red-500 text-white font-black text-xs rounded-xl flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Swords size={14} />
                      <span>Saldır</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        const r = engineRef.current.proposeAlliance(inspectedNation.id);
                        showToast(r.msg, r.ok ? 'success' : 'error');
                      }}
                      className="py-2 px-3 bg-emerald-600 hover:bg-emerald-500 text-white font-black text-xs rounded-xl flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Handshake size={14} />
                      <span>İttifak Kur</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        const r = engineRef.current.demandTribute(inspectedNation.id);
                        showToast(r.msg, r.ok ? 'success' : 'error');
                      }}
                      className="col-span-2 py-2 px-3 bg-gradient-to-r from-amber-500 to-purple-600 hover:from-amber-400 hover:to-purple-500 text-white font-black text-xs rounded-xl flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Crown size={14} />
                      <span>Haraç / Vasal İste (Büyük Devlet Gücü)</span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      const r = engineRef.current.breakAlliance(inspectedNation.id);
                      showToast(r.msg, 'info');
                    }}
                    className="col-span-2 py-2 px-3 bg-red-600/85 hover:bg-red-600 text-white font-black text-xs rounded-xl flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Swords size={14} />
                    <span>İttifakı Boz ve Sınırları Aç</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* BOTTOM CENTER: Sleek Floating Command Dock */}
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 w-[96vw] max-w-2xl bg-slate-900/88 backdrop-blur-lg border border-white/15 rounded-2xl px-3 py-2.5 shadow-2xl flex flex-col sm:flex-row items-center justify-between gap-2.5">
            {/* 4 Command Mode Pills */}
            <div className="flex items-center gap-1.5 w-full sm:w-auto justify-center">
              <button
                type="button"
                onClick={() => { setActionMode('AUTO'); soundManager.playClick(); }}
                className={`flex-1 sm:flex-none px-3 py-2 rounded-xl text-xs font-black flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  actionMode === 'AUTO'
                    ? 'bg-gradient-to-r from-amber-400 to-orange-500 text-slate-950 shadow-md'
                    : 'bg-white/8 hover:bg-white/15 text-slate-200'
                }`}
              >
                <Swords size={14} />
                <span>Fethet</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setActionMode('NAVAL');
                  soundManager.playClick();
                  showToast('🚢 Donanma Modu: Çıkarma yapmak istediğin kıyıya veya kıtaya tıkla!');
                }}
                className={`flex-1 sm:flex-none px-3 py-2 rounded-xl text-xs font-black flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  actionMode === 'NAVAL'
                    ? 'bg-sky-500 text-white shadow-md'
                    : 'bg-white/8 hover:bg-white/15 text-slate-200'
                }`}
              >
                <Anchor size={14} />
                <span>Donanma</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setActionMode('FORTIFY');
                  soundManager.playClick();
                  showToast(`🏰 Kale Modu: Kendi toprağına tıkla (1.2K Asker • ${hud.fortCount}/${hud.maxForts} Kale)`);
                }}
                className={`flex-1 sm:flex-none px-3 py-2 rounded-xl text-xs font-black flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  actionMode === 'FORTIFY'
                    ? 'bg-amber-200 text-slate-950 shadow-md'
                    : 'bg-white/8 hover:bg-white/15 text-slate-200'
                }`}
              >
                <Castle size={14} />
                <span>Kale ({hud.fortCount}/{hud.maxForts})</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setActionMode('DIPLOMACY');
                  soundManager.playClick();
                  showToast('🤝 Diplomasi Modu: İttifak veya haraç için bir ülkeye tıkla!');
                }}
                className={`flex-1 sm:flex-none px-3 py-2 rounded-xl text-xs font-black flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  actionMode === 'DIPLOMACY'
                    ? 'bg-emerald-500 text-slate-950 shadow-md'
                    : 'bg-white/8 hover:bg-white/15 text-slate-200'
                }`}
              >
                <Handshake size={14} />
                <span className="hidden xs:inline">Diplomasi</span>
              </button>
            </div>

            {/* Smooth Army Deployment Ratio Slider */}
            <div className="flex items-center gap-2 w-full sm:w-auto sm:min-w-[235px]">
              <div className="flex items-center gap-1">
                {[25, 50, 75].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => { setSendRatio(pct); soundManager.playClick(); }}
                    className={`px-2 py-1 rounded-lg text-[10px] font-black transition cursor-pointer ${
                      sendRatio === pct
                        ? 'bg-amber-400 text-slate-950'
                        : 'bg-white/10 text-slate-300 hover:bg-white/20'
                    }`}
                  >
                    %{pct}
                  </button>
                ))}
              </div>
              <input
                type="range"
                min={10}
                max={90}
                step={5}
                value={sendRatio}
                onChange={(e) => setSendRatio(Number(e.target.value))}
                className="flex-1 accent-amber-400 cursor-pointer h-1.5"
              />
              <span className="text-[11px] font-black text-amber-300 min-w-[54px] text-right">
                {formatTroops(troopsToDeploy)}
              </span>
            </div>
          </div>
        </>
      )}

      {/* TOAST NOTIFICATION */}
      {toast && (
        <div
          className={`absolute top-16 sm:top-4 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-2xl shadow-2xl border font-black text-xs sm:text-sm flex items-center gap-2 animate-in fade-in slide-in-from-top-2 ${
            toast.type === 'error'
              ? 'bg-red-950/95 border-red-500/60 text-red-100'
              : toast.type === 'success'
              ? 'bg-emerald-950/95 border-emerald-400/60 text-emerald-100'
              : 'bg-slate-900/95 border-amber-400/60 text-amber-200'
          }`}
        >
          {toast.type === 'error' ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
          <span>{toast.msg}</span>
        </div>
      )}

      {/* OFFLINE GUARDIAN AI REPORT MODAL */}
      {offlineReport && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-slate-900 border-2 border-emerald-400/60 rounded-3xl p-6 max-w-sm w-full text-center space-y-4 shadow-2xl">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
              <Shield size={32} />
            </div>
            <div>
              <div className="text-[11px] font-black uppercase tracking-wider text-emerald-400">
                Vekil Muhafız Raporu
              </div>
              <h3 className="text-xl font-black text-white mt-1">Tekrar Hoş Geldin, Kumandan!</h3>
              <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">
                Yaklaşık <strong>{offlineReport.elapsedMinutes} dakika</strong> boyunca devletini nöbette korudum.
              </p>
            </div>
            <div className="bg-slate-800/80 rounded-2xl p-3.5 text-left text-xs space-y-2 border border-white/10">
              <div className="flex justify-between">
                <span className="text-slate-400">Garnizonda Üretilen Asker:</span>
                <span className="font-black text-emerald-400">+{formatTroops(offlineReport.producedTroops)}</span>
              </div>
              {offlineReport.guardianWasOn && (
                <>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Püskürtülen Sınır Akını:</span>
                    <span className="font-black text-amber-300">{offlineReport.raidsRepelled} Saldırı</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Düşmana Verdirilen Kayıp:</span>
                    <span className="font-black text-red-400">-{formatTroops(offlineReport.enemyCasualties)} Asker</span>
                  </div>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                soundManager.playClick();
                setOfflineReport(null);
              }}
              className="w-full py-3 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-sm rounded-xl shadow-lg cursor-pointer"
            >
              Komutayı Devral ⚔️
            </button>
          </div>
        </div>
      )}

      {/* VICTORY / DEFEAT OVERLAY */}
      {phase === 'PLAYING' && (!hud.alive || hud.winner) && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4 animate-in zoom-in-95">
          <div className="bg-slate-900 border-2 border-amber-400 rounded-3xl p-7 max-w-sm w-full text-center space-y-4 shadow-2xl">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-amber-500/20 text-amber-400 flex items-center justify-center">
              <Trophy size={36} />
            </div>
            <h2 className="text-2xl font-black text-white">
              {hud.winner?.isPlayer ? 'DÜNYA HAKİMİYETİ!' : !hud.alive ? 'İMPARATORLUK DÜŞTÜ' : 'SAVAŞ SONA ERDİ'}
            </h2>
            <p className="text-xs text-slate-300 leading-relaxed">
              {hud.winner?.isPlayer
                ? `${empireName} dünyaya hükmetti ve tüm kıtalarda bayrağını dalgalandırdı!`
                : !hud.alive
                ? 'Toprakların kaybedildi, ama yeni bir kıtadan çok daha güçlü doğabilirsin!'
                : `${hud.winner?.name} dünya hakimiyetini ilan etti.`}
            </p>
            <div className="flex flex-col gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  localStorage.removeItem(SAVE_KEY);
                  setPhase('SETUP');
                }}
                className="w-full py-3 bg-gradient-to-r from-amber-400 to-orange-500 text-slate-950 font-black text-sm rounded-xl shadow-lg cursor-pointer"
              >
                Yeni İmparatorluk Kur 🌍
              </button>
              <button
                type="button"
                onClick={() => {
                  localStorage.removeItem(SAVE_KEY);
                  onReturnToModeSelect();
                }}
                className="w-full py-2.5 bg-white/10 hover:bg-white/20 text-white font-bold text-xs rounded-xl cursor-pointer"
              >
                Ana Menüye Dön
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
