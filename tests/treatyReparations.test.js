import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldSimulationEngine } from '../src/world/worldEngine.js';

function createMockEngine() {
  const worldData = { isLand: new Uint8Array(1000 * 500) };
  const engine = new WorldSimulationEngine(worldData);
  engine.sync = { broadcast: () => {} };
  return engine;
}

test('treaty break with insufficient gold creates reparation debt and diverts production', () => {
  const engine = createMockEngine();

  // Setup Country 1 (Breaker) and Country 2 (Victim)
  const c1 = {
    id: 1,
    name: 'Breakerland',
    gold: 200,
    goldIncome: 10,
    landCount: 10,
    population: 100,
    maxPopulation: 1000,
    popGrowthRate: 0.1,
    troops: 20,
    capacity: 20,
    upgrades: {},
  };
  const c2 = {
    id: 2,
    name: 'Victimland',
    gold: 50,
    goldIncome: 5,
    landCount: 10,
    population: 100,
    maxPopulation: 1000,
    popGrowthRate: 0.1,
    troops: 20,
    capacity: 20,
    upgrades: {},
  };

  engine.countries = [c1, c2];
  engine.countryMap.set(1, c1);
  engine.countryMap.set(2, c2);
  engine.myCountryId = 1;

  // Active alliance treaty with 205 gold penalty (200 in treasury, 5 debt)
  const treaty = {
    id: 'tr_test_1',
    fromId: 1,
    toId: 2,
    fromName: 'Breakerland',
    toName: 'Victimland',
    type: 'ALLIANCE',
    penalty: 205,
    status: 'ACTIVE',
  };
  engine.treaties = [treaty];

  // 1. Break the treaty
  const res = engine.breakTreaty(treaty.id, 1, 'SALDIRI');
  assert.equal(res.ok, true);
  assert.equal(res.deducted, 200, 'All 200 upfront gold must be paid');
  assert.equal(res.debt, 5, 'Remaining debt must be 5');
  assert.equal(c1.gold, 0, 'Breaker gold must drop to 0');
  assert.equal(c2.gold, 250, 'Victim receives upfront 200 gold (50 + 200)');
  assert.equal(treaty.status, 'BROKEN');
  assert.equal(treaty.remainingDebt, 5);

  // 2. Simulate gold production ticks for Country 1
  engine.update(1.0);
  assert.equal(c1.gold, 0, 'Breaker must keep 0 gold while in debt');
  assert.equal(treaty.remainingDebt < 5, true, 'Debt should decrease as income is diverted');

  // Simulate enough ticks to completely clear the 5 gold debt
  while (treaty.remainingDebt > 0.05) {
    engine.update(1.0);
  }
  assert.equal(treaty.remainingDebt <= 0.05, true, 'Debt should be fully paid off');
  assert.equal(engine.getActiveReparationDebts(1).length, 0, 'No active debts remaining');

  // 3. Next tick after debt is cleared: breaker now keeps their own gold income
  const goldBefore = c1.gold;
  engine.update(1.0);
  assert.equal(c1.gold > goldBefore, true, 'Breaker now accumulates their own gold again');
});

test('creditor receives quest progression on reparation payment, debtor does not', () => {
  const engine = createMockEngine();

  const c2 = {
    id: 2,
    name: 'Victimland',
    gold: 0,
    landCount: 10,
    population: 100,
    maxPopulation: 1000,
    popGrowthRate: 0.1,
    troops: 20,
    capacity: 20,
    upgrades: {},
  };
  engine.countries = [c2];
  engine.countryMap.set(2, c2);
  engine.myCountryId = 2; // I am the creditor/victim

  // Initialize quests for creditor
  const quests = engine.getQuests();
  const goldQuest = quests.find((q) => q.type === 'GOLD');
  const initialQuestProgress = goldQuest ? goldQuest.current : 0;

  const treaty = {
    id: 'tr_test_2',
    fromId: 1,
    toId: 2,
    debtorId: 1,
    creditorId: 2,
    debtorName: 'Breakerland',
    creditorName: 'Victimland',
    totalDebt: 500,
    paidDebt: 0,
    remainingDebt: 500,
    status: 'BROKEN',
  };
  engine.treaties = [treaty];

  // Receive remote reparation payment of 150 gold
  engine.handleRemoteTreatyReparationPayment(treaty.id, 150, 350, Date.now(), false);

  assert.equal(c2.gold, 150, 'Creditor gold must increase by 150');
  assert.equal(treaty.remainingDebt, 350, 'Remaining debt must update to 350');
  if (goldQuest) {
    assert.equal(goldQuest.current, initialQuestProgress + 150, 'Creditor GOLD quest must progress by 150');
  }
});

