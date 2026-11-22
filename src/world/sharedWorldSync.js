// Real-Time Cross-Device Shared World Synchronization Layer
// Uses HTTPS Cloud Pub/Sub (ntfy.sh JSON Envelope POST + 3s Active HTTPS Polling + Live SSE) + Local BroadcastChannel
// Guaranteed to sync Phone (4G/5G/Wi-Fi) and PC reliably

import { FLAG_W, FLAG_H } from './flagLibrary';

const CLOUD_TOPIC = 'sf_world_mmo_v12_global_sync';
const CLOUD_ROOT_URL = 'https://ntfy.envs.net';
const CLOUD_TOPIC_URL = `${CLOUD_ROOT_URL}/${CLOUD_TOPIC}`;

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
    this._lastPollTime = 'all';
    this._pollInterval = null;
    this._announceInterval = null;
    this._statsInterval = null;

    // Pending pixel conquest batch buffer
    this._pendingPixels = [];
    this._batchTimer = null;

    // 1. Local BroadcastChannel for instant same-browser tab sync
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel('sf_shared_world_mmo_v11');
        this.channel.onmessage = (e) => {
          this._handleRemoteMessage(e.data, false);
        };
      } catch {}
    }

    // 2. Listen to localStorage updates across tabs
    if (typeof window !== 'undefined') {
      this._storageListener = (e) => {
        if (e.key === 'sf_shared_world_v9_clean' || e.key === 'sf_my_country_id') {
          this.engine.loadState();
          this.onRemoteUpdate();
        }
      };
      window.addEventListener('storage', this._storageListener);
    }

    // 3. Start Cloud Sync (Initial History Poll + 3s Active Poll + Live SSE)
    this._initCloudSync();
  }

  getConnectedPeersCount() {
    return this.isCloudConnected ? Math.max(1, this.engine.countries.length) : 0;
  }

  _initCloudSync() {
    if (typeof window === 'undefined') return;

    // Immediate history poll
    this._pollCloudMessages();

    // Fallback poll every 15 seconds for networks where SSE is restricted
    this._pollInterval = setInterval(() => {
      this._pollCloudMessages();
    }, 15000);

    // Periodically announce our country snapshot every 16 seconds so newly opened devices always see us
    this._announceInterval = setInterval(() => {
      const myC = this.engine.getMyCountry();
      if (myC && myC.landCount > 0) {
        this.publishMyCountrySnapshot();
      }
    }, 16000);

    // Periodically broadcast our real-time troops, gold & stats every 6 seconds so all players see exact troop counts without spamming HTTP 429
    this._statsInterval = setInterval(() => {
      const myC = this.engine.getMyCountry();
      if (myC && myC.landCount > 0) {
        this.broadcast({
          type: 'SYNC_COUNTRY_STATS',
          countryId: myC.id,
          stats: {
            troops: Number(myC.troops.toFixed(1)),
            gold: Math.floor(myC.gold),
            population: Math.floor(myC.population),
            color: myC.color,
            upgrades: myC.upgrades,
          },
        });
      }
    }, 6000);

    // Live SSE stream for sub-second updates
    if (typeof EventSource !== 'undefined') {
      try {
        const es = new EventSource(`${CLOUD_TOPIC_URL}/sse`);
        this.eventSource = es;

        es.onopen = () => {
          this.isCloudConnected = true;
          this.onRemoteUpdate();
          setTimeout(() => {
            this.publishMyCountrySnapshot();
          }, 400);
        };

        es.onmessage = (ev) => {
          if (!ev || !ev.data) return;
          try {
            const env = JSON.parse(ev.data);
            if (env && env.time) {
              this._lastPollTime = env.time;
            }
            if (env && env.event === 'message' && env.message) {
              const payload = typeof env.message === 'string' ? JSON.parse(env.message) : env.message;
              this._handleRemoteMessage(payload, false);
            }
          } catch {}
        };
      } catch {}
    }
  }

  async _pollCloudMessages() {
    try {
      const url = `${CLOUD_TOPIC_URL}/json?poll=1&since=${this._lastPollTime}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return;

      const text = await res.text();
      this.isCloudConnected = true;

      if (!text || !text.trim()) return;

      let maxTime = typeof this._lastPollTime === 'number' ? this._lastPollTime : 0;
      const lines = text.split('\n');
      let anyHandled = false;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const env = JSON.parse(line);
          if (env && typeof env.time === 'number' && env.time > maxTime) {
            maxTime = env.time;
          }
          if (env && env.event === 'message' && env.message) {
            const data = typeof env.message === 'string' ? JSON.parse(env.message) : env.message;
            this._handleRemoteMessage(data, true);
            anyHandled = true;
          }
        } catch {}
      }

      if (maxTime > 0) {
        this._lastPollTime = maxTime;
      }
      if (anyHandled) {
        this.onRemoteUpdate();
      }
    } catch {}
  }

  // Synchronously convert country's decoded flagRgba buffer (or small dataUrl) into a compact <=1200 byte JPEG dataUrl
  getCompactFlagFromCountry(country) {
    if (!country || typeof document === 'undefined') return null;
    try {
      if (country.flagRgba && country.flagRgba.length === FLAG_W * FLAG_H * 4) {
        const srcCv = document.createElement('canvas');
        srcCv.width = FLAG_W;
        srcCv.height = FLAG_H;
        const sctx = srcCv.getContext('2d');
        const imgData = sctx.createImageData(FLAG_W, FLAG_H);
        imgData.data.set(country.flagRgba);
        sctx.putImageData(imgData, 0, 0);

        const dstCv = document.createElement('canvas');
        dstCv.width = 36;
        dstCv.height = 24;
        const dctx = dstCv.getContext('2d');
        dctx.drawImage(srcCv, 0, 0, 36, 24);
        return dstCv.toDataURL('image/jpeg', 0.65);
      }
      if (country.flagDataUrl && country.flagDataUrl.length <= 1500) {
        return country.flagDataUrl;
      }
    } catch {}
    return null;
  }

  // Publish our country's current state + owned pixels to the cloud so Phone & PC always see each other
  publishMyCountrySnapshot() {
    const myC = this.engine.getMyCountry();
    if (!myC || myC.landCount <= 0) return;

    const pts = this.engine.getCountryPixelCoords(myC.id, 280);
    const compactFlag = this.getCompactFlagFromCountry(myC);

    this._sendToCloud({
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

  queuePixelConquest(countryId, x, y, cost) {
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

    this._pendingPixels.push(x, y);
    if (!this._batchTimer) {
      this._batchTimer = setTimeout(() => {
        this._flushPixelBatch(countryId);
      }, 400);
    }
  }

  _flushPixelBatch(countryId) {
    this._batchTimer = null;
    if (this._pendingPixels.length === 0) return;
    const pts = this._pendingPixels.splice(0, 220);
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

    // 2. Cloud HTTPS pub/sub
    if (data.type === 'CONQUER_PIXEL') {
      this.queuePixelConquest(data.countryId, data.x, data.y, data.cost);
      return;
    }

    if (data.type === 'NEW_COUNTRY' && packet.country) {
      const fullC = this.engine.countryMap.get(packet.country.id) || packet.country;
      const compactFlag = this.getCompactFlagFromCountry(fullC);
      this._sendToCloud({
        ...packet,
        country: {
          ...packet.country,
          flagDataUrl: compactFlag,
        },
      });
      // Also send full sync packet after 1s
      setTimeout(() => {
        this.publishMyCountrySnapshot();
      }, 900);
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

    fetch(CLOUD_TOPIC_URL, {
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
      if (this.seenMsgIds.size > 800) {
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
      if (data.country.deviceId === this.engine.myDeviceId && !this.engine.myCountryId) {
        this.engine.myCountryId = data.country.id;
      }
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
    } else if (data.type === 'UNDO_PIXEL') {
      this.engine.handleRemoteUndoPixel(data.countryId, data.x, data.y, data.prevOwner);
      this.onRemoteUpdate();
    } else if (data.type === 'GLOBAL_CHAT' && data.chat) {
      this.engine.handleRemoteChatMessage(data.chat);
      this.onRemoteUpdate();
    }
  }

  sendChatMessage(text) {
    if (!text || !text.trim()) return;
    const myC = this.engine.getMyCountry();
    const chat = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      countryId: myC?.id || 0,
      countryName: myC?.name || 'Gezgin',
      countryColor: myC?.color || '#38BDF8',
      flagDataUrl: myC ? this.getCompactFlagFromCountry(myC) : null,
      text: text.trim().slice(0, 160),
      time: Date.now(),
    };
    this.engine.handleRemoteChatMessage(chat);
    this.broadcast({
      type: 'GLOBAL_CHAT',
      chat,
    });
  }
}
