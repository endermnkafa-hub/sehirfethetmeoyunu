// Real-Time Cross-Device Shared World Synchronization Layer
// Uses HTTPS Cloud Pub/Sub + Persistent History (ntfy.sh SSE/REST) + Local BroadcastChannel
// Works across Phone (4G/5G/Wi-Fi) and PC without NAT blocks, even if devices open at different times!

const CLOUD_TOPIC = 'sf_world_mmo_v10_global_shared_earth';
const CLOUD_URL = `https://ntfy.sh/${CLOUD_TOPIC}`;

export class SharedWorldSync {
  constructor(engine, onRemoteUpdate) {
    this.engine = engine;
    this.onRemoteUpdate = onRemoteUpdate || (() => {});
    this.channel = null;
    this.tabId = 'tab_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);

    this.eventSource = null;
    this.isCloudConnected = false;
    this.seenMsgIds = new Set();
    this._msgSeq = 0;
    this._destroyed = false;

    // Pending pixel conquest batch buffer so dragging doesn't spam network requests
    this._pendingPixels = [];
    this._batchTimer = null;

    // 1. Local BroadcastChannel for instant same-browser tab sync
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel('sf_shared_world_mmo_v10');
        this.channel.onmessage = (e) => {
          this._handleRemoteMessage(e.data);
        };
      } catch {}
    }

    // 2. Listen to localStorage updates across tabs
    if (typeof window !== 'undefined') {
      this._storageListener = (e) => {
        if (e.key === 'sf_shared_world_v10_cloud' || e.key === 'sf_my_country_id') {
          this.engine.loadState();
          this.onRemoteUpdate();
        }
      };
      window.addEventListener('storage', this._storageListener);
    }

    // 3. Connect to Persistent Cloud Sync (Phone <-> PC over standard HTTPS)
    this._initCloudSync();
  }

  getConnectedPeersCount() {
    return this.isCloudConnected ? Math.max(1, this.engine.countries.length) : 0;
  }

  async _initCloudSync() {
    if (this._destroyed || typeof window === 'undefined') return;

    // Step A: Fetch 24h persistent cloud history immediately via HTTPS GET
    try {
      const res = await fetch(`${CLOUD_URL}/json?poll=1&since=all`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const text = await res.text();
        const lines = text.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const env = JSON.parse(line);
            if (env && env.event === 'message' && env.message) {
              const data = JSON.parse(env.message);
              this._handleRemoteMessage(data, true);
            }
          } catch {}
        }
        this.isCloudConnected = true;
        this.onRemoteUpdate();
      }
    } catch (e) {
      console.warn('Cloud history fetch warning:', e);
    }

    // Step B: Open real-time HTTPS Server-Sent Events (EventSource) stream
    if (typeof EventSource !== 'undefined' && !this._destroyed) {
      try {
        const es = new EventSource(`${CLOUD_URL}/sse`);
        this.eventSource = es;

        es.onopen = () => {
          this.isCloudConnected = true;
          this.onRemoteUpdate();
          // Announce our country to other connected devices if we have one
          this.publishMyCountrySnapshot();
        };

        es.onmessage = (ev) => {
          if (!ev || !ev.data) return;
          try {
            const env = JSON.parse(ev.data);
            if (env && env.event === 'message' && env.message) {
              const payload = JSON.parse(env.message);
              this._handleRemoteMessage(payload, false);
            }
          } catch {}
        };

        es.onerror = () => {
          this.isCloudConnected = false;
        };
      } catch (e) {
        console.warn('EventSource error:', e);
      }
    }
  }

  // Create a compact <= 1400 byte thumbnail dataUrl of a flag so it fits in fast cloud packets
  createCompactFlagUrl(flagDataUrl) {
    if (!flagDataUrl || typeof document === 'undefined') return null;
    try {
      if (flagDataUrl.length <= 1400) return flagDataUrl;
      const img = new Image();
      img.src = flagDataUrl;
      if (!img.complete || img.naturalWidth === 0) return null;
      const cv = document.createElement('canvas');
      cv.width = 36;
      cv.height = 24;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, 36, 24);
      return cv.toDataURL('image/jpeg', 0.6);
    } catch {
      return null;
    }
  }

  // Publish our country's current state + owned pixels to the cloud so other devices (Phone/PC) see it
  publishMyCountrySnapshot() {
    const myC = this.engine.getMyCountry();
    if (!myC || myC.landCount <= 0) return;

    const pts = this.engine.getCountryPixelCoords(myC.id, 350);
    const compactFlag = this.createCompactFlagUrl(myC.flagDataUrl);

    this.broadcast({
      type: 'COUNTRY_SYNC_PACKET',
      country: {
        id: myC.id,
        name: myC.name,
        color: myC.color,
        flagDataUrl: compactFlag,
        capitalX: myC.capitalX,
        capitalY: myC.capitalY,
        population: Math.round(myC.population),
        gold: Math.round(myC.gold),
        troops: Number(myC.troops.toFixed(1)),
        upgrades: myC.upgrades,
        creatorIp: myC.creatorIp,
        deviceId: myC.deviceId,
        createdAt: myC.createdAt,
      },
      pts,
    });
  }

  // Queue a pixel conquest for batched cloud broadcast (instant locally, batched every 450ms to cloud)
  queuePixelConquest(countryId, x, y, cost) {
    // 1. Instant local tab broadcast
    if (this.channel) {
      try {
        this.channel.postMessage({
          type: 'CONQUER_PIXEL',
          countryId,
          x,
          y,
          cost,
          _senderTabId: this.tabId,
        });
      } catch {}
    }

    // 2. Batch for cloud broadcast so dragging doesn't flood network
    this._pendingPixels.push(x, y);
    if (!this._batchTimer) {
      this._batchTimer = setTimeout(() => {
        this._flushPixelBatch(countryId);
      }, 450);
    }
  }

  _flushPixelBatch(countryId) {
    this._batchTimer = null;
    if (this._pendingPixels.length === 0) return;
    const pts = this._pendingPixels.splice(0, 240);
    this._sendToCloud({
      type: 'CONQUER_BATCH',
      countryId,
      pts,
    });
  }

  broadcast(data) {
    const packet = {
      ...data,
      _msgId: data._msgId || `${this.tabId}_${Date.now()}_${++this._msgSeq}`,
      _senderTabId: this.tabId,
      _senderDeviceId: this.engine.myDeviceId,
    };

    this.seenMsgIds.add(packet._msgId);

    // 1. Local browser tabs
    if (this.channel) {
      try {
        this.channel.postMessage(packet);
      } catch {}
    }

    // 2. Cloud HTTPS pub/sub for all remote devices (Phone <-> PC)
    if (data.type === 'CONQUER_PIXEL') {
      this.queuePixelConquest(data.countryId, data.x, data.y, data.cost);
      return;
    }

    if (data.type === 'NEW_COUNTRY' && packet.country) {
      const compactFlag = this.createCompactFlagUrl(packet.country.flagDataUrl);
      this._sendToCloud({
        ...packet,
        country: {
          ...packet.country,
          flagDataUrl: compactFlag,
        },
      });
      return;
    }

    this._sendToCloud(packet);
  }

  _sendToCloud(packet) {
    const fullPacket = {
      ...packet,
      _msgId: packet._msgId || `${this.tabId}_${Date.now()}_${++this._msgSeq}`,
      _senderTabId: this.tabId,
    };
    this.seenMsgIds.add(fullPacket._msgId);

    fetch(CLOUD_URL, {
      method: 'POST',
      body: JSON.stringify(fullPacket),
    }).catch(() => {});
  }

  _handleRemoteMessage(data, isHistoryReplay = false) {
    if (!data) return;
    if (!isHistoryReplay && data._senderTabId === this.tabId) return;

    if (data._msgId) {
      if (this.seenMsgIds.has(data._msgId)) return;
      this.seenMsgIds.add(data._msgId);
      if (this.seenMsgIds.size > 600) {
        const first = this.seenMsgIds.values().next().value;
        this.seenMsgIds.delete(first);
      }
    }

    if (data.type === 'NEW_COUNTRY' && data.country) {
      this.engine.handleRemoteNewCountry(data.country);
      if (data.country.deviceId === this.engine.myDeviceId && !this.engine.myCountryId) {
        this.engine.myCountryId = data.country.id;
      }
      this.onRemoteUpdate();
    } else if (data.type === 'COUNTRY_SYNC_PACKET' && data.country) {
      this.engine.handleRemoteCountrySyncPacket(data.country, data.pts);
      this.onRemoteUpdate();
    } else if (data.type === 'CONQUER_PIXEL') {
      this.engine.handleRemoteConquerPixel(data.countryId, data.x, data.y, data.cost);
      this.onRemoteUpdate();
    } else if (data.type === 'CONQUER_BATCH' && Array.isArray(data.pts)) {
      for (let i = 0; i < data.pts.length; i += 2) {
        this.engine.handleRemoteConquerPixel(data.countryId, data.pts[i], data.pts[i + 1], 0);
      }
      this.onRemoteUpdate();
    } else if (data.type === 'LAUNCH_SHIP' && data.ship) {
      this.engine.handleRemoteLaunchShip(data.ship);
      this.onRemoteUpdate();
    } else if (data.type === 'SYNC_COUNTRY_STATS') {
      this.engine.handleRemoteSyncCountryStats(data.countryId, data.stats);
      this.onRemoteUpdate();
    }
  }

  destroy() {
    this._destroyed = true;
    if (this._batchTimer) clearTimeout(this._batchTimer);
    if (this.channel) {
      try { this.channel.close(); } catch {}
    }
    if (this.eventSource) {
      try { this.eventSource.close(); } catch {}
    }
    if (typeof window !== 'undefined' && this._storageListener) {
      window.removeEventListener('storage', this._storageListener);
    }
  }
}
