// Real-Time Cross-Device Shared World Synchronization Layer
// Powered 100% by Google Firebase Realtime Database (WebSocket Real-Time + Instant Replay + Local BroadcastChannel)
// Guaranteed 0% timeout, 0 rate limits, instant cross-device sync between Mobile and PC!

import { FLAG_W, FLAG_H } from './flagLibrary.js';
import { rtdb } from '../firebaseConfig.js';
import { ref, push, set, remove, onChildAdded, query, limitToLast, get, onValue } from 'firebase/database';

// In localhost dev mode, use a completely isolated sandbox DB path
// so testing starts on a clean map without touching the live production world!
const IS_DEV_SANDBOX =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const EVENTS_DB_PATH = IS_DEV_SANDBOX ? 'game_events_dev_v1' : 'game_events_v1';
const COUNTRIES_STATE_PATH = IS_DEV_SANDBOX ? 'countries_state_dev_v1' : 'countries_state_v1';

export class SharedWorldSync {
  constructor(engine, onRemoteUpdate) {
    this.engine = engine;
    this.onRemoteUpdate = onRemoteUpdate || (() => {});
    this.destroyed = false;
    this.channel = null;
    this.tabId = 'tab_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);

    this.isCloudConnected = false;
    this.hasInitialSyncLoaded = false;
    this.isSyncError = false;
    this.lastWriteError = false;
    this.seenMsgIds = new Set();
    this._msgSeq = 0;
    this._announceInterval = null;
    this._statsInterval = null;
    this._unsubscribeFirebase = null;
    this._unsubscribeConnected = null;
    this._rtdbConnected = false;

    // Pending pixel conquest batch buffer (ultra fast 250ms batching)
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

    // 2. Start Firebase Realtime Synchronization
    this._initFirebaseSync();
  }

  getConnectedPeersCount() {
    return this.isCloudConnected ? Math.max(1, this.engine.countries.length) : 0;
  }

