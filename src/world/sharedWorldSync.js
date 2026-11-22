// Real-Time Shared World Synchronization Layer (Cross-Device Global WebRTC Mesh + Cross-Tab BroadcastChannel)
// Connects Phone, PC, and all online players into a single shared World Map automatically via PeerJS

import PeerPkg from 'peerjs';

const Peer = typeof PeerPkg === 'function' ? PeerPkg : (PeerPkg?.Peer || PeerPkg?.default || PeerPkg);

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
];

const GLOBAL_NODE_PREFIX = 'sf-world-mmo-v9-node-';
const MAX_GLOBAL_NODES = 8;

export class SharedWorldSync {
  constructor(engine, onRemoteUpdate) {
    this.engine = engine;
    this.onRemoteUpdate = onRemoteUpdate || (() => {});
    this.channel = null;
    this.tabId = 'tab_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);

    // WebRTC Global Mesh state
    this.peer = null;
    this.mySlotIndex = -1;
    this.peers = new Map(); // remotePeerId -> DataConnection
    this.seenMsgIds = new Set();
    this._msgSeq = 0;
    this._meshInterval = null;
    this._destroyed = false;

    // 1. Local BroadcastChannel for instant same-device tab sync
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel('sf_shared_world_mmo');
        this.channel.onmessage = (e) => {
          this._handleRemoteMessage(e.data);
        };
      } catch (err) {
        console.warn('BroadcastChannel error:', err);
      }
    }

    // 2. Listen to storage events from other tabs in the same browser
    if (typeof window !== 'undefined') {
      this._storageListener = (e) => {
        if (
          e.key === 'sf_shared_world_v9_clean' ||
          e.key === 'sf_shared_world_v8_clean' ||
          e.key === 'sf_my_country_id'
        ) {
          this.engine.loadState();
          this.onRemoteUpdate();
        }
      };
      window.addEventListener('storage', this._storageListener);
    }

    // 3. Join Global Multi-Device WebRTC Mesh (syncs Phone, PC, and other players worldwide)
    this._initGlobalMesh(0);
  }

  getConnectedPeersCount() {
    let count = 0;
    for (const conn of this.peers.values()) {
      if (conn && conn.open) count++;
    }
    return count;
  }

  _initGlobalMesh(trySlot = 0) {
    if (this._destroyed || typeof window === 'undefined' || !Peer) return;

    const slot = trySlot < MAX_GLOBAL_NODES ? trySlot : -1;
    const desiredId =
      slot >= 0
        ? `${GLOBAL_NODE_PREFIX}${slot}`
        : `${GLOBAL_NODE_PREFIX}guest-${Math.random().toString(36).slice(2, 8)}`;

    try {
      const peer = new Peer(desiredId, {
        debug: 0,
        config: { iceServers: ICE_SERVERS },
      });

      peer.on('open', (id) => {
        if (this._destroyed) {
          try { peer.destroy(); } catch {}
          return;
        }
        this.peer = peer;
        this.mySlotIndex = slot;
        this._connectToGlobalNodes();

        if (this._meshInterval) clearInterval(this._meshInterval);
        this._meshInterval = setInterval(() => {
          this._connectToGlobalNodes();
        }, 7000);
      });

      peer.on('connection', (conn) => {
        this._setupPeerConnection(conn);
      });

      peer.on('error', (err) => {
        if (err && err.type === 'unavailable-id' && slot >= 0 && slot + 1 <= MAX_GLOBAL_NODES) {
          try { peer.destroy(); } catch {}
          this._initGlobalMesh(slot + 1);
        }
      });
    } catch (e) {
      console.warn('Global mesh init error:', e);
    }
  }

  _connectToGlobalNodes() {
    if (!this.peer || this.peer.destroyed || !this.peer.open) return;

    for (let i = 0; i < MAX_GLOBAL_NODES; i++) {
      if (i === this.mySlotIndex) continue;
      const targetId = `${GLOBAL_NODE_PREFIX}${i}`;
      const existing = this.peers.get(targetId);
      if (existing && existing.open) continue;

      try {
        const conn = this.peer.connect(targetId, { reliable: true });
        if (conn) {
          this._setupPeerConnection(conn);
        }
      } catch {}
    }
  }

  _setupPeerConnection(conn) {
    if (!conn) return;

    conn.on('open', () => {
      this.peers.set(conn.peer, conn);
      // Immediately exchange full world snapshot with the newly connected device (Phone <-> PC)
      const snapshot = this.engine.exportSnapshot();
      if (snapshot) {
        try {
          conn.send({
            type: 'WORLD_SNAPSHOT',
            snapshot,
            _msgId: `snap_${this.tabId}_${Date.now()}`,
            _senderTabId: this.tabId,
          });
        } catch {}
      }
      this.onRemoteUpdate();
    });

    conn.on('data', (data) => {
      this._handleRemoteMessage(data, conn);
    });

    conn.on('close', () => {
      this.peers.delete(conn.peer);
      this.onRemoteUpdate();
    });

    conn.on('error', () => {
      this.peers.delete(conn.peer);
    });
  }

  // Broadcast an action to all other tabs AND all remote devices (Phone, PC, other players)
  broadcast(data) {
    const packet = {
      ...data,
      _msgId: data._msgId || `${this.tabId}_${Date.now()}_${++this._msgSeq}`,
      _timestamp: Date.now(),
      _senderTabId: this.tabId,
      _senderDeviceId: this.engine.myDeviceId,
    };

    this.seenMsgIds.add(packet._msgId);

    // 1. Local tabs
    if (this.channel) {
      try {
        this.channel.postMessage(packet);
      } catch {}
    }

    // 2. Remote devices over WebRTC mesh
    for (const conn of this.peers.values()) {
      if (conn && conn.open) {
        try {
          conn.send(packet);
        } catch {}
      }
    }
  }

  _handleRemoteMessage(data, sourceConn = null) {
    if (!data || data._senderTabId === this.tabId) return;

    if (data._msgId) {
      if (this.seenMsgIds.has(data._msgId)) return;
      this.seenMsgIds.add(data._msgId);
      if (this.seenMsgIds.size > 400) {
        const first = this.seenMsgIds.values().next().value;
        this.seenMsgIds.delete(first);
      }
    }

    if (data.type === 'WORLD_SNAPSHOT' && data.snapshot) {
      this.engine.mergeRemoteSnapshot(data.snapshot);
      this.onRemoteUpdate();
      return;
    }

    if (data.type === 'NEW_COUNTRY') {
      this.engine.handleRemoteNewCountry(data.country);
      if (data.country.deviceId === this.engine.myDeviceId) {
        this.engine.myCountryId = data.country.id;
      }
      this.onRemoteUpdate();
    } else if (data.type === 'CONQUER_PIXEL') {
      this.engine.handleRemoteConquerPixel(data.countryId, data.x, data.y, data.cost);
      this.onRemoteUpdate();
    } else if (data.type === 'LAUNCH_SHIP') {
      this.engine.handleRemoteLaunchShip(data.ship);
      this.onRemoteUpdate();
    } else if (data.type === 'SYNC_COUNTRY_STATS') {
      this.engine.handleRemoteSyncCountryStats(data.countryId, data.stats);
      this.onRemoteUpdate();
    }

    // Relay packet to other connected mesh peers so all devices stay in sync
    if (sourceConn) {
      for (const conn of this.peers.values()) {
        if (conn && conn.open && conn !== sourceConn) {
          try {
            conn.send(data);
          } catch {}
        }
      }
    }
  }

  destroy() {
    this._destroyed = true;
    if (this._meshInterval) clearInterval(this._meshInterval);
    if (this.channel) {
      try { this.channel.close(); } catch {}
    }
    if (this.peer) {
      try { this.peer.destroy(); } catch {}
    }
    if (typeof window !== 'undefined' && this._storageListener) {
      window.removeEventListener('storage', this._storageListener);
    }
  }
}
