const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { dashboard, globalTeamUnits } = require('../server');

assert.strictEqual(globalTeamUnits(0.68), 34, '0.68 USD must display as 34 Global Team');
assert.strictEqual(globalTeamUnits(0.02), 1, '0.02 USD must display as 1 Global Team');
assert.strictEqual(globalTeamUnits(0), 0, '0 USD must display as 0 Global Team');

const user = { id: 'usr_global', name: 'Global User', email: 'global@hb9.local', role: 'user', status: 'active', createdAt: '2026-06-28T00:00:00.000Z' };
const db = {
  users: [user],
  settings: { dailyRoi: 2, directMultiplier: 2, fallbackPrice: 0.2 },
  hb9_market_settings: { fallbackPrice: 0.2 },
  deposits: [],
  stakes: [],
  directBusiness: [],
  globalTeamRecords: [
    { id: 'gbl_1', userId: user.id, date: '2026-06-28', paid: 0.02, unpaid: 0.68, value: 0.7, globalTeamCount: 35 }
  ],
  flushRecords: [{ id: 'fls_1', userId: user.id, date: '2026-06-28', incomeType: 'B1 / Global Team', flushedIncome: 0.68 }],
  incomeLedger: [],
  referralLedger: [],
  level_income_ledger: [],
  salary_payouts: [],
  withdrawals: [],
  transfers: [],
  conversions: [],
  reserve_wallets: [],
  reserve_ledger: [],
  burn_ledger: [],
  wallet_ledger: [],
  exchange_orders: []
};
const summary = dashboard(db, user);
assert.strictEqual(summary.income.paidGlobal, 1, 'API paidGlobal must be team count');
assert.strictEqual(summary.income.unpaidGlobal, 34, 'API unpaidGlobal must be team count');
assert.strictEqual(summary.income.paidGlobalValue, 0.02, 'API keeps paidGlobalValue in USD');
assert.strictEqual(summary.income.unpaidGlobalValue, 0.68, 'API keeps unpaidGlobalValue in USD');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'latin1');
assert(app.includes('const globalTeam=n=>String(Math.round(Number(n||0)));'), 'frontend must round Global Team to whole numbers');
assert(!/money\(i\.paidGlobal\)|money\(i\.unpaidGlobal\)/.test(app), 'dashboard must not render Global Team as money');
assert(!/points\(i\.paidGlobal\)|points\(i\.unpaidGlobal\)/.test(app), 'dashboard must not render raw decimal Global Team values');
assert(/globalTeam\(i\.paidGlobal\).*globalTeam\(i\.unpaidGlobal\)/s.test(app), 'dashboard must render paid/unpaid Global Team with integer formatter');

console.log('GLOBAL TEAM DISPLAY SMOKE PASS: USD values convert to whole Global Team counts and dashboard avoids decimal/money formatting.');
