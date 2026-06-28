process.env.MARKET_TEST_MODE = 'true';
process.env.BNB_USDT_FALLBACK_PRICE = '600';

const assert = require('assert');
const { convertUsdtToAsset, exchangeReserveReport, walletBalances } = require('../server');

function fixture({ bnbReserve = 0 } = {}) {
  const user = {
    id: 'usr_reserve',
    name: 'Reserve User',
    email: 'reserve@example.com',
    role: 'user',
    status: 'active',
    createdAt: new Date().toISOString()
  };
  return {
    users: [user],
    deposits: [{ id: 'dep_reserve', userId: user.id, amount: 2000000, status: 'approved', createdAt: new Date().toISOString() }],
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
    wallet_ledger: [],
    exchange_orders: [],
    reserve_wallets: [
      { asset: 'HB9', walletType: 'exchange', balance: 0, lockedBalance: 0 },
      { asset: 'HB9', walletType: 'income', balance: 1000000, lockedBalance: 0 },
      { asset: 'USDT', walletType: 'treasury', balance: 0, lockedBalance: 0 },
      { asset: 'BNB', walletType: 'exchange', balance: bnbReserve, lockedBalance: 0 }
    ],
    reserve_ledger: [],
    burn_ledger: [],
    hb9_supply: { totalSupply: 1000000, fixed: true },
    hb9_market_settings: {
      fallbackPrice: 1,
      priceOffset: 0,
      spreadPercent: 0,
      manualOverrideEnabled: true
    },
    settings: {
      exchangeEnabled: true,
      fallbackPrice: 1,
      hb9Price: 1,
      priceOffset: 0,
      buyFeePercent: 0,
      tradingFeePercent: 0,
      sellFeePercent: 0,
      directMultiplier: 2,
      referralPercent: 5,
      dailyRoi: 1
    }
  };
}

(async () => {
  const db = fixture();
  const user = db.users[0];

  assert.strictEqual(exchangeReserveReport(db).hb9.total, 1000000);
  assert.strictEqual(exchangeReserveReport(db).hb9.remaining, 1000000);
  assert.strictEqual(db.reserve_wallets.find(x => x.asset === 'HB9' && x.walletType === 'exchange').balance, 0);

  const first = await convertUsdtToAsset(db, user, { fromAsset: 'USDT', toAsset: 'HB9', amount: 100, clientRequestId: 'reserve-hb9-first' });
  assert.strictEqual(first.order.hb9Amount, 100);
  assert.strictEqual(walletBalances(db, user.id).hb9, 100);
  assert.strictEqual(exchangeReserveReport(db).hb9.sold, 100);
  assert.strictEqual(exchangeReserveReport(db).hb9.remaining, 999900);

  const second = await convertUsdtToAsset(db, user, { fromAsset: 'USDT', toAsset: 'HB9', amount: 999900, clientRequestId: 'reserve-hb9-second' });
  assert.strictEqual(second.order.hb9Amount, 999900);
  assert.strictEqual(exchangeReserveReport(db).hb9.sold, 1000000);
  assert.strictEqual(exchangeReserveReport(db).hb9.remaining, 0);

  await assert.rejects(
    () => convertUsdtToAsset(db, user, { fromAsset: 'USDT', toAsset: 'HB9', amount: 1, clientRequestId: 'reserve-hb9-exhausted' }),
    /HB9 reserve is insufficient/
  );

  const noBnb = fixture({ bnbReserve: 0 });
  await assert.rejects(
    () => convertUsdtToAsset(noBnb, noBnb.users[0], { fromAsset: 'USDT', toAsset: 'BNB', amount: 600, clientRequestId: 'reserve-bnb-none' }),
    /BNB reserve not configured/
  );

  const bnb = fixture({ bnbReserve: 1 });
  const bnbBuy = await convertUsdtToAsset(bnb, bnb.users[0], { fromAsset: 'USDT', toAsset: 'BNB', amount: 600, clientRequestId: 'reserve-bnb-one' });
  assert.strictEqual(bnbBuy.order.bnbAmount, 1);
  assert.strictEqual(exchangeReserveReport(bnb).bnb.sold, 1);
  assert.strictEqual(exchangeReserveReport(bnb).bnb.remaining, 0);

  await assert.rejects(
    () => convertUsdtToAsset(bnb, bnb.users[0], { fromAsset: 'USDT', toAsset: 'BNB', amount: 600, clientRequestId: 'reserve-bnb-exhausted' }),
    /BNB reserve insufficient|BNB reserve not configured/
  );

  console.log('exchange-reserve-smoke ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
