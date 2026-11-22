// Real-Time Shared World Synchronization Layer
// Syncs player countries, pixel conquests, and device registrations across tabs & network

const STORAGE_KEY = 'sf_shared_world_v4_registry';

export class SharedWorldSync {
  constructor(engine, onRemoteUpdate) {
    this.engine = engine;
    this.onRemoteUpdate = onRemoteUpdate || (() => {});
    this.channel = null;

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
  }

  // Broadcast an action to other players
  broadcast(data) {
    if (this.channel) {
      try {
        this.channel.postMessage({
          ...data,
          _timestamp: Date.now(),
          _senderId: this.engine.myDeviceId,
        });
      } catch (e) {
        console.warn('Broadcast error:', e);
      }
    }
  }

  _handleRemoteMessage(data) {
    if (!data || data._senderId === this.engine.myDeviceId) return;

    if (data.type === 'NEW_COUNTRY') {
      this.engine.handleRemoteNewCountry(data.country);
      this.onRemoteUpdate();
    } else if (data.type === 'CONQUER_PIXEL') {
      this.engine.handleRemoteConquerPixel(data.countryId, data.x, data.y);
      this.onRemoteUpdate();
    }
  }

  // Load registry from localStorage
  loadRegistry() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // Save registry to localStorage
  saveRegistry(payload) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('Storage save error:', e);
    }
  }
}