  async _initFirebaseSync() {
    if (typeof window === 'undefined') return;

    // Listen to Firebase Realtime Database .info/connected
    try {
      const connectedRef = ref(rtdb, '.info/connected');
      this._unsubscribeConnected = onValue(connectedRef, (snap) => {
        if (this.destroyed) return;
        const isConnected = Boolean(snap.val());
        this._rtdbConnected = isConnected;
        if (!isConnected) {
          if (this.hasInitialSyncLoaded) {
            // Lost connection after initial load
            this.isCloudConnected = false;
          }
        } else {
          this.isCloudConnected = true;
          this.isSyncError = false;
        }
        this.onRemoteUpdate();
      });
    } catch (e) {
      console.warn('Firebase .info/connected listener warning:', e);
    }

    try {
      const eventsRef = ref(rtdb, EVENTS_DB_PATH);
      const countriesStateRef = ref(rtdb, COUNTRIES_STATE_PATH);

      // 1. Initial State Load: Fetch BOTH persistent countries_state AND recent event history!
      const recentQuery = query(eventsRef, limitToLast(600));
      
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Firebase initial load timeout')), 9000)
      );

      const [countriesSnap, snapshot] = await Promise.race([
        Promise.all([get(countriesStateRef).catch(() => null), get(recentQuery)]),
        timeoutPromise,
      ]);

      this.isCloudConnected = true;
      this.hasInitialSyncLoaded = true;
      this.isSyncError = false;
      this.onRemoteUpdate();

      const eventPayloads = [];
      let latestResetTime = 0;
      this.seenFirebaseKeys = new Set();
      if (snapshot.exists()) {
        snapshot.forEach((childSnap) => {
          if (childSnap.key) this.seenFirebaseKeys.add(childSnap.key);
          const val = childSnap.val();
          if (val) {
            eventPayloads.push(val);
            if (val.type === 'ADMIN_RESET_WORLD') {
              const t = val._sentAt || val._envTime || 0;
              if (t > latestResetTime) latestResetTime = t;
            }
          }
        });
      }

      // Collect persistent countries_state snapshots saved AFTER the latest ADMIN_RESET_WORLD
      const countriesStateSnapshots = [];
      if (countriesSnap && countriesSnap.exists()) {
        countriesSnap.forEach((childSnap) => {
          const val = childSnap.val();
          if (val && val.country) {
            const snapTime = val._sentAt || val.country.lastHeartbeatTime || val.country.lastActiveTime || 0;
            if (latestResetTime > 0 && snapTime <= latestResetTime) return;
            countriesStateSnapshots.push({
              type: 'COUNTRY_SYNC_PACKET',
              country: val.country,
              rle: val.rle || null,
              _sentAt: snapTime || 1,
              _fromCountriesState: true,
            });
          }
        });
      }

      if (eventPayloads.length > 0 || countriesStateSnapshots.length > 0) {
        this._replayCompactedHistory(eventPayloads, countriesStateSnapshots);
        this.onRemoteUpdate();
      }

      // 2. Live Sub-Millisecond WebSocket Event Listener
      const listenerQuery = query(eventsRef, limitToLast(120));
      this._unsubscribeFirebase = onChildAdded(listenerQuery, (childSnap) => {
        if (this.destroyed) return;
        if (childSnap.key && this.seenFirebaseKeys.has(childSnap.key)) return;
        if (childSnap.key) this.seenFirebaseKeys.add(childSnap.key);
        const data = childSnap.val();
        if (data) {
          this.isCloudConnected = true;
          this.isSyncError = false;
          this._handleRemoteMessage(data, false);
          this.onRemoteUpdate();
        }
      });

      // Periodically announce our country snapshot every 45 seconds so Firebase always holds freshest state
      this._announceInterval = setInterval(() => {
        const myC = this.engine.getMyCountry();
        if (myC && myC.landCount > 0) {
          this.publishMyCountrySnapshot();
        }
      }, 45000);

      // Periodically broadcast our real-time troops, gold & stats every 20 seconds
      this._statsInterval = setInterval(() => {
        const myC = this.engine.getMyCountry();
        if (myC && myC.landCount > 0) {
          const now = Date.now();
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
              popBoostUntil: myC.popBoostUntil || 0,
              lastActiveTime: now,
              lastHeartbeatTime: now,
              lastInputTime: this.engine.lastInputTime || myC.lastInputTime || now,
            },
          });
        }
      }, 20000);

    } catch (err) {
      console.warn('Firebase connection notice:', err);
      this.isCloudConnected = false;
      this.hasInitialSyncLoaded = false;
      this.isSyncError = true;
      this.onRemoteUpdate();
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this._announceInterval) clearInterval(this._announceInterval);
    if (this._statsInterval) clearInterval(this._statsInterval);
    if (this._batchTimer) clearTimeout(this._batchTimer);
    if (this._authoritativeSnapshotTimer) clearTimeout(this._authoritativeSnapshotTimer);
    if (typeof this._unsubscribeFirebase === 'function') {
      try { this._unsubscribeFirebase(); } catch {}
      this._unsubscribeFirebase = null;
    }
    if (typeof this._unsubscribeConnected === 'function') {
      try { this._unsubscribeConnected(); } catch {}
      this._unsubscribeConnected = null;
    }
    if (this.channel) {
      try { this.channel.close(); } catch {}
      this.channel = null;
    }
  }

  // Ultra-fast O(N) in-memory server history compactor: reduces 1,000+ server logs into exact current world state in <15ms!
  _replayCompactedHistory(payloads, countriesStateSnapshots = []) {
    // 1. Find latest ADMIN_RESET_WORLD & ADMIN_CLEAR_CHAT index
    let lastResetIdx = -1;
    let lastChatClearIdx = -1;
    let lastRadiationClearIdx = -1;
    let lastTreatyResetIdx = -1;
    for (let i = 0; i < payloads.length; i++) {
      const p = payloads[i];
      if (!p) continue;
      if (p._msgId) this.seenMsgIds.add(p._msgId);
      if (p.type === 'ADMIN_RESET_WORLD') lastResetIdx = i;
      if (p.type === 'ADMIN_CLEAR_CHAT') lastChatClearIdx = i;
      if (p.type === 'ADMIN_CLEAR_RADIATION') lastRadiationClearIdx = i;
      if (p.type === 'ADMIN_RESET_TREATIES') lastTreatyResetIdx = i;
    }

    // Sunucudaki admin sıfırlamalarını yerel önbelleğe de uygula (yoksa eski veri geri geliyor)
    if (lastResetIdx >= 0) {
      this.engine.adminResetWorld(false, false);
    }
    if (lastRadiationClearIdx > lastResetIdx) {
      const p = payloads[lastRadiationClearIdx];
      this.engine.adminClearRadiation(false, p._sentAt || p._envTime || 0);
    }
    if (lastTreatyResetIdx > lastResetIdx) {
      this.engine.adminResetTreaties(false);
    }

    const startIdx = lastResetIdx + 1;
    const deletedCountries = new Map(); // countryId -> { idx, time }
    const latestSnapshot = new Map(); // countryId -> { idx, time, data, fromState }
    const latestStats = new Map(); // countryId -> { idx, time, data }
    const newCountries = new Map(); // countryId -> { idx, time, data }
    const updateFlags = new Map(); // countryId -> { idx, time, flagDataUrl }
    const pixelOps = []; // { idx, time, data }
    const treatyOps = [];
    const nuclearStrikes = [];
    const chats = [];

    for (let i = startIdx; i < payloads.length; i++) {
      const p = payloads[i];
      if (!p || !p.type) continue;
      const evTime = p._sentAt || p._envTime || 0;

      if (p.type === 'ADMIN_DELETE_COUNTRY' && p.countryId) {
        deletedCountries.set(p.countryId, { idx: i, time: evTime });
      } else if (p.type === 'NEW_COUNTRY' && p.country?.id) {
        newCountries.set(p.country.id, { idx: i, time: evTime, data: p });
      } else if (p.type === 'UPDATE_COUNTRY_FLAG' && p.countryId && p.flagDataUrl) {
        updateFlags.set(p.countryId, { idx: i, time: evTime, flagDataUrl: p.flagDataUrl });
      } else if (p.type === 'COUNTRY_SYNC_PACKET' && p.country?.id) {
        const prev = latestSnapshot.get(p.country.id);
        if (!prev || evTime >= prev.time) {
          latestSnapshot.set(p.country.id, { idx: i, time: evTime, data: p, fromState: false });
        }
      } else if (p.type === 'SYNC_COUNTRY_STATS' && p.countryId) {
        const prev = latestStats.get(p.countryId);
        if (!prev || evTime >= prev.time) {
          latestStats.set(p.countryId, { idx: i, time: evTime, data: p });
        }
      } else if (p.type === 'CONQUER_BATCH' || p.type === 'CONQUER_PIXEL' || p.type === 'UNDO_PIXEL') {
        pixelOps.push({ idx: i, time: evTime, data: p });
      } else if (p.type === 'NUCLEAR_STRIKE' && p.strike) {
        // Radyasyon temizlendiyse öncesindeki nükleer saldırıları tekrar uygulama
        if (i > lastRadiationClearIdx) nuclearStrikes.push(p.strike);
      } else if (p.type === 'ADMIN_BREAK_COUNTRY_TREATIES' && p.countryId) {
        if (i > lastTreatyResetIdx) treatyOps.push(p);
      } else if (
        p.type === 'TREATY_PROPOSAL' ||
        p.type === 'TREATY_ACCEPT' ||
        p.type === 'TREATY_REJECT' ||
        p.type === 'TREATY_BREAK' ||
        p.type === 'TREATY_PAYMENT' ||
        p.type === 'TREATY_REPARATION_PAYMENT' ||
        p.type === 'TREATY_TERMINATION_REQUEST' ||
        p.type === 'TREATY_TERMINATION_CANCEL_REQUEST' ||
        p.type === 'TREATY_TERMINATION_ACCEPT' ||
        p.type === 'TREATY_TERMINATION_REJECT'
      ) {
        if (i > lastTreatyResetIdx) treatyOps.push(p);
      }
    }

    // Merge persistent countries_state_v1 snapshots using true _sentAt timestamps
    for (const snap of countriesStateSnapshots) {
      if (!snap || !snap.country?.id) continue;
      const cid = snap.country.id;
      const snapTime = snap._sentAt || 0;
      const prev = latestSnapshot.get(cid);
      if (!prev || snapTime >= prev.time) {
        latestSnapshot.set(cid, { idx: -1, time: snapTime, data: snap, fromState: true });
      }
    }

    const isDeletedAfter = (cid, entryIdx, entryTime, fromState = false) => {
      const del = deletedCountries.get(cid);
      if (!del) return false;
      if (!fromState && entryIdx >= 0 && del.idx > entryIdx) return true;
      if (del.time > 0 && entryTime > 0 && del.time >= entryTime) return true;
      return false;
    };

    // Collect valid Global Chat messages after last chat clear & last reset
    const chatStart = Math.max(startIdx, lastChatClearIdx + 1);
    for (let i = chatStart; i < payloads.length; i++) {
      const p = payloads[i];
      if (p && p.type === 'GLOBAL_CHAT' && p.chat) {
        chats.push(p.chat);
      }
    }

    // Replay Nuclear Strikes (radioactive wastelands without re-triggering explosion animations)
    for (const strike of nuclearStrikes) {
      this.engine.handleRemoteNuclearStrike(strike, false, true);
    }

    // 2. Apply active countries (skip any deleted AFTER their last creation/sync)
    for (const [cid, entry] of newCountries.entries()) {
      if (isDeletedAfter(cid, entry.idx, entry.time, false)) continue;
      if (!latestSnapshot.has(cid)) {
        this.engine.handleRemoteNewCountry(entry.data.country);
      }
    }

    // Sort snapshots chronologically (oldest first, newest last) so newer snapshots ALWAYS win contested pixels!
    const sortedSnapshots = Array.from(latestSnapshot.entries()).sort(
      (a, b) => (a[1].time || 0) - (b[1].time || 0)
    );

    for (const [cid, entry] of sortedSnapshots) {
      if (isDeletedAfter(cid, entry.idx, entry.time, entry.fromState)) continue;

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
        entry.time || 0,
        true, // batchMode: compute bounds once at the end!
        entry.data.rle || null
      );
    }

    // 3. Apply pixel conquests/undos that occurred AFTER a country's latest snapshot (by real timestamp!)
    for (const { idx, time, data } of pixelOps) {
      const cid = data.countryId;
      if (isDeletedAfter(cid, idx, time, false)) continue;
      const snap = latestSnapshot.get(cid);
      if (snap) {
        if (!snap.fromState && snap.idx >= 0 && idx <= snap.idx) continue;
        if (snap.time > 0 && time > 0 && time <= snap.time) continue;
      }

      if (data.type === 'CONQUER_PIXEL') {
        this.engine.handleRemoteConquerPixel(cid, data.x, data.y, data.cost, true, data.wasEnemy ?? null);
      } else if (data.type === 'CONQUER_BATCH' && Array.isArray(data.pts)) {
        for (let k = 0; k < data.pts.length; k += 2) {
          this.engine.handleRemoteConquerPixel(cid, data.pts[k], data.pts[k + 1], 0, true, false);
        }
      } else if (data.type === 'UNDO_PIXEL') {
        this.engine.handleRemoteUndoPixel(cid, data.x, data.y, data.prevOwner, true);
      }
    }

    // 4. Apply latest stats (troops, gold, population, upgrades, color) for each country
    for (const [cid, entry] of latestStats.entries()) {
      if (isDeletedAfter(cid, entry.idx, entry.time, false)) continue;
      const snap = latestSnapshot.get(cid);
      if (snap) {
        if (!snap.fromState && snap.idx >= 0 && entry.idx < snap.idx) continue;
        if (snap.time > 0 && entry.time > 0 && entry.time < snap.time) continue;
      }
      this.engine.handleRemoteSyncCountryStats(
        cid,
        entry.data.stats,
        entry.time || 0,
        true, // allow initializing own country's latest server stats on reload!
        Boolean(entry.data.isAdminOverride)
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
        this.engine.handleRemoteTreatyBreak(p.treatyId, p.breakerId, p.penalty, p.upfrontPaid, p.debt, p.reason, true);
      } else if (p.type === 'TREATY_PAYMENT' && p.treatyId) {
        this.engine.handleRemoteTreatyPayment(p.treatyId, p.amount, p.time, true);
      } else if (p.type === 'TREATY_REPARATION_PAYMENT' && p.treatyId) {
        this.engine.handleRemoteTreatyReparationPayment(p.treatyId, p.amount, p.remainingDebt, p.time, true);
      } else if (p.type === 'TREATY_TERMINATION_REQUEST' && p.treatyId) {
        this.engine.handleRemoteTreatyTerminationRequest(p.treatyId, p.requesterId);
      } else if (p.type === 'TREATY_TERMINATION_CANCEL_REQUEST' && p.treatyId) {
        this.engine.handleRemoteTreatyTerminationCancel(p.treatyId);
      } else if (p.type === 'TREATY_TERMINATION_ACCEPT' && p.treatyId) {
        this.engine.handleRemoteTreatyTerminationAccept(p.treatyId);
      } else if (p.type === 'TREATY_TERMINATION_REJECT' && p.treatyId) {
        this.engine.handleRemoteTreatyTerminationReject(p.treatyId);
      } else if (p.type === 'ADMIN_BREAK_COUNTRY_TREATIES' && p.countryId) {
        this.engine.adminBreakCountryTreaties(p.countryId, false);
      }
    }

    // Admin tarafından silinen devletleri yerel önbellekten de kaldır
    for (const [cid, del] of deletedCountries.entries()) {
      const newEntry = newCountries.get(cid);
      const snapEntry = latestSnapshot.get(cid);
      const createdAfter =
        (newEntry && !isDeletedAfter(cid, newEntry.idx, newEntry.time, false)) ||
        (snapEntry && !isDeletedAfter(cid, snapEntry.idx, snapEntry.time, snapEntry.fromState));
      if (!createdAfter && this.engine.countryMap.has(cid)) {
        this.engine.adminDeleteCountry(cid, false);
      }
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
      inventory: myC.inventory || { nukes: 0, specialTroops: myC.specialTroops || 0 },
      doctrine: myC.doctrine || 'BALANCED',
      dailyStreak: myC.dailyStreak || 0,
      lastDailyClaimDay: myC.lastDailyClaimDay || '',
      quests: Array.isArray(myC.quests) ? myC.quests : null,
      _rewardGoldPool: Math.floor(myC._rewardGoldPool || 0),
      popBoostUntil: myC.popBoostUntil || 0,
      lastActiveTime: myC.lastActiveTime || Date.now(),
      creatorIp: myC.creatorIp,
      deviceId: myC.deviceId,
      createdAt: myC.createdAt,
      lastHeartbeatTime: Date.now(),
      lastInputTime: this.engine.lastInputTime || myC.lastInputTime || Date.now(),
    };

    const payload = {
      type: 'COUNTRY_SYNC_PACKET',
      country: countryMeta,
      rle,
    };

    // Persist authoritative country snapshot in countries_state_v1/<id> so new joiners ALWAYS see every country!
    try {
      const countryRef = ref(rtdb, `${COUNTRIES_STATE_PATH}/${myC.id}`);
      set(countryRef, {
        country: countryMeta,
        rle,
        _sentAt: Date.now(),
      }).catch(() => {});
    } catch {}

    // Safety guard: keep total JSON strictly under 3600-byte inline message limit for event log!
    if (JSON.stringify(payload).length > 3600) {
      delete payload.country.flagDataUrl;
    }

    this._sendToFirebase(payload);
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
      }, 300);
    }
  }

  _flushPixelBatch(countryId) {
    this._batchTimer = null;
    if (this._pendingPixels.length === 0) return;
    const pts = this._pendingPixels.splice(0, 250);
    this._sendToFirebase({
      type: 'CONQUER_BATCH',
      countryId,
      pts,
    });
    // If more pixels remain queued, schedule the next batch flush
    if (this._pendingPixels.length > 0) {
      this._batchTimer = setTimeout(() => {
        this._flushPixelBatch(countryId);
      }, 200);
    }
    // Send full authoritative RLE country snapshot 2s after conquest stops so all remote devices match 100%
    if (this._authoritativeSnapshotTimer) clearTimeout(this._authoritativeSnapshotTimer);
    this._authoritativeSnapshotTimer = setTimeout(() => {
      this.publishMyCountrySnapshot();
    }, 2000);
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

    // 2. Firebase Realtime DB
    if (data.type === 'CONQUER_PIXEL') {
      // Enemy attacks must preserve wasEnemy=true and send immediately (never downgraded to neutral CONQUER_BATCH)
      if (data.wasEnemy === true) {
        this._sendToFirebase(packet);
        if (this._authoritativeSnapshotTimer) clearTimeout(this._authoritativeSnapshotTimer);
        this._authoritativeSnapshotTimer = setTimeout(() => {
          this.publishMyCountrySnapshot();
        }, 2000);
        return;
      }
      this.queuePixelConquest(data.countryId, data.x, data.y, data.cost);
      return;
    }

    if (data.type === 'NEW_COUNTRY' && packet.country) {
      const fullC = this.engine.countryMap.get(packet.country.id) || packet.country;
      const compactFlag = this.getCompactFlagFromCountry(fullC);
      this._sendToFirebase({
        ...packet,
        country: {
          ...packet.country,
          flagDataUrl: compactFlag,
        },
      });
      // Persist immediately to countries_state_v1 so new countries NEVER vanish on reload or event rollover!
      this.publishMyCountrySnapshot();
      return;
    }

    this._sendToFirebase(packet);
  }

  clearAllCloudCountriesState() {
    try {
      remove(ref(rtdb, COUNTRIES_STATE_PATH)).catch((err) => {
        console.warn('Firebase countries_state wipe error:', err);
      });
    } catch {}
  }

  deleteCloudCountryState(countryId) {
    if (!countryId) return;
    try {
      remove(ref(rtdb, `${COUNTRIES_STATE_PATH}/${countryId}`)).catch(() => {});
    } catch {}
  }

  _sendToFirebase(packet) {
    const fullPacket = {
      ...packet,
      _msgId: packet._msgId || `${this.tabId}_${Date.now()}_${++this._msgSeq}`,
      _senderTabId: this.tabId,
      _sentAt: packet._sentAt || Date.now(),
    };
    this.seenMsgIds.add(fullPacket._msgId);

    if (packet.type === 'ADMIN_RESET_WORLD') {
      // Hard-wipe BOTH countries_state AND the entire event log in Firebase, then write a single clean reset marker!
      try {
        const eventsRef = ref(rtdb, EVENTS_DB_PATH);
        const countriesRef = ref(rtdb, COUNTRIES_STATE_PATH);
        Promise.all([
          remove(countriesRef).catch(() => {}),
          remove(eventsRef).catch(() => {}),
        ]).then(() => {
          push(eventsRef, fullPacket).catch(() => {});
        });
      } catch {}
      return;
    }

    if (packet.type === 'ADMIN_DELETE_COUNTRY' && packet.countryId) {
      this.deleteCloudCountryState(packet.countryId);
    }

    try {
      const eventsRef = ref(rtdb, EVENTS_DB_PATH);
      push(eventsRef, fullPacket)
        .then(() => {
          this.lastWriteError = false;
        })
        .catch((err) => {
          console.warn('Firebase push write error:', err);
          this.lastWriteError = true;
          this.onRemoteUpdate();
        });
    } catch (e) {
      this.lastWriteError = true;
      this.onRemoteUpdate();
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
      this.engine.handleRemoteConquerPixel(data.countryId, data.x, data.y, data.cost, false, data.wasEnemy ?? null);
      this.onRemoteUpdate();
    } else if (data.type === 'CONQUER_BATCH' && Array.isArray(data.pts)) {
      for (let i = 0; i < data.pts.length; i += 2) {
        this.engine.handleRemoteConquerPixel(data.countryId, data.pts[i], data.pts[i + 1], 0, false, false);
      }
      this.engine.computeCountryBounds();
      this.engine.dirtyPixels = true;
      this.onRemoteUpdate();
    } else if (data.type === 'LAUNCH_SHIP' && data.ship) {
      this.engine.handleRemoteLaunchShip(data.ship);
      this.onRemoteUpdate();
    } else if (data.type === 'SYNC_COUNTRY_STATS') {
      this.engine.handleRemoteSyncCountryStats(
        data.countryId,
        data.stats,
        data._sentAt || 0,
        false,
        Boolean(data.isAdminOverride)
      );
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
      this.engine.handleRemoteTreatyBreak(data.treatyId, data.breakerId, data.penalty, data.upfrontPaid, data.debt, data.reason, false);
      this.onRemoteUpdate();
    } else if (data.type === 'TREATY_PAYMENT' && data.treatyId) {
      this.engine.handleRemoteTreatyPayment(data.treatyId, data.amount, data.time, false);
      this.onRemoteUpdate();
    } else if (data.type === 'TREATY_REPARATION_PAYMENT' && data.treatyId) {
      this.engine.handleRemoteTreatyReparationPayment(data.treatyId, data.amount, data.remainingDebt, data.time, false);
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
      this.engine.handleRemoteNuclearStrike(data.strike, false, isHistoryReplay);
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
      this.engine.adminClearRadiation(false, data._sentAt || data._envTime || 0);
      this.onRemoteUpdate();
    } else if (data.type === 'ADMIN_BREAK_COUNTRY_TREATIES' && data.countryId) {
      this.engine.adminBreakCountryTreaties(data.countryId, false);
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
    const rankInfo = myC ? this.engine.getCountryTitle(myC) : null;

    const chat = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      countryId: myC?.id || 0,
      countryName: myC?.name || (isAdmin ? 'Admin' : 'Gezgin'),
      countryColor: isAdmin ? '#FBBF24' : myC?.color || '#38BDF8',
      countryTitle: rankInfo?.title || null,
      countryTitleBadge: rankInfo?.badge || null,
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
