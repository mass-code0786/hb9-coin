process.env.MARKET_TEST_MODE = 'true';

const assert = require('assert');
const { dashboard } = require('../server');

const user = { id: 'usr_salary_source', name: 'Salary Source', email: 'salary-source@hb9.local', role: 'user', status: 'active', createdAt: '2026-06-01T00:00:00.000Z' };
const salaryKey = `${user.id}:2026-07-01:SALARY`;
const queuedKey = `${user.id}:2026-07-16:SALARY`;
const db = {
  users: [user],
  settings: { dailyRoi: 2, directMultiplier: 2, fallbackPrice: 2 },
  hb9_market_settings: { fallbackPrice: 2 },
  deposits: [],
  stakes: [],
  directBusiness: [],
  incomeLedger: [],
  referralLedger: [],
  level_income_ledger: [],
  salary_ranks: [],
  salary_qualifications: [],
  salary_payouts: [
    { id: 'sal_credited', userId: user.id, type: 'SALARY_INCOME', asset: 'HB9', rank: 1, rankName: 'Rank 1', salaryPeriodDate: '2026-07-01', cycleStart: '2026-07-01', duplicateKey: salaryKey, incomeKey: salaryKey, usdAmount: 20, hb9Amount: 9.52, status: 'CREDITED', reason: 'Salary income credited', createdAt: '2026-07-01T00:00:00.000Z' },
    { id: 'sal_duplicate', userId: user.id, type: 'SALARY_INCOME', asset: 'HB9', rank: 1, rankName: 'Rank 1', salaryPeriodDate: '2026-07-01', cycleStart: '2026-07-01', duplicateKey: salaryKey, incomeKey: salaryKey, usdAmount: 20, hb9Amount: 9.52, status: 'credited', reason: 'Duplicate fixture', createdAt: '2026-07-01T00:01:00.000Z' },
    { id: 'sal_queued', userId: user.id, type: 'SALARY_INCOME', asset: 'HB9', rank: 1, rankName: 'Rank 1', salaryPeriodDate: '2026-07-16', cycleStart: '2026-07-16', duplicateKey: queuedKey, incomeKey: queuedKey, usdAmount: 20, hb9Amount: 7.25, status: 'QUEUED', reason: 'HB9 income reserve insufficient', createdAt: '2026-07-16T00:00:00.000Z' }
  ],
  globalTeamRecords: [],
  flushRecords: [],
  withdrawals: [],
  transfers: [],
  conversions: [],
  reserve_wallets: [
    { id: 'res_hb9_income', asset: 'HB9', walletType: 'income', balance: 1000, lockedBalance: 0, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' }
  ],
  reserve_ledger: [],
  burn_ledger: [],
  wallet_ledger: [],
  exchange_orders: [],
  income_emissions: [],
  auditLogs: [],
  salaryRuns: [],
  dailyRuns: [],
  schedulerRuns: {}
};

const summary = dashboard(db, user);
const salaryHistory = summary.incomeHistory.filter(row => row.type === 'salary');

assert.strictEqual(salaryHistory.length, 1, 'only credited salary row should appear in income history');
assert.strictEqual(salaryHistory[0].amount, 9.52, 'salary history should use credited salary amount');
assert.strictEqual(salaryHistory[0].status, 'Credited', 'credited salary status should display as Credited');
assert.strictEqual(summary.income.totalSalary, 9.52, 'Salary Income card total should include credited salary once');
assert.strictEqual(summary.wallets.hb9, 9.52, 'HB9 wallet should include credited salary once');
assert(!salaryHistory.some(row => row.id === 'sal_queued'), 'queued salary should not appear as income history amount');

console.log('salary-income-source-smoke ok');
