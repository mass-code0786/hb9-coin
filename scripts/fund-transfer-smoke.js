const assert = require('assert');
const { adminFundTransfer, walletBalances } = require('../server');

function store() {
  const now = new Date().toISOString();
  return {
    users: [
      { id: 'usr_admin', name: 'Admin', email: 'admin@hb9.local', role: 'admin', status: 'active', createdAt: now },
      { id: 'usr_user', name: 'Fund User', email: 'fund@hb9.local', role: 'user', status: 'active', createdAt: now },
      { id: 'usr_other', name: 'Other User', email: 'other@hb9.local', role: 'user', status: 'active', createdAt: now }
    ],
    deposits: [],
    conversions: [],
    stakes: [],
    withdrawals: [],
    transfers: [],
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
    salary_payouts: []
  };
}

const db = store();
const admin = db.users[0];
const nonAdmin = db.users[1];

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

console.log('FUND TRANSFER SMOKE PASS: admin credit/debit, negative debit block, non-admin block, ledger, audit, and balances verified.');
