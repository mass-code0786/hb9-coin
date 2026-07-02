const assert = require('assert');
const { parseEther, parseUnits } = require('ethers');

process.env.MARKET_TEST_MODE = 'true';
process.env.WITHDRAWAL_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538dc9e86dae9bb8f3c7f0c8a4b8d1e0f5f2';
process.env.WITHDRAWAL_FROM_ADDRESS = '0x0000000000000000000000000000000000000001';
process.env.BSC_RPC_URL = 'http://127.0.0.1:1';
process.env.USDT_BEP20_CONTRACT = '0x55d398326f99059ff775485246999027b3197955';
process.env.WITHDRAWAL_MIN_HOT_WALLET_BNB = '0.002';
process.env.WITHDRAWAL_CONFIRMATIONS = '3';

const {
  createWithdrawalRequest,
  processWithdrawalAutomation,
  processWithdrawalBroadcast,
  updateWithdrawalConfirmations,
  walletBalances
} = require('../server');

const hot = process.env.WITHDRAWAL_FROM_ADDRESS;
const userAddress = '0x2222222222222222222222222222222222222222';
const txHash = `0x${'a'.repeat(64)}`;

function db() {
  return {
    users: [{ id: 'usr_1', name: 'User', email: 'user@hb9.local', role: 'user', status: 'active', createdAt: new Date().toISOString() }],
    deposits: [],
    conversions: [],
    stakes: [],
    withdrawals: [],
    transfers: [],
    directBusiness: [],
    globalTeamRecords: [],
    flushRecords: [],
    dailyRuns: [],
    wallet_ledger: [{ id: 'seed', userId: 'usr_1', asset: 'USDT', direction: 'credit', amount: 100, reason: 'seed', type: 'ADMIN_FUND_TRANSFER', createdAt: new Date().toISOString() }],
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
    settings: { minWithdrawal: 9, maxWithdrawal: 80, withdrawalFeePercent: 5 }
  };
}

function deps({ usdt = 100, bnb = '0.01', receipt = null, latest = 100, transferFails = false } = {}) {
  const calls = { transfers: 0 };
  return {
    calls,
    provider: {
      getBalance: async () => parseEther(String(bnb)),
      getTransactionReceipt: async () => receipt,
      getBlockNumber: async () => latest
    },
    signer: { address: hot },
    token: {
      balanceOf: async () => parseUnits(String(usdt), 18),
      transfer: async () => {
        calls.transfers += 1;
        if (transferFails) throw Error('mock transfer failed');
        return { hash: txHash };
      }
    }
  };
}

