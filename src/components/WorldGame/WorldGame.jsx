import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { MAP_W, MAP_H, getWorldRasterData } from '../../world/worldRasterizer';
import { WorldSimulationEngine, UPGRADE_DEFINITIONS } from '../../world/worldEngine';
import { WorldMapRenderer } from '../../world/worldRenderer';
import { checkNetworkAndSecurity } from '../../world/networkSecurity';
import { soundManager } from '../../utils/audio';
import confetti from 'canvas-confetti';
import {
  ArrowLeft,
  Upload,
  Globe,
  ZoomIn,
  ZoomOut,
  Compass,
  Volume2,
  VolumeX,
  HelpCircle,
  X,
  AlertTriangle,
  Sparkles,
  ShieldAlert,
} from 'lucide-react';

export default function WorldGame({ onReturnToModeSelect }) {
  // Raster grey world data (1000x500)
  const worldData = useMemo(() => getWorldRasterData(), []);

  // Synchronized Engine & Renderer Refs
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const rendererRef = useRef(null);
  const fileInputRef = useRef(null);

  // Camera Ref: panX, panY, zoom
  const cameraRef = useRef({ zoom: 1.0, panX: 0, panY: 0 });

  // Security & IP State
  const [networkInfo, setNetworkInfo] = useState({
    clientIp: '',
    isVpnOrProxy: false,
    hasExistingCountry: false,
    checked: false,
  });

  // Founding Modal State (when player clicks an unclaimed pixel)
  const [foundingModal, setFoundingModal] = useState(null); // { x, y }
  const [foundName, setFoundName] = useState('');
  const [foundColor, setFoundColor] = useState('#E11D48');
  const [foundFlagDataUrl, setFoundFlagDataUrl] = useState(null);

  // VPN Block Modal
  const [vpnBlocked, setVpnBlocked] = useState(false);

  // Modes & UI
  const [toolMode, setToolMode] = useState('CONQUER'); // 'CONQUER' | 'PAN'
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [showRules, setShowRules] = useState(false);
  const [showUpgrades, setShowUpgrades] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);

  // Real-time HUD state
  const [hud, setHud] = useState({
    myCountry: null,
    totalCountriesCount: 0,
    time: 0,
  });

  // Mouse & Touch interaction tracking
  const isMouseDownRef = useRef(false);
  const isPaintingRef = useRef(false);
  const lastCellRef = useRef(null);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const pointersRef = useRef(new Map());
  const pinchStartDistRef = useRef(0);
  const pinchStartZoomRef = useRef(1);
  const hoveredPosRef = useRef(null);
  const lastTickTimeRef = useRef(performance.now());

  const showToast = useCallback((msg) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3400);
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
          try { confetti({ particleCount: 65, spread: 75, origin: { y: 0.6 } }); } catch {}
        }
      },
    });
  }

  // Network & Security Check on Mount
  useEffect(() => {
    checkNetworkAndSecurity().then((info) => {
      setNetworkInfo({ ...info, checked: true });
      if (info.isVpnOrProxy) {
        setVpnBlocked(true);
      }
    });
  }, []);

  // Center camera on coordinates without drift
  const centerOnCoords = useCallback((cx, cy, targetZoom = 3.6) => {
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

  // Zoom relative to viewport center without drift
  const handleZoom = useCallback((factor) => {
    const oldZoom = cameraRef.current.zoom;
    const newZoom = Math.max(0.6, Math.min(32.0, oldZoom * factor));
    const ratio = newZoom / oldZoom;
    cameraRef.current.zoom = newZoom;
    cameraRef.current.panX *= ratio;
    cameraRef.current.panY *= ratio;
  }, []);

  // Initial center on player's country if exists
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    const myC = eng.getMyCountry();
    if (myC) {
      centerOnCoords(myC.capitalX, myC.capitalY, 3.8);
    }
  }, [centerOnCoords]);

  // Handle Custom Flag Upload
  const handleFileUpload = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      setFoundFlagDataUrl(ev.target.result);
      showToast('✅ Resim seçildi!');
    };
    reader.readAsDataURL(file);
  }, [showToast]);

  // Found Country Confirmation
  const handleConfirmFoundCountry = useCallback(async () => {
    if (!foundingModal) return;
    if (networkInfo.isVpnOrProxy) {
      setVpnBlocked(true);
      return;
    }
    if (!foundName.trim()) {
      showToast('⚠️ Lütfen bir ülke adı yazın!');
      return;
    }

    let flagUrl = foundFlagDataUrl;
    if (!flagUrl) {
      // Auto-generate clean vector flag with country's initial and chosen color if no image uploaded
      const cv = document.createElement('canvas');
      cv.width = 128;
      cv.height = 80;
      const cctx = cv.getContext('2d');
      cctx.fillStyle = foundColor || '#E11D48';
      cctx.fillRect(0, 0, 128, 80);
      cctx.fillStyle = '#FFFFFF';
      cctx.font = '900 36px Inter, sans-serif';
      cctx.textAlign = 'center';
      cctx.textBaseline = 'middle';
      const initial = (foundName || 'D').trim().charAt(0).toUpperCase();
      cctx.fillText(initial, 64, 40);
      flagUrl = cv.toDataURL('image/png');
    }

    const eng = engineRef.current;
    if (!eng) return;

    const res = await eng.foundCountry({
      name: foundName,
      color: foundColor,
      flagDataUrl: flagUrl,
      capitalX: foundingModal.x,
      capitalY: foundingModal.y,
      creatorIp: networkInfo.clientIp,
    });

    if (res.ok) {
      setFoundingModal(null);
      centerOnCoords(res.country.capitalX, res.country.capitalY, 7.5);
    } else {
      showToast(res.reason || 'Devlet kurulamadı.');
    }
  }, [foundingModal, networkInfo, foundName, foundColor, foundFlagDataUrl, centerOnCoords, showToast]);

  // Coordinate mapper from viewport to map coordinates
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
    };
  }, []);

  // Pointer interactions (drag conquest & smooth pan)
  const handlePointerDown = useCallback((e) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    isMouseDownRef.current = true;
    dragStartRef.current = { x: e.clientX, y: e.clientY };

    // Right-click or middle-click or PAN mode -> pure camera pan
    if (e.button === 2 || e.button === 1 || toolMode === 'PAN') {
      isPaintingRef.current = false;
      return;
    }

    if (pointersRef.current.size === 1) {
      const pos = getMapCoords(e.clientX, e.clientY);
      if (pos && pos.x >= 0 && pos.x < MAP_W && pos.y >= 0 && pos.y < MAP_H) {
        lastCellRef.current = { x: pos.x, y: pos.y };

        const eng = engineRef.current;
        const myCountry = eng?.getMyCountry();

        if (!myCountry) {
          // Player has no country yet: clicking an unclaimed land pixel prompts founding modal!
          const idx = pos.y * MAP_W + pos.x;
          if (worldData.isLand[idx] && eng.owners[idx] === 0) {
            if (networkInfo.isVpnOrProxy) {
              setVpnBlocked(true);
              return;
            }
            // Enforce 1 Device = 1 Country
            const existing = eng.countries.find((c) => c.deviceId === eng.myDeviceId);
            if (existing) {
              showToast(`⚠️ Bu cihazdan zaten "${existing.name}" kurulmuş! (1 Cihaz = 1 Ülke)`);
              eng.myCountryId = existing.id;
              centerOnCoords(existing.capitalX, existing.capitalY, 3.8);
              return;
            }
            setFoundingModal({ x: pos.x, y: pos.y });
          } else if (worldData.isLand[idx]) {
            showToast('⚠️ Bu piksel zaten başka bir devlete ait!');
          } else {
            showToast('⚠️ Deniz veya okyanusa ülke kurulamaz!');
          }
          isPaintingRef.current = false;
          return;
        }

        // Player already has country: conquer adjacent pixel
        const check = eng.canExpandToPixel(myCountry.id, pos.x, pos.y);
        if (check.valid) {
          isPaintingRef.current = true;
          eng.conquerPixel(myCountry.id, pos.x, pos.y);
        } else {
          // Dragging outside border cells pans the map smoothly!
          isPaintingRef.current = false;
        }
      }
    } else if (pointersRef.current.size === 2) {
      isPaintingRef.current = false;
      const pts = Array.from(pointersRef.current.values());
      pinchStartDistRef.current = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchStartZoomRef.current = cameraRef.current.zoom;
    }
  }, [getMapCoords, toolMode, worldData, networkInfo, showToast]);

  const handlePointerMove = useCallback((e) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const pos = getMapCoords(e.clientX, e.clientY);
    hoveredPosRef.current = pos;

    if (pointersRef.current.size === 1) {
      if (isPaintingRef.current && pos && lastCellRef.current) {
        if (pos.x !== lastCellRef.current.x || pos.y !== lastCellRef.current.y) {
          const eng = engineRef.current;
          const myCountry = eng?.getMyCountry();
          if (myCountry) {
            eng.conquerPixel(myCountry.id, pos.x, pos.y);
          }
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
        const newZoom = Math.max(0.6, Math.min(32.0, pinchStartZoomRef.current * ratio));
        cameraRef.current.zoom = newZoom;
      }
    }
  }, [getMapCoords]);

  const handlePointerUp = useCallback((e) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size === 0) {
      isMouseDownRef.current = false;
      isPaintingRef.current = false;
      lastCellRef.current = null;
    }
  }, []);

  // Non-passive wheel event listener
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.2 : 0.83;
      handleZoom(factor);
    };

    const preventContext = (e) => e.preventDefault();

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', preventContext);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', preventContext);
    };
  }, [handleZoom]);

  // 60 FPS Real-time Render & Continuous Troop Production Loop
  useEffect(() => {
    let animId;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    let lastHudSync = 0;

    const loop = (now) => {
      const dt = Math.min(0.1, (now - lastTickTimeRef.current) / 1000);
      lastTickTimeRef.current = now;

      // 1. Update continuous real-time troop generation
      if (engineRef.current) {
        engineRef.current.update(dt);
      }

      // 2. Render frame onto high-DPI viewport
      const viewW = canvas.clientWidth || window.innerWidth;
      const viewH = canvas.clientHeight || window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      if (canvas.width !== viewW * dpr || canvas.height !== viewH * dpr) {
        canvas.width = viewW * dpr;
        canvas.height = viewH * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      if (rendererRef.current && engineRef.current) {
        rendererRef.current.renderFrame(ctx, viewW, viewH, cameraRef.current, engineRef.current, {
          hoveredMapPos: hoveredPosRef.current,
          timeSec: now / 1000,
        });
      }

      ctx.restore();

      // 3. Throttle HUD state update to React (every ~180ms)
      if (now - lastHudSync > 180) {
        lastHudSync = now;
        const eng = engineRef.current;
        if (eng) {
          const myC = eng.getMyCountry();
          setHud({
            myCountry: myC ? { ...myC } : null,
            totalCountriesCount: eng.countries.length,
            time: now,
          });
        }
      }

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, []);

  const myCountry = hud.myCountry;

  const handleBuyUpgrade = useCallback((key) => {
    const eng = engineRef.current;
    const myC = eng?.getMyCountry();
    if (!eng || !myC) return;
    const res = eng.buyUpgrade(myC.id, key);
    if (!res.ok) {
      showToast(`⚠️ ${res.reason}`);
    }
  }, [showToast]);

  return (
    <div className="relative w-full h-screen overflow-hidden bg-slate-950 text-white select-none">
      {/* Hidden File Input for Image Upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileUpload}
        className="hidden"
      />

      {/* SLEEK MINIMALIST TOP BAR */}
      <div className="absolute top-3 left-3 right-3 sm:left-5 sm:right-5 flex flex-wrap items-center justify-between gap-2 pointer-events-none z-10">
        <div className="pointer-events-auto bg-slate-900/90 border border-slate-700/75 backdrop-blur-md rounded-2xl px-2.5 py-2 shadow-2xl flex items-center gap-2.5 max-w-full">
          <button
            onClick={onReturnToModeSelect}
            className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
            title="Menüye Dön"
          >
            <ArrowLeft size={16} />
          </button>

          {myCountry ? (
            <div className="flex flex-wrap items-center gap-3">
              {/* Flag & Country Name */}
              <div className="flex items-center gap-2 pr-2.5 border-r border-slate-700/80">
                <div className="w-8 h-6 rounded overflow-hidden border border-amber-400/60 shadow shrink-0 bg-slate-950">
                  {myCountry.flagDataUrl && (
                    <img src={myCountry.flagDataUrl} alt="Bayrak" className="w-full h-full object-cover" />
                  )}
                </div>
                <span className="text-xs sm:text-sm font-black text-white tracking-tight">
                  {myCountry.name}
                </span>
              </div>

              {/* Clean Metrics */}
              <div className="flex flex-wrap items-center gap-3 text-xs font-bold">
                <span className="text-amber-400" title="Mevcut Asker / Maksimum Kapasite">
                  ⚔️ {myCountry.troops.toFixed(1)} / {myCountry.capacity}
                  <span className="text-emerald-400 ml-1 text-[11px]">
                    (+{(myCountry.productionRate || 0).toFixed(3)}/sn)
                  </span>
                </span>

                <span className="text-slate-300" title="Toplam Toprak (Piksel)">
                  📍 {myCountry.landCount} Piksel
                </span>

                <span className="text-sky-300 hidden sm:inline" title="Ülkende Yaşayan Halk Nüfusu">
                  👥 {Math.floor(myCountry.population || 15)} Halk
                </span>

                <span className="text-amber-300" title="Vergi Hazinesi (Geliştirmeler için kullanılır)">
                  💰 {Math.floor(myCountry.gold || 0)} Altın
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs font-bold text-amber-400 pr-2">
              <Sparkles size={15} />
              <span>Devletin Yok • Sahipsiz bir gri piksele tıkla ve kur!</span>
            </div>
          )}
        </div>

        {/* Right Controls */}
        <div className="pointer-events-auto flex items-center gap-2">
          {myCountry && (
            <button
              onClick={() => setShowUpgrades(true)}
              className="px-3.5 h-9 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs flex items-center gap-1.5 shadow-xl transition"
            >
              <span>🏛️ Geliştir</span>
            </button>
          )}

          <button
            onClick={() => setSoundEnabled((prev) => !prev)}
            className="w-9 h-9 rounded-xl bg-slate-900/85 border border-slate-700 text-slate-300 flex items-center justify-center hover:bg-slate-800 transition shadow"
            title={soundEnabled ? 'Sesi Kapat' : 'Sesi Aç'}
          >
            {soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>

          <button
            onClick={() => setShowRules(true)}
            className="w-9 h-9 rounded-xl bg-slate-900/85 border border-slate-700 text-slate-300 flex items-center justify-center hover:bg-slate-800 transition shadow"
            title="Kurallar"
          >
            <HelpCircle size={16} />
          </button>
        </div>
      </div>

      {/* FLOATING CAMERA CONTROLS */}
      <div className="absolute right-3 sm:right-5 bottom-20 flex flex-col gap-2 z-10">
        <button
          onClick={() => handleZoom(1.35)}
          className="w-10 h-10 rounded-2xl bg-slate-900/90 border border-slate-700 text-slate-200 flex items-center justify-center hover:bg-slate-800 shadow-xl transition"
          title="Yakınlaştır"
        >
          <ZoomIn size={18} />
        </button>
        <button
          onClick={() => handleZoom(0.75)}
          className="w-10 h-10 rounded-2xl bg-slate-900/90 border border-slate-700 text-slate-200 flex items-center justify-center hover:bg-slate-800 shadow-xl transition"
          title="Uzaklaştır"
        >
          <ZoomOut size={18} />
        </button>
        <button
          onClick={() => {
            if (myCountry) centerOnCoords(myCountry.capitalX, myCountry.capitalY, 6.0);
          }}
          className="w-10 h-10 rounded-2xl bg-slate-900/90 border border-slate-700 text-amber-400 flex items-center justify-center hover:bg-slate-800 shadow-xl transition"
          title="Başkente Odaklan"
        >
          <Compass size={18} />
        </button>
      </div>

      {/* CLEAN BOTTOM TOOLBAR */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 w-full max-w-xs px-4 pointer-events-none">
        <div className="pointer-events-auto bg-slate-900/90 border border-slate-700/80 backdrop-blur-lg rounded-2xl p-1.5 shadow-2xl flex items-center justify-between gap-1.5">
          <button
            onClick={() => setToolMode('CONQUER')}
            className={`flex-1 py-2 px-3 rounded-xl font-black text-xs flex items-center justify-center gap-1.5 transition ${
              toolMode === 'CONQUER'
                ? 'bg-amber-500 text-slate-950 shadow'
                : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            <span>⚔️ Fethet</span>
          </button>

          <button
            onClick={() => setToolMode('PAN')}
            className={`flex-1 py-2 px-3 rounded-xl font-black text-xs flex items-center justify-center gap-1.5 transition ${
              toolMode === 'PAN'
                ? 'bg-indigo-500 text-white shadow'
                : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            <span>🖐️ Kaydır</span>
          </button>
        </div>
      </div>

      {/* FULLSCREEN VIEWPORT CANVAS */}
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="w-full h-full cursor-crosshair touch-none"
      />

      {/* UPGRADES MODAL */}
      {showUpgrades && myCountry && (
        <div className="absolute inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-3xl p-5 shadow-2xl text-left">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-base font-black text-white">🏛️ Devlet Geliştirmeleri</h3>
                <p className="text-[11px] text-slate-400">
                  Halkının ödediği vergilerle ({Math.floor(myCountry.gold)} 💰 Altın) devletini kalıcı olarak güçlendir.
                </p>
              </div>
              <button
                onClick={() => setShowUpgrades(false)}
                className="p-1.5 rounded-xl bg-slate-800 text-slate-400 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
              {UPGRADE_DEFINITIONS.map((def) => {
                const lvl = myCountry.upgrades?.[def.key] || 0;
                const isMax = lvl >= def.maxLevel;
                const cost = Math.round(def.baseCost * Math.pow(def.costScale, lvl));
                const canAfford = myCountry.gold >= cost && !isMax;

                return (
                  <div
                    key={def.key}
                    className="p-3 rounded-2xl bg-slate-800/80 border border-slate-700/80 flex items-center justify-between gap-3"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-black text-xs text-white">
                          {def.icon} {def.name}
                        </span>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300">
                          Sv. {lvl}/{def.maxLevel}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5">{def.desc}</p>
                    </div>

                    <button
                      disabled={!canAfford}
                      onClick={() => handleBuyUpgrade(def.key)}
                      className={`px-3 py-2 rounded-xl font-black text-xs shrink-0 transition ${
                        isMax
                          ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-600/40'
                          : canAfford
                          ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow'
                          : 'bg-slate-700/50 text-slate-500 cursor-not-allowed'
                      }`}
                    >
                      {isMax ? 'Maksimum' : `${cost} 💰`}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* FOUND COUNTRY MODAL */}
      {foundingModal && (
        <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-3xl p-5 sm:p-6 shadow-2xl text-left">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-black text-white">🏛️ Devletini Kur</h3>
              <button
                onClick={() => setFoundingModal(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-300 uppercase mb-1">
                  Ülke Adı
                </label>
                <input
                  type="text"
                  value={foundName}
                  onChange={(e) => setFoundName(e.target.value)}
                  placeholder="Devletinin Adını Yaz..."
                  className="w-full px-3.5 py-2 rounded-xl bg-slate-800 border border-slate-700 text-white font-bold text-sm focus:outline-none focus:border-amber-400"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 uppercase mb-1">
                  Özel Resim / Bayrak Yükle
                </label>
                <div className="flex items-center gap-3">
                  <div className="w-16 h-12 rounded-xl overflow-hidden border border-slate-600 bg-slate-950 flex items-center justify-center shrink-0">
                    {foundFlagDataUrl ? (
                      <img src={foundFlagDataUrl} alt="Yüklenen" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-[10px] text-slate-500 font-bold">Resim Yok</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-1 py-2 px-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs transition shadow flex items-center justify-center gap-1.5"
                  >
                    <Upload size={14} />
                    <span>Fotoğraf Seç</span>
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 uppercase mb-1.5">
                  Renk
                </label>
                <div className="flex gap-2.5">
                  {['#E11D48', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'].map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setFoundColor(c)}
                      style={{ backgroundColor: c }}
                      className={`w-7 h-7 rounded-full transition ${
                        foundColor === c ? 'ring-4 ring-white/60 scale-110' : 'opacity-80 hover:opacity-100'
                      }`}
                    />
                  ))}
                </div>
              </div>

              <div className="p-2.5 rounded-xl bg-slate-800/80 border border-slate-700 text-[11px] text-slate-300 space-y-0.5">
                <div>📍 Konum: ({foundingModal.x}, {foundingModal.y})</div>
                <div>⚔️ Başlangıç: 1 Piksel Toprak & 1 Asker Kapasitesi</div>
                <div>🖼️ Yüklediğin resim 1 pikselde bile tam çözünürlükte toprağının içinde görünür.</div>
              </div>

              <button
                type="button"
                onClick={handleConfirmFoundCountry}
                className="w-full py-3 rounded-2xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-sm transition shadow-xl"
              >
                Devletimi Kur ➔
              </button>
            </div>
          </div>
        </div>
      )}

      {/* VPN / PROXY WARNING BLOCKED MODAL */}
      {vpnBlocked && (
        <div className="absolute inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-gradient-to-b from-red-950/90 to-slate-950 border-2 border-red-500 rounded-3xl p-6 shadow-2xl text-center">
            <div className="w-16 h-16 rounded-3xl bg-red-500/20 text-red-400 flex items-center justify-center mx-auto mb-3">
              <ShieldAlert size={36} />
            </div>
            <h3 className="text-xl font-black text-white">VPN / PROXY KULLANIMI YASAK!</h3>
            <p className="text-xs text-slate-300 mt-2 leading-relaxed">
              Dünya haritasında çoklu hesap veya suistimalleri önlemek için VPN ve Proxy kullanımı yasaklanmıştır.
            </p>
            <button
              onClick={() => {
                setVpnBlocked(false);
                onReturnToModeSelect();
              }}
              className="w-full mt-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs transition"
            >
              Menüye Dön
            </button>
          </div>
        </div>
      )}

      {/* RULES MODAL */}
      {showRules && (
        <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-3xl p-6 shadow-2xl text-white">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-black text-amber-400">Dünya Haritası Kuralları</h3>
              <button onClick={() => setShowRules(false)} className="p-1 rounded-lg text-slate-400 hover:text-white">
                <X size={18} />
              </button>
            </div>
            <div className="space-y-2.5 text-xs text-slate-300 leading-relaxed">
              <div className="p-2.5 rounded-xl bg-slate-800/80 border border-slate-700">
                <div className="font-black text-white mb-0.5">⚔️ Değerli Büyüme & Asker Üretimi</div>
                <div>Her piksel değerlidir. Ülkenin asker kapasitesi toprak sayısına eşittir. Asker üretim hızı logaritmik artar; büyük devletler yüksek kapasiteye sahip olurken küçük devletler de üretim hızıyla onlara yetişebilir.</div>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-800/80 border border-slate-700">
                <div className="font-black text-white mb-0.5">👥 Halk, Altın & Geliştirmeler</div>
                <div>Topraklarında yaşayan halk zamanla çoğalır ve hazinene otomatik <b>Altın</b> vergisi öder. Biriken altınlarla <b>🏛️ Geliştir</b> menüsünden üretim hızını, saldırı/savunma gücünü ve ordu kapasiteni artırabilirsin.</div>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-800/80 border border-slate-700">
                <div className="font-black text-white mb-0.5">🖼️ Tam Çözünürlüklü Bayrak Haritası</div>
                <div>Yüklediğin resim, ülken 1 piksel bile olsa harita üzerinde toprağının tam içine yüksek çözünürlüklü olarak çizilir ve sınırların genişledikçe haritaya yayılır.</div>
              </div>
            </div>
            <button
              onClick={() => setShowRules(false)}
              className="w-full mt-4 py-2.5 rounded-xl bg-amber-500 text-slate-950 font-black text-xs hover:bg-amber-400 transition"
            >
              Anladım
            </button>
          </div>
        </div>
      )}

      {/* TOAST MESSAGE */}
      {toastMessage && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-40 bg-slate-900/95 border border-amber-400/50 text-white px-4 py-2 rounded-2xl shadow-2xl text-xs font-bold flex items-center gap-2">
          <Sparkles size={15} className="text-amber-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}
