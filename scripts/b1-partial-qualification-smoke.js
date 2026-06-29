process.env.MARKET_TEST_MODE = 'true';

const assert = require('assert');
const {
  calculateB1IncomeForStake,
  dashboard,
  dailyB1Percent,
  getUserDirectBusinessUsd,
  runRoiDaily
} = require('../server');
const { repairWrongFlushedB1 } = require('./repair-wrong-flushed-b1');

const date = '2026-06-28';
const createdAt = '2026-06-20T00:00:00.000Z';

function baseDb(users, directBusiness) {
  return {
    users,
    settings: { globalActivityMin: 5, globalActivityMax: 15, dailyRoi: 2, directMultiplier: 2, fallbackPrice: null },
    hb9_market_settings: { fallbackPrice: null },
    deposits: [],
    stakes: users.map(user => ({ id: `stk_${user.id}`, userId: user.id, amount: 21, usdValueAtStake: 21, stakeUsdValue: 21, stakeAsset: 'HB9', stakeAmount: 9.33, coinAmount: 9.33, hb9EquivalentAmount: 9.33, status: 'active', startDate: '2026-06-20', createdAt })),
    directBusiness,
    incomeLedger: [],
    income_emissions: [],
    referralLedger: [],
    level_income_ledger: [],
    salary_payouts: [],
    globalTeamRecords: [],
    flushRecords: [],
    withdrawals: [],
    transfers: [],
    conversions: [],
    reserve_wallets: [{ id: 'rsv_income', asset: 'HB9', walletType: 'income', balance: 1000 }],
    reserve_ledger: [],
    burn_ledger: [],
    wallet_ledger: [],
    exchange_orders: [],
    salary_ranks: [],
    salary_qualifications: [],
    auditLogs: []
  };
}

