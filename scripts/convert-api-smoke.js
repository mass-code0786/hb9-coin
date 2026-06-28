process.env.MARKET_TEST_MODE = 'true';
process.env.BNB_USDT_FALLBACK_PRICE = '600';
process.env.DATA_FILE = require('path').join(require('os').tmpdir(), `hb9-convert-api-${process.pid}.json`);

const assert = require('assert');
const fs = require('fs');
const { server, readDB, writeDB } = require('../server');

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
  db.settings.hb9Price = 0.2;
  db.settings.fallbackPrice = 0.2;
  db.settings.priceOffset = 0;
  db.settings.buyFeePercent = 0;
  db.settings.tradingFeePercent = 0;
  db.hb9_market_settings = { fallbackPrice: 0.2, priceOffset: 0, spreadPercent: 0, manualOverrideEnabled: true };
  db.reserve_wallets = [
    { asset: 'HB9', walletType: 'exchange', balance: 1000000, lockedBalance: 0 },
    { asset: 'HB9', walletType: 'income', balance: 1000000, lockedBalance: 0 },
    { asset: 'USDT', walletType: 'treasury', balance: 1000000, lockedBalance: 0 },
    { asset: 'BNB', walletType: 'exchange', balance: 1000, lockedBalance: 0 }
  ];
  writeDB(db);

  const login = await request(base, '/api/auth/login', {
    method: 'POST',
    body: { email: 'convert@example.com', password: 'password123' }
  });
  const token = login.token;

  const hb9 = await request(base, '/api/convert', {
    method: 'POST',
    token,
    body: { fromAsset: 'USDT', toAsset: 'HB9', amount: 100, clientRequestId: 'api-hb9-convert' }
  });
  assert.strictEqual(hb9.order.toAsset, 'HB9');
  assert.strictEqual(hb9.conversion.toAsset, 'HB9');
  assert.strictEqual(hb9.balance.usdt, 900);
  assert.strictEqual(hb9.balance.hb9, 500);

  const bnb = await request(base, '/api/convert', {
    method: 'POST',
    token,
    body: { fromAsset: 'USDT', toAsset: 'BNB', amount: 600, clientRequestId: 'api-bnb-convert' }
  });
  assert.strictEqual(bnb.order.toAsset, 'BNB');
  assert.strictEqual(bnb.conversion.toAsset, 'BNB');
  assert.strictEqual(bnb.balance.usdt, 300);
  assert.strictEqual(bnb.balance.bnb, 1);

  const dashboard = await request(base, '/api/dashboard', { token });
  assert.strictEqual(dashboard.wallets.usdt, 300);
  assert.strictEqual(dashboard.wallets.hb9, 500);
  assert.strictEqual(dashboard.wallets.bnb, 1);
  assert.strictEqual(dashboard.conversions.length, 2);
  assert(dashboard.conversions.some(item => item.toAsset === 'BNB' && item.toAmount === 1), 'Conversion history exposes BNB toAmount');

  const diagnostic = await request(base, `/api/admin/diagnostics/bnb-wallet?userId=${user.id}`, { token });
  assert.strictEqual(diagnostic.asset, 'BNB');
  assert.strictEqual(diagnostic.credits, 1);
  assert.strictEqual(diagnostic.debits, 0);
  assert.strictEqual(diagnostic.computedBalance, 1);
  assert.strictEqual(diagnostic.dashboardBalance, 1);

  await assert.rejects(
    () => request(base, '/api/convert', {
      method: 'POST',
      token,
      body: { fromAsset: 'USDT', toAsset: 'BNB', amount: 10000, clientRequestId: 'api-bnb-insufficient' }
    }),
    /Not enough USDT/
  );

  console.log('convert-api-smoke ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  server.close();
  try { fs.unlinkSync(process.env.DATA_FILE); } catch (_) {}
});
