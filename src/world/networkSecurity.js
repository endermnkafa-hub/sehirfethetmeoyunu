// Client Network & Device Security Guard
// Enforces: 1 Device = 1 Country, Max 2 Countries per IP, VPN/Proxy Detection

const DEVICE_ID_KEY = 'sf_unique_device_id';
const MY_COUNTRY_KEY = 'sf_my_country_id';

// Salted FNV-1a hashes of authorized Admin IPv4 & IPv6 /64 prefix so raw IPs are never exposed in public source
const ADMIN_IP_HASHES = new Set(['8e7ef9be', 'fd703693']);

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

export function getOrCreateDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = 'dev_' + Math.random().toString(36).substring(2, 12) + '_' + Date.now().toString(36);
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return 'dev_' + Math.random().toString(36).substring(2, 12);
  }
}

export function getMyCountryId() {
  try {
    return localStorage.getItem(MY_COUNTRY_KEY);
  } catch {
    return null;
  }
}

export function saveMyCountryId(countryId) {
  try {
    localStorage.setItem(MY_COUNTRY_KEY, countryId);
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
    // Fast check via ipwho.is which returns proxy/vpn detection
    const res = await fetch('https://ipwho.is/', { cache: 'no-store' });
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
  } catch (err) {
    // Fallback IP check
    try {
      const r2 = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
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