(async () => {
  assert(dailyB1Percent(date) >= 1 && dailyB1Percent(date) <= 4, 'daily B1 percent must be between 1 and 4');
  assert.notStrictEqual(dailyB1Percent('2026-06-29'), dailyB1Percent('2026-07-01'), 'different days can use different B1 percent');
  assert.strictEqual(dailyB1Percent(date), 2, 'test fixture date should use 2% B1');

  const zero = { id: 'usr_zero_b1', name: 'Zero', email: 'zero-b1@example.com', role: 'user', status: 'active', createdAt };
  const partial = { id: 'usr_partial_b1', name: 'Partial', email: 'partial-b1@example.com', role: 'user', status: 'active', createdAt };
  const full = { id: 'usr_full_b1', name: 'Full', email: 'full-b1@example.com', role: 'user', status: 'active', createdAt };
  const db = baseDb([zero, partial, full], [
    { id: 'biz_partial', userId: partial.id, sourceUserId: 'src_partial', amount: 10, createdAt },
    { id: 'biz_full', userId: full.id, sourceUserId: 'src_full', amount: 42, createdAt }
  ]);

  let summary = await runRoiDaily(db, { fromDate: date, toDate: date, backfill: true });
  assert.strictEqual(summary.createdDays, 3, 'all three users should receive one B1 processing pass');
  summary = await runRoiDaily(db, { fromDate: date, toDate: date, backfill: true });
  assert.strictEqual(summary.createdDays, 0, 'same date rerun must not duplicate B1 processing');

  const zeroRow = db.incomeLedger.find(row => row.userId === zero.id);
  const partialRow = db.incomeLedger.find(row => row.userId === partial.id);
  const fullRow = db.incomeLedger.find(row => row.userId === full.id);
  assert.strictEqual(zeroRow.status, 'flushed', 'zero direct business is fully flushed');
  assert.strictEqual(zeroRow.paidB1Usd, 0, 'zero direct business paid B1 is zero');
  assert.strictEqual(zeroRow.flushedB1Usd, 0.42, 'zero direct business flushes full B1');

  assert.strictEqual(partialRow.qualifiedStakeUsd, 5, 'partial direct business qualifies directBusiness / 2');
  assert.strictEqual(partialRow.unqualifiedStakeUsd, 16, 'partial direct business leaves unqualified stake');
  assert.strictEqual(partialRow.grossB1Usd, 0.42, 'partial gross B1 uses full active stake');
  assert.strictEqual(partialRow.paidB1Usd, 0.1, 'partial paid B1 uses qualified stake only');
  assert.strictEqual(partialRow.flushedB1Usd, 0.32, 'partial flushed B1 uses unqualified stake only');
  assert.strictEqual(partialRow.dailyB1Percent, 2, 'B1 row stores selected daily percent');
  assert.strictEqual(partialRow.incomeKey, `${partial.id}:stk_${partial.id}:${date}:B1`, 'B1 duplicate key includes userId, stakeId, date, and B1');

  assert.strictEqual(fullRow.qualifiedStakeUsd, 21, 'full direct business qualifies all stake');
  assert.strictEqual(fullRow.unqualifiedStakeUsd, 0, 'full direct business has no unqualified stake');
  assert.strictEqual(fullRow.paidB1Usd, 0.42, 'full direct business pays all B1');
  assert.strictEqual(fullRow.flushedB1Usd, 0, 'full direct business has no B1 flush');

  const partialDash = dashboard(db, partial);
  const partialFlush = db.flushRecords.find(row => row.userId === partial.id && row.date === date);
  assert.strictEqual(partialDash.income.totalB1, partialRow.paidB1Hb9, 'dashboard B1 shows paid HB9 only');
  assert.strictEqual(partialFlush.flushedB1Usd, 0.32, 'flush record stores flushed B1 amount');
  assert(partialDash.income.totalFlush >= 0.32, 'dashboard flush income includes flushed B1 amount');
  const partialHistory = partialDash.incomeHistory.find(row => row.type === 'b1');
  assert.strictEqual(partialHistory.status, 'Partial', 'income history labels partial B1 rows');
  assert.strictEqual(partialHistory.details.paidB1Usd, 0.1, 'income history exposes paid B1');
  assert.strictEqual(partialHistory.details.flushedB1Usd, 0.32, 'income history exposes flushed B1');
  assert.strictEqual(partialHistory.details.qualifiedStakeUsd, 5, 'income history exposes qualified stake');
  assert.strictEqual(partialHistory.details.directBusinessUsd, 10, 'income history exposes direct business');
  assert.strictEqual(partialHistory.details.dailyB1Percent, 2, 'income history exposes B1 percent');

  const derivedDate = '2026-06-29';
  assert.strictEqual(dailyB1Percent(derivedDate), 3, 'reported fixture date should use 3% B1');
  const sponsor = { id: 'usr_derived_sponsor', name: 'Derived Sponsor', email: 'derived-sponsor@example.com', role: 'user', status: 'active', createdAt };
  const hb9Direct = { id: 'usr_direct_hb9', name: 'HB9 Direct', email: 'direct-hb9@example.com', role: 'user', status: 'active', sponsorId: sponsor.id, createdAt };
  const bnbDirect = { id: 'usr_direct_bnb', name: 'BNB Direct', email: 'direct-bnb@example.com', role: 'user', status: 'active', sponsorId: sponsor.id, createdAt };
  const adminDirect = { id: 'usr_direct_admin', name: 'Admin Direct', email: 'direct-admin@example.com', role: 'user', status: 'active', sponsorId: sponsor.id, createdAt };
  const derivedDb = baseDb([sponsor, hb9Direct, bnbDirect, adminDirect], []);
  derivedDb.stakes = [
    { id: 'stk_derived_sponsor', userId: sponsor.id, amount: 21, usdValueAtStake: 21, stakeUsdValue: 21, stakeAsset: 'HB9', stakeAmount: 9.33, coinAmount: 9.33, hb9EquivalentAmount: 9.33, status: 'active', startDate: '2026-06-20', createdAt },
    { id: 'stk_direct_hb9', userId: hb9Direct.id, amount: 20, usdValueAtStake: 20, stakeUsdValue: 20, stakeAsset: 'HB9', stakeAmount: 8.89, coinAmount: 8.89, hb9EquivalentAmount: 8.89, status: 'active', startDate: derivedDate, createdAt: `${derivedDate}T10:00:00.000Z` },
    { id: 'stk_direct_bnb', userId: bnbDirect.id, amount: 30, usdValueAtStake: 30, stakeUsdValue: 30, stakeAsset: 'BNB', stakeAmount: 0.05, bnbPriceAtStake: 600, hb9EquivalentAmount: 13.33, status: 'active', startDate: derivedDate, createdAt: `${derivedDate}T11:00:00.000Z` },
    { id: 'stk_direct_admin', userId: adminDirect.id, amount: 10, usdValueAtStake: 10, stakeUsdValue: 10, stakeAsset: 'HB9', stakeAmount: 4.44, coinAmount: 4.44, hb9EquivalentAmount: 4.44, source: 'ADMIN_FUND_TRANSFER', status: 'active', startDate: derivedDate, createdAt: `${derivedDate}T12:00:00.000Z` }
  ];
  await runRoiDaily(derivedDb, { fromDate: derivedDate, toDate: derivedDate, now: new Date(`${derivedDate}T18:00:00.000Z`), backfill: true });
  const derivedRow = derivedDb.incomeLedger.find(row => row.userId === sponsor.id && row.date === derivedDate);
  const derivedCalculation = calculateB1IncomeForStake({ db: derivedDb, userId: sponsor.id, stakeId: 'stk_derived_sponsor', date: derivedDate, hb9PriceOverride: 2.25, cutoffDateTime: new Date(`${derivedDate}T18:00:00.000Z`) });
  assert.strictEqual(getUserDirectBusinessUsd(derivedDb, sponsor.id, new Date(`${derivedDate}T18:00:00.000Z`)), 60, 'shared direct business source counts direct stakes before cutoff');
  assert.strictEqual(derivedCalculation.paidB1Usd, derivedRow.paidB1Usd, 'scheduler B1 row uses centralized calculator output');
  assert.strictEqual(derivedRow.directBusinessUsd, 60, 'B1 direct business derives all direct active stakes even without referral income rows');
  assert.strictEqual(derivedRow.qualifiedStakeUsd, 21, 'derived direct business qualifies stake using directBusiness / 2 capped at active stake');
  assert.strictEqual(derivedRow.paidB1Usd, 0.63, 'qualified stake with positive percent creates positive paid B1');
  assert.strictEqual(derivedRow.flushedB1Usd, 0, 'full qualification removes B1 flush');
  assert(derivedDb.auditLogs.some(row => row.type === 'B1_CALCULATION_TRACE' && row.details.userId === sponsor.id && row.details.directBusinessUsd === 60), 'B1 calculation trace is logged');

  const insufficientReserveUser = { id: 'usr_insufficient_reserve', name: 'Reserve User', email: 'reserve@example.com', role: 'user', status: 'active', createdAt };
  const insufficientDb = baseDb([insufficientReserveUser], [{ id: 'biz_reserve', userId: insufficientReserveUser.id, sourceUserId: 'src_reserve', amount: 10, createdAt }]);
  insufficientDb.reserve_wallets.find(item => item.asset === 'HB9' && item.walletType === 'income').balance = 0;
  await runRoiDaily(insufficientDb, { fromDate: date, toDate: date, backfill: true });
  const reserveRow = insufficientDb.incomeLedger.find(row => row.userId === insufficientReserveUser.id);
  assert(reserveRow.qualifiedStakeUsd > 0, 'reserve fallback fixture has qualified stake');
  assert(reserveRow.paidB1Usd > 0, 'qualified stake still stores paid B1 when reserve debit is unavailable');
  assert(reserveRow.paidB1Hb9 > 0, 'qualified stake still credits HB9 when reserve debit is unavailable');
  assert.notStrictEqual(reserveRow.status, 'queued', 'reserve fallback must not zero paid B1 into queued status');

  const repairUser = { id: 'usr_repair_wrong_flush', name: 'Repair', email: 'repair-b1@example.com', role: 'user', status: 'active', createdAt };
  const repairDb = baseDb([repairUser], [{ id: 'biz_repair', userId: repairUser.id, sourceUserId: 'src_repair', amount: 10, createdAt }]);
  const repairCalculation = calculateB1IncomeForStake({ db: repairDb, userId: repairUser.id, stakeId: `stk_${repairUser.id}`, date, hb9PriceOverride: 2.25 });
  const grossRepairB1Usd = repairCalculation.paidB1Usd + repairCalculation.flushedB1Usd;
  repairDb.flushRecords.push({ id: 'fls_wrong', userId: repairUser.id, date, incomeType: 'B1 / Global Team', eligibleIncome: grossRepairB1Usd, paidIncome: 0, flushedIncome: grossRepairB1Usd, flushedB1Usd: grossRepairB1Usd, burnStatus: 'Burned Forever', createdAt });
  repairDb.globalTeamRecords.push({ id: 'gbl_wrong', userId: repairUser.id, date, paid: 0, unpaid: grossRepairB1Usd, createdAt });
  repairDb.incomeLedger.push({ id: 'led_wrong', userId: repairUser.id, date, type: 'B1_INCOME', amount: 0, hb9Amount: 0, status: 'flushed', createdAt });

  const dry = await repairWrongFlushedB1({ date, dryRun: true, db: repairDb });
  assert.strictEqual(dry.createdRows + dry.updatedRows, 1, 'dry run identifies corrected partial paid B1 row');
  assert.strictEqual(repairDb.incomeLedger.length, 1, 'dry run does not create rows');
  const real = await repairWrongFlushedB1({ date, dryRun: false, db: repairDb });
  assert.strictEqual(real.createdRows + real.updatedRows, 1, 'real repair upserts corrected partial paid B1 row');
  assert.strictEqual(repairDb.incomeLedger.length, 1, 'real repair updates the wrong row without duplicating B1 rows');
  assert.strictEqual(repairDb.incomeLedger.filter(row => row.type === 'B1_INCOME' && row.amount > 0).length, 1, 'real repair inserts one paid B1 row');
  const repairedRow = repairDb.incomeLedger.find(row => row.type === 'B1_INCOME' && row.amount > 0);
  assert.strictEqual(repairedRow.paidB1Usd, repairCalculation.paidB1Usd, 'repair B1 row uses centralized calculator output');
  const duplicate = await repairWrongFlushedB1({ date, dryRun: false, db: repairDb });
  assert.strictEqual(duplicate.createdRows + duplicate.updatedRows, 0, 'repair rerun does not duplicate paid B1 row');
  assert.strictEqual(repairDb.flushRecords[0].flushedB1Usd, 0.32, 'repair adjusts full flush to correct partial flush amount');

  console.log('b1-partial-qualification-smoke ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
