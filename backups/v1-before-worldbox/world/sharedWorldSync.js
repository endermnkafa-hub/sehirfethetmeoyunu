// Real-Time Shared World Synchronization Layer
// Syncs player countries, pixel conquests, and device registrations across tabs & network

const STORAGE_KEY = 'sf_shared_world_v4_registry';

export class SharedWorldSync {
  constructor(engine, onRemoteUpdate) {
    this.engine = engine;
    this.onRemoteUpdate = onRemoteUpdate || (() => {});
    this.channel = null;
    this.tabId = 'tab_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);

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

    // Listen to storage events from other tabs in the same browser
    if (typeof window !== 'undefined') {
      this._storageListener = (e) => {
        if (e.key === 'sf_shared_world_v4_data' || e.key === 'sf_my_country_id') {
          this.engine.loadState();
          this.onRemoteUpdate();
        }
      };
      window.addEventListener('storage', this._storageListener);
    }
  }

  // Broadcast an action to other tabs & players
  broadcast(data) {
    if (this.channel) {
      try {
        this.channel.postMessage({
          ...data,
          _timestamp: Date.now(),
          _senderTabId: this.tabId,
          _senderDeviceId: this.engine.myDeviceId,
        });
      } catch (e) {
        console.warn('Broadcast error:', e);
      }
    }
  }

  _handleRemoteMessage(data) {
    // Ignore messages echoing back to the exact same tab instance
    if (!data || data._senderTabId === this.tabId) return;

    if (data.type === 'NEW_COUNTRY') {
      this.engine.handleRemoteNewCountry(data.country);

      // If the new country belongs to this device (created in another tab), associate it!
      if (data.country.deviceId === this.engine.myDeviceId) {
        this.engine.myCountryId = data.country.id;
      }
      this.onRemoteUpdate();
    } else if (data.type === 'CONQUER_PIXEL') {
      this.engine.handleRemoteConquerPixel(data.countryId, data.x, data.y, data.cost);
      this.onRemoteUpdate();
    }
  }

  destroy() {
    if (this.channel) {
      try { this.channel.close(); } catch {}
    }
    if (typeof window !== 'undefined' && this._storageListener) {
      window.removeEventListener('storage', this._storageListener);
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
