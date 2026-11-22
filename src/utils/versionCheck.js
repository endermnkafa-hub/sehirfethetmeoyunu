// Version and Update Management for Mobile App (Android APK) and Web
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';

export const CURRENT_CLIENT_INFO = {
  versionCode: 3,
  versionName: '1.2',
  platform: typeof window !== 'undefined' && Capacitor.isNativePlatform() ? 'android' : 'web',
};

// Remote endpoints to check for version metadata
const REMOTE_VERSION_URLS = [
  'https://ankafa-hub.github.io/sehirfethetmeoyunu/version.json',
  '/version.json',
];

export async function checkAppVersion() {
  let localBuild = CURRENT_CLIENT_INFO.versionCode;
  let localVersion = CURRENT_CLIENT_INFO.versionName;
  const isNative = typeof window !== 'undefined' && Capacitor.isNativePlatform();

  if (isNative) {
    try {
      const info = await CapApp.getInfo();
      if (info && info.build) {
        localBuild = parseInt(info.build, 10) || localBuild;
      }
      if (info && info.version) {
        localVersion = info.version;
      }
    } catch (e) {
      console.warn('[VersionCheck] CapApp.getInfo failed, using fallback:', e);
    }
  }

  let remoteData = null;
  for (const url of REMOTE_VERSION_URLS) {
    try {
      const resp = await fetch(`${url}?t=${Date.now()}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (resp.ok) {
        remoteData = await resp.json();
        break;
      }
    } catch {}
  }

  if (!remoteData || typeof remoteData.versionCode !== 'number') {
    return {
      checked: true,
      needsUpdate: false,
      isMandatory: false,
      localVersion,
      localBuild,
      remoteData: null,
    };
  }

  // On Android native app:
  // If remote.versionCode > localBuild, update is MANDATORY!
  const isOutdated = remoteData.versionCode > localBuild;
  const isMandatory = isNative && isOutdated;

  return {
    checked: true,
    isNative,
    needsUpdate: isOutdated,
    isMandatory,
    localVersion,
    localBuild,
    remoteVersion: remoteData.versionName,
    remoteBuild: remoteData.versionCode,
    apkUrl:
      remoteData.apkUrl ||
      'https://github.com/endermnkafa-hub/sehirfethetmeoyunu/releases/download/v1.0-latest/sehir-fethetme-oyunu.apk',
    releaseNotes: remoteData.releaseNotes || 'Yeni güncellemeler ve hata düzeltmeleri.',
  };
}