(async () => {
  assert.throws(() => createWithdrawalRequest(db(), db().users[0], { amount: 8.99, address: userAddress }), /Minimum withdrawal is 9 USDT/, '$8.99 withdrawal is rejected');
  const minDb = db();
  const minRequest = createWithdrawalRequest(minDb, minDb.users[0], { amount: 9, address: userAddress });
  assert.strictEqual(minRequest.withdrawal.amount, 9, '$9.00 withdrawal is accepted');
  const tenDb = db();
  const tenRequest = createWithdrawalRequest(tenDb, tenDb.users[0], { amount: 10, address: userAddress });
  assert.strictEqual(tenRequest.withdrawal.amount, 10, '$10.00 withdrawal is accepted');

  const successDb = db(), user = successDb.users[0];
  const originalEnv = {
    WITHDRAWAL_AUTO_ENABLED: process.env.WITHDRAWAL_AUTO_ENABLED,
    WITHDRAWAL_PRIVATE_KEY: process.env.WITHDRAWAL_PRIVATE_KEY,
    WITHDRAWAL_FROM_ADDRESS: process.env.WITHDRAWAL_FROM_ADDRESS,
    BSC_RPC_URL: process.env.BSC_RPC_URL,
    USDT_BEP20_CONTRACT: process.env.USDT_BEP20_CONTRACT
  };
  const restoreEnv = () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const missingConfigDb = db(), missingConfig = createWithdrawalRequest(missingConfigDb, missingConfigDb.users[0], { amount: 20, address: userAddress });
  delete process.env.WITHDRAWAL_PRIVATE_KEY;
  await processWithdrawalAutomation(missingConfigDb, missingConfig.withdrawal, deps());
  assert.strictEqual(missingConfig.withdrawal.status, 'pending', 'missing auto config leaves withdrawal pending');
  assert.strictEqual(missingConfig.withdrawal.failureReason, undefined, 'missing auto config must not store failureReason');
  restoreEnv();

  const disabledDb = db(), disabled = createWithdrawalRequest(disabledDb, disabledDb.users[0], { amount: 20, address: userAddress });
  process.env.WITHDRAWAL_AUTO_ENABLED = 'false';
  await processWithdrawalAutomation(disabledDb, disabled.withdrawal, deps());
  assert.strictEqual(disabled.withdrawal.status, 'pending', 'disabled auto withdrawal leaves withdrawal pending');
  assert.strictEqual(disabled.withdrawal.failureReason, undefined, 'disabled auto withdrawal must not store failureReason');
  restoreEnv();

  const first = createWithdrawalRequest(successDb, user, { amount: 20, address: userAddress, clientRequestId: 'wd-success' });
  assert.strictEqual(walletBalances(successDb, user.id).withdrawableUsdt, 80, 'withdrawal amount is locked immediately');
  const duplicate = createWithdrawalRequest(successDb, user, { amount: 20, address: userAddress, clientRequestId: 'wd-success' });
  assert.strictEqual(duplicate.duplicate, true, 'duplicate client request returns existing withdrawal');
  assert.strictEqual(successDb.withdrawals.length, 1, 'duplicate request must not create a second withdrawal');

  const okDeps = deps();
  await processWithdrawalBroadcast(successDb, first.withdrawal, okDeps);
  assert.strictEqual(first.withdrawal.status, 'broadcasted', 'successful send becomes broadcasted');
  assert.strictEqual(first.withdrawal.txHash, txHash, 'tx hash is stored');
  assert.strictEqual(first.withdrawal.fromAddress, hot, 'from address is stored');
  assert.strictEqual(first.withdrawal.toAddress, userAddress, 'to address is stored');
  assert.strictEqual(first.withdrawal.netAmount, 19, 'net amount stores amount minus fee');
  await processWithdrawalBroadcast(successDb, first.withdrawal, okDeps);
  assert.strictEqual(okDeps.calls.transfers, 1, 'existing tx hash prevents duplicate broadcasts');

  await updateWithdrawalConfirmations(successDb, first.withdrawal, deps({ receipt: { status: 1, blockNumber: 98 }, latest: 100 }).provider);
  assert.strictEqual(first.withdrawal.status, 'confirmed', 'confirmed receipt updates withdrawal');
  assert(first.withdrawal.confirmedAt, 'confirmedAt is stored');

  const lowUsdtDb = db(), lowUsdt = createWithdrawalRequest(lowUsdtDb, lowUsdtDb.users[0], { amount: 20, address: userAddress });
  await processWithdrawalBroadcast(lowUsdtDb, lowUsdt.withdrawal, deps({ usdt: 1 }));
  assert.strictEqual(lowUsdt.withdrawal.status, 'failed', 'insufficient hot USDT fails withdrawal');
  assert(lowUsdt.withdrawal.failureReason.includes('insufficient USDT'), 'insufficient hot USDT stores failureReason');
  assert.strictEqual(walletBalances(lowUsdtDb, 'usr_1').withdrawableUsdt, 100, 'failed hot USDT rollback releases lock');

  const lowBnbDb = db(), lowBnb = createWithdrawalRequest(lowBnbDb, lowBnbDb.users[0], { amount: 20, address: userAddress });
  await processWithdrawalBroadcast(lowBnbDb, lowBnb.withdrawal, deps({ bnb: '0.0001' }));
  assert.strictEqual(lowBnb.withdrawal.status, 'failed', 'insufficient BNB gas fails withdrawal');
  assert(lowBnb.withdrawal.failureReason.includes('insufficient BNB'), 'insufficient BNB gas stores failureReason');

  const failedTxDb = db(), failedTx = createWithdrawalRequest(failedTxDb, failedTxDb.users[0], { amount: 20, address: userAddress });
  await processWithdrawalBroadcast(failedTxDb, failedTx.withdrawal, deps({ transferFails: true }));
  assert.strictEqual(failedTx.withdrawal.status, 'failed', 'transfer exception marks failed');
  assert(failedTx.withdrawal.failureReason.includes('mock transfer failed'), 'failure reason is stored');

  assert.throws(() => createWithdrawalRequest(db(), user, { amount: 90, address: userAddress }), /Maximum withdrawal/, 'max withdrawal is enforced');

  console.log('WITHDRAWAL AUTO SMOKE PASS: success, hot wallet balance, BNB gas, duplicate request, failed rollback, confirmations, and tx hash storage verified.');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
