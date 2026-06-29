process.env.MARKET_TEST_MODE = 'true';

const assert = require('assert');
const { dashboard, walletBalances } = require('../server');

const user = { id: 'usr_repaired_b1', name: 'Repaired B1 User', email: 'repaired-b1@example.com', role: 'user', status: 'active', createdAt: '2026-06-01T00:00:00.000Z' };
const repairedRows = [
  {
    id: 'led_repaired_b1_1',
    userId: user.id,
    stakeId: 'stk_repaired_b1_1',
    incomeKey: `${user.id}:stk_repaired_b1_1:2026-06-28:B1`,
    date: '2026-06-28',
    type: 'B1_INCOME',
    asset: 'HB9',
    amount: 0.31,
    hb9Amount: 0.31,
    status: 'credited',
    note: 'Missed B1 income repair',
    createdAt: '2026-06-29T01:00:00.000Z'
  },
  {
    id: 'led_repaired_b1_2',
    userId: user.id,
    stakeId: 'stk_repaired_b1_2',
    incomeKey: `${user.id}:stk_repaired_b1_2:2026-06-28:B1`,
    incomeDate: '2026-06-28',
    incomeType: 'B1 Income',
    asset: 'HB9',
    creditedB1Hb9: 0.31,
    status: 'repaired',
    reason: 'Missed B1 income repair',
    createdAt: '2026-06-29T01:01:00.000Z'
  }
];

const db = {
  users: [user],
  settings: { dailyRoi: 2, directMultiplier: 2, fallbackPrice: null },
  hb9_market_settings: { fallbackPrice: null },
  deposits: [],
  stakes: [],
  directBusiness: [],
  incomeLedger: repairedRows,
  referralLedger: [],
  level_income_ledger: [],
  salary_payouts: [],
  globalTeamRecords: [],
  flushRecords: [],
  withdrawals: [],
  transfers: [],
  conversions: [],
  reserve_wallets: [],
  reserve_ledger: [],
  burn_ledger: [],
  wallet_ledger: [],
  exchange_orders: [],
  salary_ranks: [],
  salary_qualifications: []
};

const summary = dashboard(db, user);
const repairedHistory = summary.incomeHistory.filter(item => item.type === 'b1');

assert.strictEqual(summary.income.totalB1, 0.62, 'dashboard Total B1 Income includes repaired B1 ledger rows immediately');
assert.strictEqual(walletBalances(db, user.id).hb9, 0.62, 'wallet HB9 balance includes repaired B1 ledger rows');
assert.strictEqual(repairedHistory.length, 2, 'Income History includes all repaired B1 rows');
assert.strictEqual(repairedHistory.reduce((sum, item) => sum + item.amount, 0), 0.62, 'Income History repaired B1 amount totals match dashboard');
assert(repairedHistory.every(item => item.incomeType === 'B1 Income'), 'repaired rows are mapped as B1 Income history');
assert(summary.b1Records.length === 2, 'dashboard b1Records includes repaired rows');

console.log('repaired-b1-dashboard-smoke ok');
