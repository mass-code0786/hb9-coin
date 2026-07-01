const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { dailyB1Percent } = require('../server');

const dataFile = path.join(os.tmpdir(), `hb9-b1-repair-${process.pid}.json`);
const yesterday = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
})();
const wrongDate = '2026-01-01';
const now = `${yesterday}T08:00:00.000Z`;
const expectedB1Hb9 = Number(((225 * dailyB1Percent(yesterday) / 100) / 2.25).toFixed(2));

function fixture() {
  return {
    users: [
      { id: 'usr_missing', name: 'Missing', email: 'missing@example.com', role: 'user', status: 'active', createdAt: now },
      { id: 'usr_existing', name: 'Existing', email: 'existing@example.com', role: 'user', status: 'active', createdAt: now },
      { id: 'usr_inactive', name: 'Inactive', email: 'inactive@example.com', role: 'user', status: 'active', createdAt: now },
      { id: 'usr_wrong_date', name: 'Wrong Date', email: 'wrong@example.com', role: 'user', status: 'active', createdAt: now }
    ],
    settings: { dailyRoi: 2, directMultiplier: 2, fallbackPrice: 2.25 },
    hb9_market_settings: { fallbackPrice: 2.25 },
    stakes: [
      { id: 'stk_missing', userId: 'usr_missing', status: 'active', stakeAsset: 'HB9', amount: 225, usdValueAtStake: 225, stakeAmount: 100, hb9EquivalentAmount: 100, createdAt: now },
      { id: 'stk_existing', userId: 'usr_existing', status: 'active', stakeAsset: 'HB9', amount: 225, usdValueAtStake: 225, stakeAmount: 100, hb9EquivalentAmount: 100, createdAt: now },
      { id: 'stk_inactive', userId: 'usr_inactive', status: 'inactive', stakeAsset: 'HB9', amount: 225, usdValueAtStake: 225, stakeAmount: 100, hb9EquivalentAmount: 100, createdAt: now },
      { id: 'stk_wrong_date', userId: 'usr_wrong_date', status: 'active', stakeAsset: 'HB9', amount: 225, usdValueAtStake: 225, stakeAmount: 100, hb9EquivalentAmount: 100, createdAt: now }
    ],
    directBusiness: [
      { id: 'biz_missing', userId: 'usr_missing', amount: 450 },
      { id: 'biz_existing', userId: 'usr_existing', amount: 450 },
      { id: 'biz_inactive', userId: 'usr_inactive', amount: 450 },
      { id: 'biz_wrong_date', userId: 'usr_wrong_date', amount: 450 }
    ],
    incomeLedger: [
      { id: 'led_existing', userId: 'usr_existing', stakeId: 'stk_existing', incomeKey: `usr_existing:stk_existing:${yesterday}:B1`, date: yesterday, type: 'B1_INCOME', amount: 2, hb9Amount: 2, status: 'credited' },
      { id: 'led_wrong_date', userId: 'usr_wrong_date', stakeId: 'stk_wrong_date', incomeKey: `usr_wrong_date:stk_wrong_date:${wrongDate}:B1`, date: wrongDate, type: 'B1_INCOME', amount: 2, hb9Amount: 2, status: 'credited' }
    ],
    referralLedger: [],
    level_income_ledger: [],
    salary_payouts: [],
    salary_ranks: [],
    salary_qualifications: [],
    globalTeamRecords: [],
    flushRecords: [],
    deposits: [],
    withdrawals: [],
    transfers: [],
    conversions: [],
    wallet_ledger: [],
    reserve_ledger: [],
    burn_ledger: [],
    income_emissions: [],
    reserve_wallets: [{ id: 'res_income', asset: 'HB9', walletType: 'income', balance: 1000, lockedBalance: 0 }],
    exchange_orders: [],
    auditLogs: []
  };
}

