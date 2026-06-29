const assert = require('assert');
process.env.MARKET_TEST_MODE = 'true';
const fs = require('fs');
const path = require('path');
const { adminFundTransfer, dashboard, walletBalances } = require('../server');

function store() {
  const now = new Date().toISOString();
  return {
    users: [
      { id: 'usr_admin', name: 'Admin', email: 'admin@hb9.local', role: 'admin', status: 'active', createdAt: now },
      { id: 'usr_sponsor', name: 'Sponsor User', email: 'sponsor@hb9.local', role: 'user', status: 'active', createdAt: now },
      { id: 'usr_user', name: 'Fund User', email: 'fund@hb9.local', role: 'user', status: 'active', sponsorId: 'usr_sponsor', createdAt: now },
      { id: 'usr_other', name: 'Other User', email: 'other@hb9.local', role: 'user', status: 'active', createdAt: now }
    ],
    deposits: [],
    conversions: [],
    stakes: [],
    withdrawals: [],
    transfers: [],
    directBusiness: [],
    globalTeamRecords: [],
    flushRecords: [],
    dailyRuns: [],
    wallet_ledger: [],
    auditLogs: [],
    reserve_wallets: [],
    reserve_ledger: [],
    burn_ledger: [],
    exchange_orders: [],
    income_emissions: [],
    incomeLedger: [],
    referralLedger: [],
    level_income_ledger: [],
    salary_ranks: [],
    salary_qualifications: [],
    salary_payouts: [],
    settings: {
      exchangeEnabled: true,
      fallbackPrice: 0.19,
      hb9Price: 0.19,
      priceOffset: 0,
      spreadPercent: 0,
      buyFeePercent: 0,
      sellFeePercent: 0,
      tradingFeePercent: 0,
      dailyRoi: 2,
      directMultiplier: 2,
      referralPercent: 10
    },
    hb9_market_settings: {
      fallbackPrice: 0.19,
      priceOffset: 0,
      spreadPercent: 0,
      manualOverrideEnabled: false
    }
  };
}