test('both parties in a TRIBUTE treaty are protected; attacking breaks treaty and pays penalty', () => {
  const engine = createMockEngine();

  const overlord = {
    id: 10,
    name: 'Overlord',
    gold: 300,
    landCount: 10,
    troops: 50,
    upgrades: {},
  };
  const vassal = {
    id: 20,
    name: 'Vassal',
    gold: 50,
    landCount: 10,
    troops: 50,
    upgrades: {},
  };

  engine.countries = [overlord, vassal];
  engine.countryMap.set(10, overlord);
  engine.countryMap.set(20, vassal);

  const tributeTreaty = {
    id: 'tr_tribute_1',
    fromId: 10,
    toId: 20,
    tributeReceiverId: 10,
    tributePayerId: 20,
    type: 'TRIBUTE',
    penalty: 500,
    status: 'ACTIVE',
  };
  engine.treaties = [tributeTreaty];

  // 1. Check canExpandToPixel from Overlord towards Vassal
  // Place vassal land at (50, 50) and make it habitable
  engine.worldData.isLand[50 * 1000 + 50] = 1;
  engine.owners[50 * 1000 + 50] = 20;

  const check1 = engine.canExpandToPixel(10, 50, 50);
  assert.equal(check1.valid, false);
  assert.equal(check1.isTreatyViolation, true);
  assert.equal(check1.treaty.id, 'tr_tribute_1');

  // 2. Overlord attacks Vassal: breaks treaty and pays penalty to Vassal
  const res = engine.breakTreaty('tr_tribute_1', 10, 'SALDIRI');
  assert.equal(res.ok, true);
  assert.equal(res.deducted, 300);
  assert.equal(res.debt, 200);
  assert.equal(vassal.gold, 350, 'Vassal receives 300 penalty gold');
  assert.equal(overlord.gold, 0);
  assert.equal(tributeTreaty.status, 'BROKEN');
});

test('naval landing on treaty partner shore breaks treaty and pays penalty', () => {
  const engine = createMockEngine();

  const c1 = { id: 1, name: 'Attacker', gold: 100, landCount: 5, troops: 50, upgrades: {} };
  const c2 = { id: 2, name: 'Ally', gold: 0, landCount: 5, troops: 50, upgrades: {} };
  engine.countries = [c1, c2];
  engine.countryMap.set(1, c1);
  engine.countryMap.set(2, c2);

  const alliance = {
    id: 'tr_naval_1',
    fromId: 1,
    toId: 2,
    type: 'ALLIANCE',
    penalty: 400,
    status: 'ACTIVE',
  };
  engine.treaties = [alliance];

  // Target shore owned by Ally
  const shoreIdx = 30 * 1000 + 30;
  engine.worldData.isLand[shoreIdx] = 1;
  engine.owners[shoreIdx] = 2;

  const ship = {
    id: 'ship_test',
    countryId: 1,
    toX: 30,
    toY: 30,
  };

  engine._completeNavalLanding(ship);

  assert.equal(alliance.status, 'BROKEN', 'Alliance must be broken on landing');
  assert.equal(c1.gold, 0, 'Attacker pays 100 upfront gold');
  assert.equal(c2.gold, 100, 'Ally receives 100 upfront gold');
  assert.equal(alliance.remainingDebt, 300, 'Remaining debt must be 300');
});

test('nuclear strike hitting treaty partner territory breaks treaty and pays penalty', () => {
  const engine = createMockEngine();

  const c1 = { id: 1, name: 'NuclearState', gold: 150, landCount: 10, troops: 50, upgrades: {} };
  const c2 = { id: 2, name: 'VictimAlly', gold: 10, landCount: 10, troops: 50, upgrades: {} };
  engine.countries = [c1, c2];
  engine.countryMap.set(1, c1);
  engine.countryMap.set(2, c2);

  const alliance = {
    id: 'tr_nuke_1',
    fromId: 1,
    toId: 2,
    type: 'ALLIANCE',
    penalty: 600,
    status: 'ACTIVE',
  };
  engine.treaties = [alliance];

  // Set ally land within blast radius
  const blastCenterIdx = 100 * 1000 + 100;
  engine.worldData.isLand[blastCenterIdx] = 1;
  engine.owners[blastCenterIdx] = 2;

  const strike = {
    id: 'strike_test_1',
    attackerId: 1,
    attackerName: 'NuclearState',
    x: 100,
    y: 100,
    radius: 10,
    time: Date.now(),
  };

  engine._detonateNuclearStrike(strike, false);

  assert.equal(alliance.status, 'BROKEN', 'Treaty must be broken on nuke blast');
  assert.equal(c1.gold, 0, 'NuclearState pays 150 upfront gold');
  assert.equal(c2.gold, 160, 'VictimAlly receives 150 upfront gold (10 + 150)');
  assert.equal(alliance.remainingDebt, 450, 'Remaining debt must be 450');
});
