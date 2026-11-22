// Procedural World Map Generator for "Dev Dünya Haritası"
// Models continents, oceans, islands, and navigation paths

export const WORLD_WIDTH = 90;
export const WORLD_HEIGHT = 48;

// Continental landmass bounding boxes & shapes to generate recognizable World Map
// 0 = WATER (Ocean), 1 = LAND
export function generateWorldMap() {
  const grid = Array.from({ length: WORLD_HEIGHT }, () =>
    Array.from({ length: WORLD_WIDTH }, () => ({
      type: 'WATER',
      name: 'Okyanus',
      continent: null,
      ownerId: null,
      troops: 0,
      fortLevel: 0,
    }))
  );

  // Helper to mark land polygon / ellipse / rectangle
  function addLand(cx, cy, rx, ry, continentName, name = 'Toprak', noiseChance = 0.9) {
    for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(WORLD_HEIGHT - 1, Math.ceil(cy + ry)); y++) {
      for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(WORLD_WIDTH - 1, Math.ceil(cx + rx)); x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) {
          if (Math.random() < noiseChance) {
            grid[y][x] = {
              type: 'LAND',
              name,
              continent: continentName,
              ownerId: null,
              troops: 10 + Math.floor(Math.random() * 20), // Neutral barbarians/tribes
              fortLevel: 0,
            };
          }
        }
      }
    }
  }

  // Helper for land rectangles with organic jitter
  function addLandRect(x1, y1, x2, y2, continentName, name = 'Toprak', density = 0.88) {
    for (let y = Math.max(0, y1); y <= Math.min(WORLD_HEIGHT - 1, y2); y++) {
      for (let x = Math.max(0, x1); x <= Math.min(WORLD_WIDTH - 1, x2); x++) {
        if (Math.random() < density) {
          grid[y][x] = {
            type: 'LAND',
            name,
            continent: continentName,
            ownerId: null,
            troops: 10 + Math.floor(Math.random() * 25),
            fortLevel: 0,
          };
        }
      }
    }
  }

  // 1. NORTH AMERICA (Kuzey Amerika)
  // Canada / Alaska
  addLandRect(4, 5, 26, 12, 'Kuzey Amerika', 'Kanada & Alaska', 0.92);
  // USA (Merkez ve Doğu/Batı)
  addLandRect(8, 13, 27, 20, 'Kuzey Amerika', 'Kuzey Amerika', 0.95);
  // Florida
  addLand(24, 21, 2, 3, 'Kuzey Amerika', 'Florida');
  // Mexico & Central America
  addLand(12, 21, 4, 3, 'Kuzey Amerika', 'Meksika');
  addLand(14, 24, 3, 2, 'Kuzey Amerika', 'Orta Amerika');
  addLand(17, 26, 2, 2, 'Kuzey Amerika', 'Panama');

  // Greenland (Grönland)
  addLand(32, 4, 6, 4, 'Kuzey Amerika', 'Grönland', 0.85);

  // 2. SOUTH AMERICA (Güney Amerika)
  // Colombia, Venezuela, Brazil, Amazon
  addLandRect(19, 28, 30, 36, 'Güney Amerika', 'Brezilya & Amazon', 0.94);
  // Andes / Peru / Chile
  addLandRect(17, 30, 21, 42, 'Güney Amerika', 'And Dağları / Şili', 0.90);
  // Argentina / Pampas
  addLandRect(21, 37, 27, 44, 'Güney Amerika', 'Arjantin', 0.92);

  // 3. EUROPE (Avrupa)
  // British Isles (İngiltere & İrlanda)
  addLand(40, 11, 2, 3, 'Avrupa', 'Birleşik Krallık', 0.88);
  // Scandinavia (İskandinavya)
  addLandRect(45, 4, 51, 10, 'Avrupa', 'İskandinavya', 0.90);
  // Western Europe (Fransa, Almanya)
  addLandRect(41, 13, 49, 18, 'Avrupa', 'Batı Avrupa', 0.95);
  // Iberian Peninsula (İspanya & Portekiz)
  addLandRect(38, 17, 43, 21, 'Avrupa', 'İber Yarımadası', 0.92);
  // Italy (İtalya)
  addLand(46, 19, 1.5, 3, 'Avrupa', 'İtalya');
  // Eastern Europe / Balkans
  addLandRect(48, 13, 56, 19, 'Avrupa', 'Doğu Avrupa & Balkanlar', 0.94);

  // 4. AFRICA (Afrika)
  // North Africa / Sahara
  addLandRect(40, 22, 57, 27, 'Afrika', 'Kuzey Afrika', 0.95);
  // West Africa
  addLandRect(39, 28, 48, 33, 'Afrika', 'Batı Afrika', 0.92);
  // Central & East Africa (Kongo, Nil, Kenya)
  addLandRect(48, 28, 58, 37, 'Afrika', 'Doğu & Orta Afrika', 0.94);
  // Southern Africa (Güney Afrika)
  addLandRect(47, 38, 54, 43, 'Afrika', 'Güney Afrika', 0.92);
  // Madagascar (Madagaskar)
  addLand(60, 37, 2, 4, 'Afrika', 'Madagaskar', 0.85);

  // 5. ASIA (Asya)
  // Russia / Siberia (Geniş Kuzey Asya)
  addLandRect(56, 5, 84, 12, 'Asya', 'Sibirya & Rusya', 0.95);
  // Middle East / Anatolia (Türkiye, İran, Arabistan)
  addLandRect(54, 18, 64, 24, 'Asya', 'Orta Doğu & Anadolu', 0.92);
  // Central Asia (Kazakistan, Özbekistan vb.)
  addLandRect(58, 13, 69, 17, 'Asya', 'Orta Asya', 0.94);
  // India (Hindistan Yarımadası)
  addLand(67, 23, 4, 5, 'Asya', 'Hindistan', 0.92);
  // China / East Asia (Çin, Kore, Moğolistan)
  addLandRect(70, 13, 82, 23, 'Asya', 'Doğu Asya & Çin', 0.96);
  // Southeast Asia (Güneydoğu Asya / Hindiçin)
  addLandRect(74, 24, 79, 30, 'Asya', 'Güneydoğu Asya', 0.88);
  // Japan (Japonya Adaları)
  addLand(84, 16, 2, 4, 'Asya', 'Japonya', 0.85);
  // Indonesia / Philippines (Adalar)
  addLand(78, 32, 5, 3, 'Asya', 'Endonezya & Filipinler', 0.70);

  // 6. OCEANIA / AUSTRALIA (Avustralya & Okyanusya)
  addLandRect(77, 37, 86, 44, 'Okyanusya', 'Avustralya', 0.95);
  // New Zealand (Yeni Zelanda)
  addLand(88, 43, 1.5, 3, 'Okyanusya', 'Yeni Zelanda', 0.80);

  return grid;
}

