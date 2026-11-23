// Client Network & Device Security Guard
// Enforces: 1 Device = 1 Country, Max 2 Countries per IP, VPN/Proxy Detection

const DEVICE_ID_KEY = 'sf_unique_device_id';
const MY_COUNTRY_KEY = 'sf_my_country_id';

// Salted FNV-1a hashes of authorized Admin IPv4 & IPv6 /64 prefix so raw IPs are never exposed in public source
const ADMIN_IP_HASHES = new Set([
  '8e7ef9be',
  'fd703693',
  'bb850af4',
  '4ee3cbf5',
  'bbe48bfc',
  '3d67831b',
  '75b15967',
  '11be88f1',
]);

function hashIpForAdmin(ip) {
  if (!ip || typeof ip !== 'string') return '';
  const s = 'sf_admin_salt_2026:' + ip.trim().toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function isAdminIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  if (ADMIN_IP_HASHES.has(hashIpForAdmin(ip))) return true;
  if (ip.includes(':')) {
    const prefix64 = ip.split(':').slice(0, 4).join(':');
    if (ADMIN_IP_HASHES.has(hashIpForAdmin(prefix64))) return true;
  }
  return false;
}

// Helper to read/write persistent cookies as robust backup for localStorage (Chrome on mobile)
function getCookie(name) {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(^|;\\s*)(' + name + ')=([^;]*)'));
  return match ? decodeURIComponent(match[3]) : null;
}

function setCookie(name, val) {
  if (typeof document === 'undefined') return;
  try {
    const oneYear = 60 * 60 * 24 * 365;
    document.cookie = `${name}=${encodeURIComponent(val)}; max-age=${oneYear}; path=/; SameSite=Lax`;
  } catch {}
}

export function getOrCreateDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY) || sessionStorage.getItem(DEVICE_ID_KEY) || getCookie(DEVICE_ID_KEY);
    if (!id) {
      id = 'dev_' + Math.random().toString(36).substring(2, 12) + '_' + Date.now().toString(36);
    }
    localStorage.setItem(DEVICE_ID_KEY, id);
    try { sessionStorage.setItem(DEVICE_ID_KEY, id); } catch {}
    setCookie(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return 'dev_' + Math.random().toString(36).substring(2, 12);
  }
}

export function getMyCountryId() {
  try {
    const id = localStorage.getItem(MY_COUNTRY_KEY) || sessionStorage.getItem(MY_COUNTRY_KEY) || getCookie(MY_COUNTRY_KEY);
    if (id) {
      try { localStorage.setItem(MY_COUNTRY_KEY, id); } catch {}
      try { sessionStorage.setItem(MY_COUNTRY_KEY, id); } catch {}
      setCookie(MY_COUNTRY_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

export function saveMyCountryId(countryId) {
  try {
    if (countryId) {
      localStorage.setItem(MY_COUNTRY_KEY, String(countryId));
      try { sessionStorage.setItem(MY_COUNTRY_KEY, String(countryId)); } catch {}
      setCookie(MY_COUNTRY_KEY, String(countryId));
    } else {
      localStorage.removeItem(MY_COUNTRY_KEY);
      try { sessionStorage.removeItem(MY_COUNTRY_KEY); } catch {}
      setCookie(MY_COUNTRY_KEY, '');
    }
  } catch (e) {
    console.warn('Could not save country ID:', e);
  }
}

// Check IP and detect VPN/Proxy
export async function checkNetworkAndSecurity() {
  let clientIp = '127.0.0.1';
  let isVpnOrProxy = false;
  let providerName = '';

  try {
    // Fast check via ipwho.is with timeout to never block world map load
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const res = await fetch('https://ipwho.is/', { cache: 'no-store', signal: controller.signal });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      if (data && data.success !== false) {
        clientIp = data.ip || clientIp;
        providerName = data.connection?.isp || data.connection?.org || '';

        // Known datacenter/hosting/VPN keywords in ISP or Org
        const lowerIsp = (providerName + ' ' + (data.connection?.org || '')).toLowerCase();
        const vpnKeywords = [
          'vpn', 'proxy', 'tor', 'hosting', 'datacenter', 'digitalocean', 'm247',
          'ovh', 'linode', 'hetzner', 'choopa', 'amazon', 'google cloud', 'azure',
          'cloudflare', 'nordvpn', 'expressvpn', 'surfshark', 'privateinternetaccess',
          'cyberghost', 'zenmate', 'protonvpn', 'mullvad', 'windscribe'
        ];

        for (const kw of vpnKeywords) {
          if (lowerIsp.includes(kw)) {
            isVpnOrProxy = true;
            break;
          }
        }

        if (data.security?.vpn || data.security?.proxy || data.security?.tor) {
          isVpnOrProxy = true;
        }
      }
    }
  } catch (_err) {
    // Fallback IP check with timeout
    try {
      const controller2 = new AbortController();
      const timeoutId2 = setTimeout(() => controller2.abort(), 1500);
      const r2 = await fetch('https://api.ipify.org?format=json', { cache: 'no-store', signal: controller2.signal });
      clearTimeout(timeoutId2);
      const d2 = await r2.json();
      if (d2?.ip) clientIp = d2.ip;
    } catch {}
  }

  // Device country check
  const existingCountryId = getMyCountryId();
  const hasExistingCountry = Boolean(existingCountryId);

  return {
    clientIp,
    isVpnOrProxy,
    isAdmin: isAdminIp(clientIp),
    providerName,
    hasExistingCountry,
    deviceId: getOrCreateDeviceId(),
  };
}
