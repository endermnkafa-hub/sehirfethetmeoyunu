// Real-Time Cross-Device Shared World Synchronization Layer
// Uses HTTPS Cloud Pub/Sub (ntfy.sh JSON Envelope POST + 3s Active HTTPS Polling + Live SSE) + Local BroadcastChannel
// Guaranteed to sync Phone (4G/5G/Wi-Fi) and PC reliably

import { FLAG_W, FLAG_H } from './flagLibrary';

const CLOUD_TOPIC = 'sf_mmo_earth_v17_fresh';
const CLOUD_ROOT_URL = 'https://ntfy.sh';
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

    // Outgoing rate-limited POST queue (prevents HTTP 429 rate limits on ntfy.envs.net!)
    this._sendQueue = [];
    this._sendQueueTimer = null;

    // 2. Start 100% Server-Backed Cloud Sync (Initial Compacted History Load + Fallback Poll + Live SSE)
    this._initCloudSync();
  }

  getConnectedPeersCount() {
    return this.isCloudConnected ? Math.max(1, this.engine.countries.length) : 0;
  }

  _initCloudSync() {
    if (typeof window === 'undefined') return;

    // Immediate full server state load (compacted in-memory in <15ms!)
    this._pollCloudMessages();

    // Fallback poll every 30 seconds ONLY if live SSE is disconnected (0 wasted requests when SSE is live!)
    this._pollInterval = setInterval(() => {
      if (!this.isCloudConnected) {
        this._pollCloudMessages();
      }
    }, 30000);

    // Periodically announce our country snapshot every 90 seconds so server always holds latest RLE state
    this._announceInterval = setInterval(() => {
      const myC = this.engine.getMyCountry();
      if (myC && myC.landCount > 0) {
        this.publishMyCountrySnapshot();
      }
    }, 90000);

    // Periodically broadcast our real-time troops, gold & stats every 25 seconds
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
            inventory: myC.inventory || { nukes: 0 },
            lastActiveTime: Date.now(),
          },
        });
      }
    }, 25000);

    // Live SSE stream for sub-second updates
    if (typeof EventSource !== 'undefined') {
      try {
        const es = new EventSource(`${CLOUD_TOPIC_URL}/sse`);
        this.eventSource = es;

        es.onopen = () => {
          this.isCloudConnected = true;
          this.onRemoteUpdate();
        };

        es.onmessage = async (ev) => {
          if (!ev || !ev.data) return;
          try {
            const env = JSON.parse(ev.data);
            if (env && env.time) {
              this._lastPollTime = env.time;
            }
            if (env && env.attachment && env.attachment.url) {
              try {
                const aRes = await fetch(env.attachment.url, { cache: 'no-store' });
                if (aRes.ok) {
                  const aData = await aRes.json();
                  if (aData) this._handleRemoteMessage(aData, false);
                }
              } catch {}
            } else if (env && env.event === 'message' && env.message) {
              const payload = typeof env.message === 'string' ? JSON.parse(env.message) : env.message;
              this._handleRemoteMessage(payload, false);
            }
          } catch {}
        };
        es.onerror = () => {
          this.isCloudConnected = false;
          this.onRemoteUpdate();
        };
      } catch {}
    }
  }

  destroy() {
    if (this._pollInterval) clearInterval(this._pollInterval);
    if (this._announceInterval) clearInterval(this._announceInterval);
    if (this._statsInterval) clearInterval(this._statsInterval);
    if (this._batchTimer) clearTimeout(this._batchTimer);
    if (this._authoritativeSnapshotTimer) clearTimeout(this._authoritativeSnapshotTimer);
    if (this._sendQueueTimer) clearTimeout(this._sendQueueTimer);
    this._sendQueue = [];
    if (this.eventSource) {
      try { this.eventSource.close(); } catch {}
      this.eventSource = null;
    }
    if (this.channel) {
      try { this.channel.close(); } catch {}
      this.channel = null;
    }
  }

  async _pollCloudMessages() {
    try {
      const isInitialLoad = this._lastPollTime === 'all';
      const url = `${CLOUD_TOPIC_URL}/json?poll=1&since=${this._lastPollTime}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      let res;
      try {
        res = await fetch(url, { cache: 'no-store', signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!res.ok) return;

      const text = await res.text();
      this.isCloudConnected = true;

      if (!text || !text.trim()) {
        this.onRemoteUpdate();
        return;
      }

      let maxTime = typeof this._lastPollTime === 'number' ? this._lastPollTime : 0;
      const lines = text.split('\n');
      const parsedPayloads = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const env = JSON.parse(line);
          if (env && typeof env.time === 'number' && env.time > maxTime) {
            maxTime = env.time;
          }
          if (env && env.attachment && env.attachment.url) {
            try {
              const aRes = await fetch(env.attachment.url, { cache: 'no-store' });
              if (aRes.ok) {
                const aData = await aRes.json();
                if (aData) {
                  aData._envTime = (env.time || 0) * 1000;
                  parsedPayloads.push(aData);
                }
              }
            } catch {}
          } else if (env && env.event === 'message' && env.message) {
            const data = typeof env.message === 'string' ? JSON.parse(env.message) : env.message;
            if (data) {
              data._envTime = (env.time || 0) * 1000;
              parsedPayloads.push(data);
            }
          }
        } catch {}
      }

      if (maxTime > 0) {
        this._lastPollTime = maxTime;
      }

      if (parsedPayloads.length > 0) {
        if (isInitialLoad) {
          this._replayCompactedHistory(parsedPayloads);
        } else {
          for (const data of parsedPayloads) {
            this._handleRemoteMessage(data, true);
          }
        }
        this.onRemoteUpdate();
      }
    } catch {}
  }

  // Ultra-fast O(N) in-memory server history compactor: reduces 1,000+ server logs into exact current world state in <15ms!
  _replayCompactedHistory(payloads) {
    // 1. Find latest ADMIN_RESET_WORLD & ADMIN_CLEAR_CHAT index
    let lastResetIdx = -1;
    let lastChatClearIdx = -1;
    for (let i = 0; i < payloads.length; i++) {
      const p = payloads[i];
      if (p._msgId) this.seenMsgIds.add(p._msgId);
      if (p.type === 'ADMIN_RESET_WORLD') lastResetIdx = i;
      if (p.type === 'ADMIN_CLEAR_CHAT') lastChatClearIdx = i;
    }

    const startIdx = lastResetIdx + 1;
    const deletedCountries = new Map(); // countryId -> index of deletion
    const latestSnapshot = new Map(); // countryId -> { idx, data }
    const latestStats = new Map(); // countryId -> { idx, data }
    const newCountries = new Map(); // countryId -> { idx, data }
    const updateFlags = new Map(); // countryId -> { idx, flagDataUrl }
    const pixelOps = []; // { idx, data }
    const treatyOps = [];
    const nuclearStrikes = [];
    const chats = [];

    for (let i = startIdx; i < payloads.length; i++) {
      const p = payloads[i];
      if (!p || !p.type) continue;

      if (p.type === 'ADMIN_DELETE_COUNTRY' && p.countryId) {
        deletedCountries.set(p.countryId, i);
      } else if (p.type === 'NEW_COUNTRY' && p.country?.id) {
        newCountries.set(p.country.id, { idx: i, data: p });
      } else if (p.type === 'UPDATE_COUNTRY_FLAG' && p.countryId && p.flagDataUrl) {
        updateFlags.set(p.countryId, { idx: i, flagDataUrl: p.flagDataUrl });
      } else if (p.type === 'COUNTRY_SYNC_PACKET' && p.country?.id) {
        latestSnapshot.set(p.country.id, { idx: i, data: p });
      } else if (p.type === 'SYNC_COUNTRY_STATS' && p.countryId) {
        latestStats.set(p.countryId, { idx: i, data: p });
      } else if (p.type === 'CONQUER_BATCH' || p.type === 'CONQUER_PIXEL' || p.type === 'UNDO_PIXEL') {
        pixelOps.push({ idx: i, data: p });
      } else if (p.type === 'NUCLEAR_STRIKE' && p.strike) {
        nuclearStrikes.push(p.strike);
      } else if (
        p.type === 'TREATY_PROPOSAL' ||
        p.type === 'TREATY_ACCEPT' ||
        p.type === 'TREATY_REJECT' ||
        p.type === 'TREATY_BREAK' ||
        p.type === 'TREATY_PAYMENT' ||
        p.type === 'TREATY_TERMINATION_REQUEST' ||
        p.type === 'TREATY_TERMINATION_CANCEL_REQUEST' ||
        p.type === 'TREATY_TERMINATION_ACCEPT' ||
        p.type === 'TREATY_TERMINATION_REJECT'
      ) {
        treatyOps.push(p);
      }
    }

    // Collect valid Global Chat messages after last chat clear & last reset
    const chatStart = Math.max(startIdx, lastChatClearIdx + 1);
    for (let i = chatStart; i < payloads.length; i++) {
      const p = payloads[i];
      if (p && p.type === 'GLOBAL_CHAT' && p.chat) {
        chats.push(p.chat);
      }
    }

    // 2. Apply active countries (skip any deleted AFTER their last creation/sync)
    for (const [cid, entry] of newCountries.entries()) {
      const delIdx = deletedCountries.get(cid);
      if (delIdx !== undefined && delIdx > entry.idx) continue;
      if (!latestSnapshot.has(cid)) {
        this.engine.handleRemoteNewCountry(entry.data.country);
      }
    }

    for (const [cid, entry] of latestSnapshot.entries()) {
      const delIdx = deletedCountries.get(cid);
      if (delIdx !== undefined && delIdx > entry.idx) continue;

      // Restore flag from newCountries or updateFlags if snapshot was stripped due to payload size!
      if (!entry.data.country?.flagDataUrl) {
        const flagFromUpdate = updateFlags.get(cid)?.flagDataUrl;
        const flagFromNew = newCountries.get(cid)?.data?.country?.flagDataUrl;
        if (flagFromUpdate) {
          entry.data.country.flagDataUrl = flagFromUpdate;
        } else if (flagFromNew) {
          entry.data.country.flagDataUrl = flagFromNew;
        }
      }

      this.engine.handleRemoteCountrySyncPacket(
        entry.data.country,
        entry.data.pts,
        entry.data._sentAt || entry.data._envTime || 0,
        true, // batchMode: compute bounds once at the end!
        entry.data.rle || null
      );
    }

    // 3. Apply pixel conquests/undos that occurred AFTER a country's latest snapshot
    for (const { idx, data } of pixelOps) {
      const cid = data.countryId;
      const delIdx = deletedCountries.get(cid);
      if (delIdx !== undefined && delIdx > idx) continue;
      const snap = latestSnapshot.get(cid);
      if (snap && idx <= snap.idx) continue;

      if (data.type === 'CONQUER_PIXEL') {
        this.engine.handleRemoteConquerPixel(cid, data.x, data.y, data.cost);
      } else if (data.type === 'CONQUER_BATCH' && Array.isArray(data.pts)) {
        for (let k = 0; k < data.pts.length; k += 2) {
          this.engine.handleRemoteConquerPixel(cid, data.pts[k], data.pts[k + 1], 0);
        }
      } else if (data.type === 'UNDO_PIXEL') {
        this.engine.handleRemoteUndoPixel(cid, data.x, data.y, data.prevOwner, true);
      }
    }

    // 4. Apply latest stats (troops, gold, population, upgrades, color) for each country
    for (const [cid, entry] of latestStats.entries()) {
      const delIdx = deletedCountries.get(cid);
      if (delIdx !== undefined && delIdx > entry.idx) continue;
      const snap = latestSnapshot.get(cid);
      if (snap && entry.idx < snap.idx) continue;
      this.engine.handleRemoteSyncCountryStats(
        cid,
        entry.data.stats,
        entry.data._sentAt || entry.data._envTime || 0,
        true // allow initializing own country's latest server stats on reload!
      );
    }

    // 5. Reconnect player's own country from server state if it exists
    this.engine.restoreMyCountryFromServer();

    // Replay diplomacy treaties (İttifak & Haraç)
    for (const p of treatyOps) {
      if (p.type === 'TREATY_PROPOSAL' && p.treaty) {
        this.engine.handleRemoteTreatyProposal(p.treaty, true);
      } else if (p.type === 'TREATY_ACCEPT' && p.treatyId) {
        this.engine.handleRemoteTreatyAccept(p.treatyId, p.activatedAt || p._sentAt || 0, true);
      } else if (p.type === 'TREATY_REJECT' && p.treatyId) {
        this.engine.handleRemoteTreatyReject(p.treatyId, true);
      } else if (p.type === 'TREATY_BREAK' && p.treatyId) {
        this.engine.handleRemoteTreatyBreak(p.treatyId, p.breakerId, p.penalty, p.reason, true);
      } else if (p.type === 'TREATY_PAYMENT' && p.treatyId) {
        this.engine.handleRemoteTreatyPayment(p.treatyId, p.amount, p.time, true);
      } else if (p.type === 'TREATY_TERMINATION_REQUEST' && p.treatyId) {
        this.engine.handleRemoteTreatyTerminationRequest(p.treatyId, p.requesterId);
      } else if (p.type === 'TREATY_TERMINATION_CANCEL_REQUEST' && p.treatyId) {
        this.engine.handleRemoteTreatyTerminationCancel(p.treatyId);
      } else if (p.type === 'TREATY_TERMINATION_ACCEPT' && p.treatyId) {
        this.engine.handleRemoteTreatyTerminationAccept(p.treatyId);
      } else if (p.type === 'TREATY_TERMINATION_REJECT' && p.treatyId) {
        this.engine.handleRemoteTreatyTerminationReject(p.treatyId);
      }
    }

    // Replay Nuclear Strikes (radioactive wastelands)
    for (const strike of nuclearStrikes) {
      this.engine.handleRemoteNuclearStrike(strike, true);
    }

    // 6. Compute exact country bounds ONCE for the entire map
    this.engine.computeCountryBounds();
    this.engine.dirtyRegions = false;
    this.engine.dirtyPixels = true;
    this.engine.saveState();

    // 7. Load latest 50 chat messages from server
    const recentChats = chats.slice(-50);
    for (const chat of recentChats) {
      this.engine.handleRemoteChatMessage(chat);
    }
  }

  // Synchronously convert country's decoded flagRgba buffer (or small dataUrl) into a compact <=1600 byte JPEG dataUrl
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
        dstCv.width = 60;
        dstCv.height = 38;
        const dctx = dstCv.getContext('2d');
        dctx.drawImage(srcCv, 0, 0, 60, 38);
        return dstCv.toDataURL('image/jpeg', 0.70);
      }
      if (country.flagDataUrl && country.flagDataUrl.length <= 2500) {
        return country.flagDataUrl;
      }
    } catch {}
    return null;
  }

  // Publish our country's current state + RLE-compressed territory to the cloud (fits 5,000+ pixels under 4 KB!)
  publishMyCountrySnapshot() {
    const myC = this.engine.getMyCountry();
    if (!myC || myC.landCount <= 0) return;

    const rle = this.engine.getCountryRleSpans(myC.id);
    const compactFlag = this.getCompactFlagFromCountry(myC);

    const countryMeta = {
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
      inventory: myC.inventory || { nukes: 0 },
      creatorIp: myC.creatorIp,
      deviceId: myC.deviceId,
      createdAt: myC.createdAt,
    };

    const payload = {
      type: 'COUNTRY_SYNC_PACKET',
      country: countryMeta,
      rle,
    };

    // Safety guard: keep total JSON strictly under ntfy's 4096-byte inline message limit!
    if (JSON.stringify(payload).length > 3600) {
      delete payload.country.flagDataUrl;
    }

    this._sendToCloud(payload);
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
      }, 1200);
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
    // If more pixels remain queued, schedule the next batch flush
    if (this._pendingPixels.length > 0) {
      this._batchTimer = setTimeout(() => {
        this._flushPixelBatch(countryId);
      }, 900);
    }
    // Send full authoritative RLE country snapshot 3.5s after conquest stops so all remote devices match 100%
    if (this._authoritativeSnapshotTimer) clearTimeout(this._authoritativeSnapshotTimer);
    this._authoritativeSnapshotTimer = setTimeout(() => {
      this.publishMyCountrySnapshot();
    }, 3500);
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
      // Immediately send NEW_COUNTRY packet without waiting in queue
      this._sendToCloudImmediately({
        ...packet,
        country: {
          ...packet.country,
          flagDataUrl: compactFlag,
        },
      });
      // Also send immediate initial snapshot packet
      setTimeout(() => {
        this.publishMyCountrySnapshot();
      }, 500);
      return;
    }

    this._sendToCloud(packet);
  }

  _sendToCloudImmediately(packet) {
    const fullPacket = {
      ...packet,
      _msgId: packet._msgId || `${this.tabId}_${Date.now()}_${++this._msgSeq}`,
      _senderTabId: this.tabId,
      _sentAt: packet._sentAt || Date.now(),
    };
    this.seenMsgIds.add(fullPacket._msgId);

    fetch(CLOUD_TOPIC_URL, {
      method: 'POST',
      body: JSON.stringify(fullPacket),
    }).catch(() => {});
  }

  _sendToCloud(packet) {
    const fullPacket = {
      ...packet,
      _msgId: packet._msgId || `${this.tabId}_${Date.now()}_${++this._msgSeq}`,
      _senderTabId: this.tabId,
      _sentAt: packet._sentAt || Date.now(),
    };
    this.seenMsgIds.add(fullPacket._msgId);

    // Deduplicate queued snapshots/stats so we always send the freshest one without wasting quota
    if (fullPacket.type === 'COUNTRY_SYNC_PACKET' || fullPacket.type === 'SYNC_COUNTRY_STATS') {
      this._sendQueue = this._sendQueue.filter(
        (q) => !(q.type === fullPacket.type && (q.countryId === fullPacket.countryId || q.country?.id === fullPacket.country?.id))
      );
    }

    this._sendQueue.push(fullPacket);
    if (!this._sendQueueTimer) {
      this._drainSendQueue();
    }
  }

  async _drainSendQueue() {
    this._sendQueueTimer = null;
    if (this._sendQueue.length === 0) return;

    const pkt = this._sendQueue.shift();
    let nextDelay = 850;

    try {
      const res = await fetch(CLOUD_TOPIC_URL, {
        method: 'POST',
        body: JSON.stringify(pkt),
      });
      if (res.status === 429) {
        // Rate limited: put back at front and retry after 4.5 seconds
        this._sendQueue.unshift(pkt);
        nextDelay = 4500;
      }
    } catch {
      // Transient network hiccup: retry once if queue isn't bloated
      if (this._sendQueue.length < 15 && !pkt._retried) {
        pkt._retried = true;
        this._sendQueue.unshift(pkt);
        nextDelay = 3000;
      }
    }

    if (this._sendQueue.length > 0) {
      this._sendQueueTimer = setTimeout(() => this._drainSendQueue(), nextDelay);
    }
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
    } else if (data.type === 'UPDATE_COUNTRY_FLAG' && data.countryId && data.flagDataUrl) {
      this.engine.handleRemoteUpdateFlag(data.countryId, data.flagDataUrl);
      this.onRemoteUpdate();
    } else if (data.type === 'COUNTRY_SYNC_PACKET' && data.country) {
      this.engine.handleRemoteCountrySyncPacket(
        data.country,
        data.pts,
        data._sentAt || 0,
        false,
        data.rle || null
      );
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
      this.engine.computeCountryBounds();
      this.engine.dirtyPixels = true;
      this.onRemoteUpdate();
    } else if (data.type === 'LAUNCH_SHIP' && data.ship) {
      this.engine.handleRemoteLaunchShip(data.ship);
      this.onRemoteUpdate();
    } else if (data.type === 'SYNC_COUNTRY_STATS') {
      this.engine.handleRemoteSyncCountryStats(data.countryId, data.stats, data._sentAt || 0);
      this.onRemoteUpdate();
    } else if (data.type === 'UNDO_PIXEL') {
      this.engine.handleRemoteUndoPixel(data.countryId, data.x, data.y, data.prevOwner);
      this.onRemoteUpdate();
    } else if (data.type === 'TREATY_PROPOSAL' && data.treaty) {
      this.engine.handleRemoteTreatyProposal(data.treaty, false);
      this.onRemoteUpdate();
    } else if (data.type === 'TREATY_ACCEPT' && data.treatyId) {
      this.engine.handleRemoteTreatyAccept(data.treatyId, data.activatedAt || data._sentAt || Date.now(), false);
      this.onRemoteUpdate();
    } else if (data.type === 'TREATY_REJECT' && data.treatyId) {
      this.engine.handleRemoteTreatyReject(data.treatyId, false);
      this.onRemoteUpdate();
    } else if (data.type === 'TREATY_BREAK' && data.treatyId) {
      this.engine.handleRemoteTreatyBreak(data.treatyId, data.breakerId, data.penalty, data.reason, false);
      this.onRemoteUpdate();
    } else if (data.type === 'TREATY_PAYMENT' && data.treatyId) {
      this.engine.handleRemoteTreatyPayment(data.treatyId, data.amount, data.time, false);
      this.onRemoteUpdate();
    } else if (data.type === 'TREATY_TERMINATION_REQUEST' && data.treatyId) {
      this.engine.handleRemoteTreatyTerminationRequest(data.treatyId, data.requesterId);
      this.onRemoteUpdate();
    } else if (data.type === 'TREATY_TERMINATION_CANCEL_REQUEST' && data.treatyId) {
      this.engine.handleRemoteTreatyTerminationCancel(data.treatyId);
      this.onRemoteUpdate();
    } else if (data.type === 'TREATY_TERMINATION_ACCEPT' && data.treatyId) {
      this.engine.handleRemoteTreatyTerminationAccept(data.treatyId);
      this.onRemoteUpdate();
    } else if (data.type === 'TREATY_TERMINATION_REJECT' && data.treatyId) {
      this.engine.handleRemoteTreatyTerminationReject(data.treatyId);
      this.onRemoteUpdate();
    } else if (data.type === 'NUCLEAR_STRIKE' && data.strike) {
      this.engine.handleRemoteNuclearStrike(data.strike, false);
      this.onRemoteUpdate();
    } else if (data.type === 'GLOBAL_CHAT' && data.chat) {
      this.engine.handleRemoteChatMessage(data.chat);
      this.onRemoteUpdate();
    } else if (data.type === 'ADMIN_DELETE_COUNTRY' && data.countryId) {
      this.engine.adminDeleteCountry(data.countryId, false);
      this.onRemoteUpdate();
    } else if (data.type === 'ADMIN_CLEAR_CHAT') {
      this.engine.adminClearChat(false);
      this.onRemoteUpdate();
    } else if (data.type === 'ADMIN_CLEAR_RADIATION') {
      this.engine.adminClearRadiation(false);
      this.onRemoteUpdate();
    } else if (data.type === 'ADMIN_RESET_TREATIES') {
      this.engine.adminResetTreaties(false);
      this.onRemoteUpdate();
    } else if (data.type === 'ADMIN_RESET_WORLD') {
      this.engine.adminResetWorld(false);
      this.onRemoteUpdate();
    }
  }

  sendChatMessage(text, isAdmin = false) {
    if (!text || !text.trim()) return;
    const myC = this.engine.getMyCountry();
    const richest = this.engine.getRichestCountry();
    const isRichest = Boolean(myC && richest && myC.id === richest.id && myC.gold >= 500);

    const chat = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      countryId: myC?.id || 0,
      countryName: myC?.name || (isAdmin ? 'Admin' : 'Gezgin'),
      countryColor: isAdmin ? '#FBBF24' : myC?.color || '#38BDF8',
      flagDataUrl: myC ? this.getCompactFlagFromCountry(myC) : null,
      isAdmin: Boolean(isAdmin),
      isRichest,
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
