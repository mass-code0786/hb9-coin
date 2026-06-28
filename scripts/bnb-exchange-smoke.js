process.env.MARKET_TEST_MODE = 'true';
process.env.BNB_USDT_FALLBACK_PRICE = '600';

const assert = require('assert');
const {
  adminFundTransfer,
  bnbLedgerDiagnostic,
  convertUsdtToAsset,
  createStake,
  dashboard,
  repairBnbConversionPrecision,
  walletBalances
} = require('../server');

function dbFixture() {
  const user = {
    id: 'usr_bnb',
    name: 'BNB User',
    email: 'bnb@example.com',
    passwordHash: 'x',
    role: 'user',
    status: 'active',
    blocked: false,
    sponsorId: null,
    createdAt: new Date().toISOString()
  };
  const admin = {
    id: 'adm_bnb',
    name: 'Admin',
    email: 'admin@example.com',
    passwordHash: 'x',
    role: 'admin',
    status: 'active',
    blocked: false,
    createdAt: new Date().toISOString()
  };
  return {
    users: [user, admin],
    deposits: [{ id: 'dep_seed', userId: user.id, amount: 1000, status: 'approved', createdAt: new Date().toISOString() }],
    conversions: [],
    stakes: [],
    withdrawals: [],
    transfers: [],
    directBusiness: [],
    incomeLedger: [],
    referralLedger: [],
    level_income_ledger: [],
    salary_payouts: [],
    globalTeamRecords: [],
    flushRecords: [],
    dailyRuns: [],
    auditLogs: [],
    wallet_ledger: [],
    exchange_orders: [],
    reserve_wallets: [
      { asset: 'HB9', walletType: 'exchange', balance: 1000000, lockedBalance: 0 },
      { asset: 'HB9', walletType: 'income', balance: 1000000, lockedBalance: 0 },
      { asset: 'USDT', walletType: 'treasury', balance: 1000000, lockedBalance: 0 },
      { asset: 'BNB', walletType: 'exchange', balance: 1000, lockedBalance: 0 }
    ],
    reserve_ledger: [],
    burn_ledger: [],
    hb9_supply: { totalSupply: 1000000000, burned: 0 },
    hb9_market_settings: {
      fallbackPrice: 0.2,
      priceOffset: 0,
      spreadPercent: 0,
      manualOverrideEnabled: true
    },
    settings: {
      exchangeEnabled: true,
      fallbackPrice: 0.2,
      hb9Price: 0.2,
      priceOffset: 0,
      buyFeePercent: 0,
      sellFeePercent: 0,
      tradingFeePercent: 0,
      lockDays: 15,
      dailyRate: 0.01,
      referralPercent: 5,
      directBusinessRequired: 0
    }
  };
}

