// Iconic World Metropolises & Capitals Database
// Real geographic coordinates (lon, lat) mapped to massive Earth grid
// Each city has a strategic cell radius, landmark icon, soldier conquest bonus, and turn income bonus

export const WORLD_CITIES = [
  // Türkiye
  { id: 'istanbul', name: 'İstanbul', country: 'Türkiye', lon: 28.97, lat: 41.00, radius: 4, icon: '🕌', bonusTroops: 60, incomeBonus: 8, tier: 'METROPOLIS' },
  { id: 'ankara', name: 'Ankara', country: 'Türkiye', lon: 32.85, lat: 39.93, radius: 3, icon: '🏛️', bonusTroops: 45, incomeBonus: 6, tier: 'CAPITAL' },
  { id: 'izmir', name: 'İzmir', country: 'Türkiye', lon: 27.14, lat: 38.42, radius: 3, icon: '⚓', bonusTroops: 35, incomeBonus: 5, tier: 'CITY' },
  { id: 'antalya', name: 'Antalya', country: 'Türkiye', lon: 30.70, lat: 36.89, radius: 2, icon: '🌴', bonusTroops: 25, incomeBonus: 4, tier: 'CITY' },
  { id: 'bursa', name: 'Bursa', country: 'Türkiye', lon: 29.06, lat: 40.18, radius: 2, icon: '🌲', bonusTroops: 25, incomeBonus: 4, tier: 'CITY' },
  { id: 'trabzon', name: 'Trabzon', country: 'Türkiye', lon: 39.71, lat: 41.00, radius: 2, icon: '🌊', bonusTroops: 20, incomeBonus: 3, tier: 'CITY' },

  // Balkanlar & Akdeniz
  { id: 'athens', name: 'Atina', country: 'Yunanistan', lon: 23.72, lat: 37.98, radius: 3, icon: '🏛️', bonusTroops: 40, incomeBonus: 5, tier: 'CAPITAL' },
  { id: 'thessaloniki', name: 'Selanik', country: 'Yunanistan', lon: 22.94, lat: 40.64, radius: 2, icon: '🏰', bonusTroops: 25, incomeBonus: 3, tier: 'CITY' },
  { id: 'sofia', name: 'Sofya', country: 'Bulgaristan', lon: 23.32, lat: 42.69, radius: 2, icon: '⛪', bonusTroops: 25, incomeBonus: 3, tier: 'CAPITAL' },
  { id: 'belgrade', name: 'Belgrad', country: 'Sırbistan', lon: 20.46, lat: 44.81, radius: 2, icon: '🏰', bonusTroops: 25, incomeBonus: 3, tier: 'CAPITAL' },
  { id: 'bucharest', name: 'Bükreş', country: 'Romanya', lon: 26.10, lat: 44.43, radius: 2, icon: '🏛️', bonusTroops: 25, incomeBonus: 3, tier: 'CAPITAL' },

  // Orta & Batı Avrupa
  { id: 'rome', name: 'Roma', country: 'İtalya', lon: 12.49, lat: 41.90, radius: 3, icon: '🏟️', bonusTroops: 55, incomeBonus: 7, tier: 'METROPOLIS' },
  { id: 'paris', name: 'Paris', country: 'Fransa', lon: 2.35, lat: 48.85, radius: 4, icon: '🗼', bonusTroops: 65, incomeBonus: 8, tier: 'METROPOLIS' },
  { id: 'london', name: 'Londra', country: 'Birleşik Krallık', lon: -0.12, lat: 51.50, radius: 4, icon: '🎡', bonusTroops: 65, incomeBonus: 8, tier: 'METROPOLIS' },
  { id: 'berlin', name: 'Berlin', country: 'Almanya', lon: 13.40, lat: 52.52, radius: 3, icon: '🏛️', bonusTroops: 55, incomeBonus: 7, tier: 'CAPITAL' },
  { id: 'vienna', name: 'Viyana', country: 'Avusturya', lon: 16.37, lat: 48.20, radius: 3, icon: '🎻', bonusTroops: 40, incomeBonus: 5, tier: 'CAPITAL' },
  { id: 'madrid', name: 'Madrid', country: 'İspanya', lon: -3.70, lat: 40.41, radius: 3, icon: '🏰', bonusTroops: 50, incomeBonus: 6, tier: 'CAPITAL' },
  { id: 'amsterdam', name: 'Amsterdam', country: 'Hollanda', lon: 4.90, lat: 52.37, radius: 2, icon: '🌷', bonusTroops: 35, incomeBonus: 5, tier: 'CAPITAL' },
  { id: 'warsaw', name: 'Varşova', country: 'Polonya', lon: 21.01, lat: 52.23, radius: 3, icon: '🏰', bonusTroops: 40, incomeBonus: 5, tier: 'CAPITAL' },

  // Doğu Avrupa & Kafkaslar
  { id: 'moscow', name: 'Moskova', country: 'Rusya', lon: 37.61, lat: 55.75, radius: 4, icon: '🏰', bonusTroops: 70, incomeBonus: 9, tier: 'METROPOLIS' },
  { id: 'kyiv', name: 'Kiev', country: 'Ukrayna', lon: 30.52, lat: 50.45, radius: 3, icon: '⛪', bonusTroops: 45, incomeBonus: 6, tier: 'CAPITAL' },
  { id: 'baku', name: 'Bakü', country: 'Azerbaycan', lon: 49.86, lat: 40.40, radius: 3, icon: '🔥', bonusTroops: 45, incomeBonus: 6, tier: 'CAPITAL' },
  { id: 'tbilisi', name: 'Tiflis', country: 'Gürcistan', lon: 44.78, lat: 41.71, radius: 2, icon: '⛰️', bonusTroops: 25, incomeBonus: 3, tier: 'CAPITAL' },

  // Orta Doğu & Kuzey Afrika
  { id: 'cairo', name: 'Kahire', country: 'Mısır', lon: 31.23, lat: 30.04, radius: 4, icon: '🏺', bonusTroops: 60, incomeBonus: 8, tier: 'METROPOLIS' },
  { id: 'baghdad', name: 'Bağdat', country: 'Irak', lon: 44.36, lat: 33.31, radius: 3, icon: '🌴', bonusTroops: 50, incomeBonus: 6, tier: 'CAPITAL' },
  { id: 'damascus', name: 'Şam', country: 'Suriye', lon: 36.29, lat: 33.51, radius: 2, icon: '🕌', bonusTroops: 30, incomeBonus: 4, tier: 'CAPITAL' },
  { id: 'tehran', name: 'Tahran', country: 'İran', lon: 51.38, lat: 35.68, radius: 3, icon: '⛰️', bonusTroops: 55, incomeBonus: 7, tier: 'CAPITAL' },
  { id: 'riyadh', name: 'Riyad', country: 'Suudi Arabistan', lon: 46.67, lat: 24.71, radius: 3, icon: '🏜️', bonusTroops: 45, incomeBonus: 6, tier: 'CAPITAL' },
  { id: 'jerusalem', name: 'Kudüs', country: 'Filistin', lon: 35.21, lat: 31.76, radius: 2, icon: '✨', bonusTroops: 40, incomeBonus: 5, tier: 'CAPITAL' },
  { id: 'tunis', name: 'Tunus', country: 'Tunus', lon: 10.18, lat: 36.80, radius: 2, icon: '🏛️', bonusTroops: 25, incomeBonus: 3, tier: 'CAPITAL' },

  // Asya
  { id: 'tokyo', name: 'Tokyo', country: 'Japonya', lon: 139.69, lat: 35.68, radius: 4, icon: '🗼', bonusTroops: 75, incomeBonus: 10, tier: 'METROPOLIS' },
  { id: 'beijing', name: 'Pekin', country: 'Çin', lon: 116.40, lat: 39.90, radius: 4, icon: '🏮', bonusTroops: 75, incomeBonus: 10, tier: 'METROPOLIS' },
  { id: 'shanghai', name: 'Şanghay', country: 'Çin', lon: 121.47, lat: 31.23, radius: 3, icon: '🏙️', bonusTroops: 60, incomeBonus: 8, tier: 'CITY' },
  { id: 'delhi', name: 'Yeni Delhi', country: 'Hindistan', lon: 77.20, lat: 28.61, radius: 4, icon: '🛕', bonusTroops: 70, incomeBonus: 9, tier: 'METROPOLIS' },
  { id: 'astana', name: 'Astana', country: 'Kazakistan', lon: 71.44, lat: 51.16, radius: 3, icon: '🇰🇿', bonusTroops: 40, incomeBonus: 5, tier: 'CAPITAL' },
  { id: 'tashkent', name: 'Taşkent', country: 'Özbekistan', lon: 69.24, lat: 41.29, radius: 3, icon: '🕌', bonusTroops: 35, incomeBonus: 4, tier: 'CAPITAL' },
  { id: 'bangkok', name: 'Bangkok', country: 'Tayland', lon: 100.50, lat: 13.75, radius: 3, icon: '🛕', bonusTroops: 45, incomeBonus: 6, tier: 'CAPITAL' },
  { id: 'seoul', name: 'Seul', country: 'Güney Kore', lon: 126.97, lat: 37.56, radius: 3, icon: '🏙️', bonusTroops: 55, incomeBonus: 7, tier: 'CAPITAL' },

  // Amerika Kıtası
  { id: 'new_york', name: 'New York', country: 'ABD', lon: -74.00, lat: 40.71, radius: 4, icon: '🗽', bonusTroops: 75, incomeBonus: 10, tier: 'METROPOLIS' },
  { id: 'washington', name: 'Washington', country: 'ABD', lon: -77.03, lat: 38.90, radius: 3, icon: '🏛️', bonusTroops: 55, incomeBonus: 7, tier: 'CAPITAL' },
  { id: 'los_angeles', name: 'Los Angeles', country: 'ABD', lon: -118.24, lat: 34.05, radius: 3, icon: '🌴', bonusTroops: 50, incomeBonus: 6, tier: 'CITY' },
  { id: 'mexico_city', name: 'Meksiko', country: 'Meksika', lon: -99.13, lat: 19.43, radius: 4, icon: '🌮', bonusTroops: 60, incomeBonus: 8, tier: 'METROPOLIS' },
  { id: 'rio', name: 'Rio de Janeiro', country: 'Brezilya', lon: -43.17, lat: -22.90, radius: 3, icon: '🏖️', bonusTroops: 50, incomeBonus: 6, tier: 'CITY' },
  { id: 'buenos_aires', name: 'Buenos Aires', country: 'Arjantin', lon: -58.38, lat: -34.60, radius: 3, icon: '💃', bonusTroops: 50, incomeBonus: 6, tier: 'CAPITAL' },

  // Afrika & Okyanusya
  { id: 'johannesburg', name: 'Johannesburg', country: 'Güney Afrika', lon: 28.04, lat: -26.20, radius: 3, icon: '💎', bonusTroops: 45, incomeBonus: 6, tier: 'METROPOLIS' },
  { id: 'sydney', name: 'Sidney', country: 'Avustralya', lon: 151.20, lat: -33.86, radius: 3, icon: '🦘', bonusTroops: 50, incomeBonus: 6, tier: 'METROPOLIS' },
];

export const CITY_MAP_CACHE = new Map();
