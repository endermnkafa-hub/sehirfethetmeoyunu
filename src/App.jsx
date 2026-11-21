import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import GameSetup from './components/GameSetup';
import GameBoard from './components/GameBoard';
import TurnControls from './components/TurnControls';
import WheelModal from './components/WheelModal';
import DiplomacyModal from './components/DiplomacyModal';
import RulesModal from './components/RulesModal';
import DebugModal from './components/DebugModal';
import OnlineRoomModal from './components/OnlineRoomModal';
import { multiplayer } from './utils/multiplayer';
import {
  initializeBoardTerritories,
  countPlayerTerritories,
  canExpandToCell,
  canBuildWallOnCell,
  hasAnyValidPlacingMove,
  shrinkCountrySmart,
  transferTerritory,
  expandPlayerInstant,
  calculateMaxSafeNumber,
  PLAYER_COLORS,
} from './utils/gameLogic';
import { soundManager } from './utils/audio';
import confetti from 'canvas-confetti';
import { Volume2, VolumeX, BookOpen, RotateCcw, Trophy, Users, Shield, AlertTriangle, AlertCircle, Wrench, Wifi } from 'lucide-react';

export default function App() {
  const [gameState, setGameState] = useState('SETUP'); // 'SETUP' | 'PLAYING' | 'GAMEOVER'
  const [gameMode, setGameMode] = useState('KLASIK'); // 'KLASIK' | 'MODERN'
  const [players, setPlayers] = useState([]);
  const [grid, setGrid] = useState([]);
  const [walls, setWalls] = useState({}); // { 'x,y': true }
  const [gridWidth, setGridWidth] = useState(60);
  const [gridHeight, setGridHeight] = useState(60);

  // Turn management
  const [roundNumber, setRoundNumber] = useState(1);
  const [activePlayerIndex, setActivePlayerIndex] = useState(0);
  const [turnPhase, setTurnPhase] = useState('PICK_NUMBER'); // 'PICK_NUMBER' | 'PLACING' | 'WAITING'
  const [chosenNumber, setChosenNumber] = useState(2);
  const [totalToPlace, setTotalToPlace] = useState(0);
  const [placingMode, setPlacingMode] = useState('EXPAND'); // 'EXPAND' | 'WALL'
  const [pendingCells, setPendingCells] = useState([]);
  const [pendingWalls, setPendingWalls] = useState([]);
  const [turnHistory, setTurnHistory] = useState([]); // Unified undo stack for cells, walls, breaches
  const [wallAttack1Hit, setWallAttack1Hit] = useState(false); // Toggle: 1-hit wall demolish & conquer

  // Synchronous refs for 0-latency multi-step drag and Bresenham line painting
  const pendingCellsRef = useRef(pendingCells);
  const pendingWallsRef = useRef(pendingWalls);
  const wallsRef = useRef(walls);
  const turnHistoryRef = useRef(turnHistory);

  useEffect(() => { pendingCellsRef.current = pendingCells; }, [pendingCells]);
  useEffect(() => { pendingWallsRef.current = pendingWalls; }, [pendingWalls]);
  useEffect(() => { wallsRef.current = walls; }, [walls]);
  useEffect(() => { turnHistoryRef.current = turnHistory; }, [turnHistory]);

  // Modals & Popups
  const [isWheelOpen, setIsWheelOpen] = useState(false);
  const [isDiplomacyOpen, setIsDiplomacyOpen] = useState(false);
  const [isRulesOpen, setIsRulesOpen] = useState(false);
  const [isDebugOpen, setIsDebugOpen] = useState(false);
  const [isOnlineModalOpen, setIsOnlineModalOpen] = useState(false);
  const [fixedRoll, setFixedRoll] = useState(null); // Debug fixed wheel roll
  const [wheelRollData, setWheelRollData] = useState(null); // Synchronous roll target & jitter
  const [incomingProposal, setIncomingProposal] = useState(null); // Remote alliance proposal
  const [incomingCancelRequest, setIncomingCancelRequest] = useState(null); // Remote cancel request
  const [actionMessage, setActionMessage] = useState(null);
  const [breachPrompt, setBreachPrompt] = useState(null);

  // Online Multiplayer State
  const [onlineInfo, setOnlineInfo] = useState(null); // { isHost, roomCode, myPlayer }
  const [disconnectAlert, setDisconnectAlert] = useState(false);

  // Diplomacy
  const [alliances, setAlliances] = useState([]);

  // Audio mute
  const [soundEnabled, setSoundEnabled] = useState(true);

  // Winner
  const [winner, setWinner] = useState(null);

  const territoryCounts = grid.length > 0 && players.length > 0
    ? countPlayerTerritories(grid, players)
    : {};

  const activePlayer = players[activePlayerIndex] || { id: 1, name: 'Oyuncu 1', hex: '#2563eb' };
  const activePlayerArea = territoryCounts[activePlayer.id] || 0;
  const isMyTurn = !onlineInfo || activePlayer.phoneId === onlineInfo.myDevice;

  const broadcastToAll = (msg) => {
    if (!onlineInfo) return;
    if (onlineInfo.isHost) {
      multiplayer.broadcastState(msg);
    } else {
      multiplayer.sendAction(msg);
    }
  };

  const syncTurnAction = (newPendingCells, newPendingWalls, newWalls) => {
    if (!onlineInfo) return;
    broadcastToAll({
      type: 'LIVE_PENDING_SYNC',
      pendingCells: newPendingCells,
      pendingWalls: newPendingWalls,
      walls: newWalls,
    });
  };

  useEffect(() => {
    soundManager.enabled = soundEnabled;
  }, [soundEnabled]);

  const messageTimerRef = useRef(null);

  const showMessage = (msg, duration = 3500) => {
    if (messageTimerRef.current) {
      clearTimeout(messageTimerRef.current);
    }
    setActionMessage(msg);
    messageTimerRef.current = setTimeout(() => {
      setActionMessage(null);
      messageTimerRef.current = null;
    }, duration);
  };

  const hasValidMoves = useMemo(() => {
    if (turnPhase !== 'PLACING' || !isMyTurn) return true;
    const spent = pendingCells.reduce((sum, c) => sum + (c.cost || 1), 0) + pendingWalls.length;
    if (spent >= totalToPlace) return true;
    return hasAnyValidPlacingMove(grid, activePlayer.id, pendingCells, pendingWalls, walls, alliances, gameMode);
  }, [turnPhase, isMyTurn, grid, activePlayer.id, pendingCells, pendingWalls, walls, alliances, gameMode, totalToPlace]);

  const returnToSetup = (broadcastReset = false) => {
    if (broadcastReset && onlineInfo) {
      broadcastToAll({ type: 'RESET_GAME_SYNC' });
    }
    setTimeout(() => {
      multiplayer.cleanup();
    }, 50);
    setOnlineInfo(null);
    setDisconnectAlert(false);
    setIsWheelOpen(false);
    setIsDiplomacyOpen(false);
    setIsDebugOpen(false);
    setIncomingProposal(null);
    setIncomingCancelRequest(null);
    setBreachPrompt(null);
    setAlliances([]);
    setPendingCells([]);
    setPendingWalls([]);
    setTurnHistory([]);
    setTotalToPlace(0);
    setWinner(null);
    setGameState('SETUP');
  };

  const handleStartGame = ({ gameMode: mode, players: initPlayers, gridWidth: gw, gridHeight: gh, startSize }) => {
    multiplayer.cleanup();
    setOnlineInfo(null);
    setDisconnectAlert(false);
    const initGrid = initializeBoardTerritories(gw, gh, initPlayers, startSize);
    setGameMode(mode || 'KLASIK');
    setPlayers(initPlayers);
    setGridWidth(gw);
    setGridHeight(gh);
    setGrid(initGrid);
    setWalls({});
    setRoundNumber(1);
    setActivePlayerIndex(0);
    setTurnPhase('PICK_NUMBER');
    setChosenNumber(Math.min(2, calculateMaxSafeNumber(startSize * startSize)));
    setAlliances([]);
    setPendingCells([]);
    setPendingWalls([]);
    setTurnHistory([]);
    setTotalToPlace(0);
    setPlacingMode('EXPAND');
    setWinner(null);
    setGameState('PLAYING');
  };

  const advanceTurn = useCallback((currentGrid = grid, currentPlayers = players, currentWalls = walls, overrideAlliances = undefined) => {
    const alivePlayers = currentPlayers.filter(p => p.alive && (countPlayerTerritories(currentGrid, currentPlayers)[p.id] || 0) > 0);
    if (alivePlayers.length <= 1 && currentPlayers.length > 1) {
      const finalWinner = alivePlayers[0] || currentPlayers[0];
      setWinner(finalWinner);
      setGameState('GAMEOVER');
      soundManager.playWin();
      confetti({ particleCount: 150, spread: 80 });
      if (onlineInfo) {
        broadcastToAll({
          type: 'GAME_OVER_SYNC',
          winner: finalWinner,
          grid: currentGrid,
          walls: currentWalls,
          players: currentPlayers,
        });
      }
      return;
    }

    let currentAlliances = overrideAlliances !== undefined ? overrideAlliances : alliances;
    let nextIdx = (activePlayerIndex + 1) % currentPlayers.length;
    let newRound = roundNumber;
    let wrappedRound = (nextIdx === 0);

    let loops = 0;
    while (!currentPlayers[nextIdx].alive && loops < currentPlayers.length) {
      nextIdx = (nextIdx + 1) % currentPlayers.length;
      if (nextIdx === 0) wrappedRound = true;
      loops++;
    }

    if (wrappedRound) {
      newRound += 1;
      setRoundNumber(newRound);

      const updated = [];
      currentAlliances.forEach(a => {
        if (a.durationRounds > 0) {
          const rem = a.durationRounds - 1;
          if (rem > 0) {
            updated.push({ ...a, durationRounds: rem });
          } else {
            showMessage(`Bir ittifakın süresi doldu ve sona erdi!`, 4000);
          }
        } else {
          updated.push(a);
        }
      });
      currentAlliances = updated;
      setAlliances(currentAlliances);
    } else if (overrideAlliances !== undefined) {
      setAlliances(currentAlliances);
    }

    const nextArea = countPlayerTerritories(currentGrid, currentPlayers)[currentPlayers[nextIdx].id] || 1;
    const maxSafe = calculateMaxSafeNumber(nextArea);
    const nextChosen = Math.min(2, maxSafe);

    setActivePlayerIndex(nextIdx);
    setTurnPhase('PICK_NUMBER');
    setChosenNumber(nextChosen);
    setPendingCells([]);
    setPendingWalls([]);
    setTurnHistory([]);
    setTotalToPlace(0);
    setPlacingMode('EXPAND');

    if (onlineInfo) {
      broadcastToAll({
        type: 'TURN_FINISH_SYNC',
        grid: currentGrid,
        walls: currentWalls,
        players: currentPlayers,
        roundNumber: newRound,
        activePlayerIndex: nextIdx,
        alliances: currentAlliances,
        chosenNumber: nextChosen,
      });
    }
  }, [activePlayerIndex, grid, players, roundNumber, walls, alliances, onlineInfo]);

  const handleSelectChosenNumber = (num) => {
    setChosenNumber(num);
    if (onlineInfo) {
      broadcastToAll({
        type: 'CHOSEN_NUMBER_SYNC',
        chosenNumber: num,
      });
    }
  };

  const handleStartSpin = () => {
    if (!isMyTurn || turnPhase !== 'PICK_NUMBER' || isWheelOpen) return;

    const maxSafe = calculateMaxSafeNumber(activePlayerArea);
    const safeChosen = Math.min(chosenNumber, maxSafe);
    if (safeChosen !== chosenNumber) {
      setChosenNumber(safeChosen);
    }

    // Active player rolls uniformly
    const roll = fixedRoll !== null ? fixedRoll : Math.floor(Math.random() * 10);
    const jitter = Math.floor(Math.random() * 19) - 9;
    const fullSpins = 10 + Math.floor(Math.random() * 3);
    const rollData = { target: roll, jitter, fullSpins };

    setWheelRollData(rollData);
    setIsWheelOpen(true);

    if (onlineInfo) {
      broadcastToAll({
        type: 'WHEEL_SPIN_SYNC',
        phase: 'SPINNING',
        chosenNumber: safeChosen,
        rollData,
      });
    }
  };

  const handleWheelFinish = ({ resultNumber, outcome, diff }) => {
    if (!isMyTurn) return;
    setIsWheelOpen(false);

    if (onlineInfo) {
      broadcastToAll({
        type: 'WHEEL_SPIN_SYNC',
        phase: 'FINISHED',
        chosenNumber,
        resultNumber,
        diff,
        outcome,
      });
    }

    if (outcome === 'draw') {
      setTurnPhase('WAITING');
      showMessage('Çark 0 geldi! Ne kazanç ne kayıp. Sıradaki oyuncuya geçiliyor.');
      setTimeout(() => {
        advanceTurn();
      }, 1000);
    } else if (outcome === 'win') {
      setTotalToPlace(diff);
      setPendingCells([]);
      setPendingWalls([]);
      setTurnHistory([]);
      setTurnPhase('PLACING');
      setPlacingMode('EXPAND');
      showMessage(`Harika! ${diff} puan kazandın.`);
    } else if (outcome === 'lose') {
      soundManager.playEraser();
      const { newGrid, newWalls, removedCells } = shrinkCountrySmart(grid, activePlayer.id, diff, walls);
      setGrid(newGrid);
      setWalls(newWalls);

      const remainingCount = countPlayerTerritories(newGrid, players)[activePlayer.id] || 0;
      if (remainingCount <= 0) {
        showMessage(`${activePlayer.name} tüm topraklarını kaybederek elendi!`, 4000);
        const updatedPlayers = players.map(p => p.id === activePlayer.id ? { ...p, alive: false } : p);
        setPlayers(updatedPlayers);
        const nextAlliances = alliances.filter(a => a.player1Id !== activePlayer.id && a.player2Id !== activePlayer.id);
        setAlliances(nextAlliances);
        advanceTurn(newGrid, updatedPlayers, newWalls, nextAlliances);
      } else {
        setTurnPhase('WAITING');
        showMessage(`Kayıp! Ülken dış sınırlardan ${removedCells.length} kare küçüldü.`);
        setTimeout(() => {
          advanceTurn(newGrid, players, newWalls);
        }, 1200);
      }
    }
  };

  // Build a Wall in Modern Mode (Costs 1 point)
  const handleBuildWall = (x, y) => {
    if (!isMyTurn || gameMode !== 'MODERN') return { valid: false };
    const curPendingCells = pendingCellsRef.current;
    const curPendingWalls = pendingWallsRef.current;
    const curWalls = wallsRef.current;

    const spent = curPendingCells.reduce((sum, c) => sum + (c.cost || 1), 0) + curPendingWalls.length;
    if (totalToPlace - spent < 1) {
      showMessage('Duvar örmek için en az 1 puanın olmalı!');
      return { valid: false, reason: 'Puanın kalmadı' };
    }

    const currentWallsMap = { ...curWalls };
    curPendingWalls.forEach(w => currentWallsMap[`${w.x},${w.y}`] = true);

    const check = canBuildWallOnCell(grid, activePlayer.id, x, y, currentWallsMap, curPendingCells);
    if (!check.valid) {
      showMessage(check.reason, 2500);
      return { valid: false, reason: check.reason };
    }

    soundManager.playPencil();
    const updatedWalls = [...curPendingWalls, { x, y }];
    const updatedHistory = [...turnHistoryRef.current, { type: 'WALL', x, y }];

    pendingWallsRef.current = updatedWalls;
    turnHistoryRef.current = updatedHistory;

    setPendingWalls(updatedWalls);
    setTurnHistory(updatedHistory);
    showMessage('🛡️ Sınırına Sur/Duvar eklendi (1 Hak harcandı).', 2000);
    syncTurnAction(curPendingCells, updatedWalls, curWalls);
    return { valid: true };
  };

  // Handle cell click / drag paint on GameBoard
  const handleCellClick = (x, y) => {
    if (!isMyTurn || turnPhase !== 'PLACING') return { valid: false };

    const curPendingCells = pendingCellsRef.current;
    const curPendingWalls = pendingWallsRef.current;
    const curWalls = wallsRef.current;

    const spent = curPendingCells.reduce((sum, c) => sum + (c.cost || 1), 0) + curPendingWalls.length;
    const remaining = totalToPlace - spent;
    if (remaining < 1) return { valid: false, reason: 'Tüm haklarını kullandın' };

    const key = `${x},${y}`;
    const breachedIdx = curPendingCells.findIndex(c => c.x === x && c.y === y && c.isWallBreachOnly);

    // 1. Second hit on a cell whose wall was breached this turn: Conquer it! (costs 1 point)
    if (breachedIdx !== -1) {
      const pendingExcludingBreach = curPendingCells.filter((_, i) => i !== breachedIdx);
      const check = canExpandToCell(grid, activePlayer.id, x, y, pendingExcludingBreach, alliances);
      if (!check.valid) {
        showMessage(check.reason, 2500);
        return { valid: false, reason: check.reason };
      }
      soundManager.playPencil();
      const updatedPending = curPendingCells.map((c, i) => i === breachedIdx ? {
        x,
        y,
        cost: 2,
        isWallBreachOnly: false,
        wasBreachedThisTurn: true,
        previousOwner: grid[y][x],
        isAllianceAttack: check.isAllianceAttack,
        targetOwner: check.targetOwner,
        playerId: activePlayer.id,
      } : c);
      const updatedHistory = [...turnHistoryRef.current, { type: 'CONQUER_BREACHED', x, y }];

      pendingCellsRef.current = updatedPending;
      turnHistoryRef.current = updatedHistory;

      setPendingCells(updatedPending);
      setTurnHistory(updatedHistory);
      showMessage('⚔️ Suru yıkılan toprağı fethettin! (1 Hak harcandı)', 2500);
      syncTurnAction(updatedPending, curPendingWalls, curWalls);
      return { valid: true };
    }

    // 2. Must be adjacent to active player's territory or conquered pending cells
    const check = canExpandToCell(grid, activePlayer.id, x, y, curPendingCells, alliances);
    if (!check.valid) {
      showMessage(check.reason, 2500);
      return { valid: false, reason: check.reason };
    }

    // 3. Target is an enemy cell with a Wall!
    if (curWalls[key] && grid[y][x] !== activePlayer.id) {
      if (wallAttack1Hit || remaining >= 2) {
        // Demolish wall AND conquer cell in this attack!
        const cost = wallAttack1Hit ? 1 : 2;
        const newWalls = { ...curWalls };
        delete newWalls[key];

        soundManager.playEraser();
        setTimeout(() => soundManager.playPencil(), 80);

        const newEntry = {
          x,
          y,
          cost,
          isWallDemolished: true,
          previousOwner: grid[y][x],
          isAllianceAttack: check.isAllianceAttack,
          targetOwner: check.targetOwner,
          playerId: activePlayer.id,
        };
        const updatedPending = [...curPendingCells, newEntry];
        const updatedHistory = [...turnHistoryRef.current, { type: 'WALL_CONQUER_2PT', x, y, key, cost }];

        wallsRef.current = newWalls;
        pendingCellsRef.current = updatedPending;
        turnHistoryRef.current = updatedHistory;

        setWalls(newWalls);
        setPendingCells(updatedPending);
        setTurnHistory(updatedHistory);

        showMessage(cost === 1 ? '💥🛡️ Sur yıkıldı ve toprak fethedildi! (1 Hak)' : '💥🛡️ Düşmanın surunu yıktın ve toprağını fethettin! (2 Hak)', 3000);
        syncTurnAction(updatedPending, curPendingWalls, newWalls);
        return { valid: true };
      } else {
        // Player only has 1 point: Demolish the wall (costs 1 point)
        const newWalls = { ...curWalls };
        delete newWalls[key];

        soundManager.playEraser();
        const newEntry = {
          x,
          y,
          cost: 1,
          isWallBreachOnly: true,
          wallKey: key,
          previousOwner: grid[y][x],
          isAllianceAttack: check.isAllianceAttack,
          targetOwner: check.targetOwner,
          playerId: activePlayer.id,
        };
        const updatedPending = [...curPendingCells, newEntry];
        const updatedHistory = [...turnHistoryRef.current, { type: 'BREACH', x, y, cellKey: key }];

        wallsRef.current = newWalls;
        pendingCellsRef.current = updatedPending;
        turnHistoryRef.current = updatedHistory;

        setWalls(newWalls);
        setPendingCells(updatedPending);
        setTurnHistory(updatedHistory);

        if (check.isAllianceAttack) {
          const ally = players.find(p => p.id === check.targetOwner);
          showMessage(`⚠️ Müttefikin ${ally?.name || ''} surunu yıktın! Turu onaylarken ittifak bozulup ceza uygulanacak.`, 3500);
        } else {
          showMessage('💥 Düşmanın surunu yıktın! (1 Hak harcandı. Kare hâlâ rakipte, fethetmek için 1 hak daha gerekir).', 3500);
        }
        syncTurnAction(updatedPending, curPendingWalls, newWalls);
        return { valid: true };
      }
    }

    // 4. Normal Expansion / Attack (No wall)
    soundManager.playPencil();
    const newCell = {
      x,
      y,
      cost: 1,
      previousOwner: grid[y][x],
      isAllianceAttack: check.isAllianceAttack,
      targetOwner: check.targetOwner,
      playerId: activePlayer.id,
    };
    const updatedPending = [...curPendingCells, newCell];
    const updatedHistory = [...turnHistoryRef.current, { type: 'CELL', x, y }];

    pendingCellsRef.current = updatedPending;
    turnHistoryRef.current = updatedHistory;

    setPendingCells(updatedPending);
    setTurnHistory(updatedHistory);
    syncTurnAction(updatedPending, curPendingWalls, curWalls);

    if (check.isAllianceAttack) {
      const ally = players.find(p => p.id === check.targetOwner);
      showMessage(`⚠️ Müttefikin ${ally?.name || ''} karesini seçtin. Turu onaylarken ceza uygulanacak.`, 2500);
    }
    return { valid: true };
  };

  const finalizeTurnPlacing = (penaltyCells = 0, allianceIdsToDissolve = null) => {
    let newGrid = grid.map(row => [...row]);
    let newWalls = { ...walls };

    pendingCells.forEach(cell => {
      if (!cell.isWallBreachOnly) {
        newGrid[cell.y][cell.x] = activePlayer.id;
      }
    });

    pendingWalls.forEach(w => {
      newWalls[`${w.x},${w.y}`] = true;
    });

    let nextAlliances = alliances;
    if (allianceIdsToDissolve) {
      const ids = Array.isArray(allianceIdsToDissolve) ? allianceIdsToDissolve : [allianceIdsToDissolve];
      nextAlliances = alliances.filter(a => !ids.includes(a.id));
      setAlliances(nextAlliances);
    }

    if (penaltyCells > 0) {
      const currentArea = countPlayerTerritories(newGrid, players)[activePlayer.id] || 0;

      if (currentArea <= penaltyCells) {
        // Delete all walls belonging to the eliminated player before clearing their territory
        Object.keys(newWalls).forEach(key => {
          const [wx, wy] = key.split(',').map(Number);
          if (newGrid[wy] && newGrid[wy][wx] === activePlayer.id) {
            delete newWalls[key];
          }
        });
        newGrid = newGrid.map(row => row.map(cell => cell === activePlayer.id ? 0 : cell));
        nextAlliances = nextAlliances.filter(a => a.player1Id !== activePlayer.id && a.player2Id !== activePlayer.id);
        setGrid(newGrid);
        setWalls(newWalls);
        setAlliances(nextAlliances);
        const updatedPlayers = players.map(p => p.id === activePlayer.id ? { ...p, alive: false } : p);
        setPlayers(updatedPlayers);
        showMessage(`${activePlayer.name} ittifak cezasını (${penaltyCells} kare) karşılayamadığı için elendi!`, 4500);
        advanceTurn(newGrid, updatedPlayers, newWalls, nextAlliances);
        return;
      } else {
        const { newGrid: shrunkGrid, newWalls: shrunkWalls } = shrinkCountrySmart(newGrid, activePlayer.id, penaltyCells, newWalls);
        newGrid = shrunkGrid;
        newWalls = shrunkWalls;
        showMessage(`İttifak cezası olarak sınırlarından ${penaltyCells} kare havaya terk edildi.`, 4000);
      }
    }

    // Modern Mode: Automatic Tribute (Haraç / Vergi) payment for all active tribute alliances
    if (gameMode === 'MODERN') {
      const tributeAlliances = nextAlliances.filter(
        a => a.status === 'active' && a.type === 'TRIBUTE' &&
             ((a.payerId ? a.payerId === activePlayer.id : a.player1Id === activePlayer.id))
      );
      tributeAlliances.forEach((tributeAlliance) => {
        const patronId = tributeAlliance.patronId || (tributeAlliance.payerId === tributeAlliance.player1Id ? tributeAlliance.player2Id : tributeAlliance.player1Id);
        const patron = players.find(p => p.id === patronId);
        const patronAlive = patron && patron.alive && (countPlayerTerritories(newGrid, players)[patron.id] || 0) > 0;

        if (!patronAlive) {
          nextAlliances = nextAlliances.filter(a => a.id !== tributeAlliance.id);
          setAlliances(nextAlliances);
          showMessage(`⚠️ ${patron?.name || 'Müttefik'} elendiği için haraç anlaşması feshedildi.`, 4000);
        } else {
          const myArea = countPlayerTerritories(newGrid, players)[activePlayer.id] || 0;
          const requestedAmount = tributeAlliance.tributeAmount || 1;

          if (myArea <= 1) {
            showMessage(`⚠️ ${activePlayer.name} sadece 1 karesi kaldığı için bu tur haraç ödeyemedi (yok edilemez).`, 4000);
          } else {
            const safeAmount = Math.min(requestedAmount, myArea - 1);
            const { newGrid: tGrid, newWalls: tWalls, transferred } = transferTerritory(
              newGrid,
              activePlayer.id,
              patronId,
              safeAmount,
              newWalls
            );
            if (transferred.length > 0) {
              newGrid = tGrid;
              newWalls = tWalls;
              soundManager.playPencil();
              showMessage(`💰 ${activePlayer.name}, müttefiki ${patron.name} devletine ${transferred.length} kare vergi/haraç ödedi!`, 4000);
            } else {
              showMessage(`⚠️ ${activePlayer.name} ile ${patron.name} arasında ortak sınır kalmadığı için bu tur vergi ödenemedi (sınır teması yok).`, 4000);
            }
          }
        }
      });
    }

    const counts = countPlayerTerritories(newGrid, players);
    const updatedPlayers = players.map(p => {
      const area = counts[p.id] || 0;
      return { ...p, alive: area > 0 };
    });

    players.forEach(p => {
      if (p.alive && (counts[p.id] || 0) === 0 && p.id !== activePlayer.id) {
        soundManager.playWin();
        confetti({ particleCount: 120, spread: 70 });
        showMessage(`🏆 ${p.name} tamamen fethedilerek oyundan elendi!`, 5000);
        nextAlliances = nextAlliances.filter(a => a.player1Id !== p.id && a.player2Id !== p.id);
        setAlliances(nextAlliances);
      }
    });

    setPlayers(updatedPlayers);
    setGrid(newGrid);
    setWalls(newWalls);
    soundManager.playPencil();
    advanceTurn(newGrid, updatedPlayers, newWalls, nextAlliances);
  };

  const handleConfirmBreach = () => {
    if (!breachPrompt) return;
    const { penaltyCells, allianceIds, allianceId } = breachPrompt;
    setBreachPrompt(null);
    finalizeTurnPlacing(penaltyCells, allianceIds || allianceId);
  };

  const handleUndo = () => {
    if (!isMyTurn) return;
    const curHistory = turnHistoryRef.current;
    if (curHistory.length === 0) return;
    soundManager.playEraser();
    const lastAction = curHistory[curHistory.length - 1];
    const nextHistory = curHistory.slice(0, -1);
    turnHistoryRef.current = nextHistory;
    setTurnHistory(nextHistory);

    let nextPendingCells = pendingCellsRef.current;
    let nextPendingWalls = pendingWallsRef.current;
    let nextWalls = wallsRef.current;

    if (lastAction.type === 'WALL_CONQUER_2PT') {
      nextWalls = { ...nextWalls, [lastAction.key]: true };
      nextPendingCells = nextPendingCells.filter(c => !(c.x === lastAction.x && c.y === lastAction.y));
    } else if (lastAction.type === 'BREACH') {
      nextWalls = { ...nextWalls, [lastAction.cellKey]: true };
      nextPendingCells = nextPendingCells.filter(c => !(c.x === lastAction.x && c.y === lastAction.y));
    } else if (lastAction.type === 'CONQUER_BREACHED') {
      nextPendingCells = nextPendingCells.map(c => (c.x === lastAction.x && c.y === lastAction.y) ? { ...c, isWallBreachOnly: true, cost: 1 } : c);
    } else if (lastAction.type === 'WALL') {
      nextPendingWalls = nextPendingWalls.filter(w => !(w.x === lastAction.x && w.y === lastAction.y));
    } else if (lastAction.type === 'CELL') {
      nextPendingCells = nextPendingCells.filter(c => !(c.x === lastAction.x && c.y === lastAction.y));
    }

    pendingCellsRef.current = nextPendingCells;
    pendingWallsRef.current = nextPendingWalls;
    wallsRef.current = nextWalls;

    setPendingCells(nextPendingCells);
    setPendingWalls(nextPendingWalls);
    setWalls(nextWalls);

    syncTurnAction(nextPendingCells, nextPendingWalls, nextWalls);
  };

  const handleFinishPlacing = () => {
    if (!isMyTurn) return;
    const spent = pendingCells.reduce((sum, c) => sum + (c.cost || 1), 0) + pendingWalls.length;
    if (spent !== totalToPlace && hasValidMoves) return;

    const breachCells = pendingCells.filter(c => c.isAllianceAttack);
    if (breachCells.length > 0) {
      const breachedMap = new Map();
      breachCells.forEach(c => {
        const alliance = alliances.find(a => 
          a.status === 'active' && 
          ((a.player1Id === activePlayer.id && a.player2Id === c.targetOwner) ||
           (a.player2Id === activePlayer.id && a.player1Id === c.targetOwner))
        );
        if (alliance && !breachedMap.has(alliance.id)) {
          const ally = players.find(p => p.id === c.targetOwner);
          breachedMap.set(alliance.id, { alliance, ally });
        }
      });

      if (breachedMap.size > 0) {
        const breachedList = Array.from(breachedMap.values());
        const totalPenalty = breachedList.reduce((sum, item) => sum + (item.alliance.penaltyCells || 1), 0);
        const allianceIds = breachedList.map(item => item.alliance.id);
        const allyNames = breachedList.map(item => item.ally?.name).filter(Boolean).join(', ');
        const conqueredCount = pendingCells.filter(c => !c.isWallBreachOnly && grid[c.y][c.x] !== activePlayer.id).length;
        const projectedArea = activePlayerArea + conqueredCount;
        setBreachPrompt({
          allyNames,
          ally: breachedList[0]?.ally,
          penaltyCells: totalPenalty,
          allianceIds,
          projectedArea,
        });
        return;
      }
    }

    finalizeTurnPlacing(0, null);
  };

  // Territory Transfer in Modern Mode
  const handleTransferTerritory = (fromId, toId, amount) => {
    const { newGrid, newWalls, transferred } = transferTerritory(grid, fromId, toId, amount, walls);
    if (transferred.length === 0) {
      showMessage('Toprak devredilemedi (Sınır komşusu değilsiniz veya bütünlük bozuluyor)!', 3500);
      return;
    }
    setGrid(newGrid);
    setWalls(newWalls);
    const fromP = players.find(p => p.id === fromId);
    const toP = players.find(p => p.id === toId);
    const transferMsg = `${fromP?.name || 'Oyuncu'}, ${toP?.name || 'müttefikine'} ${transferred.length} kare toprak devretti!`;
    showMessage(transferMsg, 3500);
    if (onlineInfo) {
      broadcastToAll({
        type: 'DIPLOMACY_SYNC',
        grid: newGrid,
        walls: newWalls,
        message: transferMsg,
      });
    }
  };

  const handleProposeAlliance = (newAlliance) => {
    const created = { ...newAlliance, id: Date.now() };
    const updated = [...alliances, created];
    setAlliances(updated);
    showMessage('Anlaşma başarıyla kuruldu!', 3000);
    if (onlineInfo) {
      broadcastToAll({
        type: 'DIPLOMACY_SYNC',
        alliances: updated,
      });
    }
  };

  const handleCancelMutualAlliance = (allianceId) => {
    const updated = alliances.filter(a => a.id !== allianceId);
    setAlliances(updated);
    showMessage('Anlaşma iki tarafın rızasıyla cezasız sonlandırıldı.', 3000);
    if (onlineInfo) {
      broadcastToAll({
        type: 'DIPLOMACY_SYNC',
        alliances: updated,
      });
    }
  };

  const handleSendOnlineProposal = (proposalData) => {
    broadcastToAll({
      type: 'DIPLOMACY_PROPOSAL',
      proposal: proposalData,
    });
  };

  const handleSendOnlineCancel = (alliance, proposer, ally) => {
    broadcastToAll({
      type: 'DIPLOMACY_CANCEL_PROPOSAL',
      alliance,
      proposer,
      ally,
    });
  };

  const handleAcceptIncomingProposal = (proposal) => {
    const newAlliance = {
      id: Date.now(),
      player1Id: proposal.proposer.id,
      player2Id: proposal.target.id,
      payerId: proposal.payerId || proposal.proposer.id,
      patronId: proposal.patronId || proposal.target.id,
      durationRounds: proposal.durationRounds,
      penaltyCells: proposal.penaltyCells,
      type: proposal.type || 'PEACE',
      tributeAmount: proposal.tributeAmount || 0,
      status: 'active',
    };

    setAlliances(prev => [...prev.filter(a => a.id !== newAlliance.id), newAlliance]);
    setIncomingProposal(null);
    soundManager.playWin();
    confetti({ particleCount: 90, spread: 60 });
    const successMsg = `🤝 ${proposal.proposer.name} ile ${proposal.target.name} arasında ittifak kuruldu!`;
    showMessage(successMsg, 4000);

    broadcastToAll({
      type: 'DIPLOMACY_PROPOSAL_RESPONSE',
      proposalId: proposal.id,
      accepted: true,
      alliance: newAlliance,
      message: successMsg,
    });
  };

  const handleRejectIncomingProposal = (proposal) => {
    setIncomingProposal(null);
    const rejectMsg = `${proposal.target.name} ittifak teklifini reddetti.`;
    showMessage(rejectMsg, 3000);

    broadcastToAll({
      type: 'DIPLOMACY_PROPOSAL_RESPONSE',
      proposalId: proposal.id,
      accepted: false,
      message: rejectMsg,
    });
  };

  const handleAcceptIncomingCancel = (request) => {
    setAlliances(prev => prev.filter(a => a.id !== request.alliance.id));
    setIncomingCancelRequest(null);
    const cancelMsg = `Anlaşma barışçıl şekilde sonlandırıldı.`;
    showMessage(cancelMsg, 3500);

    broadcastToAll({
      type: 'DIPLOMACY_CANCEL_RESPONSE',
      allianceId: request.alliance.id,
      accepted: true,
      message: cancelMsg,
    });
  };

  const handleRejectIncomingCancel = (request) => {
    setIncomingCancelRequest(null);
    const msg = `Fesih talebi reddedildi. Anlaşma devam ediyor.`;
    showMessage(msg, 3000);

    broadcastToAll({
      type: 'DIPLOMACY_CANCEL_RESPONSE',
      accepted: false,
      message: msg,
    });
  };

  // Instant auto-expansion for Debug/Testing
  const handleInstantExpand = (playerId, amount) => {
    const { newGrid, added } = expandPlayerInstant(grid, playerId, amount);
    if (added > 0) {
      setGrid(newGrid);
      const target = players.find(p => p.id === playerId);
      soundManager.playPencil();
      showMessage(`${target?.name || 'Oyuncu'} için +${added} kare otomatik eklendi!`, 3000);
      if (onlineInfo) {
        broadcastToAll({
          type: 'SYNC_STATE',
          grid: newGrid,
          walls,
          players,
          roundNumber,
          activePlayerIndex,
        });
      }
    } else {
      showMessage('Genişleyecek uygun boş alan bulunamadı!', 2500);
    }
  };

  // Instant Kill/Eliminate Player for Debug/Testing
  const handleEliminatePlayer = (targetId) => {
    let newGrid = grid.map(row => row.map(cell => cell === targetId ? activePlayer.id : cell));
    const newWalls = { ...walls };
    Object.keys(newWalls).forEach(key => {
      const [wx, wy] = key.split(',').map(Number);
      if (grid[wy][wx] === targetId) delete newWalls[key];
    });

    const updatedPlayers = players.map(p => p.id === targetId ? { ...p, alive: false } : p);
    const nextAlliances = alliances.filter(a => a.player1Id !== targetId && a.player2Id !== targetId);
    setPlayers(updatedPlayers);
    setAlliances(nextAlliances);
    setGrid(newGrid);
    setWalls(newWalls);
    soundManager.playWin();
    confetti({ particleCount: 150, spread: 80 });
    const target = players.find(p => p.id === targetId);
    showMessage(`⚡ ${target?.name || 'Oyuncu'} hile ile tamamen fethedilerek elendi!`, 4000);
    advanceTurn(newGrid, updatedPlayers, newWalls, nextAlliances);
  };

  // Online Multiplayer State Listener for Both Host & Client
  useEffect(() => {
    if (!onlineInfo) return;

    const handleIncomingSync = (msg) => {
      if (!msg) return;

      if (msg.type === 'START_GAME') {
        pendingCellsRef.current = [];
        pendingWallsRef.current = [];
        turnHistoryRef.current = [];
        setGameMode(msg.gameMode || 'KLASIK');
        setPlayers(msg.players || []);
        setGrid(msg.grid || []);
        setWalls(msg.walls || {});
        setRoundNumber(msg.roundNumber || 1);
        setActivePlayerIndex(msg.activePlayerIndex || 0);
        setGridWidth(msg.grid?.[0]?.length || 60);
        setGridHeight(msg.grid?.length || 60);
        setTurnPhase('PICK_NUMBER');
        setChosenNumber(2);
        setAlliances([]);
        setWinner(null);
        setDisconnectAlert(false);
        setIncomingProposal(null);
        setIncomingCancelRequest(null);
        setPendingCells([]);
        setPendingWalls([]);
        setTurnHistory([]);
        setTotalToPlace(0);
        setGameState('PLAYING');
      } else if (msg.type === 'LIVE_PENDING_SYNC') {
        if (msg.pendingCells !== undefined) setPendingCells(msg.pendingCells);
        if (msg.pendingWalls !== undefined) setPendingWalls(msg.pendingWalls);
        if (msg.walls !== undefined) setWalls(msg.walls);
      } else if (msg.type === 'WHEEL_SPIN_SYNC') {
        if (msg.chosenNumber !== undefined) setChosenNumber(msg.chosenNumber);
        if (msg.phase === 'SPINNING') {
          if (msg.rollData) setWheelRollData(msg.rollData);
          setIsWheelOpen(true);
        } else if (msg.phase === 'FINISHED') {
          setIsWheelOpen(false);
          if (msg.outcome === 'win') {
            setTotalToPlace(msg.diff);
            setPendingCells([]);
            setPendingWalls([]);
            setTurnHistory([]);
            setTurnPhase('PLACING');
            setPlacingMode('EXPAND');
          } else if (msg.outcome === 'draw') {
            setTurnPhase('PICK_NUMBER');
          }
        }
      } else if (msg.type === 'DIPLOMACY_PROPOSAL') {
        const p = msg.proposal;
        if (!onlineInfo || p?.target?.phoneId === onlineInfo.myDevice) {
          setIncomingProposal(p);
          soundManager.playTick();
        }
      } else if (msg.type === 'DIPLOMACY_PROPOSAL_RESPONSE') {
        setIsDiplomacyOpen(false);
        if (msg.accepted && msg.alliance) {
          setAlliances(prev => [...prev.filter(a => a.id !== msg.alliance.id), msg.alliance]);
          soundManager.playWin();
          confetti({ particleCount: 90, spread: 60 });
        }
        if (msg.message) showMessage(msg.message, 3500);
      } else if (msg.type === 'DIPLOMACY_PROPOSAL_ABORTED') {
        setIncomingProposal(null);
        showMessage('İttifak teklifi gönderen tarafından iptal edildi.', 2500);
      } else if (msg.type === 'DIPLOMACY_CANCEL_PROPOSAL') {
        if (!onlineInfo || msg.ally?.phoneId === onlineInfo.myDevice) {
          setIncomingCancelRequest(msg);
          soundManager.playTick();
        }
      } else if (msg.type === 'DIPLOMACY_CANCEL_ABORTED') {
        setIncomingCancelRequest(null);
        showMessage('Fesih isteği gönderen tarafından iptal edildi.', 2500);
      } else if (msg.type === 'DIPLOMACY_CANCEL_RESPONSE') {
        setIsDiplomacyOpen(false);
        if (msg.accepted && msg.allianceId) {
          setAlliances(prev => prev.filter(a => a.id !== msg.allianceId));
        }
        if (msg.message) showMessage(msg.message, 3500);
      } else if (msg.type === 'TURN_FINISH_SYNC') {
        if (msg.grid) setGrid(msg.grid);
        if (msg.walls) setWalls(msg.walls);
        if (msg.players) setPlayers(msg.players);
        if (msg.roundNumber !== undefined) setRoundNumber(msg.roundNumber);
        if (msg.activePlayerIndex !== undefined) setActivePlayerIndex(msg.activePlayerIndex);
        if (msg.alliances) setAlliances(msg.alliances);
        if (msg.chosenNumber !== undefined) setChosenNumber(msg.chosenNumber);
        pendingCellsRef.current = [];
        pendingWallsRef.current = [];
        turnHistoryRef.current = [];
        setPendingCells([]);
        setPendingWalls([]);
        setTurnHistory([]);
        setTotalToPlace(0);
        setTurnPhase('PICK_NUMBER');
        setPlacingMode('EXPAND');
        if (msg.message) showMessage(msg.message, 3500);
      } else if (msg.type === 'DIPLOMACY_SYNC') {
        if (msg.alliances) setAlliances(msg.alliances);
        if (msg.grid) setGrid(msg.grid);
        if (msg.walls) setWalls(msg.walls);
        if (msg.message) showMessage(msg.message, 3000);
      } else if (msg.type === 'CHOSEN_NUMBER_SYNC') {
        if (msg.chosenNumber !== undefined) setChosenNumber(msg.chosenNumber);
      } else if (msg.type === 'GAME_OVER_SYNC') {
        if (msg.grid) setGrid(msg.grid);
        if (msg.walls) setWalls(msg.walls);
        if (msg.players) setPlayers(msg.players);
        if (msg.winner) setWinner(msg.winner);
        pendingCellsRef.current = [];
        pendingWallsRef.current = [];
        turnHistoryRef.current = [];
        setPendingCells([]);
        setPendingWalls([]);
        setTurnHistory([]);
        setGameState('GAMEOVER');
        soundManager.playWin();
        confetti({ particleCount: 150, spread: 80 });
      } else if (msg.type === 'RESET_GAME_SYNC') {
        returnToSetup(false);
        showMessage('Oyun yeniden başlatıldı, ana menüye dönüldü.', 3500);
      } else if (msg.type === 'SYNC_STATE') {
        if (msg.grid) setGrid(msg.grid);
        if (msg.walls) setWalls(msg.walls);
        if (msg.players) setPlayers(msg.players);
        if (msg.roundNumber !== undefined) setRoundNumber(msg.roundNumber);
        if (msg.activePlayerIndex !== undefined) setActivePlayerIndex(msg.activePlayerIndex);
        if (msg.alliances) setAlliances(msg.alliances);
        if (msg.totalToPlace !== undefined) setTotalToPlace(msg.totalToPlace);
        if (msg.turnPhase !== undefined) setTurnPhase(msg.turnPhase);
        if (msg.wallAttack1Hit !== undefined) setWallAttack1Hit(msg.wallAttack1Hit);
        if (msg.pendingCells !== undefined) setPendingCells(msg.pendingCells);
        if (msg.pendingWalls !== undefined) setPendingWalls(msg.pendingWalls);
      }
    };

    multiplayer.onPeerDisconnected = () => {
      setDisconnectAlert(true);
    };

    if (onlineInfo.isHost) {
      multiplayer.onActionReceived = (action) => {
        handleIncomingSync(action);
        multiplayer.broadcastState(action);
      };
    } else {
      multiplayer.onStateChange = (msg) => {
        handleIncomingSync(msg);
      };
    }

    return () => {
      multiplayer.onPeerDisconnected = null;
    };
  }, [onlineInfo]);

  // Online Game Starter Callback
  const handleStartOnlineGame = ({ isHost, roomCode, myDevice, joinedPlayers, initialState, roomSettings }) => {
    if (isHost) {
      const initPlayers = joinedPlayers.map((p, idx) => ({
        ...PLAYER_COLORS[idx] || PLAYER_COLORS[0],
        id: idx + 1,
        name: p.name || `Oyuncu ${idx + 1}`,
        phoneId: p.phoneId || (idx < 2 ? 'HOST' : 'CLIENT'),
        alive: true,
      }));
      const gWidth = roomSettings?.gridSize || 60;
      const gHeight = roomSettings?.gridSize || 60;
      const sSize = roomSettings?.startSize || 3;
      const gMode = roomSettings?.gameMode || 'KLASIK';

      const initGrid = initializeBoardTerritories(gWidth, gHeight, initPlayers, sSize);
      setGameMode(gMode);
      setPlayers(initPlayers);
      setGridWidth(gWidth);
      setGridHeight(gHeight);
      setGrid(initGrid);
      setWalls({});
      setRoundNumber(1);
      setActivePlayerIndex(0);
      setTurnPhase('PICK_NUMBER');
      setChosenNumber(2);
      setAlliances([]);
      setPendingCells([]);
      setPendingWalls([]);
      setTurnHistory([]);
      setTotalToPlace(0);
      setPlacingMode('EXPAND');
      setWinner(null);
      setGameState('PLAYING');
      setOnlineInfo({ isHost: true, roomCode, myDevice: 'HOST' });

      multiplayer.broadcastState({
        type: 'START_GAME',
        gameMode: gMode,
        players: initPlayers,
        grid: initGrid,
        walls: {},
        roundNumber: 1,
        activePlayerIndex: 0,
      });
    } else {
      setOnlineInfo({ isHost: false, roomCode, myDevice: 'CLIENT' });
      setAlliances([]);
      setPendingCells([]);
      setPendingWalls([]);
      setTurnHistory([]);
      setTotalToPlace(0);
      setTurnPhase('PICK_NUMBER');
      setPlacingMode('EXPAND');
      setChosenNumber(2);
      setWinner(null);
      setDisconnectAlert(false);
      if (initialState) {
        setGameMode(initialState.gameMode || 'KLASIK');
        setPlayers(initialState.players || []);
        setGrid(initialState.grid || []);
        setWalls(initialState.walls || {});
        setRoundNumber(initialState.roundNumber || 1);
        setActivePlayerIndex(initialState.activePlayerIndex || 0);
        setGridWidth(initialState.grid?.[0]?.length || 60);
        setGridHeight(initialState.grid?.length || 60);
      }
      setGameState('PLAYING');
    }
  };

  if (gameState === 'SETUP') {
    return (
      <>
        <GameSetup
          onStartGame={handleStartGame}
          onOpenRules={() => setIsRulesOpen(true)}
          onOpenOnline={() => setIsOnlineModalOpen(true)}
        />
        <RulesModal
          isOpen={isRulesOpen}
          onClose={() => setIsRulesOpen(false)}
        />
        <OnlineRoomModal
          isOpen={isOnlineModalOpen}
          onClose={() => setIsOnlineModalOpen(false)}
          onStartOnlineGame={handleStartOnlineGame}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-stone-100 select-none">
      
      {/* 1. Top Navigation Bar */}
      <header className="game-header bg-white/95 backdrop-blur-md border-b border-stone-200 px-3 py-2 z-20 flex items-center justify-between shadow-sm">
        
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="bg-amber-100 text-amber-800 font-black px-2.5 py-1 rounded-xl text-xs sm:text-sm border border-amber-300">
            TUR {roundNumber}
          </div>
          {onlineInfo?.roomCode && (
            <div className="flex items-center gap-1 bg-blue-100 text-blue-800 text-xs font-black px-2 py-1 rounded-xl border border-blue-300">
              <Wifi size={13} />
              <span>Oda: {onlineInfo.roomCode}</span>
            </div>
          )}
          <div className="text-stone-700 font-extrabold text-xs sm:text-sm hidden sm:block">
            {gameMode === 'MODERN' ? 'Modern Mod' : 'Klasik Mod'}
          </div>
        </div>

        {/* Center: Live Players Scoreboard */}
        <div className="flex items-center gap-1.5 overflow-x-auto max-w-[55vw] sm:max-w-[65vw] px-1 py-0.5 no-scrollbar">
          {players.map(p => {
            const count = territoryCounts[p.id] || 0;
            const isTurn = p.id === activePlayer.id;

            return (
              <div
                key={p.id}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-bold transition whitespace-nowrap border shrink-0 ${
                  !p.alive || count === 0
                    ? 'bg-stone-100 text-stone-400 border-stone-200 line-through opacity-50'
                    : isTurn
                    ? 'bg-white text-stone-900 border-stone-800 shadow-md ring-2 ring-stone-800/20'
                    : 'bg-stone-50 text-stone-700 border-stone-200'
                }`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: p.hex }}
                />
                <span className="truncate max-w-[65px]">{p.name}</span>
                <span className="text-[10px] font-black opacity-80 bg-stone-200/80 px-1.5 py-0.2 rounded-md">
                  {count}
                </span>
              </div>
            );
          })}
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-1 sm:gap-2">
          <button
            onClick={() => setIsDebugOpen(true)}
            className="px-2.5 py-1.5 text-amber-950 bg-amber-400 hover:bg-amber-500 border border-amber-500 rounded-xl transition flex items-center gap-1 shadow-sm text-xs font-black"
            title="Hile & Test Paneli"
          >
            <Wrench size={14} />
            <span>Hile</span>
          </button>
          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className="p-2 text-stone-600 hover:text-stone-900 hover:bg-stone-100 rounded-xl transition"
            title={soundEnabled ? 'Sesi Kapat' : 'Sesi Aç'}
          >
            {soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
          <button
            onClick={() => setIsRulesOpen(true)}
            className="p-2 text-stone-600 hover:text-stone-900 hover:bg-stone-100 rounded-xl transition"
            title="Kurallar"
          >
            <BookOpen size={18} />
          </button>
          <button
            onClick={() => {
              if (window.confirm('Oyunu sıfırlayıp ana menüye dönmek istiyor musun?')) {
                returnToSetup(true);
              }
            }}
            className="p-2 text-red-600 hover:bg-red-50 rounded-xl transition"
            title="Yeniden Başlat"
          >
            <RotateCcw size={18} />
          </button>
        </div>
      </header>

      {/* 2. Main Interactive Board + Turn Controls (Portrait: Top/Bottom, Landscape: Left/Right) */}
      <div className="flex-1 flex flex-col game-body-layout overflow-hidden min-h-0">
        <main className="flex-1 relative overflow-hidden min-h-0 min-w-0">
          <GameBoard
            grid={grid}
            gridWidth={gridWidth}
            gridHeight={gridHeight}
            activePlayer={activePlayer}
            pendingCells={pendingCells}
            pendingWalls={pendingWalls}
            walls={walls}
            placingMode={placingMode}
            onCellClick={handleCellClick}
            onBuildWall={handleBuildWall}
            onUndo={handleUndo}
            canPlaceMore={isMyTurn && (pendingCells.reduce((sum, c) => sum + (c.cost || 1), 0) + pendingWalls.length < totalToPlace)}
            alliances={alliances}
            isPlacingPhase={isMyTurn && turnPhase === 'PLACING'}
            isMyTurn={isMyTurn}
          />
        </main>

        {/* 3. Turn Control Panel (Bottom in Portrait, Right Sidebar in Landscape) */}
        <TurnControls
          gameMode={gameMode}
          activePlayer={activePlayer}
          playerArea={activePlayerArea}
          turnPhase={turnPhase}
          chosenNumber={chosenNumber}
          setChosenNumber={handleSelectChosenNumber}
          onStartSpin={handleStartSpin}
          placingMode={placingMode}
          setPlacingMode={setPlacingMode}
          pendingCells={pendingCells}
          pendingWalls={pendingWalls}
          totalToPlace={totalToPlace}
          onFinishPlacing={handleFinishPlacing}
          onUndo={handleUndo}
          isMyTurn={isMyTurn}
          hasValidMoves={hasValidMoves}
          onOpenDiplomacy={() => {
            if (!isMyTurn) return;
            if (pendingCells.length > 0 || pendingWalls.length > 0) {
              showMessage('Önce haritadaki hamleni tamamla veya geri al!', 3000);
              return;
            }
            setIsDiplomacyOpen(true);
          }}
          actionMessage={actionMessage}
        />
      </div>

      {/* Modals */}
      <WheelModal
        isOpen={isWheelOpen}
        chosenNumber={chosenNumber}
        activePlayer={activePlayer}
        onFinish={handleWheelFinish}
        fixedRoll={fixedRoll}
        isMyTurn={isMyTurn}
        rollData={wheelRollData}
      />

      {/* Floating Quick Action: Debug & Test */}
      <button
        onClick={() => setIsDebugOpen(true)}
        className="debug-float-btn fixed top-14 right-3 z-40 bg-amber-400 hover:bg-amber-500 text-stone-900 font-black text-xs px-2.5 py-1.5 rounded-xl shadow-lg border border-amber-500 flex items-center gap-1 active:scale-95 transition"
        title="Hile & Test Paneli"
      >
        <Wrench size={16} />
        <span>🛠️ Test / Hile</span>
      </button>

      <DebugModal
        isOpen={isDebugOpen}
        onClose={() => setIsDebugOpen(false)}
        players={players}
        activePlayer={activePlayer}
        onSwitchPlayer={(idx) => {
          if (!players[idx]?.alive) return;
          // Restore any unconfirmed demolished walls from previous player's turnHistory
          const restoredWalls = { ...wallsRef.current };
          turnHistoryRef.current.forEach(action => {
            if (action.type === 'WALL_CONQUER_2PT' && action.key) restoredWalls[action.key] = true;
            else if (action.type === 'BREACH' && action.cellKey) restoredWalls[action.cellKey] = true;
          });
          wallsRef.current = restoredWalls;
          setWalls(restoredWalls);

          pendingCellsRef.current = [];
          pendingWallsRef.current = [];
          turnHistoryRef.current = [];
          setPendingCells([]);
          setPendingWalls([]);
          setTurnHistory([]);
          setTotalToPlace(0);
          setTurnPhase('PICK_NUMBER');

          setActivePlayerIndex(idx);
          showMessage(`Sıra ${players[idx].name} oyuncusuna verildi!`);
          if (onlineInfo) {
            broadcastToAll({
              type: 'SYNC_STATE',
              activePlayerIndex: idx,
              turnPhase: 'PICK_NUMBER',
              totalToPlace: 0,
              pendingCells: [],
              pendingWalls: [],
              walls: restoredWalls,
            });
            broadcastToAll({
              type: 'LIVE_PENDING_SYNC',
              pendingCells: [],
              pendingWalls: [],
              walls: restoredWalls,
            });
          }
        }}
        onAddPoints={(pts, targetIdx) => {
          if (targetIdx !== undefined && !players[targetIdx]?.alive) return;
          const isSwitching = targetIdx !== undefined && targetIdx !== activePlayerIndex;
          if (isSwitching) {
            const restoredWalls = { ...wallsRef.current };
            turnHistoryRef.current.forEach(action => {
              if (action.type === 'WALL_CONQUER_2PT' && action.key) restoredWalls[action.key] = true;
              else if (action.type === 'BREACH' && action.cellKey) restoredWalls[action.cellKey] = true;
            });
            wallsRef.current = restoredWalls;
            setWalls(restoredWalls);

            pendingCellsRef.current = [];
            pendingWallsRef.current = [];
            turnHistoryRef.current = [];
            setPendingCells([]);
            setPendingWalls([]);
            setTurnHistory([]);
            setActivePlayerIndex(targetIdx);
            setTotalToPlace(pts);
            setTurnPhase('PLACING');
            showMessage(`${players[targetIdx]?.name || 'Oyuncu'} sırasına geçildi ve +${pts} büyüme hakkı verildi!`);
            if (onlineInfo) {
              broadcastToAll({
                type: 'SYNC_STATE',
                activePlayerIndex: targetIdx,
                totalToPlace: pts,
                turnPhase: 'PLACING',
                pendingCells: [],
                pendingWalls: [],
                walls: restoredWalls,
              });
              broadcastToAll({
                type: 'LIVE_PENDING_SYNC',
                pendingCells: [],
                pendingWalls: [],
                walls: restoredWalls,
              });
            }
          } else {
            const next = totalToPlace + pts;
            setTotalToPlace(next);
            setTurnPhase('PLACING');
            showMessage(`+${pts} Büyüme puanı eklendi!`);
            if (onlineInfo) {
              broadcastToAll({
                type: 'SYNC_STATE',
                totalToPlace: next,
                turnPhase: 'PLACING',
              });
            }
          }
        }}
        onInstantExpand={handleInstantExpand}
        onSetFixedRoll={(num) => {
          setFixedRoll(num);
          showMessage(num !== null ? `Sonraki çark ${num} gelecek!` : 'Çark normale döndü.');
        }}
        fixedRoll={fixedRoll}
        wallAttack1Hit={wallAttack1Hit}
        setWallAttack1Hit={(val) => {
          setWallAttack1Hit(val);
          if (onlineInfo) {
            broadcastToAll({
              type: 'SYNC_STATE',
              wallAttack1Hit: val,
            });
          }
        }}
        onEliminatePlayer={handleEliminatePlayer}
      />

      <DiplomacyModal
        isOpen={isDiplomacyOpen}
        onClose={() => setIsDiplomacyOpen(false)}
        gameMode={gameMode}
        activePlayer={activePlayer}
        players={players}
        alliances={alliances}
        territoryCounts={territoryCounts}
        onProposeAlliance={handleProposeAlliance}
        onCancelMutualAlliance={handleCancelMutualAlliance}
        onTransferTerritory={handleTransferTerritory}
        onlineInfo={onlineInfo}
        onSendOnlineProposal={handleSendOnlineProposal}
        onSendOnlineCancel={handleSendOnlineCancel}
        onAbortOnlineProposal={() => broadcastToAll({ type: 'DIPLOMACY_PROPOSAL_ABORTED' })}
        onAbortOnlineCancel={() => broadcastToAll({ type: 'DIPLOMACY_CANCEL_ABORTED' })}
      />

      {/* Incoming Alliance Proposal Modal for Remote Player */}
      {incomingProposal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-3xl p-6 shadow-2xl max-w-sm w-full border-4 border-amber-400 text-center space-y-4">
            <div className="w-12 h-12 bg-amber-100 text-amber-700 rounded-2xl flex items-center justify-center mx-auto shadow-sm">
              <Shield size={28} />
            </div>
            <div>
              <div className="text-xs font-black uppercase tracking-wider text-amber-600">
                {incomingProposal.type === 'TRIBUTE' ? 'Vergi / Haraç Anlaşması' : 'İttifak Teklifi Geldi!'}
              </div>
              <h3 className="text-lg font-black text-stone-800 mt-1">
                <span style={{ color: incomingProposal.proposer?.hex }}>{incomingProposal.proposer?.name}</span>
                <br />
                {incomingProposal.type === 'TRIBUTE'
                  ? (incomingProposal.payerId === incomingProposal.target?.id
                      ? `senden her tur ${incomingProposal.tributeAmount} kare haraç talep ediyor!`
                      : `sana her tur ${incomingProposal.tributeAmount} kare haraç ödemeyi teklif ediyor!`)
                  : 'seninle barış ittifakı kurmak istiyor!'}
              </h3>
            </div>

            <div className="p-3 bg-stone-50 rounded-2xl border border-stone-200 text-xs text-stone-700 text-left space-y-1.5 font-medium">
              <div>
                <span className="font-bold text-stone-900">Süre: </span>
                {incomingProposal.durationRounds === 0 ? 'Kalıcı (Süresiz)' : `${incomingProposal.durationRounds} Tur`}
              </div>
              <div>
                <span className="font-bold text-stone-900">İhlal Cezası: </span>
                <span className="text-red-600 font-extrabold">{incomingProposal.penaltyCells} Kare Toprak</span>
              </div>
              {incomingProposal.type === 'TRIBUTE' && (
                <div>
                  <span className="font-bold text-stone-900">Tur Başına Haraç: </span>
                  <span className="text-amber-700 font-extrabold">{incomingProposal.tributeAmount} Kare Toprak</span>
                </div>
              )}
            </div>

            <div className="flex gap-2.5 pt-1">
              <button
                onClick={() => handleRejectIncomingProposal(incomingProposal)}
                className="flex-1 py-3 bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold text-sm rounded-xl transition"
              >
                Reddet
              </button>
              <button
                onClick={() => handleAcceptIncomingProposal(incomingProposal)}
                className="flex-1 py-3 bg-green-600 hover:bg-green-700 text-white font-bold text-sm rounded-xl shadow-md transition"
              >
                Kabul Et 🤝
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Incoming Cancel Request Modal for Remote Player */}
      {incomingCancelRequest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-3xl p-6 shadow-2xl max-w-sm w-full border-4 border-amber-400 text-center space-y-4">
            <div className="w-12 h-12 bg-amber-100 text-amber-700 rounded-2xl flex items-center justify-center mx-auto shadow-sm">
              <AlertCircle size={28} />
            </div>
            <div>
              <div className="text-xs font-black uppercase tracking-wider text-amber-600">
                Barışçıl Fesih İsteği
              </div>
              <h3 className="text-lg font-black text-stone-800 mt-1">
                <span style={{ color: incomingCancelRequest.proposer?.hex }}>{incomingCancelRequest.proposer?.name}</span>
                <br />
                ittifakınızı <u>cezasız ve barışçıl</u> sonlandırmak istiyor.
              </h3>
            </div>

            <div className="flex gap-2.5 pt-2">
              <button
                onClick={() => handleRejectIncomingCancel(incomingCancelRequest)}
                className="flex-1 py-3 bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold text-sm rounded-xl transition"
              >
                Reddet
              </button>
              <button
                onClick={() => handleAcceptIncomingCancel(incomingCancelRequest)}
                className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-bold text-sm rounded-xl shadow-md transition"
              >
                Onayla (Feshet)
              </button>
            </div>
          </div>
        </div>
      )}

      <RulesModal
        isOpen={isRulesOpen}
        onClose={() => setIsRulesOpen(false)}
      />

      {/* Alliance Breach Warning Dialog */}
      {breachPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="bg-white rounded-3xl p-6 shadow-2xl max-w-sm w-full border-4 border-red-400 text-center">
            <div className="w-12 h-12 rounded-full bg-red-100 text-red-600 flex items-center justify-center mx-auto mb-3">
              <AlertTriangle size={28} />
            </div>
            <h3 className="text-lg font-black text-stone-800">
              İttifakı Bozmak Üzeresin!
            </h3>
            
            {(breachPrompt.projectedArea || activePlayerArea) <= breachPrompt.penaltyCells ? (
              <div className="p-3 bg-red-50 border border-red-300 rounded-xl mt-2 text-xs text-red-800 font-bold text-left">
                ⚠️ DİKKAT: Toplam toprağın ({breachPrompt.projectedArea || activePlayerArea} kare), ittifak bozma cezasından ({breachPrompt.penaltyCells} kare) küçük veya eşit! Anlaşmayı bozup turu tamamlarsan TÜM TOPRAKLARINI KAYBEDİP ELENECEKSİN!
              </div>
            ) : (
              <p className="text-xs text-stone-600 mt-2 leading-relaxed">
                Bu turda müttefikin <strong>{breachPrompt.allyNames || breachPrompt.ally?.name}</strong> topraklarına saldırdın. Hamleni tamamlarsan anlaşma bozulacak ve ceza olarak sınırlarından{' '}
                <strong className="text-red-600">{breachPrompt.penaltyCells} Toprak</strong> havaya terk edilecektir. (Kalan toprağın:{' '}
                {(breachPrompt.projectedArea || activePlayerArea) - breachPrompt.penaltyCells} kare).
              </p>
            )}

            <div className="flex gap-2 mt-5">
              <button
                onClick={() => setBreachPrompt(null)}
                className="flex-1 py-3 bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold rounded-xl text-xs transition"
              >
                Geri Dön (Düzelt)
              </button>
              <button
                onClick={handleConfirmBreach}
                className={`flex-1 py-3 text-white font-black rounded-xl text-xs shadow-md transition ${
                  (breachPrompt.projectedArea || activePlayerArea) <= breachPrompt.penaltyCells
                    ? 'bg-red-700 hover:bg-red-800'
                    : 'bg-red-600 hover:bg-red-700'
                }`}
              >
                {(breachPrompt.projectedArea || activePlayerArea) <= breachPrompt.penaltyCells ? 'Boz ve Elen!' : 'Onayla ve Cezayı Öde'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Game Over Screen */}
      {gameState === 'GAMEOVER' && winner && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 animate-in zoom-in-95">
          <div className="bg-white rounded-3xl p-8 shadow-2xl max-w-sm w-full text-center border-4 border-amber-400">
            <div className="w-16 h-16 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center mx-auto mb-4 shadow-inner">
              <Trophy size={36} />
            </div>
            <h2 className="text-2xl font-black text-stone-800">
              ZAFER!
            </h2>
            <div className="mt-2 text-base font-bold" style={{ color: winner.hex }}>
              {winner.name} Haritanın Hakimi Oldu!
            </div>
            <p className="text-xs text-stone-500 mt-1">
              Tüm rakiplerini geride bırakarak oyunu kazandı.
            </p>
            <button
              onClick={() => returnToSetup(false)}
              className="w-full mt-6 py-3.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white font-black text-base rounded-2xl shadow-lg transition active:scale-95"
            >
              Yeni Oyun Başlat
            </button>
          </div>
        </div>
      )}

      {/* Peer Disconnect Alert Modal */}
      {disconnectAlert && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4 animate-in fade-in">
          <div className="bg-white rounded-3xl p-6 shadow-2xl max-w-sm w-full border-4 border-amber-400 text-center space-y-4">
            <div className="w-14 h-14 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center mx-auto shadow-sm">
              <Wifi size={28} />
            </div>
            <div>
              <h3 className="text-lg font-black text-stone-800">
                Bağlantı Kesildi!
              </h3>
              <p className="text-xs text-stone-600 mt-1.5 leading-relaxed">
                Diğer telefon veya oyuncunun internet bağlantısı koptu. Oyuna bu telefondan tek cihaz olarak devam edebilir ya da ana menüye dönebilirsiniz.
              </p>
            </div>
            <div className="flex flex-col gap-2 pt-2">
              <button
                onClick={() => {
                  multiplayer.cleanup();
                  setOnlineInfo(null);
                  setDisconnectAlert(false);
                  showMessage('Oyun yerel (Pass & Play) moduna geçirildi, tek telefondan devam ediliyor.');
                }}
                className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-black text-xs rounded-xl shadow-md transition active:scale-95"
              >
                📱 Bu Telefondan Devam Et (Yerel Mod)
              </button>
              <button
                onClick={() => returnToSetup(false)}
                className="w-full py-2.5 bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold text-xs rounded-xl transition"
              >
                🏠 Ana Menüye Dön
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
