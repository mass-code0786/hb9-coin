const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb9-wallet-'));
process.env.DATA_FILE = path.join(tempDir, 'db.json');
process.env.MARKET_TEST_MODE = 'true';
process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin-wallet@hb9.local';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'AdminWallet@123';

const { server, readDB } = require('../server');

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, options = {}, expectedStatus = 200) => {
    const response = await fetch(`${base}${url}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    assert.strictEqual(response.status, expectedStatus, `${url} expected ${expectedStatus}, got ${response.status}: ${text}`);
    return payload;
  };
  const register = (email) => request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: email.split('@')[0], email, password: 'Password@123' })
  }, 201);

  const first = await register('wallet-user1@hb9.local');
  assert(first.token, 'registration should auto-login without a wallet address');
  assert.strictEqual(first.user.usdtBep20WalletAddress, undefined, 'registration should not require wallet address');

  const second = await register('wallet-user2@hb9.local');
  const validAddress = '0x1111111111111111111111111111111111111111';
  const bind = await request('/api/profile/usdt-bep20-wallet', {
    method: 'POST',
    token: first.token,
    body: JSON.stringify({ walletAddress: validAddress })
  });
  assert.strictEqual(bind.user.usdtBep20WalletAddress, validAddress, 'valid lowercase EVM address should bind');
  assert(bind.user.walletBoundAt, 'walletBoundAt should be set on first bind');
  assert(bind.user.walletUpdatedAt, 'walletUpdatedAt should be set on first bind');

  await request('/api/profile/usdt-bep20-wallet', {
    method: 'POST',
    token: first.token,
    body: JSON.stringify({ walletAddress: '0x123' })
  }, 400);

  await request('/api/profile/usdt-bep20-wallet', {
    method: 'POST',
    token: first.token,
    body: JSON.stringify({ userId: second.user.id, walletAddress: '0x2222222222222222222222222222222222222222' })
  });
  const dbAfterCrossAttempt = readDB();
  const secondUser = dbAfterCrossAttempt.users.find(user => user.id === second.user.id);
  assert(!secondUser.usdtBep20WalletAddress, 'user must not update another user wallet');

  const dashboard = await request('/api/dashboard', { token: first.token });
  assert.strictEqual(dashboard.user.usdtBep20WalletAddress, '0x2222222222222222222222222222222222222222', 'profile should return bound wallet address after update');

  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD })
  });
  const overview = await request('/api/admin/overview', { token: adminLogin.token });
  const adminFirstUser = overview.users.find(user => user.id === first.user.id);
  assert.strictEqual(adminFirstUser.usdtBep20WalletAddress, dashboard.user.usdtBep20WalletAddress, 'admin should see bound wallet address');

  const auditTypes = readDB().auditLogs.map(log => log.type);
  assert(auditTypes.includes('USER_USDT_BEP20_WALLET_BOUND'), 'bind audit log should be recorded');
  assert(auditTypes.includes('USER_USDT_BEP20_WALLET_UPDATED'), 'update audit log should be recorded');

  console.log('usdt-bep20-wallet-smoke ok');
}

main().finally(() => server.close());
