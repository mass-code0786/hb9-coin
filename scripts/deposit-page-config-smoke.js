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
  assert(fnSource.includes('create-qr-code'), 'Deposit renderer should render an on-site QR code');
  assert(fnSource.includes('Open payment page'), 'Deposit renderer should keep NOWPayments page only as fallback');
  assert(!/<a[^>]*>\s*Pay\s*<\/a>/.test(fnSource), 'Deposit renderer must not expose a primary Pay redirect link');
  const deposit = {
    id: 'dep_onsite_1',
    amount: 25,
    payAmount: 25,
    payCurrency: 'usdtbsc',
    payAddress: '0x1111111111111111111111111111111111111111',
    paymentId: 'mock_pay_abcdef123456',
    paymentStatus: 'waiting',
    paymentUrl: 'https://nowpayments.io/payment/?pid=mock_pay_abcdef123456',
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString()
  };
  const creditedDeposit = {
    ...deposit,
    status: 'credited',
    paymentStatus: 'finished',
    creditedAmount: 25
  };
  const form = { elements: { amount: { value: '25' } }, querySelector: () => null };
  const panel = {
    style: {},
    innerHTML: '',
    querySelector: () => ({ addEventListener: () => {} })
  };
  const tbody = { innerHTML: '', inserted: '', insertAdjacentHTML: (_pos, html) => { tbody.inserted = html; } };
  const page = {
    innerHTML: '',
    querySelector(selector) {
      if (selector === '#deposit-intent') return form;
      if (selector === '#deposit-payment-panel') return panel;
      if (selector === 'section.card.income tbody') return tbody;
      return null;
    }
  };
  const logs = [];
  let pollingCallback;
  let countdownCallback;
  let popupTimeout;
  let bodyHtml = '';
  let backdropRemoved = false;
  const localStore = {};
  const dashboardAfterCredit = {
    ...freshDashboard,
    user: { ...(freshDashboard.user || {}), wallet: { USDT: 25 } },
    deposits: [creditedDeposit]
  };
  const context = {
    data: { deposits: [], depositService: { configured: false, message: 'NOWPayments deposit gateway is not configured yet.' } },
    me: null,
    localStorage: {
      getItem: key => localStore[key] || null,
      setItem: (key, value) => { localStore[key] = String(value); }
    },
    page,
    console: { log: (name, payload) => logs.push({ name, payload }) },
    api: async (url, options = {}) => {
      if (url === '/api/dashboard') {
        return pollingCallback ? dashboardAfterCredit : freshDashboard;
      }
      if (url === '/api/deposits') {
        assert.strictEqual(options.method, 'POST', 'Deposit form should create a deposit with POST /api/deposits');
        return { message: 'NOWPayments deposit created', deposit, payment: { pay_address: deposit.payAddress, pay_amount: deposit.payAmount, pay_currency: deposit.payCurrency, payment_id: deposit.paymentId, payment_status: 'waiting', payment_url: deposit.paymentUrl } };
      }
      throw Error(`Unexpected api call: ${url}`);
    },
    money: n => `$${Number(n || 0).toFixed(2)}`,
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    badge: (text, kind) => `<span class="badge ${kind}">${text}</span>`,
    toast: () => {},
    loading: () => () => {},
    navigator: { clipboard: { writeText: async () => {} } },
    window: {},
    setInterval: (callback, ms) => {
      if (ms === 1000) countdownCallback = callback;
      if (ms === 5000) pollingCallback = callback;
      return ms;
    },
    clearInterval: () => {},
    setTimeout: (callback, ms) => { popupTimeout = { callback, ms }; return 10; },
    Date,
    document: {
      querySelector: selector => {
        if (selector === '[data-close-deposit-success]') return { addEventListener: () => {} };
        if (selector === '.deposit-success-backdrop') return { remove: () => { backdropRemoved = true; bodyHtml = ''; } };
        return null;
      },
      body: { insertAdjacentHTML: (_position, html) => { bodyHtml += html; } },
      createElement: () => ({ value: '', select: () => {}, remove: () => {} }),
      execCommand: () => true
    }
  };
  await Function('context', `with(context){ return (${fnSource})(); }`)(context);
  assert.strictEqual(context.data.depositService.configured, true, 'Deposit renderer should use fresh configured dashboard service');
  assert(!page.innerHTML.includes('NOWPayments deposit gateway is not configured yet.'), 'Deposit page must not show not-configured message when backend is configured');
  assert(logs.some(item => item.name === 'DEPOSIT_FRONTEND_STATUS' && item.payload.configured === true), 'Deposit page should log configured frontend status');
  assert(!bodyHtml.includes('Congratulations!'), 'Deposit page refresh should not show success popup before a new credited polling transition');
  assert.strictEqual(typeof form.onsubmit, 'function', 'Deposit form submit handler should be attached');

  await form.onsubmit({ preventDefault: () => {}, submitter: { disabled: false, textContent: 'Create deposit' } });
  assert(panel.innerHTML.includes('Send USDT BEP20'), 'Created deposit should render on-site BEP20 payment details');
  assert(panel.innerHTML.includes('Payment expires in'), 'Created deposit should render countdown timer');
  assert(panel.innerHTML.includes('api.qrserver.com/v1/create-qr-code'), 'Created deposit should render a QR code');
  assert(panel.innerHTML.includes('0x1111111111111111111111111111111111111111'), 'Created deposit should render pay_address');
  assert(panel.innerHTML.includes('Copy address'), 'Created deposit should render copy address button');
  assert(panel.innerHTML.includes('Copy amount'), 'Created deposit should render copy amount button');
  assert(panel.innerHTML.includes('Open payment page'), 'Fallback NOWPayments page link may be rendered');
  assert(!/<a[^>]*>\s*Pay\s*<\/a>/.test(panel.innerHTML), 'Created deposit must not render a primary Pay redirect');
  assert(tbody.inserted.includes('mock_pay'), 'Deposit history should show short payment id');
  assert.strictEqual(typeof countdownCallback, 'function', 'Deposit page should start a countdown timer');

  assert.strictEqual(typeof pollingCallback, 'function', 'Deposit page should poll dashboard status after create');
  await pollingCallback();
  assert(panel.innerHTML.includes('Credited'), 'Polling should update the on-site payment status to credited');
  assert(bodyHtml.includes('Congratulations!'), 'Credited polling response should show success popup');
  assert(bodyHtml.includes('Your deposit amount $25.00 has been credited successfully.'), 'Success popup should include credited amount');
  assert.strictEqual(popupTimeout.ms, 10000, 'Success popup should auto close after 10 seconds');
  popupTimeout.callback();
  assert.strictEqual(backdropRemoved, true, 'Success popup auto-close should remove the popup');

  const popupCountAfterFirstCredit = Object.keys(localStore).filter(key => key.startsWith('hb9.deposit.success.')).length;
  await pollingCallback();
  assert.strictEqual(Object.keys(localStore).filter(key => key.startsWith('hb9.deposit.success.')).length, popupCountAfterFirstCredit, 'Credited deposit popup should only be marked shown once');

  deposit.status = 'pending';
  deposit.paymentStatus = 'waiting';
  deposit.expiresAt = new Date(Date.now() - 1000).toISOString();
  panel.innerHTML = '';
  await form.onsubmit({ preventDefault: () => {}, submitter: { disabled: false, textContent: 'Create deposit' } });
  countdownCallback();
  assert(panel.innerHTML.includes('This deposit request has expired. Please create a new deposit.'), 'Expired deposit should replace address panel with expiry message');
  assert(!panel.innerHTML.includes('0x1111111111111111111111111111111111111111'), 'Expired deposit should hide/cancel the payment address panel');
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
  const created = await apiRequest(base, '/api/deposits', {
    token: auth.token,
    method: 'POST',
    body: JSON.stringify({ amount: 12.5 })
  }, 201);
  assert(created.deposit.payAddress, 'POST /api/deposits should return pay_address on the deposit');
  assert.strictEqual(created.deposit.payAmount, 12.5, 'POST /api/deposits should return pay_amount on the deposit');
  assert.strictEqual(created.deposit.payCurrency, 'usdtbsc', 'POST /api/deposits should return BEP20 USDT pay_currency');
  assert(created.deposit.expiresAt, 'POST /api/deposits should return expiresAt');
  assert(Math.abs((Date.parse(created.deposit.expiresAt) - Date.parse(created.deposit.createdAt)) - 20 * 60 * 1000) < 2000, 'POST /api/deposits should expire in 20 minutes');
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
