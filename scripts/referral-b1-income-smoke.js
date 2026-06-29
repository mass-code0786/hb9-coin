process.env.MARKET_TEST_MODE = 'true';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createStake,
  dashboard,
  repairReferralB1Income,
  walletBalances
} = require('../server');

function yesterday() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function fixture() {
  const date = yesterday();
  const now = `${date}T08:00:00.000Z`;
  return {
    users: [
      { id: 'usr_sponsor', name: 'Sponsor', email: 'sponsor@example.com', role: 'user', status: 'active', createdAt: now },
      { id: 'usr_bismillah', name: 'Bismillah', email: 'bismillah@example.com', role: 'user', status: 'active', sponsorId: 'usr_sponsor', createdAt: now },
      { id: 'usr_new_direct', name: 'New Direct', email: 'new-direct@example.com', role: 'user', status: 'active', sponsorId: 'usr_sponsor', createdAt: now }
    ],
    deposits: [],
    conversions: [{ id: 'cnv_sponsor', userId: 'usr_sponsor', direction: 'buy', toAsset: 'HB9', hb9Amount: 100, usdtAmount: 20, createdAt: now }],
    stakes: [
      { id: 'stk_sponsor_old', userId: 'usr_sponsor', stakeAsset: 'HB9', stakeAmount: 100, amount: 20, usdValueAtStake: 20, hb9EquivalentAmount: 100, coinAmount: 100, hb9Amount: 100, hb9PriceAtStake: 0.2, status: 'active', startDate: date, createdAt: now },
      { id: 'stk_bismillah_old', userId: 'usr_bismillah', stakeAsset: 'HB9', stakeAmount: 200, amount: 40, usdValueAtStake: 40, hb9EquivalentAmount: 200, coinAmount: 200, hb9Amount: 200, hb9PriceAtStake: 0.2, status: 'active', startDate: date, createdAt: now }
    ],
    withdrawals: [],
    transfers: [],
    directBusiness: [],
    incomeLedger: [],
    referralLedger: [],
    level_income_ledger: [],
    salary_ranks: [],
    salary_qualifications: [],
    salary_payouts: [],
    globalTeamRecords: [],
    flushRecords: [],
    dailyRuns: [],
    auditLogs: [],
    wallet_ledger: [
      { id: 'wlt_new_direct_admin', userId: 'usr_new_direct', asset: 'HB9', direction: 'credit', amount: 100, reason: 'Admin test credit', refId: 'aft_new_direct', type: 'ADMIN_FUND_TRANSFER', createdAt: now, immutable: true }
    ],
    reserve_wallets: [
      { asset: 'HB9', walletType: 'exchange', balance: 100000, lockedBalance: 0 },
      { asset: 'HB9', walletType: 'income', balance: 100000, lockedBalance: 0 },
      { asset: 'USDT', walletType: 'treasury', balance: 100000, lockedBalance: 0 },
      { asset: 'BNB', walletType: 'exchange', balance: 1000, lockedBalance: 0 }
    ],
    reserve_ledger: [],
    burn_ledger: [],
    exchange_orders: [],
    income_emissions: [],
    schedulerRuns: {},
    settings: {
      exchangeEnabled: true,
      fallbackPrice: 0.2,
      hb9Price: 0.2,
      priceOffset: 0,
      spreadPercent: 0,
      buyFeePercent: 0,
      sellFeePercent: 0,
      tradingFeePercent: 0,
      dailyRoi: 2,
      directMultiplier: 2,
      referralPercent: 10,
      globalActivityMin: 5,
      globalActivityMax: 15
    },
    hb9_market_settings: {
      fallbackPrice: 0.2,
      priceOffset: 0,
      spreadPercent: 0,
      manualOverrideEnabled: true
    }
  };
}

(async () => {
  const db = fixture();
  const sponsor = db.users.find(user => user.id === 'usr_sponsor');
  const newDirect = db.users.find(user => user.id === 'usr_new_direct');

  const newStake = await createStake(db, newDirect, { amount: 100, stakeAsset: 'HB9', clientRequestId: 'admin-funded-direct-stake' });
  const newReferral = db.referralLedger.find(item => item.stakeId === newStake.id);
  assert(newReferral, 'direct referral stake creates referral income');
  assert.strictEqual(newReferral.referralPercent, 10);
  assert.strictEqual(newReferral.referralUsdAmount, 2);
  assert.strictEqual(newReferral.referralHb9Amount, 10);

  const summary = await repairReferralB1Income(db, { userSearch: 'Bismillah', fromDate: yesterday(), toDate: yesterday(), runB1: true });
  assert.strictEqual(summary.created.referralLedger, 1, 'repair creates missing old referral once');
  assert.strictEqual(summary.created.directBusiness, 1, 'repair creates missing old direct business once');
  assert(summary.created.incomeLedger >= 1, 'repair runs B1 backfill through existing scheduler logic');

  const bismillahReferral = db.referralLedger.find(item => item.stakeId === 'stk_bismillah_old');
  assert(bismillahReferral, 'old Bismillah stake referral was repaired');
  assert.strictEqual(bismillahReferral.referralUsdAmount, 4);
  assert.strictEqual(bismillahReferral.referralHb9Amount, 20);
  assert(db.directBusiness.some(item => item.userId === sponsor.id && item.sourceUserId === 'usr_bismillah' && item.stakeId === 'stk_bismillah_old'), 'old Bismillah stake direct business was repaired');

  const sponsorDashboard = dashboard(db, sponsor);
  assert(sponsorDashboard.income.totalReferral >= 30, 'dashboard referral total includes direct and repaired referral income');
  assert(sponsorDashboard.income.totalB1 > 0, 'dashboard B1 total reads credited B1 ledger');
  const bismillahTeam = sponsorDashboard.team.find(item => item.name === 'Bismillah');
  assert(bismillahTeam, 'Bismillah appears in direct team');
  assert.strictEqual(bismillahTeam.totalStakeUsd, 40);
  assert.strictEqual(bismillahTeam.activeStakeUsd, 40);
  assert.strictEqual(bismillahTeam.stakeAsset, 'HB9');
  assert.strictEqual(bismillahTeam.hb9EquivalentAmount, 200);
  assert.strictEqual(bismillahTeam.directBusinessVolume, 40);

  const beforeReferral = db.referralLedger.length;
  const beforeBusiness = db.directBusiness.length;
  const beforeB1 = db.incomeLedger.length;
  await repairReferralB1Income(db, { userSearch: 'Bismillah', fromDate: yesterday(), toDate: yesterday(), runB1: true });
  assert.strictEqual(db.referralLedger.length, beforeReferral, 'repair does not duplicate referral income');
  assert.strictEqual(db.directBusiness.length, beforeBusiness, 'repair does not duplicate direct business');
  assert.strictEqual(db.incomeLedger.length, beforeB1, 'repair does not duplicate B1 income');
  assert.strictEqual(walletBalances(db, sponsor.id).hb9, sponsorDashboard.wallets.hb9, 'wallet balance and dashboard remain aligned');

  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'latin1');
  for (const label of ['Joined', 'Status', 'Total stake', 'Active stake', 'Asset', 'HB9 equivalent', 'Direct business']) {
    assert(app.includes(`'${label}'`), `Team page must include ${label}`);
  }

  console.log('referral-b1-income-smoke ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
