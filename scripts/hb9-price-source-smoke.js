process.env.MARKET_TEST_MODE = 'true';
process.env.BNB_USDT_FALLBACK_PRICE = '600';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  convertUsdtToAsset,
  createStake,
  hb9PriceSource
} = require('../server');

function fixture(price = 2.25) {
  const now = new Date().toISOString();
  const user = { id: 'usr_price', name: 'Price User', email: 'price@example.com', role: 'user', status: 'active', createdAt: now };
  return {
    users: [user],
    deposits: [{ id: 'dep_price', userId: user.id, amount: 1000, status: 'approved', createdAt: now }],
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
    exchange_orders: [],
    income_emissions: [],
    settings: {
      exchangeEnabled: true,
      fallbackPrice: price,
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
      fallbackPrice: price,
      priceOffset: 0,
      spreadPercent: 0,
      manualOverrideEnabled: false
    }
  };
}

(async () => {
  const db = fixture();
  const user = db.users[0];
  const price = await hb9PriceSource(db);
  assert.strictEqual(price.price, 2.25, 'single backend HB9 source returns test ICP price');

  const conversion = await convertUsdtToAsset(db, user, { amount: 225, toAsset: 'HB9', clientRequestId: 'price-hb9' });
  assert.strictEqual(conversion.order.price, price.buyPrice, 'conversion uses backend HB9 buy price');
  assert.strictEqual(conversion.order.toAmount, 100, 'conversion amount follows backend HB9 price');

  const hb9Stake = await createStake(db, user, { amount: 50, stakeAsset: 'HB9', clientRequestId: 'price-hb9-stake' });
  assert.strictEqual(hb9Stake.hb9PriceAtStake, price.buyPrice, 'HB9 stake uses backend HB9 buy price');
  assert.strictEqual(hb9Stake.stakeUsdValue, 112.5, 'HB9 stake USD uses backend HB9 price');

  db.wallet_ledger.push({ id: 'wlt_bnb_price', userId: user.id, asset: 'BNB', direction: 'credit', amount: 1, reason: 'BNB price test', refId: 'bnb-price', createdAt: new Date().toISOString(), immutable: true });
  const bnbStake = await createStake(db, user, { amount: 0.5, stakeAsset: 'BNB', clientRequestId: 'price-bnb-stake' });
  assert.strictEqual(bnbStake.bnbPriceAtStake, 600);
  assert.strictEqual(bnbStake.stakeUsdValue, 300);
  assert.strictEqual(bnbStake.hb9EquivalentAmount, 133.33, 'BNB HB9 equivalent uses backend HB9 price');

  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'latin1');
  const bnbExchange = fs.readFileSync(path.join(__dirname, '..', 'public', 'bnb-exchange.js'), 'utf8');
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert(app.includes('hb9PriceValue'), 'stake/dashboard frontend reads resolved backend price helper');
  assert(!/data\.settings\.hb9Price/.test(app), 'app frontend does not read stale settings.hb9Price');
  assert(!/data\.settings\.hb9Price/.test(bnbExchange), 'BNB exchange frontend does not read stale settings.hb9Price');
  assert(!/hb9Price\s*:\s*0\.20?(?!\d)|fallbackPrice\s*:\s*0\.20?(?!\d)|\|\|\s*0\.20?(?!\d)/.test(serverSource), 'server price paths do not hardcode 0.2 fallback');
  assert(!/data\.settings\.hb9Price|0\.20?(?!\d)/.test(app), 'frontend price paths do not hardcode stale 0.2');
  assert(!/data\.settings\.hb9Price|0\.20?(?!\d)/.test(bnbExchange), 'BNB/stake frontend price paths do not hardcode stale 0.2');

  delete process.env.MARKET_TEST_MODE;
  delete process.env.HB9_PRICE_FALLBACK;
  const fallbackDb = fixture(9);
  fallbackDb.hb9_market_settings.manualOverrideEnabled = false;
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, json: async () => ({}) });
  await assert.rejects(() => hb9PriceSource(fallbackDb), /HB9 price source unavailable/, 'missing env fallback does not silently use 0.2');
  process.env.HB9_PRICE_FALLBACK = '3.5';
  const fallbackPrice = await hb9PriceSource(fallbackDb);
  assert.strictEqual(fallbackPrice.price, 3.5, 'env fallback is used when ICP API fails');
  assert.strictEqual(fallbackPrice.fallbackUsed, true);
  global.fetch = originalFetch;

  console.log('hb9-price-source-smoke ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
