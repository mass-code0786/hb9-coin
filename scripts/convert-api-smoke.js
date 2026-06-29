process.env.MARKET_TEST_MODE = 'true';
process.env.BNB_USDT_FALLBACK_PRICE = '600';
process.env.DATA_FILE = require('path').join(require('os').tmpdir(), `hb9-convert-api-${process.pid}.json`);

const assert = require('assert');
const fs = require('fs');
const { server, readDB, writeDB, hb9PriceSource } = require('../server');

function request(base, path, { method = 'GET', token, body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  }).then(async response => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || payload.message || 'Request failed'), { status: response.status, payload });
    return payload;
  });
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  await request(base, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Convert User', email: 'convert@example.com', password: 'password123' }
  });

  const db = readDB();
  const user = db.users.find(item => item.email === 'convert@example.com');
  db.deposits.push({ id: 'dep_convert_api', userId: user.id, amount: 1000, status: 'approved', createdAt: new Date().toISOString() });
  db.settings.exchangeEnabled = true;
  db.settings.hb9Price = 0.19;
  db.settings.fallbackPrice = 0.19;
  db.settings.priceOffset = 0;
  db.settings.buyFeePercent = 0;
  db.settings.tradingFeePercent = 0;
  db.hb9_market_settings = { fallbackPrice: 0.19, priceOffset: 0, spreadPercent: 0, manualOverrideEnabled: false };
  db.reserve_wallets = [
    { asset: 'HB9', walletType: 'exchange', balance: 1000000, lockedBalance: 0 },
    { asset: 'HB9', walletType: 'income', balance: 1000000, lockedBalance: 0 },
    { asset: 'USDT', walletType: 'treasury', balance: 1000000, lockedBalance: 0 },
    { asset: 'BNB', walletType: 'exchange', balance: 1000, lockedBalance: 0 }
  ];
  writeDB(db);
  const hb9Price = await hb9PriceSource(db);

  const login = await request(base, '/api/auth/login', {
    method: 'POST',
    body: { email: 'convert@example.com', password: 'password123' }
  });
  const token = login.token;

  const hb9 = await request(base, '/api/convert', {
    method: 'POST',
    token,
    body: { fromAsset: 'USDT', toAsset: 'HB9', amount: 225, clientRequestId: 'api-hb9-convert' }
  });
  assert.strictEqual(hb9.order.toAsset, 'HB9');
  assert.strictEqual(hb9.conversion.toAsset, 'HB9');
  assert.strictEqual(hb9.balance.usdt, 775);
  assert.strictEqual(hb9.balance.hb9, 100);
  assert.strictEqual(hb9.order.price, hb9Price.buyPrice);
  assert.strictEqual(hb9.order.reinvestAmountHb9, undefined, 'USDT -> HB9 must not apply auto reinvest');
  assert.strictEqual(readDB().stakes.filter(item => item.source === 'AUTO_REINVEST_FROM_CONVERSION').length, 0, 'USDT -> HB9 must not create auto reinvest stake');

  const hb9Sell = await request(base, '/api/convert', {
    method: 'POST',
    token,
    body: { fromAsset: 'HB9', toAsset: 'USDT', amount: 100, price: 999, clientRequestId: 'api-hb9-sell' }
  });
  assert.strictEqual(hb9Sell.order.fromAsset, 'HB9');
  assert.strictEqual(hb9Sell.order.toAsset, 'USDT');
  assert.strictEqual(hb9Sell.order.direction, 'sell');
  assert.strictEqual(hb9Sell.order.fromAmount, 100);
  assert.strictEqual(hb9Sell.order.reinvestAmountHb9, 20);
  assert.strictEqual(hb9Sell.order.convertedAmountHb9, 80);
  assert.strictEqual(hb9Sell.order.hb9Amount, 80);
  assert.strictEqual(hb9Sell.order.toAmount, 180);
  assert.strictEqual(hb9Sell.order.price, hb9Price.buyPrice, 'Backend must price HB9 -> USDT without trusting frontend price');
  assert.strictEqual(hb9Sell.balance.usdt, 955);
  assert.strictEqual(hb9Sell.balance.hb9, 0);
  let afterSellDb = readDB();
  const autoStake = afterSellDb.stakes.find(item => item.source === 'AUTO_REINVEST_FROM_CONVERSION' && item.relatedConversionId === hb9Sell.conversion.id);
  assert(autoStake, 'HB9 -> USDT must create auto reinvest stake');
  assert.strictEqual(autoStake.stakeAsset, 'HB9');
  assert.strictEqual(autoStake.stakeAmount, 20);
  assert.strictEqual(autoStake.status, 'active');
  assert(afterSellDb.wallet_ledger.some(item => item.refId === hb9Sell.order.id && item.asset === 'HB9' && item.direction === 'debit' && item.amount === 100), 'HB9 -> USDT debits full HB9 amount');
  assert(afterSellDb.wallet_ledger.some(item => item.refId === hb9Sell.order.id && item.asset === 'USDT' && item.direction === 'credit' && item.amount === 180), 'HB9 -> USDT credits only 80% value as USDT');
  const beforeSellRetry = afterSellDb.wallet_ledger.length;
  const beforeStakeRetry = afterSellDb.stakes.length;
  const hb9SellRetry = await request(base, '/api/convert', {
    method: 'POST',
    token,
    body: { fromAsset: 'HB9', toAsset: 'USDT', amount: 100, clientRequestId: 'api-hb9-sell' }
  });
  assert.strictEqual(hb9SellRetry.order.id, hb9Sell.order.id);
  assert.strictEqual(readDB().wallet_ledger.length, beforeSellRetry, 'HB9 -> USDT idempotency prevents duplicate ledger entries');
  assert.strictEqual(readDB().stakes.length, beforeStakeRetry, 'HB9 -> USDT idempotency prevents duplicate reinvest stake');

  const tinyBnb = await request(base, '/api/convert', {
    method: 'POST',
    token,
    body: { fromAsset: 'USDT', toAsset: 'BNB', amount: 0.5, clientRequestId: 'api-bnb-tiny-convert' }
  });
  assert.strictEqual(tinyBnb.order.toAsset, 'BNB');
  assert.strictEqual(tinyBnb.order.toAmount, 0.00083333);
  assert.strictEqual(tinyBnb.order.bnbAmount, 0.00083333);
  assert.strictEqual(tinyBnb.balance.usdt, 954.5);
  assert.strictEqual(tinyBnb.balance.bnb, 0.00083333);
  assert(readDB().wallet_ledger.some(item => item.refId === tinyBnb.order.id && item.asset === 'BNB' && item.amount === 0.00083333), 'BNB ledger credit uses decimal amount');

  const bnb = await request(base, '/api/convert', {
    method: 'POST',
    token,
    body: { fromAsset: 'USDT', toAsset: 'BNB', amount: 600, clientRequestId: 'api-bnb-convert' }
  });
  assert.strictEqual(bnb.order.toAsset, 'BNB');
  assert.strictEqual(bnb.conversion.toAsset, 'BNB');
  assert.strictEqual(bnb.balance.usdt, 354.5);
  assert.strictEqual(bnb.balance.bnb, 1.00083333);

  const dashboard = await request(base, '/api/dashboard', { token });
  assert.strictEqual(dashboard.wallets.usdt, 354.5);
  assert.strictEqual(dashboard.wallets.hb9, 0);
  assert.strictEqual(dashboard.wallets.bnb, 1.00083333);
  assert(dashboard.stakes.some(item => item.source === 'AUTO_REINVEST_FROM_CONVERSION' && item.stakeAmount === 20), 'Dashboard/My Staking exposes auto reinvest stake');
  assert.strictEqual(dashboard.conversions.length, 4);
  assert(dashboard.conversions.some(item => item.toAsset === 'BNB' && item.toAmount === 1), 'Conversion history exposes BNB toAmount');
  assert(dashboard.conversions.some(item => item.toAsset === 'BNB' && item.toAmount === 0.00083333), 'Conversion history exposes tiny BNB decimal received amount');
  assert(dashboard.conversions.some(item => item.fromAsset === 'HB9' && item.toAsset === 'USDT' && item.fromAmount === 100 && item.reinvestAmountHb9 === 20 && item.convertedAmountHb9 === 80 && item.toAmount === 180), 'Conversion history exposes HB9 -> USDT reinvest split');

  const diagnostic = await request(base, `/api/admin/diagnostics/bnb-wallet?userId=${user.id}`, { token });
  assert.strictEqual(diagnostic.asset, 'BNB');
  assert.strictEqual(diagnostic.credits, 1.00083333);
  assert.strictEqual(diagnostic.debits, 0);
  assert.strictEqual(diagnostic.computedBalance, 1.00083333);
  assert.strictEqual(diagnostic.dashboardBalance, 1.00083333);

  await assert.rejects(
    () => request(base, '/api/convert', {
      method: 'POST',
      token,
      body: { fromAsset: 'USDT', toAsset: 'BNB', amount: 10000, clientRequestId: 'api-bnb-insufficient' }
    }),
    /Not enough USDT/
  );
  await assert.rejects(
    () => request(base, '/api/convert', {
      method: 'POST',
      token,
      body: { fromAsset: 'HB9', toAsset: 'USDT', amount: 10000, clientRequestId: 'api-hb9-insufficient' }
    }),
    /Not enough HB9/
  );

  console.log('convert-api-smoke ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  server.close();
  try { fs.unlinkSync(process.env.DATA_FILE); } catch (_) {}
});
