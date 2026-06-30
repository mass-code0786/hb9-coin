const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb9-nowpayments-runtime-'));
process.env.DATA_FILE = path.join(tempDir, 'db.json');
process.env.MARKET_TEST_MODE = 'true';
process.env.NOWPAYMENTS_API_KEY = 'runtime_mode_api_key';
process.env.NOWPAYMENTS_IPN_SECRET = 'runtime_mode_ipn_secret';
process.env.NOWPAYMENTS_MOCK = 'true';
process.env.BSC_RPC_URL = 'http://127.0.0.1:1';
process.env.BOOTSTRAP_ADMIN_EMAIL = 'runtime-admin@hb9.local';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'RuntimeAdmin@123';

const {
  DEPOSIT_RUNTIME_MODE,
  pollDepositWatcher,
  pollSweepWorker,
  server,
  startDepositWatcher,
  startSweepWorker
} = require('../server');

async function main() {
  assert.deepStrictEqual(DEPOSIT_RUNTIME_MODE, { provider: 'NOWPayments', hdWatcherEnabled: false });
  assert.strictEqual(startDepositWatcher(), false, 'legacy deposit watcher startup must be disabled');
  assert.strictEqual(startSweepWorker(), false, 'legacy sweep worker startup must be disabled');
  assert.deepStrictEqual(await pollDepositWatcher(), { disabled: true, provider: 'NOWPayments' }, 'deposit watcher poll must be hard-disabled');
  assert.deepStrictEqual(await pollSweepWorker(), { disabled: true, provider: 'NOWPayments' }, 'sweep worker poll must be hard-disabled');

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, options = {}, expectedStatus = 200) => {
    const response = await fetch(`${base}${url}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
      }
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    assert.strictEqual(response.status, expectedStatus, `${url} expected ${expectedStatus}, got ${response.status}: ${text}`);
    return payload;
  };

  const userAuth = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Runtime User', email: 'runtime-user@hb9.local', password: 'Password@123' })
  }, 201);
  await request('/api/deposit-address', { token: userAuth.token }, 410);
  await request('/api/internal/deposit-events', {
    method: 'POST',
    token: userAuth.token,
    body: JSON.stringify({})
  }, 410);

  const adminAuth = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD })
  });
  await request('/api/admin/sweeps', { token: adminAuth.token }, 410);
  await request('/api/admin/sweeps/swp_test/retry', {
    method: 'POST',
    token: adminAuth.token,
    body: JSON.stringify({})
  }, 410);

  await new Promise(resolve => server.close(resolve));
  console.log('nowpayments-runtime-mode-smoke ok');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (server.listening) server.close();
});
