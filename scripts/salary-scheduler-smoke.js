const assert = require('assert');
process.env.MARKET_TEST_MODE = 'true';
process.env.HB9_PRICE_FALLBACK = process.env.HB9_PRICE_FALLBACK || '2';

const {
  processSalaryPayouts,
  repairQueuedSalaryPayouts,
  salaryDuplicateKey,
  isSalaryRunDate,
  dashboard
} = require('../server');

const now = '2026-06-01T00:00:00.000Z';

function baseDb() {
  return {
    users: [
      { id: 'usr_eligible', name: 'Eligible', email: 'eligible@hb9.local', role: 'user', status: 'active', createdAt: now },
      { id: 'usr_not_eligible', name: 'Not Eligible', email: 'not-eligible@hb9.local', role: 'user', status: 'active', createdAt: now }
    ],
    settings: { globalActivityMin: 5, globalActivityMax: 15, dailyRoi: 2, directMultiplier: 2, fallbackPrice: 2 },
    hb9_market_settings: { fallbackPrice: 2 },
    deposits: [],
    stakes: [],
    directBusiness: [],
    globalTeamRecords: [],
    flushRecords: [],
    incomeLedger: [],
    referralLedger: [],
    level_income_ledger: [],
    salary_ranks: [],
    salary_qualifications: [],
    salary_payouts: [],
    reserve_wallets: [{ id: 'res_hb9_income', asset: 'HB9', walletType: 'income', balance: 100000, lockedBalance: 0, createdAt: now, updatedAt: now }],
    reserve_ledger: [],
    burn_ledger: [],
    wallet_ledger: [],
    exchange_orders: [],
    income_emissions: [],
    auditLogs: [],
    salaryRuns: [],
    withdrawals: [],
    transfers: [],
    transferLedger: [],
    conversions: [],
    dailyRuns: [],
    schedulerRuns: {}
  };
}

function addStake(db, userId, amount, createdAt = '2026-06-01T00:00:00.000Z') {
  db.stakes.push({
    id: `stk_${userId}_${db.stakes.length}`,
    userId,
    stakeAsset: 'HB9',
    amount,
    usdValueAtStake: amount,
    stakeUsdValue: amount,
    stakeAmount: amount / 2,
    hb9EquivalentAmount: amount / 2,
    status: 'active',
    startDate: createdAt.slice(0, 10),
    createdAt
  });
}

function addEligibleStructure(db) {
  addStake(db, 'usr_eligible', 50);
  for (let i = 1; i <= 10; i++) {
    const userId = `usr_direct_${i}`;
    db.users.push({ id: userId, name: `Direct ${i}`, email: `direct-${i}@hb9.local`, role: 'user', status: 'active', sponsorId: 'usr_eligible', createdAt: now });
    addStake(db, userId, 100);
  }
}

