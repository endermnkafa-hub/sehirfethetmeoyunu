import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import { MAP_W, MAP_H, getWorldRasterData } from "../../world/worldRasterizer";
import {
  WorldSimulationEngine,
  UPGRADE_DEFINITIONS,
} from "../../world/worldEngine";
import { WorldMapRenderer } from "../../world/worldRenderer";
import { checkNetworkAndSecurity } from "../../world/networkSecurity";
import {
  LogoSwords,
  LogoGold,
  LogoPopulation,
  LogoTerritory,
  LogoNavy,
  LogoPan,
  LogoPalette,
  LogoCitadel,
  UpgradeLogo,
} from "./GameLogos";
import { soundManager } from "../../utils/audio";
import confetti from "canvas-confetti";
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
  MessageSquare,
  Send,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Crown,
  Trash2,
  Zap,
} from "lucide-react";

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
    clientIp: "",
    isVpnOrProxy: false,
    isAdmin: false,
    hasExistingCountry: false,
    checked: false,
  });

  // Founding Modal State (when player clicks an unclaimed pixel)
  const [foundingModal, setFoundingModal] = useState(null); // { x, y }
  const [foundName, setFoundName] = useState("");
  const [foundColor, setFoundColor] = useState("#E11D48");
  const [foundFlagDataUrl, setFoundFlagDataUrl] = useState(null);

  // VPN Block Modal
  const [vpnBlocked, setVpnBlocked] = useState(false);

  // Modes & UI
  const [toolMode, setToolMode] = useState("CONQUER"); // 'CONQUER' | 'PAN'
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [showRules, setShowRules] = useState(false);
  const [showUpgrades, setShowUpgrades] = useState(false);
  const [showCountriesList, setShowCountriesList] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);
  const hasCenteredOnMyCountryRef = useRef(false);

  // Real-time HUD state
  const [hud, setHud] = useState({
    myCountry: null,
    totalCountriesCount: 0,
    connectedPeers: 0,
    isCloudConnected: false,
    time: 0,
  });

  // Global Chat State (minimized by default on mobile phones so it doesn't cover the map)
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatMinimized, setChatMinimized] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < 640 : false,
  );
  const chatBottomRef = useRef(null);

  // Mouse & Touch interaction tracking
  const hoveredPosRef = useRef(null);
  const isMouseDownRef = useRef(false);
  const isPaintingRef = useRef(false);
  const conqueredOnDownRef = useRef(false);
  const lastCellRef = useRef(null);
  const tapOriginRef = useRef({ x: 0, y: 0, moved: false, pointerCount: 0 });
  const pointersRef = useRef(new Map());
  const lastPinchDistRef = useRef(0);
  const lastPinchEndTimeRef = useRef(0);
  const lastTickTimeRef = useRef(performance.now());
  const soundEnabledRef = useRef(soundEnabled);
  const toastTimerRef = useRef(null);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  const showToast = useCallback((msg) => {
    setToastMessage(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToastMessage(null);
    }, 3400);
  }, []);

  // Initialize Engine & Renderer singleton
  if (!rendererRef.current) {
    rendererRef.current = new WorldMapRenderer(worldData);
  }
  if (!engineRef.current) {
    engineRef.current = new WorldSimulationEngine(worldData, {
      onEvent: (msg) => showToast(msg),
      onChat: (msgs) => setChatMessages([...msgs]),
      onSound: (sound) => {
        if (!soundEnabledRef.current) return;
        if (sound === "pencil") soundManager.playPencil();
        else if (sound === "celebration") {
          soundManager.playCelebration();
          try {
            confetti({ particleCount: 50, spread: 70, origin: { y: 0.6 } });
          } catch {}
        }
      },
    });
  }

  // Clean up cloud sync intervals & EventSource on unmount
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      engineRef.current?.sync?.destroy?.();
    };
  }, []);

  // Load initial chat messages on mount
  useEffect(() => {
    if (engineRef.current?.chatMessages) {
      setChatMessages([...engineRef.current.chatMessages]);
    }
  }, []);

  useEffect(() => {
    if (!chatMinimized && chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages, chatMinimized]);

  const handleSendChatMessage = useCallback(
    (e) => {
      e?.preventDefault();
      if (!chatInput.trim()) return;
      const eng = engineRef.current;
      if (!eng || !eng.sync) return;
      eng.sync.sendChatMessage(chatInput.trim(), networkInfo.isAdmin);
      setChatInput("");
    },
    [chatInput, networkInfo.isAdmin],
  );

  // Network & Security Check on Mount
  useEffect(() => {
    checkNetworkAndSecurity().then((info) => {
      setNetworkInfo({ ...info, checked: true });
      if (info.isVpnOrProxy) {
        setVpnBlocked(true);
      }
    });
  }, []);

  const getBaseScale = useCallback((viewW, viewH) => {
    return Math.max(viewW / MAP_W, (viewH * 0.68) / MAP_H);
  }, []);

  // Center camera on coordinates without drift (robust against undefined/NaN values)
  const centerOnCoords = useCallback(
    (cx, cy, targetZoom = 14.0) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const viewW = canvas.clientWidth || window.innerWidth || 800;
      const viewH = canvas.clientHeight || window.innerHeight || 600;
      const baseScale = getBaseScale(viewW, viewH) || 1.0;
      const safeZoom =
        Number.isFinite(targetZoom) && targetZoom > 0 ? targetZoom : 14.0;
      const safeX = Number.isFinite(cx) ? cx : MAP_W / 2;
      const safeY = Number.isFinite(cy) ? cy : MAP_H / 2;
      const scale = baseScale * safeZoom;

      cameraRef.current = {
        zoom: safeZoom,
        panX: (MAP_W / 2 - safeX) * scale,
        panY: (MAP_H / 2 - safeY) * scale,
      };
    },
    [getBaseScale],
  );

  // Zoom relative to viewport center without drift (up to 85x so individual pixels are large on mobile!)
  const handleZoom = useCallback((factor) => {
    const oldZoom =
      Number.isFinite(cameraRef.current.zoom) && cameraRef.current.zoom > 0
        ? cameraRef.current.zoom
        : 1.0;
    const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : 1.0;
    const newZoom = Math.max(0.8, Math.min(85.0, oldZoom * safeFactor));
    const ratio = newZoom / oldZoom;
    cameraRef.current.zoom = newZoom;
    cameraRef.current.panX = Number.isFinite(cameraRef.current.panX)
      ? cameraRef.current.panX * ratio
      : 0;
    cameraRef.current.panY = Number.isFinite(cameraRef.current.panY)
      ? cameraRef.current.panY * ratio
      : 0;
  }, []);

  // Initial center on Europe/Mediterranean; auto-focus on player's country as soon as server loads it
  useEffect(() => {
    centerOnCoords(550, 175, 2.8);
  }, [centerOnCoords]);

  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !hud.myCountry || hasCenteredOnMyCountryRef.current) return;
    hasCenteredOnMyCountryRef.current = true;
    const center = eng.getCountryCenter(hud.myCountry.id);
    centerOnCoords(center.x, center.y, 16.0);
  }, [hud.myCountry, centerOnCoords]);

  // Handle Custom Flag Upload
  const handleFileUpload = useCallback(
    (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (ev) => {
        setFoundFlagDataUrl(ev.target.result);
        showToast("Resim seçildi!");
      };
      reader.readAsDataURL(file);
    },
    [showToast],
  );

  // Found Country Confirmation
  const handleConfirmFoundCountry = useCallback(async () => {
    if (!foundingModal) return;
    if (networkInfo.isVpnOrProxy) {
      setVpnBlocked(true);
      return;
    }
    if (!foundName.trim()) {
      showToast("Lütfen bir ülke adı yazın!");
      return;
    }

    let flagUrl = foundFlagDataUrl;
    if (!flagUrl) {
      const cv = document.createElement("canvas");
      cv.width = 128;
      cv.height = 80;
      const cctx = cv.getContext("2d");
      cctx.fillStyle = foundColor || "#E11D48";
      cctx.fillRect(0, 0, 128, 80);
      cctx.fillStyle = "#FFFFFF";
      cctx.font = "900 36px Inter, sans-serif";
      cctx.textAlign = "center";
      cctx.textBaseline = "middle";
      const initial = (foundName || "D").trim().charAt(0).toUpperCase();
      cctx.fillText(initial, 64, 40);
      flagUrl = cv.toDataURL("image/png");
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
      centerOnCoords(res.country.capitalX, res.country.capitalY, 18.0);
    } else {
      showToast(res.reason || "Devlet kurulamadı.");
    }
  }, [
    foundingModal,
    networkInfo,
    foundName,
    foundColor,
    foundFlagDataUrl,
    centerOnCoords,
    showToast,
  ]);

  // Coordinate mapper from viewport to map coordinates
  const getMapCoords = useCallback(
    (clientX, clientY) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const vx = clientX - rect.left;
      const vy = clientY - rect.top;

      const viewW = canvas.clientWidth || rect.width;
      const viewH = canvas.clientHeight || rect.height;
      const baseScale = getBaseScale(viewW, viewH);
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
    },
    [getBaseScale],
  );

  // Pointer interactions (Zero-teleport per-pointer tracking, smooth pan, incremental pinch zoom & tap-to-found)
  const handlePointerDown = useCallback(
    (e) => {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {}

      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      isMouseDownRef.current = true;

      if (pointersRef.current.size === 1) {
        tapOriginRef.current = {
          x: e.clientX,
          y: e.clientY,
          moved: false,
          pointerCount: 1,
        };
      } else if (pointersRef.current.size >= 2) {
        tapOriginRef.current.pointerCount = pointersRef.current.size;
        tapOriginRef.current.moved = true;
        isPaintingRef.current = false;
        const pts = Array.from(pointersRef.current.values());
        lastPinchDistRef.current = Math.hypot(
          pts[0].x - pts[1].x,
          pts[0].y - pts[1].y,
        );
        return;
      }

      if (e.button === 2 || e.button === 1 || toolMode === "PAN") {
        isPaintingRef.current = false;
        return;
      }

      const pos = getMapCoords(e.clientX, e.clientY);
      if (pos && pos.x >= 0 && pos.x < MAP_W && pos.y >= 0 && pos.y < MAP_H) {
        lastCellRef.current = { x: pos.x, y: pos.y };

        const eng = engineRef.current;
        const myCountry = eng?.getMyCountry();

        if (!myCountry) {
          isPaintingRef.current = false;
          return;
        }

        // 6px touch-snap radius so mobile thumb taps easily hit adjacent border cells
        const smartTarget = eng.findSmartExpandTarget(
          myCountry.id,
          pos.x,
          pos.y,
          6,
        );
        if (
          smartTarget &&
          !smartTarget.check.isNaval &&
          myCountry.troops >= smartTarget.check.cost
        ) {
          isPaintingRef.current = true;
          conqueredOnDownRef.current = true;
          eng.conquerPixel(myCountry.id, smartTarget.x, smartTarget.y);
        } else {
          // If player doesn't have enough troops or touched outside border, allow smooth camera panning!
          isPaintingRef.current = false;
          conqueredOnDownRef.current = false;
        }
      }
    },
    [getMapCoords, toolMode],
  );

  const handlePointerMove = useCallback(
    (e) => {
      const pos = getMapCoords(e.clientX, e.clientY);
      if (pos) {
        hoveredPosRef.current = pos;
      }

      const prevPt = pointersRef.current.get(e.pointerId);
      if (!prevPt) return;

      const dx = e.clientX - prevPt.x;
      const dy = e.clientY - prevPt.y;
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      const distFromTap = Math.hypot(
        e.clientX - tapOriginRef.current.x,
        e.clientY - tapOriginRef.current.y,
      );
      if (distFromTap > 10) {
        tapOriginRef.current.moved = true;
      }

      if (pointersRef.current.size === 2) {
        // Incremental 2-finger pinch zoom (never jumps or teleports!)
        const pts = Array.from(pointersRef.current.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (lastPinchDistRef.current > 12 && dist > 12) {
          const stepFactor = dist / lastPinchDistRef.current;
          if (stepFactor > 0.75 && stepFactor < 1.35) {
            handleZoom(stepFactor);
          }
        }
        lastPinchDistRef.current = dist;
        lastPinchEndTimeRef.current = performance.now();
        return;
      }

      if (pointersRef.current.size === 1) {
        // Ignore single-finger pan for 140ms right after lifting a 2nd pinch finger to prevent any jump
        if (performance.now() - lastPinchEndTimeRef.current < 140) {
          return;
        }

        if (isPaintingRef.current) {
          const pos = getMapCoords(e.clientX, e.clientY);
          if (
            pos &&
            lastCellRef.current &&
            (pos.x !== lastCellRef.current.x || pos.y !== lastCellRef.current.y)
          ) {
            const eng = engineRef.current;
            const myCountry = eng?.getMyCountry();
            if (myCountry) {
              const smartTarget = eng.findSmartExpandTarget(
                myCountry.id,
                pos.x,
                pos.y,
                5,
              );
              if (smartTarget && !smartTarget.check.isNaval) {
                const res = eng.conquerPixel(
                  myCountry.id,
                  smartTarget.x,
                  smartTarget.y,
                );
                if (!res.ok) {
                  isPaintingRef.current = false;
                }
              }
            }
            lastCellRef.current = { x: pos.x, y: pos.y };
          }
        } else if (isMouseDownRef.current) {
          // Clamp per-frame delta to prevent any browser pointer spike from teleporting the camera
          if (Math.abs(dx) < 120 && Math.abs(dy) < 120) {
            cameraRef.current.panX += dx;
            cameraRef.current.panY += dy;
          }
        }
      }
    },
    [getMapCoords, handleZoom],
  );

  const handlePointerUp = useCallback(
    (e) => {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {}

      const wasCleanSingleTap =
        !tapOriginRef.current.moved &&
        tapOriginRef.current.pointerCount === 1 &&
        e.button !== 2 &&
        e.button !== 1 &&
        toolMode !== "PAN";

      const hadMultiplePointers = pointersRef.current.size >= 2;
      pointersRef.current.delete(e.pointerId);

      if (hadMultiplePointers) {
        lastPinchDistRef.current = 0;
        lastPinchEndTimeRef.current = performance.now();
      }

      const alreadyConqueredOnDown = conqueredOnDownRef.current;

      if (pointersRef.current.size === 0) {
        isMouseDownRef.current = false;
        isPaintingRef.current = false;
        conqueredOnDownRef.current = false;
        lastCellRef.current = null;
      }

      if (wasCleanSingleTap) {
        const pos = getMapCoords(e.clientX, e.clientY);
        if (!pos || pos.x < 0 || pos.x >= MAP_W || pos.y < 0 || pos.y >= MAP_H)
          return;

        const eng = engineRef.current;
        if (!eng) return;
        const myCountry = eng.getMyCountry();

        if (!myCountry) {
          const idx = pos.y * MAP_W + pos.x;
          const tappedOwnerId = eng.owners[idx];

          if (tappedOwnerId > 0) {
            const tappedCountry = eng.countryMap.get(tappedOwnerId);
            showToast(
              tappedCountry
                ? `Bu toprak "${tappedCountry.name}" devletine ait! Sahipsiz gri bir piksele dokunarak kendi devletini kurabilirsin.`
                : "Bu piksel zaten başka bir devlete ait!",
            );
            return;
          }

          if (worldData.isLand[idx] && tappedOwnerId === 0) {
            if (networkInfo.isVpnOrProxy) {
              setVpnBlocked(true);
              return;
            }
            const existing = eng.countries.find(
              (c) => c.deviceId === eng.myDeviceId && c.landCount > 0,
            );
            if (existing) {
              showToast(`Bu cihazdan zaten "${existing.name}" kurulmuş!`);
              eng.myCountryId = existing.id;
              const center = eng.getCountryCenter(existing.id);
              centerOnCoords(center.x, center.y, 16.0);
              return;
            }
            setFoundingModal({ x: pos.x, y: pos.y });
          } else {
            showToast(
              "Deniz veya okyanusa ülke kurulamaz! Gri bir kara pikseline dokun.",
            );
          }
        } else if (!alreadyConqueredOnDown) {
          const smartTarget = eng.findSmartExpandTarget(
            myCountry.id,
            pos.x,
            pos.y,
            6,
          );
          if (smartTarget) {
            const res = eng.conquerPixel(
              myCountry.id,
              smartTarget.x,
              smartTarget.y,
            );
            if (!res.ok && res.reason) {
              showToast(res.reason);
            }
          } else {
            const check = eng.canExpandToPixel(myCountry.id, pos.x, pos.y);
            if (check.valid && check.isNaval) {
              const res = eng.conquerPixel(myCountry.id, pos.x, pos.y);
              if (!res.ok && res.reason) {
                showToast(res.reason);
              }
            }
          }
        }
      }
    },
    [getMapCoords, toolMode, worldData, networkInfo, showToast, centerOnCoords],
  );

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

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", preventContext);
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", preventContext);
    };
  }, [handleZoom]);

  // 60 FPS Real-time Render & Continuous Troop Production Loop
  useEffect(() => {
    let animId;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: false });
    let lastHudSync = 0;

    const loop = (now) => {
      const dt = Math.min(0.1, (now - lastTickTimeRef.current) / 1000);
      lastTickTimeRef.current = now;

      // 1. Update continuous real-time troop generation
      if (engineRef.current) {
        engineRef.current.update(dt);
      }

      // 2. Render frame onto viewport (cap DPR on mobile screens for smooth 60 FPS)
      const viewW = canvas.clientWidth || window.innerWidth;
      const viewH = canvas.clientHeight || window.innerHeight;
      const isMobileScreen = viewW < 900 || viewH < 550;
      const dpr = isMobileScreen
        ? Math.min(window.devicePixelRatio || 1, 1.15)
        : Math.min(window.devicePixelRatio || 1, 2);

      const targetW = Math.floor(viewW * dpr);
      const targetH = Math.floor(viewH * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      if (rendererRef.current && engineRef.current) {
        rendererRef.current.renderFrame(
          ctx,
          viewW,
          viewH,
          cameraRef.current,
          engineRef.current,
          {
            hoveredMapPos: hoveredPosRef.current,
            timeSec: now / 1000,
          },
        );
      }

      ctx.restore();

      // 3. Throttle HUD state update to React (every ~220ms)
      if (now - lastHudSync > 220) {
        lastHudSync = now;
        const eng = engineRef.current;
        if (eng) {
          const myC = eng.getMyCountry();
          const cutoff = Date.now() - 5000;
          const undos = (eng.undoStack || []).filter((u) => u.time >= cutoff);
          const latestUndo = undos.length > 0 ? undos[undos.length - 1] : null;
          const undoSec = latestUndo
            ? Math.max(
                0,
                Math.ceil((5000 - (Date.now() - latestUndo.time)) / 1000),
              )
            : 0;

          const activeCountryIds = new Set();
          for (const c of eng.countries) {
            if (c.landCount > 0) activeCountryIds.add(c.id);
          }

          setHud({
            myCountry: myC ? { ...myC } : null,
            totalCountriesCount: activeCountryIds.size,
            connectedPeers: eng.sync?.getConnectedPeersCount() || 0,
            isCloudConnected: Boolean(eng.sync?.isCloudConnected),
            canUndo: undos.length > 0,
            undoSeconds: undoSec,
            time: now,
          });
        }
      }

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(animId);
    };
  }, []);

  const myCountry = hud.myCountry;

  const handleBuyUpgrade = useCallback(
    (key) => {
      const eng = engineRef.current;
      const myC = eng?.getMyCountry();
      if (!eng || !myC) return;
      const res = eng.buyUpgrade(myC.id, key);
      if (!res.ok) {
        showToast(res.reason);
      }
    },
    [showToast],
  );

  const handleUndo = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    const res = eng.undoLastConquest();
    if (!res.ok) {
      showToast(res.reason);
    }
  }, [showToast]);

  return (
    <div
      className="fixed inset-0 w-full h-full overflow-hidden bg-slate-950 text-white select-none touch-none"
      style={{ height: "100dvh", width: "100vw" }}
    >
      {/* Hidden File Input for Image Upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileUpload}
        className="hidden"
      />

      {/* SLEEK COMPACT TOP BAR (ERGONOMIC FOR MOBILE PORTRAIT, LANDSCAPE & DESKTOP) */}
      <div
        className="absolute top-2 sm:top-3 left-2 right-2 sm:left-4 sm:right-4 flex items-center justify-between gap-1.5 pointer-events-none z-20"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        {/* Left Country Status Pill */}
        <div className="pointer-events-auto bg-slate-900/92 border border-slate-700/80 backdrop-blur-md rounded-2xl px-2 py-1.5 shadow-2xl flex items-center gap-1.5 sm:gap-2 min-w-0 max-w-[62vw] sm:max-w-none overflow-x-auto no-scrollbar">
          <button
            onClick={onReturnToModeSelect}
            className="w-8 h-8 rounded-xl bg-slate-800 hover:bg-slate-700 active:scale-95 text-slate-300 flex items-center justify-center transition shrink-0"
            title="Menüye Dön"
          >
            <ArrowLeft size={16} />
          </button>

          {myCountry ? (
            <div className="flex items-center gap-2 sm:gap-3 shrink-0">
              {/* Flag & Country Name */}
              <div className="flex items-center gap-1.5 pr-1.5 sm:pr-2 border-r border-slate-700/80">
                <div
                  className="w-6 h-4 sm:w-7 sm:h-5 rounded overflow-hidden border-2 shadow shrink-0 bg-slate-950"
                  style={{ borderColor: myCountry.color || "#FBBF24" }}
                >
                  {myCountry.flagDataUrl && (
                    <img
                      src={myCountry.flagDataUrl}
                      alt="Bayrak"
                      className="w-full h-full object-cover"
                    />
                  )}
                </div>
                <span className="text-[11px] sm:text-sm font-black text-white tracking-tight truncate max-w-[74px] sm:max-w-[140px]">
                  {myCountry.name}
                </span>
              </div>

              {/* Clean Metrics with Vector Logos */}
              <div className="flex items-center gap-2 sm:gap-3 text-[11px] sm:text-xs font-bold">
                <span
                  className="text-amber-400 flex items-center gap-1"
                  title="Mevcut Asker / Maksimum Kapasite"
                >
                  <LogoSwords size={14} />
                  <span>
                    {Math.floor(myCountry.troops)}/{myCountry.capacity}
                  </span>
                  <span className="text-emerald-400 text-[10px] hidden md:inline">
                    (+{(myCountry.productionRate || 0).toFixed(2)}/sn)
                  </span>
                </span>

                <span
                  className="text-slate-200 flex items-center gap-1"
                  title="Toplam Toprak (Piksel)"
                >
                  <LogoTerritory size={14} />
                  <span>{myCountry.landCount}</span>
                </span>

                <span
                  className="text-sky-300 hidden lg:flex items-center gap-1"
                  title="Ülkende Yaşayan Halk Nüfusu"
                >
                  <LogoPopulation size={14} />
                  <span>{Math.floor(myCountry.population || 15)}</span>
                </span>

                <span
                  className="text-amber-300 flex items-center gap-1"
                  title="Vergi Hazinesi"
                >
                  <LogoGold size={14} />
                  <span>{Math.floor(myCountry.gold || 0)}</span>
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-[11px] sm:text-xs font-bold text-amber-400 pr-1 truncate">
              <Sparkles size={14} className="shrink-0" />
              <span className="truncate">Gri piksele dokunup devlet kur!</span>
            </div>
          )}
        </div>

        {/* Right Compact Action Buttons */}
        <div className="pointer-events-auto flex items-center gap-1 sm:gap-1.5 shrink-0">
          {networkInfo.isAdmin && (
            <button
              onClick={() => setShowAdminModal(true)}
              className="px-2 sm:px-2.5 h-9 rounded-xl bg-gradient-to-r from-rose-600 to-amber-500 hover:from-rose-500 hover:to-amber-400 active:scale-95 text-white font-black text-[11px] sm:text-xs flex items-center gap-1 shadow-xl transition"
              title="Admin Yönetim Paneli"
            >
              <Crown size={14} />
              <span className="hidden sm:inline">Admin</span>
            </button>
          )}

          <button
            onClick={() => setShowCountriesList(true)}
            className="px-2 sm:px-2.5 h-9 rounded-xl bg-slate-900/92 border border-emerald-500/45 text-emerald-300 hover:bg-slate-800 active:scale-95 font-black text-[11px] sm:text-xs flex items-center gap-1 shadow-xl transition"
            title="Haritadaki tüm devletleri gör"
          >
            <Globe size={15} />
            <span>{hud.totalCountriesCount}</span>
          </button>

          {myCountry && (
            <button
              onClick={() => setShowUpgrades(true)}
              className="px-2.5 sm:px-3 h-9 rounded-xl bg-amber-500 hover:bg-amber-400 active:scale-95 text-slate-950 font-black text-[11px] sm:text-xs flex items-center gap-1 shadow-xl transition"
              title="Devlet Geliştirmeleri"
            >
              <LogoCitadel size={15} />
              <span className="hidden xs:inline sm:inline">Geliştir</span>
            </button>
          )}

          <button
            onClick={() => setSoundEnabled((prev) => !prev)}
            className="w-9 h-9 rounded-xl bg-slate-900/90 border border-slate-700 text-slate-300 flex items-center justify-center hover:bg-slate-800 active:scale-95 transition shadow"
            title={soundEnabled ? "Sesi Kapat" : "Sesi Aç"}
          >
            {soundEnabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
          </button>

          <button
            onClick={() => setShowRules(true)}
            className="w-9 h-9 rounded-xl bg-slate-900/90 border border-slate-700 text-slate-300 flex items-center justify-center hover:bg-slate-800 active:scale-95 transition shadow"
            title="Kurallar & Ayarlar"
          >
            <HelpCircle size={15} />
          </button>
        </div>
      </div>

      {/* GLOBAL CHAT (SOL ALT KÖŞE — STANDART MMO/RTS CHAT KONUMU, HARİTAYI VEYA ÜST BARI ASLA KAPATMAZ) */}
      <div
        className={`absolute bottom-[72px] sm:bottom-4 left-2 sm:left-4 z-20 flex flex-col pointer-events-none transition-all ${
          chatMinimized ? "w-auto" : "w-[86vw] max-w-[310px] sm:max-w-xs"
        }`}
      >
        <div className="pointer-events-auto bg-slate-900/92 border border-slate-700/80 backdrop-blur-md rounded-2xl p-2 shadow-2xl transition">
          {/* Header / Toggle Pill */}
          <button
            type="button"
            onClick={() => setChatMinimized((prev) => !prev)}
            className={`w-full flex items-center justify-between gap-2 ${
              chatMinimized ? "" : "pb-1.5 border-b border-slate-700/60 mb-1.5"
            }`}
          >
            <div className="flex items-center gap-1.5 text-xs font-black text-amber-400">
              <MessageSquare size={14} className="text-amber-400 shrink-0" />
              <span>{chatMinimized ? "Sohbet" : "Global Sohbet"}</span>
              {chatMinimized && chatMessages.length > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-slate-800 text-[10px] text-slate-300 font-bold">
                  {chatMessages.length}
                </span>
              )}
              <span
                className={`w-2 h-2 rounded-full ml-0.5 shrink-0 ${
                  hud.isCloudConnected
                    ? "bg-emerald-400 animate-pulse"
                    : "bg-amber-400 animate-ping"
                }`}
                title={
                  hud.isCloudConnected
                    ? "Sunucuya Bağlı"
                    : "Sunucuya Bağlanıyor..."
                }
              />
            </div>
            <span className="p-0.5 rounded-lg bg-slate-800 text-slate-300">
              {chatMinimized ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronUp size={14} />
              )}
            </span>
          </button>

          {!chatMinimized && (
            <>
              {/* Message List */}
              <div className="max-h-36 sm:max-h-48 overflow-y-auto space-y-1.5 pr-1 text-xs">
                {chatMessages.length === 0 ? (
                  <div className="text-[11px] text-slate-400 italic py-2 text-center">
                    Henüz mesaj yok. İlk mesajı sen gönder!
                  </div>
                ) : (
                  chatMessages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`p-1.5 rounded-xl border flex flex-col gap-0.5 ${
                        msg.isAdmin
                          ? "bg-amber-500/15 border-amber-500/50"
                          : "bg-slate-800/75 border-slate-700/50"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1 text-[10px]">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {msg.flagDataUrl ? (
                            <img
                              src={msg.flagDataUrl}
                              alt=""
                              className="w-4 h-3 rounded-sm object-cover shrink-0 border"
                              style={{
                                borderColor: msg.countryColor || "#FBBF24",
                              }}
                            />
                          ) : (
                            <span
                              className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{
                                backgroundColor: msg.countryColor || "#38BDF8",
                              }}
                            />
                          )}
                          {msg.isAdmin && (
                            <span className="px-1 py-0.2 rounded bg-gradient-to-r from-rose-600 to-amber-500 text-white font-black text-[8px] shrink-0">
                              ADMIN
                            </span>
                          )}
                          <span
                            className="font-black truncate max-w-[120px]"
                            style={{ color: msg.countryColor || "#FBBF24" }}
                          >
                            {msg.countryName}
                          </span>
                        </div>
                        <span className="text-slate-400 text-[9px] shrink-0">
                          {new Date(msg.time || Date.now()).toLocaleTimeString(
                            [],
                            {
                              hour: "2-digit",
                              minute: "2-digit",
                            },
                          )}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-100 break-words pl-4">
                        {msg.text}
                      </div>
                    </div>
                  ))
                )}
                <div ref={chatBottomRef} />
              </div>

              {/* Chat Input Form */}
              <form
                onSubmit={handleSendChatMessage}
                className="mt-2 flex items-center gap-1.5"
              >
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder={
                    myCountry
                      ? `${myCountry.name} olarak yaz...`
                      : "Mesaj yaz..."
                  }
                  maxLength={140}
                  className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                />
                <button
                  type="submit"
                  disabled={!chatInput.trim()}
                  className="w-9 h-9 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:hover:bg-amber-500 text-slate-950 flex items-center justify-center transition shrink-0"
                  title="Gönder"
                >
                  <Send size={15} />
                </button>
              </form>
            </>
          )}
        </div>
      </div>

      {/* FLOATING CAMERA CONTROLS (ERGONOMIC 44px THUMB TARGETS) */}
      <div className="absolute right-2.5 sm:right-4 bottom-24 sm:bottom-24 flex flex-col gap-2 z-10">
        <button
          onClick={() => handleZoom(1.45)}
          className="w-11 h-11 rounded-2xl bg-slate-900/92 border border-slate-700/90 text-slate-100 flex items-center justify-center hover:bg-slate-800 active:scale-90 shadow-2xl transition"
          title="Yakınlaştır"
        >
          <ZoomIn size={20} />
        </button>
        <button
          onClick={() => handleZoom(0.7)}
          className="w-11 h-11 rounded-2xl bg-slate-900/92 border border-slate-700/90 text-slate-100 flex items-center justify-center hover:bg-slate-800 active:scale-90 shadow-2xl transition"
          title="Uzaklaştır"
        >
          <ZoomOut size={20} />
        </button>
        <button
          onClick={() => {
            const eng = engineRef.current;
            if (myCountry && eng) {
              const center = eng.getCountryCenter(myCountry.id);
              centerOnCoords(center.x, center.y, 16.0);
            } else {
              centerOnCoords(550, 175, 2.8);
            }
          }}
          className="w-11 h-11 rounded-2xl bg-slate-900/92 border border-amber-500/50 text-amber-400 flex items-center justify-center hover:bg-slate-800 active:scale-90 shadow-2xl transition"
          title="Ülkeme Odaklan"
        >
          <Compass size={20} />
        </button>
      </div>

      {/* ERGONOMIC BOTTOM ACTION DOCK (SAFE-AREA LOCKED FOR MOBILE WEB & ANDROID APK) */}
      <div
        className="absolute bottom-2.5 sm:bottom-4 left-1/2 -translate-x-1/2 z-10 w-full max-w-md px-2.5 pointer-events-none"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <div className="pointer-events-auto bg-slate-900/95 border border-slate-700/90 backdrop-blur-xl rounded-2xl p-1.5 shadow-2xl flex items-center justify-between gap-1.5">
          <button
            onClick={() => setToolMode("CONQUER")}
            className={`flex-1 min-h-[44px] px-2.5 rounded-xl font-black text-xs flex items-center justify-center gap-1.5 active:scale-95 transition ${
              toolMode === "CONQUER"
                ? "bg-amber-500 text-slate-950 shadow-lg"
                : "text-slate-300 hover:bg-slate-800"
            }`}
          >
            <LogoSwords size={16} />
            <span>Fethet</span>
          </button>

          {myCountry && (
            <>
              <button
                onClick={() => {
                  const eng = engineRef.current;
                  if (!eng) return;
                  const res = eng.conquerNextBorderPixel(myCountry.id);
                  if (!res.ok && res.reason) {
                    showToast(res.reason);
                  }
                }}
                className="min-h-[44px] px-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:scale-95 text-slate-950 font-black text-xs flex items-center justify-center gap-1 shadow-lg transition shrink-0"
                title="Sınırındaki en uygun komşu pikseli tek dokunuşla fetheder"
              >
                <LogoTerritory size={15} />
                <span>+1</span>
              </button>

              <button
                onClick={() => {
                  const eng = engineRef.current;
                  if (!eng) return;
                  let count = 0;
                  for (let i = 0; i < 5; i++) {
                    const res = eng.conquerNextBorderPixel(myCountry.id);
                    if (res.ok) count++;
                    else {
                      if (count === 0 && res.reason) showToast(res.reason);
                      break;
                    }
                  }
                }}
                className="min-h-[44px] px-3 rounded-xl bg-teal-400 hover:bg-teal-300 active:scale-95 text-slate-950 font-black text-xs flex items-center justify-center gap-1 shadow-lg transition shrink-0"
                title="Sınırındaki 5 komşu pikseli tek dokunuşla hızlıca fetheder"
              >
                <span>+5</span>
              </button>

              {hud.canUndo && hud.undoSeconds > 0 && (
                <button
                  onClick={handleUndo}
                  className="min-h-[44px] px-2.5 rounded-xl bg-amber-400 hover:bg-amber-300 active:scale-95 text-slate-950 font-black text-xs flex items-center justify-center gap-1 shadow-lg transition animate-pulse shrink-0"
                  title="Son 5 saniye içinde fethettiğin pikseli geri al"
                >
                  <RotateCcw size={15} />
                  <span>{hud.undoSeconds}s</span>
                </button>
              )}
            </>
          )}

          <button
            onClick={() => setToolMode("PAN")}
            className={`flex-1 min-h-[44px] px-2.5 rounded-xl font-black text-xs flex items-center justify-center gap-1.5 active:scale-95 transition ${
              toolMode === "PAN"
                ? "bg-indigo-500 text-white shadow-lg"
                : "text-slate-300 hover:bg-slate-800"
            }`}
          >
            <LogoPan size={16} />
            <span>Kaydır</span>
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
        onPointerLeave={() => {
          hoveredPosRef.current = null;
        }}
        className="w-full h-full cursor-crosshair touch-none"
      />

      {/* COUNTRIES LIST & JUMP-TO-MAP / CLAIM COUNTRY MODAL */}
      {showCountriesList && (
        <div className="absolute inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-3">
          <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-3xl p-4 sm:p-5 shadow-2xl text-left">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm sm:text-base font-black text-white flex items-center gap-2">
                  <Globe size={18} className="text-emerald-400" />
                  <span>Haritadaki Devletler ({hud.totalCountriesCount})</span>
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Haritadaki tüm aktif devletleri görebilir ve devlete
                  tıklayarak kamerasını odaklayabilirsin.
                </p>
              </div>
              <button
                onClick={() => setShowCountriesList(false)}
                className="p-1.5 rounded-xl bg-slate-800 text-slate-400 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
              {(() => {
                const uniqueCountries = [];
                const seenIds = new Set();
                for (const c of engineRef.current?.countries || []) {
                  if (c.landCount > 0 && !seenIds.has(c.id)) {
                    seenIds.add(c.id);
                    uniqueCountries.push(c);
                  }
                }
                return uniqueCountries
                  .sort((a, b) => b.landCount - a.landCount)
                  .map((c) => {
                    const isMine = myCountry && c.id === myCountry.id;

                    return (
                      <div
                        key={c.id}
                        className={`p-2.5 sm:p-3 rounded-2xl border flex items-center justify-between gap-2 ${
                          isMine
                            ? "bg-amber-500/10 border-amber-500/50"
                            : "bg-slate-800/80 border-slate-700/80"
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className="w-8 h-6 rounded overflow-hidden border-2 shrink-0 bg-slate-950"
                            style={{ borderColor: c.color || "#FBBF24" }}
                          >
                            {c.flagDataUrl && (
                              <img
                                src={c.flagDataUrl}
                                alt={c.name}
                                className="w-full h-full object-cover"
                              />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="font-black text-xs text-white flex items-center gap-1.5 truncate">
                              <span className="truncate">{c.name}</span>
                              {isMine && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500 text-slate-950 font-black shrink-0">
                                  SEN
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-400 font-bold">
                              {c.landCount} Piksel • {Math.floor(c.troops)}/
                              {c.capacity} Asker
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={() => {
                              const eng = engineRef.current;
                              if (eng) {
                                const center = eng.getCountryCenter(c.id);
                                centerOnCoords(center.x, center.y, 16.0);
                                setShowCountriesList(false);
                              }
                            }}
                            className="px-2.5 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-[11px] transition shadow"
                          >
                            Yaklaş
                          </button>
                        </div>
                      </div>
                    );
                  });
              })()}

              {(!engineRef.current?.countries ||
                engineRef.current.countries.filter((c) => c.landCount > 0)
                  .length === 0) && (
                <div className="p-6 text-center text-xs text-slate-400">
                  Henüz haritada kurulmuş bir devlet yok. Gri bir piksele
                  dokunarak ilk devleti kur!
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* UPGRADES MODAL */}
      {showUpgrades && myCountry && (
        <div className="absolute inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-3xl p-5 shadow-2xl text-left">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-base font-black text-white flex items-center gap-2">
                  <LogoCitadel size={20} />
                  <span>Devlet Geliştirmeleri (9 Dal • Max Sv.25)</span>
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5 flex items-center gap-1">
                  <span>
                    Halkının ödediği vergilerle ({Math.floor(myCountry.gold)}{" "}
                    Altın) devletini güçlendir.
                  </span>
                </p>
              </div>
              <button
                onClick={() => setShowUpgrades(false)}
                className="p-1.5 rounded-xl bg-slate-800 text-slate-400 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            {/* Live Border Color Picker */}
            <div className="mb-3 p-2.5 rounded-2xl bg-slate-800/70 border border-slate-700/80 flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                <LogoPalette size={16} />
                <span>Sınır Rengi:</span>
              </span>
              <div className="flex items-center gap-2">
                {[
                  "#E11D48",
                  "#3B82F6",
                  "#10B981",
                  "#F59E0B",
                  "#8B5CF6",
                  "#EC4899",
                  "#06B6D4",
                  "#FFFFFF",
                ].map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      engineRef.current?.setCountryColor(myCountry.id, c);
                      showToast("Sınır rengin güncellendi!");
                    }}
                    style={{ backgroundColor: c }}
                    className={`w-5 h-5 rounded-full transition ${
                      myCountry.color === c
                        ? "ring-2 ring-white scale-110"
                        : "opacity-75 hover:opacity-100"
                    }`}
                  />
                ))}
                <input
                  type="color"
                  value={myCountry.color || "#E11D48"}
                  onChange={(e) =>
                    engineRef.current?.setCountryColor(
                      myCountry.id,
                      e.target.value,
                    )
                  }
                  className="w-6 h-6 rounded cursor-pointer bg-transparent border-0"
                  title="Özel Sınır Rengi Seç"
                />
              </div>
            </div>

            <div className="space-y-2 max-h-[55vh] overflow-y-auto pr-1">
              {UPGRADE_DEFINITIONS.map((def) => {
                const lvl = myCountry.upgrades?.[def.key] || 0;
                const isMax = lvl >= def.maxLevel;
                const cost = Math.round(
                  def.baseCost * Math.pow(def.costScale, lvl),
                );
                const canAfford = myCountry.gold >= cost && !isMax;

                return (
                  <div
                    key={def.key}
                    className="p-3 rounded-2xl bg-slate-800/80 border border-slate-700/80 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-start gap-2.5 flex-1">
                      <div className="mt-0.5 shrink-0">
                        <UpgradeLogo upgradeKey={def.key} size={24} />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-black text-xs text-white">
                            {def.name}
                          </span>
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300">
                            Sv. {lvl}/{def.maxLevel}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          {def.desc}
                        </p>
                      </div>
                    </div>

                    <button
                      disabled={!canAfford}
                      onClick={() => handleBuyUpgrade(def.key)}
                      className={`px-3 py-2 rounded-xl font-black text-xs shrink-0 flex items-center gap-1 transition ${
                        isMax
                          ? "bg-emerald-950/60 text-emerald-400 border border-emerald-600/40"
                          : canAfford
                            ? "bg-amber-500 hover:bg-amber-400 text-slate-950 shadow"
                            : "bg-slate-700/50 text-slate-500 cursor-not-allowed"
                      }`}
                    >
                      {isMax ? (
                        <span>Maksimum</span>
                      ) : (
                        <>
                          <span>{cost}</span>
                          <LogoGold size={14} />
                        </>
                      )}
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
              <h3 className="text-lg font-black text-white flex items-center gap-2">
                <LogoCitadel size={22} />
                <span>Devletini Kur</span>
              </h3>
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
                      <img
                        src={foundFlagDataUrl}
                        alt="Yüklenen"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-[10px] text-slate-500 font-bold">
                        Resim Yok
                      </span>
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
                  Sınır Işıltı Rengi
                </label>
                <div className="flex items-center gap-2.5">
                  {[
                    "#E11D48",
                    "#3B82F6",
                    "#10B981",
                    "#F59E0B",
                    "#8B5CF6",
                    "#EC4899",
                    "#06B6D4",
                  ].map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setFoundColor(c)}
                      style={{ backgroundColor: c }}
                      className={`w-7 h-7 rounded-full transition ${
                        foundColor === c
                          ? "ring-4 ring-white/60 scale-110"
                          : "opacity-80 hover:opacity-100"
                      }`}
                    />
                  ))}
                  <input
                    type="color"
                    value={foundColor}
                    onChange={(e) => setFoundColor(e.target.value)}
                    className="w-7 h-7 rounded cursor-pointer bg-transparent border-0"
                    title="Özel Sınır Rengi Seç"
                  />
                </div>
              </div>

              <div className="p-2.5 rounded-xl bg-slate-800/80 border border-slate-700 text-[11px] text-slate-300 space-y-1">
                <div className="flex items-center gap-1.5">
                  <LogoTerritory size={14} />
                  <span>
                    Konum: ({foundingModal.x}, {foundingModal.y})
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <LogoSwords size={14} />
                  <span>Başlangıç: 1 Piksel Toprak & 1 Asker Kapasitesi</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <LogoNavy size={14} />
                  <span>
                    Denize kıyın olduğunda karşı kıyılara gemi gönderebilirsin.
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={handleConfirmFoundCountry}
                className="w-full py-3 rounded-2xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-sm transition shadow-xl"
              >
                Devletimi Kur
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
            <h3 className="text-xl font-black text-white">
              VPN / PROXY KULLANIMI YASAK!
            </h3>
            <p className="text-xs text-slate-300 mt-2 leading-relaxed">
              Dünya haritasında çoklu hesap veya suistimalleri önlemek için VPN
              ve Proxy kullanımı yasaklanmıştır.
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
              <h3 className="text-base font-black text-amber-400">
                Dünya Haritası Kuralları
              </h3>
              <button
                onClick={() => setShowRules(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>
            <div className="space-y-2.5 text-xs text-slate-300 leading-relaxed">
              <div className="p-2.5 rounded-xl bg-slate-800/80 border border-slate-700">
                <div className="font-black text-white mb-0.5 flex items-center gap-1.5">
                  <LogoSwords size={16} />
                  <span>Değerli Büyüme & Asker Üretimi</span>
                </div>
                <div>
                  Her piksel değerlidir. Ülkenin asker kapasitesi toprak
                  sayısına eşittir. Asker üretim hızı logaritmik artar; büyük
                  devletler yüksek kapasiteye sahip olurken küçük devletler de
                  üretim hızıyla onlara yetişebilir.
                </div>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-800/80 border border-slate-700">
                <div className="font-black text-white mb-0.5 flex items-center gap-1.5">
                  <LogoNavy size={16} />
                  <span>Deniz Aşırı Gemi Seferleri</span>
                </div>
                <div>
                  Denize kıyısı olan bir toprağın varsa, menzilin içindeki karşı
                  kıyılara veya adalara tıklayarak <b>Çıkarma Gemisi</b>{" "}
                  gönderebilirsin. Gemin denizde ilerleyip karşı kıyıya
                  ulaştığında o toprağı fetheder. <b>Donanma & Tersane</b>{" "}
                  geliştirmesiyle gemi menzilini ve hızını artırabilirsin.
                </div>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-800/80 border border-slate-700">
                <div className="font-black text-white mb-0.5 flex items-center gap-1.5">
                  <LogoGold size={16} />
                  <span>Halk, Altın & 25 Seviyeli Geliştirmeler</span>
                </div>
                <div>
                  Topraklarında yaşayan halk zamanla çoğalır ve hazinene
                  otomatik <b>Altın</b> vergisi öder. Biriken altınlarla 9
                  farklı geliştirme dalını 25. seviyeye kadar yükseltebilirsin.
                </div>
              </div>

              <div className="p-2.5 rounded-xl bg-slate-800/80 border border-slate-700">
                <div className="font-black text-amber-400 mb-0.5 flex items-center gap-1.5">
                  <Sparkles size={16} />
                  <span>Estetik Sınırlar & Otomatik Boşluk Doldurma</span>
                </div>
                <div>
                  Devletler tek piksel çizgi çekerek yılan gibi büyüyemez;
                  sınırlarını kalınlaştırarak genişlemelisin. Etrafını
                  çevrelediğin tüm iç boşluklar otomatik olarak fethedilip
                  ülkene katılır. Yanlış fethettiğin bir pikseli alt bardaki{" "}
                  <b>Geri Al (5s)</b> butonuna basarak anında geri alabilirsin.
                </div>
              </div>
            </div>

            <button
              onClick={() => setShowRules(false)}
              className="w-full mt-4 py-2.5 rounded-xl bg-amber-500 text-slate-950 font-black text-xs hover:bg-amber-400 transition"
            >
              Anladım
            </button>

            {myCountry && (
              <button
                onClick={() => {
                  if (
                    window.confirm(
                      `"${myCountry.name}" devletinin yönetimini bu cihazdan bırakmak ve haritada sıfırdan yeni bir devlet kurmak istiyor musun?`,
                    )
                  ) {
                    engineRef.current?.abandonMyCountry();
                    setShowRules(false);
                    showToast(
                      "Devlet yönetimi bırakıldı. Sahipsiz gri bir piksele dokunarak yeni devletini kurabilirsin!",
                    );
                  }
                }}
                className="w-full mt-2 py-2 rounded-xl bg-rose-500/20 border border-rose-500/50 hover:bg-rose-500/30 text-rose-300 font-bold text-[11px] transition"
              >
                Devletimi Bırak (Sıfırdan Yeni Devlet Kur)
              </button>
            )}
          </div>
        </div>
      )}

      {/* ADMIN PANEL MODAL (ONLY ACCESSIBLE FROM AUTHORIZED ADMIN IP) */}
      {showAdminModal && networkInfo.isAdmin && (
        <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3">
          <div className="w-full max-w-md bg-slate-900 border-2 border-amber-500/70 rounded-3xl p-4 sm:p-5 shadow-2xl text-left">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm sm:text-base font-black text-amber-400 flex items-center gap-2">
                  <Crown size={18} className="text-amber-400" />
                  <span>Admin Yönetim Paneli</span>
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  IP doğrulandı • Tüm işlemler anında bulut sunucusuna işlenir.
                </p>
              </div>
              <button
                onClick={() => setShowAdminModal(false)}
                className="p-1.5 rounded-xl bg-slate-800 text-slate-400 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-3 max-h-[65vh] overflow-y-auto pr-1">
              {/* Self Boost Controls */}
              {myCountry && (
                <div className="p-3 rounded-2xl bg-slate-800/80 border border-slate-700 space-y-2">
                  <div className="text-xs font-black text-amber-300 flex items-center gap-1.5">
                    <Zap size={14} />
                    <span>Kendi Devletini Güçlendir ({myCountry.name})</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() =>
                        engineRef.current?.adminGiveResources(
                          myCountry.id,
                          100,
                          5000,
                        )
                      }
                      className="py-2 px-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-[11px] transition shadow"
                    >
                      +100 Asker & +5000 Altın
                    </button>
                    <button
                      onClick={() =>
                        engineRef.current?.adminMaxUpgrades(myCountry.id)
                      }
                      className="py-2 px-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-[11px] transition shadow"
                    >
                      Tüm Geliştirmeler Sv.25
                    </button>
                  </div>
                </div>
              )}

              {/* Active Countries Moderation */}
              <div className="p-3 rounded-2xl bg-slate-800/80 border border-slate-700 space-y-2">
                <div className="text-xs font-black text-white">
                  Haritadaki Devletleri Yönet ({hud.totalCountriesCount})
                </div>
                <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                  {(engineRef.current?.countries || [])
                    .filter((c) => c.landCount > 0)
                    .sort((a, b) => b.landCount - a.landCount)
                    .map((c) => (
                      <div
                        key={c.id}
                        className="p-2 rounded-xl bg-slate-900/90 border border-slate-700/70 flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-black text-white truncate">
                            {c.name}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {c.landCount}px • {Math.floor(c.troops)} Asker
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            if (
                              window.confirm(
                                `"${c.name}" devletini haritadan tamamen silmek istiyor musun?`,
                              )
                            ) {
                              engineRef.current?.adminDeleteCountry(c.id, true);
                            }
                          }}
                          className="px-2.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-black text-[10px] flex items-center gap-1 shrink-0 transition"
                        >
                          <Trash2 size={12} />
                          <span>Sil</span>
                        </button>
                      </div>
                    ))}
                  {(!engineRef.current?.countries ||
                    engineRef.current.countries.filter((c) => c.landCount > 0)
                      .length === 0) && (
                    <div className="text-[11px] text-slate-500 text-center py-2">
                      Aktif devlet yok.
                    </div>
                  )}
                </div>
              </div>

              {/* Server Maintenance Controls */}
              <div className="p-3 rounded-2xl bg-rose-950/40 border border-rose-500/40 space-y-2">
                <div className="text-xs font-black text-rose-300">
                  Sunucu & Sohbet Kontrolleri
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => {
                      if (
                        window.confirm(
                          "Global sohbetteki tüm mesajları herkesten silmek istiyor musun?",
                        )
                      ) {
                        engineRef.current?.adminClearChat(true);
                      }
                    }}
                    className="py-2 px-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 font-bold text-[11px] transition"
                  >
                    Sohbeti Temizle
                  </button>
                  <button
                    onClick={() => {
                      if (
                        window.confirm(
                          "DİKKAT! Tüm devletler, topraklar ve sohbet herkesten sıfırlanacak. Onaylıyor musun?",
                        )
                      ) {
                        engineRef.current?.adminResetWorld(true);
                        setShowAdminModal(false);
                      }
                    }}
                    className="py-2 px-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-black text-[11px] transition shadow"
                  >
                    Tüm Haritayı Sıfırla
                  </button>
                </div>
              </div>
            </div>
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
