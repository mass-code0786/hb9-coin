const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb9-deposit-page-'));
process.env.DATA_FILE = path.join(tempDir, 'db.json');
process.env.MARKET_TEST_MODE = 'true';
process.env.NOWPAYMENTS_API_KEY = 'deposit_page_api_key';
process.env.NOWPAYMENTS_IPN_SECRET = 'deposit_page_ipn_secret';
process.env.NOWPAYMENTS_MOCK = 'true';

const { server } = require('../server');

async function apiRequest(base, url, options = {}, expectedStatus = 200) {
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
}

function extractDepositRenderer() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'latin1');
  assert(source.includes('DEPOSIT_FRONTEND_STATUS'), 'deposit page should log DEPOSIT_FRONTEND_STATUS');
  assert(source.includes('DEPOSIT_SERVICE_RESPONSE'), 'deposit page should log DEPOSIT_SERVICE_RESPONSE');
  const start = source.indexOf('pages.Deposit=async function(){', source.indexOf('const autoSweepAdminRender'));
  let end = source.indexOf(';\nconst profileLogoutPage', start);
  if (end < 0) end = source.indexOf(';\r\nconst profileLogoutPage', start);
  assert(start >= 0 && end > start, 'final Deposit renderer should be present');
  return source.slice(start + 'pages.Deposit='.length, end);
}

async function renderDepositWithFreshService(freshDashboard) {
  const fnSource = extractDepositRenderer();
  const page = {
    innerHTML: '',
    querySelector(selector) {
      if (selector === '#deposit-intent') return { elements: { amount: { value: '' } }, querySelector: () => null };
      if (selector === '#deposit-payment-panel') return { style: {}, innerHTML: '' };
      return null;
    }
  };
  const logs = [];
  const context = {
    data: { deposits: [], depositService: { configured: false, message: 'NOWPayments deposit gateway is not configured yet.' } },
    me: null,
    localStorage: {},
    page,
    console: { log: (name, payload) => logs.push({ name, payload }) },
    api: async url => {
      assert.strictEqual(url, '/api/dashboard', 'Deposit page should refresh authenticated dashboard status');
      return freshDashboard;
    },
    money: n => `$${Number(n || 0).toFixed(2)}`,
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    badge: (text, kind) => `<span class="badge ${kind}">${text}</span>`,
    toast: () => {},
    loading: () => () => {}
  };
  await Function('context', `with(context){ return (${fnSource})(); }`)(context);
  assert.strictEqual(context.data.depositService.configured, true, 'Deposit renderer should use fresh configured dashboard service');
  assert(!page.innerHTML.includes('NOWPayments deposit gateway is not configured yet.'), 'Deposit page must not show not-configured message when backend is configured');
  assert(logs.some(item => item.name === 'DEPOSIT_FRONTEND_STATUS' && item.payload.configured === true), 'Deposit page should log configured frontend status');
}

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = await apiRequest(base, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Deposit Page', email: 'deposit-page@hb9.local', password: 'Password@123' })
  }, 201);
  const dashboard = await apiRequest(base, '/api/dashboard', { token: auth.token });
  assert.strictEqual(dashboard.depositService.configured, true, 'authenticated dashboard should return configured deposit service');
  await renderDepositWithFreshService(dashboard);
  await new Promise(resolve => server.close(resolve));
  console.log('deposit-page-config-smoke ok');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (server.listening) server.close();
});