// Preset flags if user wants quick national flag instead of uploading custom image
export const PRESET_FLAGS = [
  { id: 'tr', name: 'Türkiye', emoji: '🇹🇷', url: 'https://flagcdn.com/w320/tr.png', color: '#e11d48' },
  { id: 'az', name: 'Azerbaycan', emoji: '🇦🇿', url: 'https://flagcdn.com/w320/az.png', color: '#0ea5e9' },
  { id: 'us', name: 'ABD', emoji: '🇺🇸', url: 'https://flagcdn.com/w320/us.png', color: '#2563eb' },
  { id: 'de', name: 'Almanya', emoji: '🇩🇪', url: 'https://flagcdn.com/w320/de.png', color: '#f59e0b' },
  { id: 'br', name: 'Brezilya', emoji: '🇧🇷', url: 'https://flagcdn.com/w320/br.png', color: '#10b981' },
  { id: 'jp', name: 'Japonya', emoji: '🇯🇵', url: 'https://flagcdn.com/w320/jp.png', color: '#dc2626' },
  { id: 'gb', name: 'Birleşik Krallık', emoji: '🇬🇧', url: 'https://flagcdn.com/w320/gb.png', color: '#4338ca' },
  { id: 'fr', name: 'Fransa', emoji: '🇫🇷', url: 'https://flagcdn.com/w320/fr.png', color: '#3b82f6' },
  { id: 'it', name: 'İtalya', emoji: '🇮🇹', url: 'https://flagcdn.com/w320/it.png', color: '#16a34a' },
  { id: 'es', name: 'İspanya', emoji: '🇪🇸', url: 'https://flagcdn.com/w320/es.png', color: '#ca8a04' },
];

// Calculate player stats based on conquered land
export function calculateEmpireStats(landCount) {
  if (landCount <= 0) {
    return {
      maxTroops: 200,
      regenPerSec: 10,
      regenPercent: 10,
      tierName: 'Yeni Doğan / Kabile',
      shipType: 'LIGHT_BOAT',
      fortDefenseMult: 1.2,
      canBuildHeavyFort: false,
    };
  }

  // Small Empire (1 - 25 cells): Super fast recovery, nimble, high agility
  if (landCount < 25) {
    const maxTroops = 400 + landCount * 30; // 400 - 1150
    const regenPerSec = Math.max(12, Math.floor(maxTroops * 0.08)); // ~30-90 troops/sec
    return {
      maxTroops,
      regenPerSec,
      regenPercent: 8,
      tierName: 'Çevik Bölgesel Devlet',
      shipType: 'LIGHT_BOAT',
      fortDefenseMult: 1.5,
      canBuildHeavyFort: false,
    };
  }

  // Medium Kingdom (25 - 80 cells): Balanced regional power
  if (landCount < 80) {
    const maxTroops = 1200 + landCount * 70; // 2950 - 6800
    const regenPerSec = Math.max(25, Math.floor(maxTroops * 0.035)); // ~100-240 troops/sec
    return {
      maxTroops,
      regenPerSec,
      regenPercent: 3.5,
      tierName: 'Bölgesel Krallık',
      shipType: 'WARSHIP',
      fortDefenseMult: 2.0,
      canBuildHeavyFort: true,
    };
  }

  // Great Empire (80+ cells): Colossal capacity, immense firepower, slower regen % but giant absolute numbers!
  const maxTroops = 7000 + landCount * 180; // 21,000+
  const regenPerSec = Math.max(70, Math.floor(maxTroops * 0.015)); // ~300-600+ troops/sec!
  return {
    maxTroops,
    regenPerSec,
    regenPercent: 1.5,
    tierName: 'Kıtasal Süper Güç (İmparatorluk)',
    shipType: 'DREADNOUGHT',
    fortDefenseMult: 2.8,
    canBuildHeavyFort: true,
  };
}