(async () => {
  const db = dbFixture();
  const user = db.users.find(x => x.role === 'user');
  const admin = db.users.find(x => x.role === 'admin');

  const hb9Buy = await convertUsdtToAsset(db, user, { amount: 100, toAsset: 'HB9', clientRequestId: 'hb9-buy-1' });
  assert.strictEqual(hb9Buy.order.toAsset, 'HB9');
  assert.strictEqual(hb9Buy.order.fromAsset, 'USDT');
  assert.strictEqual(hb9Buy.order.toAmount, 500);
  assert.strictEqual(hb9Buy.conversion.toAsset, 'HB9');
  assert.strictEqual(hb9Buy.balance.usdt, 900);
  assert.strictEqual(walletBalances(db, user.id).hb9, 500);
  assert(db.wallet_ledger.some(x => x.refId === hb9Buy.order.id && x.asset === 'USDT' && x.direction === 'debit'));
  assert(db.wallet_ledger.some(x => x.refId === hb9Buy.order.id && x.asset === 'HB9' && x.direction === 'credit'));

  const beforeRetryLedger = db.wallet_ledger.length;
  const retry = await convertUsdtToAsset(db, user, { amount: 100, toAsset: 'HB9', clientRequestId: 'hb9-buy-1' });
  assert.strictEqual(retry.order.id, hb9Buy.order.id);
  assert.strictEqual(db.wallet_ledger.length, beforeRetryLedger);

  const hb9Sell = await convertUsdtToAsset(db, user, { fromAsset: 'HB9', toAsset: 'USDT', amount: 100, price: 999, clientRequestId: 'hb9-sell-1' });
  assert.strictEqual(hb9Sell.order.fromAsset, 'HB9');
  assert.strictEqual(hb9Sell.order.toAsset, 'USDT');
  assert.strictEqual(hb9Sell.order.direction, 'sell');
  assert.strictEqual(hb9Sell.order.toAmount, 20);
  assert.strictEqual(hb9Sell.order.price, 0.2, 'server-side HB9 price is used instead of frontend price');
  assert.strictEqual(hb9Sell.balance.usdt, 920);
  assert.strictEqual(hb9Sell.balance.hb9, 400);
  assert(db.wallet_ledger.some(x => x.refId === hb9Sell.order.id && x.asset === 'HB9' && x.direction === 'debit'));
  assert(db.wallet_ledger.some(x => x.refId === hb9Sell.order.id && x.asset === 'USDT' && x.direction === 'credit'));
  const beforeSellRetryLedger = db.wallet_ledger.length;
  const hb9SellRetry = await convertUsdtToAsset(db, user, { fromAsset: 'HB9', toAsset: 'USDT', amount: 100, clientRequestId: 'hb9-sell-1' });
  assert.strictEqual(hb9SellRetry.order.id, hb9Sell.order.id);
  assert.strictEqual(db.wallet_ledger.length, beforeSellRetryLedger);

  const tinyBnbBuy = await convertUsdtToAsset(db, user, { amount: 0.5, toAsset: 'BNB', clientRequestId: 'bnb-buy-small' });
  assert.strictEqual(tinyBnbBuy.order.toAsset, 'BNB');
  assert.strictEqual(tinyBnbBuy.order.toAmount, 0.00083333);
  assert.strictEqual(tinyBnbBuy.order.bnbAmount, 0.00083333);
  assert.strictEqual(tinyBnbBuy.balance.usdt, 919.5);
  assert.strictEqual(tinyBnbBuy.balance.bnb, 0.00083333);
  assert(db.wallet_ledger.some(x => x.refId === tinyBnbBuy.order.id && x.asset === 'BNB' && x.direction === 'credit' && x.amount === 0.00083333));

  const bnbBuy = await convertUsdtToAsset(db, user, { amount: 600, toAsset: 'BNB' });
  assert.strictEqual(bnbBuy.order.toAsset, 'BNB');
  assert.strictEqual(bnbBuy.order.toAmount, 1);
  assert.strictEqual(bnbBuy.conversion.toAsset, 'BNB');
  assert.strictEqual(bnbBuy.balance.usdt, 319.5);
  assert.strictEqual(walletBalances(db, user.id).bnb, 1.00083333);
  assert.strictEqual(dashboard(db, user).wallets.bnb, 1.00083333);
  assert.strictEqual(dashboard(db, user).conversions.length, 4);
  assert(db.wallet_ledger.some(x => x.refId === bnbBuy.order.id && x.asset === 'USDT' && x.direction === 'debit'));
  assert(db.wallet_ledger.some(x => x.refId === bnbBuy.order.id && x.asset === 'BNB' && x.direction === 'credit'));

  await assert.rejects(
    () => convertUsdtToAsset(db, user, { amount: 10000, toAsset: 'BNB' }),
    /Not enough USDT/
  );

  const hb9Stake = await createStake(db, user, { amount: 100, stakeAsset: 'HB9' });
  assert.strictEqual(hb9Stake.stakeAsset, 'HB9');
  assert.strictEqual(hb9Stake.hb9EquivalentAmount, 100);
  assert.strictEqual(walletBalances(db, user.id).hb9, 300);

  const bnbStake = await createStake(db, user, { amount: 0.5, stakeAsset: 'BNB', clientRequestId: 'bnb-stake-1' });
  assert.strictEqual(bnbStake.stakeAsset, 'BNB');
  assert.strictEqual(bnbStake.bnbPriceAtStake, 600);
  assert.strictEqual(bnbStake.stakeUsdValue, 300);
  assert.strictEqual(bnbStake.hb9EquivalentAmount, 1500);
  assert.strictEqual(walletBalances(db, user.id).bnb, 0.50083333);
  const beforeStakeRetryLedger = db.wallet_ledger.length;
  const bnbStakeRetry = await createStake(db, user, { amount: 0.5, stakeAsset: 'BNB', clientRequestId: 'bnb-stake-1' });
  assert.strictEqual(bnbStakeRetry.id, bnbStake.id);
  assert.strictEqual(db.wallet_ledger.length, beforeStakeRetryLedger);

  const summary = dashboard(db, user);
  assert.strictEqual(summary.stats.activeStakeHb9, 1600);
  assert.strictEqual(summary.stats.activeStake, 320);
  assert.notStrictEqual(summary.stats.activeStakeHb9, 100.5);

  await assert.rejects(
    () => createStake(db, user, { amount: 10, stakeAsset: 'BNB' }),
    /Not enough BNB/
  );

  assert.throws(
    () => adminFundTransfer(db, user, { userId: user.id, asset: 'BNB', action: 'credit', amount: 1, reason: 'bad actor' }),
    /Admin only/
  );
  await adminFundTransfer(db, admin, { userId: user.id, asset: 'BNB', action: 'credit', amount: 0.25, reason: 'admin bnb smoke' });
  assert.strictEqual(walletBalances(db, user.id).bnb, 0.75083333);
  const originalConversions = db.conversions;
  db.conversions = db.conversions.filter(item => item.toAsset !== 'BNB');
  assert.strictEqual(walletBalances(db, user.id).bnb, 0.75083333, 'BNB balance must still compute from BNB wallet ledger credits/debits if conversion rows are unavailable');
  const diagnostic = bnbLedgerDiagnostic(db, user.id);
  assert.strictEqual(diagnostic.credits, 1.25083333);
  assert.strictEqual(diagnostic.debits, 0.5);
  assert.strictEqual(diagnostic.computedBalance, 0.75083333);
  assert.strictEqual(diagnostic.dashboardBalance, 0.75083333);
  db.conversions = originalConversions;

  const bad = dbFixture();
  bad.conversions.push({ id: 'cnv_bad_bnb', orderId: 'xord_bad_bnb', userId: bad.users[0].id, direction: 'buy', fromAsset: 'USDT', toAsset: 'BNB', fromAmount: 0.5, usdtAmount: 0.5, toAmount: 0, bnbAmount: 0, price: 600, status: 'completed' });
  bad.exchange_orders.push({ id: 'xord_bad_bnb', conversionId: 'cnv_bad_bnb', userId: bad.users[0].id, direction: 'buy', fromAsset: 'USDT', toAsset: 'BNB', fromAmount: 0.5, usdtAmount: 0.5, toAmount: 0, bnbAmount: 0, price: 600, status: 'completed' });
  bad.wallet_ledger.push({ id: 'wlt_bad_bnb', userId: bad.users[0].id, asset: 'BNB', direction: 'credit', amount: 0, refId: 'xord_bad_bnb' });
  bad.reserve_ledger.push({ id: 'rsv_bad_bnb', asset: 'BNB', walletType: 'exchange', direction: 'debit', amount: 0, refId: 'xord_bad_bnb', balanceAfter: 1000 });
  const repair = repairBnbConversionPrecision(bad);
  assert.strictEqual(repair.corrected, 1);
  assert.strictEqual(bad.conversions[0].toAmount, 0.00083333);
  assert.strictEqual(bad.exchange_orders[0].bnbAmount, 0.00083333);
  assert.strictEqual(bad.wallet_ledger.find(item => item.id === 'wlt_bad_bnb').amount, 0.00083333);
  assert.strictEqual(bad.reserve_ledger.find(item => item.id === 'rsv_bad_bnb').amount, 0.00083333);

  console.log('bnb-exchange-smoke ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
