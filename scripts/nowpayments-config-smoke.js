const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appDir = path.join(__dirname, '..');
const envPath = path.join(appDir, '.env');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb9-nowpayments-config-'));
const backupPath = path.join(tempDir, '.env.backup');
const hadEnv = fs.existsSync(envPath);

if (hadEnv) fs.copyFileSync(envPath, backupPath);

async function main() {
  fs.writeFileSync(envPath, [
    'NOWPAYMENTS_API_KEY=smoke_api_key',
    'NOWPAYMENTS_IPN_SECRET=smoke_ipn_secret',
    'NOWPAYMENTS_BASE_URL=https://api.nowpayments.io/v1'
  ].join('\n'));

  process.env.DATA_FILE = path.join(tempDir, 'db.json');
  process.env.MARKET_TEST_MODE = 'true';
  process.env.NOWPAYMENTS_API_KEY = '';
  process.env.NOWPAYMENTS_IPN_SECRET = '';
  process.env.NOWPAYMENTS_MOCK = 'true';
  process.chdir(os.tmpdir());

  const { server } = require('../server');
  assert.strictEqual(process.env.NOWPAYMENTS_API_KEY, 'smoke_api_key', '.env must override empty inherited API key');
  assert.strictEqual(process.env.NOWPAYMENTS_IPN_SECRET, 'smoke_ipn_secret', '.env must override empty inherited IPN secret');

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

  const auth = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'NOWPayments Config', email: 'nowpayments-config@hb9.local', password: 'Password@123' })
  }, 201);
  const dashboard = await request('/api/dashboard', { token: auth.token });
  assert.strictEqual(dashboard.depositService.configured, true, 'dashboard deposit service should be configured');
  assert.notStrictEqual(dashboard.depositService.message, 'NOWPayments deposit gateway is not configured yet.');

  const deposit = await request('/api/deposits', {
    method: 'POST',
    token: auth.token,
    body: JSON.stringify({ amount: 10 })
  }, 201);
  assert.strictEqual(deposit.service.configured, true, 'deposit API should see configured NOWPayments service');
  assert.notStrictEqual(deposit.message, 'NOWPayments deposit gateway is not configured yet.');

  await new Promise(resolve => server.close(resolve));
  console.log('nowpayments-config-smoke ok');
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      if (hadEnv) fs.copyFileSync(backupPath, envPath);
      else fs.rmSync(envPath, { force: true });
    } catch (_) {}
  });