function runRepair(extraEnv = {}) {
  const result = spawnSync(process.execPath, ['scripts/repair-missed-b1-income.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_FILE: dataFile, MARKET_TEST_MODE: 'true', HB9_PRICE_FALLBACK: '2.25', ...extraEnv },
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
  }
  assert.strictEqual(result.status, 0, 'repair script should exit cleanly');
  return result.stdout;
}

function parseSummary(output) {
  const start = output.lastIndexOf('{\n  "date"');
  assert(start >= 0, 'repair output should end with JSON summary');
  return JSON.parse(output.slice(start));
}

try {
  fs.writeFileSync(dataFile, JSON.stringify(fixture(), null, 2));
  const beforeDry = fs.readFileSync(dataFile, 'utf8');
  const dryOutput = runRepair({ DRY_RUN: 'true' });
  const drySummary = parseSummary(dryOutput);
  assert(dryOutput.includes('B1_REPAIR_DRY_RUN'), 'dry run log should be printed');
  assert.strictEqual(drySummary.missingB1Rows, 2, 'dry run should identify real missing B1 rows');
  assert.strictEqual(drySummary.createdRows, 2, 'dry run createdRows should show rows that would be created');
  assert.strictEqual(drySummary.actualCreatedRows, 0, 'dry run should not actually create rows');
  assert.strictEqual(drySummary.skippedReasons['already exists'], 1, 'dry run should explain existing rows');
  assert.strictEqual(drySummary.skippedReasons['not eligible'], 1, 'dry run should explain inactive/not eligible stakes');
  assert.strictEqual(fs.readFileSync(dataFile, 'utf8'), beforeDry, 'dry run creates nothing');

  const realOutput = runRepair();
  const realSummary = parseSummary(realOutput);
  assert(realOutput.includes('B1_REPAIR_CREATED'), 'real run should create missing B1');
  assert.strictEqual(realSummary.createdRows, 2, 'real run should report created rows');
  assert.strictEqual(realSummary.actualCreatedRows, 2, 'real run should actually insert created rows');
  let db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const repaired = db.incomeLedger.filter(item => item.date === yesterday && item.type === 'B1_INCOME' && item.userId === 'usr_missing');
  assert.strictEqual(repaired.length, 1, 'missing yesterday B1 is repaired once');
  assert.strictEqual(repaired[0].stakeId, 'stk_missing', 'repair row includes stake id');
  assert.strictEqual(repaired[0].incomeKey, `usr_missing:stk_missing:${yesterday}:B1`, 'repair row has duplicate-protection key');
  assert.strictEqual(repaired[0].hb9Amount, expectedB1Hb9, 'B1 amount follows current daily B1 percent and HB9 price');
  assert.strictEqual(db.incomeLedger.filter(item => item.userId === 'usr_existing' && item.date === yesterday && item.type === 'B1_INCOME').length, 1, 'existing B1 is not duplicated');
  assert.strictEqual(db.incomeLedger.filter(item => item.userId === 'usr_inactive' && item.type === 'B1_INCOME').length, 0, 'inactive stake skipped');
  assert.strictEqual(db.incomeLedger.filter(item => item.userId === 'usr_wrong_date' && item.date === wrongDate && item.type === 'B1_INCOME').length, 1, 'wrong date existing row remains unchanged');
  assert.strictEqual(db.incomeLedger.filter(item => item.userId === 'usr_wrong_date' && item.date === yesterday && item.type === 'B1_INCOME').length, 1, 'wrong-date user gets missing yesterday row only');

  const countAfterReal = db.incomeLedger.length;
  const rerunOutput = runRepair();
  const rerunSummary = parseSummary(rerunOutput);
  assert(rerunOutput.includes('B1_REPAIR_SKIPPED_DUPLICATE'), 'rerun should log duplicate skips');
  assert.strictEqual(rerunSummary.createdRows, 0, 'rerun should not plan new rows');
  assert.strictEqual(rerunSummary.skippedReasons['already exists'], 3, 'rerun should explain all existing yesterday rows');
  db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.strictEqual(db.incomeLedger.length, countAfterReal, 'running repair twice does not duplicate income');
  assert(db.auditLogs.some(item => item.type === 'B1_REPAIR_COMPLETED'), 'completion log is stored');

  console.log('repair-missed-b1-income-smoke ok');
} finally {
  try { fs.unlinkSync(dataFile); } catch (_) {}
}
