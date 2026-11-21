import React, { useState } from 'react';
import { PLAYER_COLORS } from '../utils/gameLogic';
import { Users, Grid, Play, BookOpen, Crown, Shield, Scroll, Wifi, Download } from 'lucide-react';

export default function GameSetup({ onStartGame, onOpenRules, onOpenOnline }) {
  const [gameMode, setGameMode] = useState('KLASIK'); // 'KLASIK' | 'MODERN'
  const [playerCount, setPlayerCount] = useState(4);
  const [playerNames, setPlayerNames] = useState([
    'Oyuncu 1', 'Oyuncu 2', 'Oyuncu 3', 'Oyuncu 4',
    'Oyuncu 5', 'Oyuncu 6', 'Oyuncu 7', 'Oyuncu 8'
  ]);
  const [gridSize, setGridSize] = useState(60); // 40, 60, 80
  const [startSize, setStartSize] = useState(3); // 3x3 or 5x5

  const handleNameChange = (idx, newName) => {
    const updated = [...playerNames];
    updated[idx] = newName;
    setPlayerNames(updated);
  };

  const handleStart = () => {
    const selectedPlayers = PLAYER_COLORS.slice(0, playerCount).map((col, idx) => ({
      ...col,
      name: playerNames[idx] || `Oyuncu ${idx + 1}`,
      alive: true,
    }));

    onStartGame({
      gameMode,
      players: selectedPlayers,
      gridWidth: gridSize,
      gridHeight: gridSize,
      startSize,
    });
  };

  return (
    <div className="min-h-screen bg-stone-100 notebook-grid flex flex-col items-center justify-center p-4">
      <div className="bg-white/95 backdrop-blur-md rounded-3xl p-6 sm:p-8 shadow-2xl max-w-md w-full border-4 border-amber-300 animate-in fade-in zoom-in-95 duration-200">
        
        {/* Title & Brand */}
        <div className="text-center mb-5">
          <div className="inline-block p-3 bg-amber-100 text-amber-800 rounded-2xl mb-2 shadow-inner">
            <Crown size={32} />
          </div>
          <h1 className="text-2xl sm:text-3xl font-black text-stone-800 tracking-tight">
            Şehir & Toprak Fethi
          </h1>
          <p className="text-stone-500 text-xs sm:text-sm mt-0.5 font-medium">
            Kareli Defter Strateji & Diplomasi Oyunu
          </p>
        </div>

        {/* Game Mode Selector */}
        <div className="mb-5">
          <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-2">
            Oyun Modu
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setGameMode('KLASIK')}
              className={`p-3 rounded-2xl border text-left transition active:scale-95 ${
                gameMode === 'KLASIK'
                  ? 'bg-blue-600 text-white border-blue-700 shadow-md ring-2 ring-blue-300'
                  : 'bg-stone-50 text-stone-700 border-stone-200 hover:bg-stone-100'
              }`}
            >
              <div className="flex items-center gap-1.5 font-black text-sm">
                <Scroll size={16} />
                <span>Klasik Mod</span>
              </div>
              <div className="text-[10px] mt-1 opacity-80 leading-tight">
                Saf defter kuralları: Temel ittifak & deliksiz fetih.
              </div>
            </button>

            <button
              type="button"
              onClick={() => setGameMode('MODERN')}
              className={`p-3 rounded-2xl border text-left transition active:scale-95 ${
                gameMode === 'MODERN'
                  ? 'bg-purple-600 text-white border-purple-700 shadow-md ring-2 ring-purple-300'
                  : 'bg-stone-50 text-stone-700 border-stone-200 hover:bg-stone-100'
              }`}
            >
              <div className="flex items-center gap-1.5 font-black text-sm">
                <Shield size={16} />
                <span>Modern Mod</span>
              </div>
              <div className="text-[10px] mt-1 opacity-80 leading-tight">
                Sur/Duvar savunması, Toprak transferi & Vergi sistemi.
              </div>
            </button>
          </div>
        </div>

        {/* 1. Player Count Selection */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-bold text-stone-700 uppercase tracking-wider flex items-center gap-1.5">
              <Users size={16} className="text-blue-600" />
              <span>Oyuncu Sayısı ({playerCount} Kişi)</span>
            </label>
          </div>
          <div className="grid grid-cols-7 gap-1">
            {[2, 3, 4, 5, 6, 7, 8].map(count => (
              <button
                key={count}
                type="button"
                onClick={() => setPlayerCount(count)}
                className={`py-2 rounded-xl font-bold text-sm transition active:scale-95 border ${
                  playerCount === count
                    ? 'bg-blue-600 text-white border-blue-700 shadow-md'
                    : 'bg-stone-50 text-stone-700 border-stone-200 hover:bg-stone-100'
                }`}
              >
                {count}
              </button>
            ))}
          </div>
        </div>

        {/* 2. Player Names List */}
        <div className="mb-4 max-h-32 overflow-y-auto pr-1 space-y-1.5">
          {Array.from({ length: playerCount }).map((_, idx) => {
            const color = PLAYER_COLORS[idx];
            return (
              <div key={idx} className="flex items-center gap-2">
                <span
                  className="w-4 h-4 rounded-full shrink-0 shadow-sm"
                  style={{ backgroundColor: color.hex }}
                />
                <input
                  type="text"
                  maxLength={15}
                  value={playerNames[idx]}
                  onChange={e => handleNameChange(idx, e.target.value)}
                  className="flex-1 px-3 py-1.5 text-xs font-bold rounded-lg border border-stone-200 bg-stone-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
                  placeholder={`Oyuncu ${idx + 1}`}
                />
              </div>
            );
          })}
        </div>

        {/* 3. Map Size */}
        <div className="mb-4">
          <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Grid size={16} className="text-amber-600" />
            <span>Harita Boyutu</span>
          </label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { size: 40, label: 'Küçük (40x40)', desc: 'Hızlı Savaş' },
              { size: 60, label: 'Orta (60x60)', desc: 'Dengeli (Önerilen)' },
              { size: 80, label: 'Büyük (80x80)', desc: 'Geniş Alan' },
            ].map(item => (
              <button
                key={item.size}
                type="button"
                onClick={() => setGridSize(item.size)}
                className={`p-2 rounded-xl text-center border transition active:scale-95 ${
                  gridSize === item.size
                    ? 'bg-amber-500 text-white border-amber-600 shadow-md'
                    : 'bg-stone-50 text-stone-700 border-stone-200 hover:bg-stone-100'
                }`}
              >
                <div className="text-xs font-bold">{item.label}</div>
                <div className="text-[10px] opacity-80">{item.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* 4. Starting Territory Size */}
        <div className="mb-5">
          <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-2">
            Başlangıç Toprağı
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setStartSize(3)}
              className={`p-2.5 rounded-xl border text-center transition active:scale-95 ${
                startSize === 3
                  ? 'bg-blue-600 text-white border-blue-700 shadow-md'
                  : 'bg-stone-50 text-stone-700 border-stone-200 hover:bg-stone-100'
              }`}
            >
              <div className="text-xs font-bold">3x3 (9 Kare)</div>
              <div className="text-[10px] opacity-80">Klasik Başlangıç</div>
            </button>
            <button
              type="button"
              onClick={() => setStartSize(5)}
              className={`p-2.5 rounded-xl border text-center transition active:scale-95 ${
                startSize === 5
                  ? 'bg-blue-600 text-white border-blue-700 shadow-md'
                  : 'bg-stone-50 text-stone-700 border-stone-200 hover:bg-stone-100'
              }`}
            >
              <div className="text-xs font-bold">5x5 (25 Kare)</div>
              <div className="text-[10px] opacity-80">Büyük Başlangıç</div>
            </button>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col gap-2">
          <button
            onClick={onOpenOnline}
            className="w-full py-3.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-black text-sm rounded-2xl shadow-lg transition active:scale-98 flex items-center justify-center gap-2"
          >
            <Wifi size={18} />
            <span>🌐 Online Oda Kur / Katıl</span>
          </button>

          <button
            onClick={handleStart}
            className="w-full py-3.5 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white font-black text-base rounded-2xl shadow-lg transition active:scale-98 flex items-center justify-center gap-2"
          >
            <Play size={20} fill="currentColor" />
            <span>Tek Telefondan Başlat (Pass & Play)</span>
          </button>

          <button
            onClick={onOpenRules}
            className="w-full py-2.5 bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold text-xs rounded-xl transition flex items-center justify-center gap-1.5"
          >
            <BookOpen size={16} />
            <span>Nasıl Oynanır? (Kurallar)</span>
          </button>

          {(() => {
            if (typeof window === 'undefined') return null;
            if (window.Capacitor?.isNativePlatform?.()) return null;
            const host = window.location.hostname;
            if (!host.endsWith('.github.io')) return null;
            const user = host.replace('.github.io', '');
            const repo = window.location.pathname.split('/').filter(Boolean)[0];
            if (!user || !repo) return null;
            const apkUrl = `https://github.com/${user}/${repo}/releases/latest/download/sehir-fethetme-oyunu.apk`;
            return (
              <a
                href={apkUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full py-2.5 bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-300 font-black text-xs rounded-xl transition flex items-center justify-center gap-1.5 shadow-xs active:scale-98"
              >
                <Download size={16} />
                <span>📱 Android APK İndir (Uygulama)</span>
              </a>
            );
          })()}
        </div>

      </div>
    </div>
  );
}
