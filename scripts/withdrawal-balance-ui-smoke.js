const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'latin1');
const start = source.lastIndexOf('pages.Withdraw=function(){');
const applyStart = source.indexOf('applyPresentation()', start);
const end = applyStart > start ? source.lastIndexOf(';', applyStart) : -1;
assert(start >= 0 && end > start, 'final Withdraw renderer should be present');

const withdrawSource = source.slice(start + 'pages.Withdraw='.length, end);
assert(withdrawSource.includes('data.wallets.usdt'), 'Withdrawal page must use the dashboard USDT wallet API field');
assert(!withdrawSource.includes('data.wallets.withdrawal'), 'Withdrawal page must not use the stale withdrawal alias');
assert(source.includes('USDT Wallet</small><b>${money(b.usdt)}</b>') || source.includes('USDT Wallet</small><b class="wallet-balance-line">${USDTLogo'), 'Dashboard/USDT wallet UI should read wallets.usdt');

function renderWithdraw({ usdt, withdrawal = 51, deposits = [] }) {
  const page = {
    innerHTML: '',
    querySelector(selector) {
      if (selector === '#withdraw') return form;
      return null;
    }
  };
  const amount = {};
  const address = {};
  const form = { elements: { amount, address } };
  const buttons = [
    { dataset: { withdrawPercent: '25' } },
    { dataset: { withdrawPercent: '50' } },
    { dataset: { withdrawPercent: '75' } },
    { dataset: { withdrawPercent: '100' } }
  ];
  const context = {
    data: {
      wallets: { usdt, withdrawal },
      deposits,
      withdrawals: [],
      settings: { minWithdrawal: 9, maxWithdrawal: 0 },
      user: { walletAddress: '0x1111111111111111111111111111111111111111' }
    },
    page,
    money: n => `$${Number(n || 0).toFixed(2)}`,
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    badge: (text, kind) => `<span class="badge ${kind}">${text}</span>`,
    withdrawalDisplayStatus: status => status || 'Pending',
    withdrawalStatusClass: () => 'unpaid',
    bscTxLink: () => '-',
    boundUsdtBep20Wallet: () => '0x1111111111111111111111111111111111111111',
    document: {
      querySelector: selector => selector === '#withdraw' ? form : null,
      querySelectorAll: selector => selector === '[data-withdraw-percent]' ? buttons : []
    },
    api: async () => ({}),
    toast: () => {},
    loading: () => () => {},
    load: () => {}
  };
  Function('context', `with(context){ return (${withdrawSource})(); }`)(context);
  return { html: page.innerHTML, amount, buttons };
}

let rendered = renderWithdraw({ usdt: 0, withdrawal: 0, deposits: [] });
assert(rendered.html.includes('Available Withdrawal Wallet'), 'Withdrawal page should render available wallet label');
assert(rendered.html.includes('<h2>$0.00</h2>'), 'USDT wallet = 0 should render withdrawal wallet as $0');

rendered = renderWithdraw({
  usdt: 0,
  withdrawal: 51,
  deposits: [{ id: 'dep_51', amount: 51, status: 'credited' }]
});
assert(rendered.html.includes('<h2>$0.00</h2>'), 'Deposit history = $51 and wallet = 0 should still render withdrawal wallet as $0');
assert(!rendered.html.includes('<h2>$51.00</h2>'), 'Withdrawal page must not render stale/cumulative $51 when wallet is $0');

rendered = renderWithdraw({ usdt: 51, withdrawal: 0, deposits: [] });
assert(rendered.html.includes('<h2>$51.00</h2>'), 'Wallet = $51 should render withdrawal wallet as $51');

console.log('withdrawal-balance-ui-smoke ok');
