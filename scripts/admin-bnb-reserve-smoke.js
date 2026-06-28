process.env.MARKET_TEST_MODE = 'true';
process.env.BNB_USDT_FALLBACK_PRICE = '600';
process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin-bnb-reserve@example.com';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'AdminReserve123!';
process.env.DATA_FILE = require('path').join(require('os').tmpdir(), `hb9-admin-bnb-reserve-${process.pid}.json`);

const assert = require('assert');
const fs = require('fs');
const { server, readDB, writeDB } = require('../server');

async function request(base, path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || payload.message || 'Request failed'), { status: response.status, payload });
  return payload;
}

(async () => {
  readDB();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const logoResponse = await fetch(`${base}/assets/bnb-logo.svg`);
  assert.strictEqual(logoResponse.status, 200);
  assert((logoResponse.headers.get('content-type') || '').includes('image/svg+xml'));

  const adminLogin = await request(base, '/api/auth/login', {
    method: 'POST',
    body: { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD }
  });

  const reserveUpdate = await request(base, '/api/admin/reserve-wallets', {
    method: 'PUT',
    token: adminLogin.token,
    body: { asset: 'BNB', walletType: 'exchange', balance: 1000 }
  });
  assert.strictEqual(reserveUpdate.wallet.asset, 'BNB');
  assert.strictEqual(reserveUpdate.wallet.walletType, 'exchange');
  assert.strictEqual(reserveUpdate.wallet.balance, 1000);
  assert.strictEqual(reserveUpdate.exchangeReserve.bnb.remaining, 1000);

  await request(base, '/api/auth/register', {
    method: 'POST',
    body: { name: 'BNB Reserve User', email: 'bnb-reserve-user@example.com', password: 'password123' }
  });
  const db = readDB();
  const user = db.users.find(item => item.email === 'bnb-reserve-user@example.com');
  db.deposits.push({ id: 'dep_bnb_reserve', userId: user.id, amount: 1000, status: 'approved', createdAt: new Date().toISOString() });
  db.settings.exchangeEnabled = true;
  writeDB(db);

  const userLogin = await request(base, '/api/auth/login', {
    method: 'POST',
    body: { email: 'bnb-reserve-user@example.com', password: 'password123' }
  });

  const converted = await request(base, '/api/convert', {
    method: 'POST',
    token: userLogin.token,
    body: { fromAsset: 'USDT', toAsset: 'BNB', amount: 600, clientRequestId: 'admin-bnb-reserve-convert' }
  });
  assert.strictEqual(converted.order.toAsset, 'BNB');
  assert.strictEqual(converted.order.bnbAmount, 1);
  assert.strictEqual(converted.balance.bnb, 1);

  const overview = await request(base, '/api/admin/overview', { token: adminLogin.token });
  assert.strictEqual(overview.exchangeReserve.bnb.sold, 1);
  assert.strictEqual(overview.exchangeReserve.bnb.remaining, 999);

  await assert.rejects(
    () => request(base, '/api/admin/reserve-wallets', {
      method: 'PUT',
      token: userLogin.token,
      body: { asset: 'BNB', walletType: 'exchange', balance: 1000 }
    }),
    /Admin only/
  );

  console.log('admin-bnb-reserve-smoke ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  server.close();
  try { fs.unlinkSync(process.env.DATA_FILE); } catch (_) {}
});
