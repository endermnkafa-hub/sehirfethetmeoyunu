// Client Network & Device Security Guard
// Enforces: 1 Device = 1 Country, Max 2 Countries per IP, VPN/Proxy Detection

const DEVICE_ID_KEY = 'sf_unique_device_id';
const MY_COUNTRY_KEY = 'sf_my_country_id';

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
    providerName,
    hasExistingCountry,
    deviceId: getOrCreateDeviceId(),
  };
}