(async () => {
  assert.strictEqual(isSalaryRunDate('2026-07-01'), true, 'salary should run on 1st');
  assert.strictEqual(isSalaryRunDate('2026-07-16'), true, 'salary should run on 16th');
  assert.strictEqual(isSalaryRunDate('2026-07-02'), false, 'salary should not run on other dates');

  const db = baseDb();
  addEligibleStructure(db);

  const skipped = await processSalaryPayouts(db, '2026-07-02');
  assert.strictEqual(skipped.runDateAllowed, false, 'non-salary date should be skipped');
  assert.strictEqual(db.salary_payouts.length, 0, 'non-salary date must not create payouts');

  const first = await processSalaryPayouts(db, '2026-07-01');
  assert.strictEqual(first.runDateAllowed, true, '1st must be an allowed salary date');
  assert.strictEqual(first.creditedUsers, 1, 'eligible user should be credited on 1st');
  assert.strictEqual(first.notEligibleUsers >= 1, true, 'non-eligible user should be skipped');
  const firstPayout = db.salary_payouts.find(row => row.userId === 'usr_eligible' && row.salaryPeriodDate === '2026-07-01');
  assert(firstPayout, 'eligible user should have salary payout for 1st');
  assert.strictEqual(firstPayout.status, 'credited', 'successful salary payout must be credited immediately');
  assert.strictEqual(firstPayout.duplicateKey, salaryDuplicateKey('usr_eligible', '2026-07-01'), 'duplicate key should be userId:date:SALARY');
  assert.strictEqual(db.wallet_ledger.filter(row => row.refId === firstPayout.duplicateKey).length, 1, 'salary credit should write one wallet ledger row');
  assert.strictEqual(db.incomeLedger.filter(row => row.incomeKey === firstPayout.duplicateKey && row.status === 'credited').length, 1, 'salary credit should write one credited income ledger row');

  const duplicate = await processSalaryPayouts(db, '2026-07-01');
  assert.strictEqual(duplicate.creditedUsers, 0, 'rerun same salary date must not credit again');
  assert.strictEqual(duplicate.duplicateUsers >= 1, true, 'rerun same salary date should skip duplicate');
  assert.strictEqual(db.salary_payouts.filter(row => row.userId === 'usr_eligible' && row.salaryPeriodDate === '2026-07-01').length, 1, 'same date must not duplicate payout');
  assert.strictEqual(db.wallet_ledger.filter(row => row.refId === firstPayout.duplicateKey).length, 1, 'duplicate run must not double credit wallet');

  const second = await processSalaryPayouts(db, '2026-07-16');
  assert.strictEqual(second.creditedUsers, 1, 'eligible user should be credited on 16th');
  assert(db.salary_payouts.some(row => row.userId === 'usr_eligible' && row.salaryPeriodDate === '2026-07-16'), 'eligible user should have salary payout for 16th');

  const userDashboard = dashboard(db, db.users.find(user => user.id === 'usr_eligible'));
  const salaryHistory = userDashboard.incomeHistory.filter(row => row.type === 'salary');
  assert(salaryHistory.some(row => row.date === '2026-07-01' && row.status === 'Credited'), 'income history should show salary credited for 1st');
  assert(salaryHistory.some(row => row.date === '2026-07-16' && row.status === 'Credited'), 'income history should show salary credited for 16th');
  assert(userDashboard.income.totalSalary > 0, 'dashboard should expose total salary income');
  assert(db.wallet_ledger.some(row => row.userId === 'usr_eligible' && row.reason === 'Salary income credited'), 'credited salary should write HB9 wallet credit');

  const logs = db.auditLogs.map(row => row.type);
  for (const type of ['SALARY_DAILY_CHECK', 'SALARY_START', 'SALARY_WALLET_CREDITED', 'SALARY_LEDGER_UPDATED', 'SALARY_COMPLETED', 'SALARY_CREDITED', 'SALARY_SKIPPED_NOT_ELIGIBLE', 'SALARY_SKIPPED_DUPLICATE']) {
    assert(logs.includes(type), `${type} log should exist`);
  }

  const retryDb = baseDb();
  addEligibleStructure(retryDb);
  retryDb.reserve_wallets.find(row => row.asset === 'HB9' && row.walletType === 'income').balance = 0;
  const queued = await processSalaryPayouts(retryDb, '2026-07-01');
  assert.strictEqual(queued.queuedUsers, 1, 'insufficient reserve should queue salary payout');
  const queuedPayout = retryDb.salary_payouts.find(row => row.userId === 'usr_eligible' && row.salaryPeriodDate === '2026-07-01');
  assert(queuedPayout && queuedPayout.status === 'queued', 'queued salary row should be stored for retry');
  assert.strictEqual(retryDb.wallet_ledger.filter(row => row.refId === queuedPayout.duplicateKey).length, 0, 'failed salary must not credit wallet');
  assert(retryDb.auditLogs.some(row => row.type === 'SALARY_FAILED'), 'failed salary should log SALARY_FAILED');
  retryDb.reserve_wallets.find(row => row.asset === 'HB9' && row.walletType === 'income').balance = 100000;
  const retried = await processSalaryPayouts(retryDb, '2026-07-01');
  assert.strictEqual(retried.creditedUsers, 1, 'queued salary should be credited after reserve is funded');
  assert.strictEqual(retryDb.salary_payouts.filter(row => row.userId === 'usr_eligible' && row.salaryPeriodDate === '2026-07-01').length, 1, 'queued retry should update existing salary row, not duplicate it');
  assert.strictEqual(queuedPayout.status, 'credited', 'queued salary row should become credited after retry');
  assert.strictEqual(retryDb.wallet_ledger.filter(row => row.refId === queuedPayout.duplicateKey).length, 1, 'queued retry should credit wallet once');

  const repairDb = baseDb();
  addEligibleStructure(repairDb);
  const repairKey = salaryDuplicateKey('usr_eligible', '2026-07-01');
  repairDb.salary_payouts.push({ id: 'salp_old_queued', userId: 'usr_eligible', type: 'SALARY_INCOME', asset: 'HB9', rank: 1, rankName: 'Rank 1', salaryPeriodDate: '2026-07-01', cycleStart: '2026-07-01', cycleEnd: '2026-07-01', duplicateKey: repairKey, incomeKey: repairKey, usdAmount: 20, hb9Amount: 10, hb9PriceAtPayout: 2, status: 'queued', reason: 'Legacy queued salary', createdAt: '2026-07-01T00:00:00.000Z', immutable: true });
  const repaired = repairQueuedSalaryPayouts(repairDb, { startup: true });
  assert.strictEqual(repaired.repaired, 1, 'startup repair should credit old queued salary rows');
  assert.strictEqual(repairDb.salary_payouts[0].status, 'credited', 'startup repair should mark queued salary credited');
  assert.strictEqual(repairDb.wallet_ledger.filter(row => row.refId === repairKey).length, 1, 'startup repair should credit wallet once');
  assert.strictEqual(repairQueuedSalaryPayouts(repairDb, { startup: true }).alreadyCredited, 0, 'credited salary should not be repaired again');

  console.log('salary-scheduler-smoke ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