(async () => {
const { createStake } = require('../server');

const db = store();
const admin = db.users[0];
const nonAdmin = db.users.find(user => user.id === 'usr_user');

const usdtCredit = adminFundTransfer(db, admin, { userId: 'fund@hb9.local', asset: 'USDT', action: 'credit', amount: 50, reason: 'USDT test credit' });
assert.strictEqual(usdtCredit.balance.usdt, 50, 'admin can credit USDT');

const hb9Credit = adminFundTransfer(db, admin, { userId: 'Fund User', asset: 'HB9', action: 'credit', amount: 25, reason: 'HB9 test credit' });
assert.strictEqual(hb9Credit.balance.hb9, 25, 'admin can credit HB9');

const debit = adminFundTransfer(db, admin, { userId: 'usr_user', asset: 'USDT', action: 'debit', amount: 10, reason: 'USDT test debit' });
assert.strictEqual(debit.balance.usdt, 40, 'admin can debit available balance');

assert.throws(() => adminFundTransfer(db, admin, { userId: 'usr_user', asset: 'USDT', action: 'debit', amount: 100, reason: 'over debit' }), /negative/, 'debit below zero is blocked');
assert.throws(() => adminFundTransfer(db, nonAdmin, { userId: 'usr_user', asset: 'USDT', action: 'credit', amount: 1, reason: 'bad actor' }), /Admin only/, 'non-admin is blocked');

const ledger = db.wallet_ledger.filter(item => item.type === 'ADMIN_FUND_TRANSFER');
assert.strictEqual(ledger.length, 3, 'each successful transfer creates a wallet ledger entry');
assert(ledger.every(item => item.reason && ['credit', 'debit'].includes(item.direction)), 'ledger entries carry reason and direction');
assert.strictEqual((db.auditLogs || []).filter(item => item.type === 'ADMIN_FUND_TRANSFER').length, 3, 'each successful transfer creates an admin audit log');
assert.strictEqual((db.admin_fund_transfers || []).length, 3, 'successful transfers are reportable');
assert.deepStrictEqual(walletBalances(db, 'usr_user'), { usdt: 40, withdrawableUsdt: 40, hb9: 25, bnb: 0, totalDeposit: 0 }, 'wallet balances include admin fund transfers');

adminFundTransfer(db, admin, { userId: 'usr_user', asset: 'HB9', action: 'credit', amount: 100, reason: 'Stakeable admin HB9 credit' });
assert.strictEqual(db.referralLedger.length, 0, 'admin transfer itself must not pay referral income');

const stake = await createStake(db, nonAdmin, { amount: 100, stakeAsset: 'HB9', clientRequestId: 'admin-funded-stake' });
assert.strictEqual(stake.stakeAsset, 'HB9', 'admin credited HB9 can be staked through normal staking API');
assert.strictEqual(db.referralLedger.length, 1, 'admin-funded stake must create one referral income row');
assert.strictEqual(db.referralLedger[0].sponsorId, 'usr_sponsor');
assert.strictEqual(db.referralLedger[0].referredUserId, 'usr_user');
assert.strictEqual(db.referralLedger[0].stakeId, stake.id);
assert.strictEqual(db.referralLedger[0].referralPercent, 10);
assert.strictEqual(db.referralLedger[0].status, 'credited');
assert.strictEqual(db.referralLedger[0].referralUsdAmount, 22.5);
assert.strictEqual(db.referralLedger[0].referralHb9Amount, 10);
assert.strictEqual(walletBalances(db, 'usr_sponsor').hb9, 10, 'sponsor wallet receives credited referral HB9');
assert.strictEqual(db.directBusiness.filter(item => item.userId === 'usr_sponsor' && item.sourceUserId === 'usr_user' && item.stakeId === stake.id).length, 1, 'stake records sponsor direct business once');
assert.strictEqual(db.directBusiness.find(item => item.stakeId === stake.id).amount, 225, 'direct business uses stake USD value');
assert.strictEqual(db.level_income_ledger.length, 1, 'first stake executes level income path');
assert.strictEqual(db.level_income_ledger[0].stakeId, stake.id, 'level income row is tied to admin-funded stake');
assert.strictEqual(db.income_emissions.filter(item => item.type === 'REFERRAL_INCOME' && item.userId === 'usr_sponsor').length, 1, 'referral income emission history is written');

const sponsorDashboard = dashboard(db, db.users.find(user => user.id === 'usr_sponsor'));
assert.strictEqual(sponsorDashboard.income.totalReferral, 10, 'sponsor dashboard total referral updates after admin-funded stake');
assert.strictEqual(sponsorDashboard.income.todayReferral, 10, 'sponsor dashboard today referral updates after admin-funded stake');
assert.strictEqual(sponsorDashboard.stats.directBusiness, 225, 'sponsor dashboard direct business updates after admin-funded stake');
const fundedMember = sponsorDashboard.team.find(member => member.id === 'usr_user');
assert(fundedMember, 'dashboard team includes admin-funded staking member');
assert.strictEqual(fundedMember.stakeAsset, 'HB9', 'team member stake asset updates');
assert.strictEqual(fundedMember.stakeAmount, 100, 'team member stake amount updates');
assert.strictEqual(fundedMember.totalInvestmentUsd, 225, 'team member total investment updates');
assert.strictEqual(fundedMember.activeStakeUsd, 225, 'team member active stake updates');
assert.strictEqual(fundedMember.hb9EquivalentAmount, 100, 'team member HB9 equivalent updates');
assert.strictEqual(fundedMember.lastStakeDate, stake.startDate, 'team member last stake date updates');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'latin1');
for (const label of ['Status', 'Join Date', 'Stake Asset', 'Stake Amount', 'Investment (USD)', 'Total Investment', 'HB9 Equivalent', "Today's Income", 'Total Income', 'Last Stake Date']) {
  assert(app.includes(label), `Team page must label ${label}`);
}

const referralCount = db.referralLedger.length;
const businessCount = db.directBusiness.length;
const stakeRetry = await createStake(db, nonAdmin, { amount: 100, stakeAsset: 'HB9', clientRequestId: 'admin-funded-stake' });
assert.strictEqual(stakeRetry.id, stake.id, 'stake retry returns existing stake by client request id');
assert.strictEqual(db.referralLedger.length, referralCount, 'stake retry must not duplicate referral income');
assert.strictEqual(db.directBusiness.length, businessCount, 'stake retry must not duplicate direct business');

console.log('FUND TRANSFER SMOKE PASS: admin credit/debit, negative debit block, non-admin block, ledger, audit, and balances verified.');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
