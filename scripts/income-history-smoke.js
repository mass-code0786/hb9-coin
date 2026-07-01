process.env.MARKET_TEST_MODE = 'true';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { dashboard } = require('../server');

const user = { id: 'usr_income', name: 'Income User', email: 'income@example.com', role: 'user', status: 'active', createdAt: '2026-06-01T00:00:00.000Z' };
const source = { id: 'usr_source', name: 'Source User', email: 'source@example.com', role: 'user', status: 'active', sponsorId: user.id, createdAt: '2026-06-01T00:00:00.000Z' };
const db = {
  users: [user, source],
  settings: { dailyRoi: 2, directMultiplier: 2, fallbackPrice: null },
  hb9_market_settings: { fallbackPrice: null },
  deposits: [],
  stakes: [],
  directBusiness: [],
  incomeLedger: [{ id: 'b1_1', userId: user.id, type: 'B1_INCOME', date: '2026-06-10', hb9Amount: 0.41000000000000003, status: 'credited', reason: 'Daily B1 income', createdAt: '2026-06-10T00:00:00.000Z' }],
  referralLedger: [{ id: 'ref_1', type: 'REFERRAL_INCOME', sponsorId: user.id, referredUserId: source.id, date: '2026-06-09', referralHb9Amount: 0.09, status: 'credited', createdAt: '2026-06-09T00:00:00.000Z' }],
  level_income_ledger: [{ id: 'lvl_1', type: 'LEVEL_INCOME', receiverUserId: user.id, sourceUserId: source.id, level: 2, hb9Amount: 12.34567, status: 'credited', createdAt: '2026-06-08T00:00:00.000Z' }],
  salary_payouts: [{ id: 'sal_1', userId: user.id, type: 'SALARY_INCOME', rankName: 'Rank 1', cycleStart: '2026-06-01', hb9Amount: 1, status: 'credited', createdAt: '2026-06-07T00:00:00.000Z' }],
  globalTeamRecords: [{ id: 'gbl_1', userId: user.id, date: '2026-06-06', paid: 0.02, unpaid: 0, value: 0.02 }],
  flushRecords: [{ id: 'fls_1', userId: user.id, date: '2026-06-05', incomeType: 'B1 Income', flushedIncome: 1.12, burnStatus: 'Burned Forever', createdAt: '2026-06-05T00:00:00.000Z' }],
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
const history = summary.incomeHistory;
assert(Array.isArray(history), 'dashboard should return incomeHistory');
assert.strictEqual(history.length, 5, 'All tab should have all five supported income entries');

const byType = Object.fromEntries(history.map(item => [item.type, item]));
assert.strictEqual(byType.referral.incomeType, 'Referral Income');
assert.strictEqual(byType.level.incomeType, 'Level Income');
assert.strictEqual(byType.b1.incomeType, 'B1 Income');
assert.strictEqual(byType.salary.incomeType, 'Salary Income');
assert.strictEqual(byType.flush.incomeType, 'Flush Income');
assert.strictEqual(byType.flush.asset, 'USD', 'Flush income remains USD');
assert.strictEqual(db.incomeLedger[0].hb9Amount, 0.41000000000000003, 'Backend raw B1 ledger value should remain unchanged');
assert.strictEqual(db.referralLedger[0].referralHb9Amount, 0.09, 'Backend raw referral ledger value should remain unchanged');
assert.strictEqual(db.level_income_ledger[0].hb9Amount, 12.34567, 'Backend raw level ledger value should remain unchanged');
assert.strictEqual(db.salary_payouts[0].hb9Amount, 1, 'Backend raw salary ledger value should remain unchanged');
assert(!history.some(item => /ROI Income/i.test(item.incomeType)), 'ROI Income must not appear in income history');
assert(!history.some(item => /Global Team/i.test(item.incomeType)), 'Global Team must not appear as income history');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'latin1');
const incomePageStart = app.indexOf('pages.Income=function()');
const incomePageEnd = app.indexOf('pages.Team=function', incomePageStart);
assert(incomePageStart >= 0 && incomePageEnd > incomePageStart, 'Income page override should exist');
const incomePage = app.slice(incomePageStart, incomePageEnd);
for (const tab of ['All', 'Referral Income', 'Level Income', 'B1 Income', 'Salary Income', 'Flush Income']) {
  assert(incomePage.includes(`'${tab}'`), `Income History should include ${tab} tab`);
}
assert(!incomePage.includes('ROI Income'), 'Income History should not include ROI Income tab');
assert(!incomePage.includes('Global Team'), 'Income History should not include Global Team tab');
assert(incomePage.includes("incomeHistoryTab='All'") || app.includes("incomeHistoryTab='All'"), 'All should be the default selected tab');
assert(incomePage.includes('data-income-history-tab'), 'Income History tabs should be clickable');
assert(incomePage.includes('data-history-type'), 'Income History cards should carry type markers');
assert(incomePage.includes('No ${active===') && incomePage.includes('Yet'), 'Income History should render selected-tab empty states');
assert(app.includes('const formatTokenAmount=value=>Number(value||0).toFixed(3);'), 'Shared HB9 token formatter should force 3 decimals');
assert(app.includes('const hb9=n=>`${formatTokenAmount(n)} HB9`;'), 'HB9 text formatter should use shared token formatter');
assert(app.includes('const hb9IconAmount=(today,total)=>') && app.includes('${formatTokenAmount(today)} <em>/</em> ${formatTokenAmount(total)}'), 'Income summary cards should use shared token formatter');
assert(incomePage.includes('hb9SingleAmount(item.amount)'), 'Income History HB9 rows should use shared token formatter');
assert.strictEqual(Number(0.41000000000000003).toFixed(3), '0.410', 'B1 income long decimal displays as 0.410');
assert.strictEqual(Number(0.09).toFixed(3), '0.090', 'Referral income displays 3 decimals');
assert.strictEqual(Number(12.34567).toFixed(3), '12.346', 'Level income displays 3 decimals');
assert.strictEqual(Number(1).toFixed(3), '1.000', 'Salary income displays 3 decimals');

const incomeCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'income-stack.css'), 'utf8');
assert(incomeCss.includes('.income-history-tabs') && /overflow-x:auto/.test(incomeCss), 'mobile tabs should be horizontally scrollable chips');
assert(/@media\(max-width:800px\)[\s\S]*?\.income-history-page\{padding-bottom:92px\}/.test(incomeCss), 'mobile content should have bottom padding above nav');
assert(incomeCss.includes('.income-history-card'), 'Income History should render compact cards');

console.log('income-history-smoke ok');
