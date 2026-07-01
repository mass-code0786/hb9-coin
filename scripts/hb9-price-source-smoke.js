process.env.BNB_USDT_FALLBACK_PRICE = '600';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  convertUsdtToAsset,
  createStake,
  hb9PriceSource,
  runRoiDaily
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
  const originalFetch = global.fetch;
  const originalFallback = process.env.HB9_PRICE_FALLBACK;
  const originalMarketTestMode = process.env.MARKET_TEST_MODE;
  delete process.env.MARKET_TEST_MODE;
  delete process.env.HB9_PRICE_FALLBACK;

  global.fetch = async url => {
    const value = String(url);
    if (value.includes('BNBUSDT')) return { ok: false, json: async () => ({}) };
    if (value.includes('ICPUSDT') && value.includes('/ticker/24hr')) return { ok: true, json: async () => ({ lastPrice: '2.25', highPrice: '2.50', lowPrice: '2.00', volume: '1000', quoteVolume: '2250', priceChangePercent: '1.5' }) };
    if (value.includes('ICPUSDT') && value.includes('/klines')) return { ok: true, json: async () => [[Date.now(), '2.20', '2.30', '2.10', '2.25', '100']] };
    return { ok: false, json: async () => ({}) };
  };

  const db = fixture();
  const user = db.users[0];
  const price = await hb9PriceSource(db);
  assert.strictEqual(price.source, 'icp_proxy', 'live backend ICP/HB9 source is used first');
  assert.strictEqual(price.price, 2.25, 'live backend ICP/HB9 source returns price');
  assert.strictEqual(price.fallbackUsed, false, 'live backend success does not use fallback');

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

  const fallbackDb = fixture(9);
  fallbackDb.hb9_market_settings.manualOverrideEnabled = false;
  global.fetch = async () => ({ ok: false, json: async () => ({}) });
  await assert.rejects(() => hb9PriceSource(fallbackDb), /missing env HB9_PRICE_FALLBACK/, 'missing env fallback gives exact env name and does not silently use 0.2');
  process.env.HB9_PRICE_FALLBACK = '3.5';
  const fallbackPrice = await hb9PriceSource(fallbackDb);
  assert.strictEqual(fallbackPrice.price, 3.5, 'env fallback is used when ICP API fails');
  assert.strictEqual(fallbackPrice.source, 'env_fallback');
  assert.strictEqual(fallbackPrice.fallbackUsed, true);

  const b1Db = fixture();
  b1Db.stakes.push({ id: 'stk_price_b1', userId: user.id, stakeAsset: 'HB9', amount: 40, usdValueAtStake: 40, stakeUsdValue: 40, stakeAmount: 10, hb9EquivalentAmount: 10, status: 'active', startDate: '2026-06-29', createdAt: '2026-06-29T10:00:00.000Z' });
  b1Db.directBusiness.push({ id: 'biz_price_b1', userId: user.id, sourceUserId: null, amount: 80, reason: 'B1 fallback price smoke', createdAt: '2026-06-29T11:00:00.000Z' });
  process.env.HB9_PRICE_FALLBACK = '4';
  const b1Summary = await runRoiDaily(b1Db, { now: new Date('2026-06-29T18:00:00.000Z'), fromDate: '2026-06-29', toDate: '2026-06-29' });
  const b1Row = b1Db.incomeLedger.find(row => row.userId === user.id && row.stakeId === 'stk_price_b1' && row.date === '2026-06-29');
  assert.strictEqual(b1Summary.hb9Price, 4, 'B1 scheduler uses centralized fallback price');
  assert.strictEqual(b1Summary.hb9PriceSource.fallbackUsed, true, 'B1 scheduler reports fallback price source');
  assert(b1Row && b1Row.paidB1Usd > 0 && b1Row.paidB1Hb9 === Number((b1Row.paidB1Usd / 4).toFixed(2)), 'B1 scheduler credits HB9 using fallback price');

  global.fetch = originalFetch;
  if (originalFallback === undefined) delete process.env.HB9_PRICE_FALLBACK;
  else process.env.HB9_PRICE_FALLBACK = originalFallback;
  if (originalMarketTestMode === undefined) delete process.env.MARKET_TEST_MODE;
  else process.env.MARKET_TEST_MODE = originalMarketTestMode;

  console.log('hb9-price-source-smoke ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
