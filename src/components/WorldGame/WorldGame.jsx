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
      centerOnCoords(res.country.capitalX, res.country.capitalY, 4.2);
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

  const handleRecruit = useCallback((amount) => {
    const eng = engineRef.current;
    const myC = eng?.getMyCountry();
    if (!eng || !myC) return;
    const res = eng.recruitSoldiers(myC.id, amount);
    if (res.ok) {
      showToast(`📯 ${res.recruited} halk vatandaşı silah altına alındı! (-${res.goldSpent} Altın)`);
    } else {
      showToast(`⚠️ ${res.reason}`);
    }
  }, [showToast]);

  const handleDemobilize = useCallback((amount) => {
    const eng = engineRef.current;
    const myC = eng?.getMyCountry();
    if (!eng || !myC) return;
    const res = eng.demobilizeSoldiers(myC.id, amount);
    if (res.ok) {
      showToast(`🏠 ${res.demobilized} asker terhis edilip halkın arasına (üretime) döndü!`);
    } else {
      showToast(`⚠️ ${res.reason}`);
    }
  }, [showToast]);

  const handleSetTax = useCallback((level) => {
    const eng = engineRef.current;
    const myC = eng?.getMyCountry();
    if (!eng || !myC) return;
    eng.setTaxLevel(myC.id, level);
    const label = level === 'LOW' ? 'Düşük Vergi (Halk Mutlu)' : level === 'HIGH' ? 'Ağır Vergi (İsyan Riski!)' : 'Normal Vergi';
    showToast(`⚖️ Vergi Politikası: ${label}`);
  }, [showToast]);

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

      {/* TOP STATUS BAR — WORLDBOX POPULATION, TREASURY, ARMY & LOYALTY */}
      <div className="absolute top-3 left-3 right-3 sm:left-5 sm:right-5 flex flex-wrap items-start justify-between gap-2 pointer-events-none z-10">
        {/* Left: Return & Country WorldBox Dashboard */}
        <div className="pointer-events-auto bg-stone-900/95 border border-stone-700/80 backdrop-blur-md rounded-2xl p-2 sm:p-2.5 shadow-2xl flex flex-wrap items-center gap-2.5 max-w-full">
          <button
            onClick={onReturnToModeSelect}
            className="p-1.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-300 transition shrink-0"
            title="Harita Seçimine Dön"
          >
            <ArrowLeft size={16} />
          </button>

          {myCountry ? (
            <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
              {/* Flag & Name */}
              <div className="flex items-center gap-2 pr-2 border-r border-stone-700/80">
                <div className="w-9 h-7 rounded-md overflow-hidden border border-amber-400/60 shadow shrink-0 bg-stone-950">
                  {myCountry.flagDataUrl && (
                    <img src={myCountry.flagDataUrl} alt="Bayrak" className="w-full h-full object-cover" />
                  )}
                </div>
                <div>
                  <div className="text-xs sm:text-sm font-black text-white flex items-center gap-1.5">
                    <span>{myCountry.name}</span>
                    {myCountry.landCount < 60 && (
                      <span className="text-[9px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-1.5 py-0.5 rounded-full font-bold" title="Küçük Ülke Vatan Savunması Bonusu">
                        🛡️ +%45 Vatan Direnci
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-stone-400 font-bold">
                    <span>📍 {myCountry.landCount} Toprak</span>
                    <span>⚓ {myCountry.coastalCount || 0} Liman</span>
                  </div>
                </div>
              </div>

              {/* WorldBox Stats Pill Row */}
              <div className="flex flex-wrap items-center gap-2 sm:gap-2.5 text-[11px] font-bold">
                {/* Population (Halk) */}
                <div className="px-2.5 py-1 rounded-xl bg-stone-800/90 border border-stone-700 flex items-center gap-1.5" title="Çalışan Sivil Halk (Vergi üretir ve askere alınır)">
                  <span>👥</span>
                  <div>
                    <div className="text-sky-300 font-black">
                      {Math.floor(myCountry.population || 0)} / {myCountry.maxPopulation || 40} Halk
                    </div>
                    <div className="text-[9px] text-emerald-400">
                      +{(myCountry.popGrowthRate || 0).toFixed(2)}/sn doğum
                    </div>
                  </div>
                </div>

                {/* Gold Treasury (Hazine) */}
                <div className="px-2.5 py-1 rounded-xl bg-stone-800/90 border border-stone-700 flex items-center gap-1.5" title="Devlet Hazinesi (Vergi + Liman Geliri - Ordu Maaşı)">
                  <span>💰</span>
                  <div>
                    <div className="text-amber-300 font-black">
                      {Math.floor(myCountry.gold || 0)} Altın
                    </div>
                    <div className={`text-[9px] ${(myCountry.netGoldRate || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {(myCountry.netGoldRate || 0) >= 0 ? '+' : ''}
                      {(myCountry.netGoldRate || 0).toFixed(2)}/sn net
                    </div>
                  </div>
                </div>

                {/* Standing Army (Ordu) */}
                <div className="px-2.5 py-1 rounded-xl bg-stone-800/90 border border-stone-700 flex items-center gap-1.5" title="Silah Altındaki Askerler (Maaş tüketir, fetih yapar)">
                  <span>⚔️</span>
                  <div>
                    <div className="text-rose-300 font-black">
                      {myCountry.troops.toFixed(1)} / {myCountry.capacity} Asker
                    </div>
                    <div className="text-[9px] text-stone-400">
                      Maaş: -{(myCountry.armyUpkeep || 0).toFixed(2)} 💰/sn
                    </div>
                  </div>
                </div>

                {/* Loyalty & Happiness (Sadakat) */}
                <div
                  className={`px-2.5 py-1 rounded-xl border flex items-center gap-1.5 ${
                    (myCountry.loyalty || 90) <= 25
                      ? 'bg-red-950/90 border-red-500 animate-pulse'
                      : 'bg-stone-800/90 border-stone-700'
                  }`}
                  title="Halkın Sadakati (%18 altına düşerse uzak eyaletlerde WorldBox İsyanı çıkar!)"
                >
                  <span>{(myCountry.loyalty || 90) <= 25 ? '🔥' : '❤️'}</span>
                  <div>
                    <div className={`font-black ${(myCountry.loyalty || 90) <= 25 ? 'text-red-300' : (myCountry.loyalty || 90) <= 55 ? 'text-amber-300' : 'text-emerald-300'}`}>
                      %{Math.round(myCountry.loyalty ?? 95)} Sadakat
                    </div>
                    <div className="text-[9px] text-stone-400">
                      Verim: %{Math.round((myCountry.adminEfficiency || 1) * 100)}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs font-bold text-amber-400 pr-2">
              <Sparkles size={15} />
              <span>Devletin Yok • Sahipsiz bir gri piksele tıkla ve halkını kur!</span>
            </div>
          )}
        </div>

        {/* Right: Upgrades, Sound & Help */}
        <div className="pointer-events-auto flex items-center gap-2">
          {myCountry && (
            <button
              onClick={() => setShowUpgrades(true)}
              className="px-3 h-9 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-stone-950 font-black text-xs flex items-center gap-1.5 shadow-xl transition"
            >
              <span>🏛️ Geliştirmeler</span>
            </button>
          )}

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
            title="Kurallar"
          >
            <HelpCircle size={16} />
          </button>
        </div>
      </div>

      {/* FLOATING CAMERA CONTROLS */}
      <div className="absolute right-3 sm:right-5 top-24 flex flex-col gap-2 z-10">
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
            if (myCountry) centerOnCoords(myCountry.capitalX, myCountry.capitalY, 3.8);
          }}
          className="w-10 h-10 rounded-2xl bg-stone-900/90 border border-stone-700 text-amber-400 flex items-center justify-center hover:bg-stone-800 shadow-xl transition"
          title="Başkente Odaklan"
        >
          <Compass size={18} />
        </button>
      </div>

      {/* BOTTOM COMMAND & WORLDBOX CONSCRIPTION DOCK */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 w-full max-w-2xl px-3 pointer-events-none">
        <div className="pointer-events-auto bg-stone-900/95 border border-stone-700/85 backdrop-blur-lg rounded-3xl p-2.5 shadow-2xl space-y-2">
          {/* Row 1: WorldBox Conscription (Halktan Asker Eğit) & Tax Controls */}
          {myCountry && (
            <div className="flex flex-wrap items-center justify-between gap-1.5 pb-2 border-b border-stone-800">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-black uppercase tracking-wider text-stone-400 px-1">
                  📯 Askere Al:
                </span>
                <button
                  onClick={() => handleRecruit(5)}
                  className="px-2.5 py-1.5 rounded-xl bg-rose-600/90 hover:bg-rose-500 text-white font-black text-[11px] transition shadow flex items-center gap-1"
                  title="5 Sivil Halkı silah altına alır (13 Altın)"
                >
                  <span>+5 Asker</span>
                  <span className="text-[9px] text-rose-200">(13💰 5👥)</span>
                </button>
                <button
                  onClick={() => handleRecruit(25)}
                  className="px-2.5 py-1.5 rounded-xl bg-rose-600/90 hover:bg-rose-500 text-white font-black text-[11px] transition shadow flex items-center gap-1"
                  title="25 Sivil Halkı silah altına alır (63 Altın)"
                >
                  <span>+25 Asker</span>
                  <span className="text-[9px] text-rose-200">(63💰 25👥)</span>
                </button>
                <button
                  onClick={() => handleRecruit(100)}
                  className="px-2.5 py-1.5 rounded-xl bg-rose-700 hover:bg-rose-600 text-white font-black text-[11px] transition shadow flex items-center gap-1"
                  title="100 Sivil Halkı silah altına alır (250 Altın)"
                >
                  <span>+100</span>
                  <span className="text-[9px] text-rose-200">(250💰)</span>
                </button>
                <button
                  onClick={() => handleDemobilize(10)}
                  className="px-2 py-1.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-emerald-300 border border-stone-700 font-bold text-[11px] transition"
                  title="10 Askeri terhis edip tarlaya/vergi üretimine geri gönderir (Ordu maaş giderini düşürür)"
                >
                  🏠 Terhis (-10⚔️ ➔ +10👥)
                </button>
              </div>

              {/* Tax Rate Selector */}
              <div className="flex items-center gap-1 bg-stone-950/80 p-1 rounded-xl border border-stone-800">
                <span className="text-[10px] font-bold text-stone-400 px-1">Vergi:</span>
                {[
                  { id: 'LOW', label: 'Düşük' },
                  { id: 'NORMAL', label: 'Normal' },
                  { id: 'HIGH', label: 'Ağır' },
                ].map((t) => (
                  <button
                    key={t.id}
                    onClick={() => handleSetTax(t.id)}
                    className={`px-2 py-1 rounded-lg text-[10px] font-black transition ${
                      myCountry.taxLevel === t.id
                        ? t.id === 'HIGH'
                          ? 'bg-red-600 text-white'
                          : t.id === 'LOW'
                          ? 'bg-emerald-600 text-white'
                          : 'bg-amber-500 text-stone-950'
                        : 'text-stone-400 hover:text-white'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Row 2: Tool Mode Switcher */}
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={() => setToolMode('CONQUER')}
              className={`flex-1 py-2 px-3 rounded-2xl font-black text-xs sm:text-sm flex items-center justify-center gap-1.5 transition ${
                toolMode === 'CONQUER'
                  ? 'bg-amber-500 text-stone-950 shadow-lg'
                  : 'bg-stone-800/80 text-stone-300 hover:bg-stone-800'
              }`}
            >
              <span>⚔️ Fethet (Sınır Boya)</span>
            </button>

            <button
              onClick={() => setToolMode('PAN')}
              className={`flex-1 py-2 px-3 rounded-2xl font-black text-xs sm:text-sm flex items-center justify-center gap-1.5 transition ${
                toolMode === 'PAN'
                  ? 'bg-indigo-500 text-white shadow-lg'
                  : 'bg-stone-800/80 text-stone-300 hover:bg-stone-800'
              }`}
            >
              <span>🖐️ Haritayı Kaydır</span>
            </button>

            {myCountry && (
              <button
                onClick={() => setShowUpgrades(true)}
                className="py-2 px-3.5 rounded-2xl bg-stone-800 hover:bg-stone-700 border border-amber-500/40 text-amber-300 font-black text-xs sm:text-sm flex items-center gap-1.5 transition"
              >
                <span>🏛️ Teknoloji</span>
              </button>
            )}
          </div>
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

      {/* UPGRADES & STATE DOCTRINE MODAL */}
      {showUpgrades && myCountry && (
        <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-gradient-to-b from-stone-900 to-zinc-950 border-2 border-amber-500/50 rounded-3xl p-5 sm:p-6 shadow-2xl text-left">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-lg font-black text-white flex items-center gap-2">
                  <span>🏛️ Devlet & Teknoloji Geliştirmeleri</span>
                </h3>
                <p className="text-xs text-stone-400">
                  Halkından toplanan vergileri ve liman ticaret altınlarını devletini güçlendirmek için harca.
                </p>
              </div>
              <button
                onClick={() => setShowUpgrades(false)}
                className="p-1.5 rounded-xl bg-stone-800 text-stone-400 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            <div className="mb-3 px-3 py-2 rounded-2xl bg-stone-800/90 border border-stone-700 flex items-center justify-between text-xs font-bold">
              <span className="text-amber-300">💰 Mevcut Hazine: {Math.floor(myCountry.gold)} Altın</span>
              <span className="text-sky-300">⚔️ Taarruz: {(myCountry.attackPower || 1).toFixed(2)}x • 🛡️ Savunma: {(myCountry.defensePower || 1).toFixed(2)}x</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[60vh] overflow-y-auto pr-1">
              {UPGRADE_DEFINITIONS.map((def) => {
                const lvl = myCountry.upgrades?.[def.key] || 0;
                const isMax = lvl >= def.maxLevel;
                const cost = Math.round(def.baseCost * Math.pow(def.costScale, lvl));
                const canAfford = myCountry.gold >= cost && !isMax;

                return (
                  <div
                    key={def.key}
                    className="p-3 rounded-2xl bg-stone-800/75 border border-stone-700/90 flex flex-col justify-between gap-2"
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="font-black text-xs sm:text-sm text-white flex items-center gap-1.5">
                          <span>{def.icon}</span>
                          <span>{def.name}</span>
                        </span>
                        <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300">
                          Sv. {lvl}/{def.maxLevel}
                        </span>
                      </div>
                      <p className="text-[11px] text-stone-400 mt-1 leading-snug">{def.desc}</p>
                    </div>

                    <button
                      disabled={!canAfford}
                      onClick={() => handleBuyUpgrade(def.key)}
                      className={`w-full py-2 rounded-xl font-black text-xs transition ${
                        isMax
                          ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-600/40 cursor-default'
                          : canAfford
                          ? 'bg-amber-500 hover:bg-amber-400 text-stone-950 shadow-lg'
                          : 'bg-stone-700/60 text-stone-500 cursor-not-allowed'
                      }`}
                    >
                      {isMax ? '✓ Maksimum Seviye' : `Geliştir (${cost} 💰 Altın)`}
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
          <div className="w-full max-w-sm bg-gradient-to-b from-stone-900 to-zinc-950 border-2 border-amber-500/50 rounded-3xl p-5 sm:p-6 shadow-2xl text-left animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-black text-white flex items-center gap-2">
                <span>🏛️ Devletini & Halkını Kur</span>
              </h3>
              <button
                onClick={() => setFoundingModal(null)}
                className="p-1 rounded-lg text-stone-400 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-stone-300 uppercase mb-1">
                  Ülke / Devlet Adı
                </label>
                <input
                  type="text"
                  value={foundName}
                  onChange={(e) => setFoundName(e.target.value)}
                  placeholder="Devletinin Adını Yaz..."
                  className="w-full px-3.5 py-2 rounded-xl bg-stone-800 border border-stone-700 text-white font-bold text-sm focus:outline-none focus:border-amber-400"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-stone-300 uppercase mb-1">
                  Özel Resim / Bayrak Yükle
                </label>
                <div className="flex items-center gap-3">
                  <div className="w-16 h-12 rounded-xl overflow-hidden border border-stone-600 bg-stone-950 flex items-center justify-center shrink-0">
                    {foundFlagDataUrl ? (
                      <img src={foundFlagDataUrl} alt="Yüklenen" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-[10px] text-stone-500 font-bold">Resim Yok</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-1 py-2 px-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 font-black text-xs transition shadow flex items-center justify-center gap-1.5"
                  >
                    <Upload size={14} />
                    <span>Cihazdan Fotoğraf Seç</span>
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-stone-300 uppercase mb-1.5">
                  Sınır Işıltı Rengi
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

              <div className="p-2.5 rounded-xl bg-stone-800/80 border border-stone-700 text-[11px] text-stone-400 space-y-0.5">
                <div>📍 Başkent Konumu: ({foundingModal.x}, {foundingModal.y})</div>
                <div>👥 Başlangıç Halkı: 30 Vatandaş • 💰 50 Altın Hazine</div>
                <div>⚔️ Başlangıç Ordusu: 4 Hazır Muhafız (Halktan Asker Eğitilir)</div>
                <div className="text-amber-400/90 text-[10px]">
                  🛡️ WorldBox Simülasyonu: Halk vergi üretir, askere çağrılır, sadakat düşerse isyan çıkar!
                </div>
              </div>

              <button
                type="button"
                onClick={handleConfirmFoundCountry}
                className="w-full py-3 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-stone-950 font-black text-sm transition shadow-xl"
              >
                Devletimi Kur ve Başla ➔
              </button>
            </div>
          </div>
        </div>
      )}

      {/* VPN / PROXY WARNING BLOCKED MODAL */}
      {vpnBlocked && (
        <div className="absolute inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-gradient-to-b from-red-950/90 to-stone-950 border-2 border-red-500 rounded-3xl p-6 shadow-2xl text-center">
            <div className="w-16 h-16 rounded-3xl bg-red-500/20 text-red-400 flex items-center justify-center mx-auto mb-3">
              <ShieldAlert size={36} />
            </div>
            <h3 className="text-xl font-black text-white">VPN / PROXY KULLANIMI YASAK!</h3>
            <p className="text-xs text-stone-300 mt-2 leading-relaxed">
              Dünya haritası gerçek oyuncuların eşit şartlarda mücadele ettiği ortak bir arenadır. Çoklu hesap veya suistimalleri önlemek için VPN ve Proxy kullanımı yasaklanmıştır.
            </p>
            <div className="my-4 p-3 rounded-2xl bg-red-500/10 border border-red-500/30 text-xs font-bold text-red-300">
              Lütfen VPN veya Proxy bağlantınızı kapatıp sayfayı yenileyin.
            </div>
            <button
              onClick={() => {
                setVpnBlocked(false);
                onReturnToModeSelect();
              }}
              className="w-full py-2.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-white font-bold text-xs transition"
            >
              Menüye Dön
            </button>
          </div>
        </div>
      )}

      {/* RULES MODAL */}
      {showRules && (
        <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-stone-900 border border-stone-700 rounded-3xl p-6 shadow-2xl text-white">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-black text-amber-400">WorldBox Dünya Simülasyonu Kuralları</h3>
              <button onClick={() => setShowRules(false)} className="p-1 rounded-lg text-stone-400 hover:text-white">
                <X size={18} />
              </button>
            </div>
            <div className="space-y-2.5 text-xs text-stone-300 leading-relaxed max-h-[60vh] overflow-y-auto pr-1">
              <div className="p-2.5 rounded-xl bg-stone-800/80 border border-stone-700">
                <div className="font-black text-white mb-0.5">👥 Halk (Nüfus) & Vergi Ekonomisi</div>
                <div>Askerler yoktan var olmaz! Topraklarında yaşayan halk zamanla çoğalır ve çalışarak hazinene <b>Altın</b> kazandırır. Denize kıyısı olan pikseller <b>Liman (⚓)</b> sayılır ve ekstra ticaret altını getirir.</div>
              </div>
              <div className="p-2.5 rounded-xl bg-stone-800/80 border border-stone-700">
                <div className="font-black text-white mb-0.5">📯 Askere Alma & Ordu Maaşı</div>
                <div>Altın harcayarak sivil halkını <b>Askere Alırsın</b>. Ancak çok fazla vatandaşı askere alırsan tarlada çalışan halk azalır ve vergi gelirin düşer! Ayrıca silah altındaki her asker saniye başı maaş tüketir; barış zamanında askerlerini <b>Terhis Edip</b> ekonomini büyütebilirsin.</div>
              </div>
              <div className="p-2.5 rounded-xl bg-stone-800/80 border border-stone-700">
                <div className="font-black text-white mb-0.5">❤️ Sadakat, Küçük Ülke Direnci & İsyan</div>
                <div>Küçük ülkeler (+%45 Vatan Savunması) ve başkent çevresi saldırılara karşı çok daha dirençlidir. Dev imparatorluklarda ise idari yük ve ağır vergiler halkın <b>Sadakatini</b> düşürür; sadakat %18 altına inerse uzak eyaletlerde <b>İsyan</b> çıkar!</div>
              </div>
              <div className="p-2.5 rounded-xl bg-stone-800/80 border border-stone-700">
                <div className="font-black text-white mb-0.5">🏛️ Teknoloji Geliştirmeleri</div>
                <div>Biriktirdiğin altınlarla Süngü Gücü, Sınır Kaleleri, Tarım/Şehirleşme, Liman Ticareti, İmparatorluk İdaresi ve Kışla Lojistiği geliştirmelerini açabilirsin.</div>
              </div>
            </div>
            <button
              onClick={() => setShowRules(false)}
              className="w-full mt-4 py-2.5 rounded-xl bg-amber-500 text-stone-950 font-black text-xs hover:bg-amber-400 transition"
            >
              Anladım
            </button>
          </div>
        </div>
      )}

      {/* TOAST MESSAGE */}
      {toastMessage && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-40 bg-stone-900/95 border border-amber-400/50 text-white px-4 py-2 rounded-2xl shadow-2xl text-xs font-bold flex items-center gap-2 animate-bounce">
          <Sparkles size={16} className="text-amber-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}
