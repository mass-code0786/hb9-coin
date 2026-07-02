const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'latin1');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'withdraw-redesign.css'), 'utf8');
const start = source.lastIndexOf('pages.Withdraw=function(){');
let end = -1, depth = 0, inString = null, escaped = false;
for (let i = source.indexOf('{', start); i < source.length; i++) {
  const char = source[i];
  if (inString) {
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (char === inString) inString = null;
    continue;
  }
  if (char === '"' || char === "'" || char === '`') {
    inString = char;
    continue;
  }
  if (char === '{') depth += 1;
  if (char === '}') {
    depth -= 1;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}
assert(start >= 0 && end > start, 'final Withdraw renderer should be present');

const withdrawSource = source.slice(start + 'pages.Withdraw='.length, end);
assert(withdrawSource.includes('data.wallets.usdt'), 'Withdrawal page must use the dashboard USDT wallet API field');
assert(!withdrawSource.includes('data.wallets.withdrawal'), 'Withdrawal page must not use the stale withdrawal alias');
assert(source.includes('USDT Wallet</small><b>${money(b.usdt)}</b>') || source.includes('USDT Wallet</small><b class="wallet-balance-line">${USDTLogo'), 'Dashboard/USDT wallet UI should read wallets.usdt');
assert(css.includes('@media(max-width:800px)') && css.includes('.withdraw-history-table{display:none!important}'), 'Mobile CSS should hide the wide withdrawal table');
assert(css.includes('.withdraw-history-cards{display:grid'), 'Mobile CSS should show withdrawal history cards');
assert(css.includes('padding-bottom:88px'), 'Mobile withdrawal page should leave room above the bottom nav');
assert(css.includes('.withdraw-submit{display:block;width:100%'), 'Withdrawal submit button should be full width');
assert(css.includes('rgba(151,112,255,.26)') && css.includes('rgba(18,13,34,.96)'), 'Mobile withdrawal cards should keep the HB9 purple/dark theme');
assert(!/withdraw-history-card\{[^}]*background:#050b0b/.test(css), 'Mobile withdrawal cards must not use the green/black card background');

function renderWithdraw({ usdt, withdrawal = 51, deposits = [], withdrawals = [] }) {
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
      withdrawals,
      settings: { minWithdrawal: 9, maxWithdrawal: 0 },
      user: { walletAddress: '0x1111111111111111111111111111111111111111' }
    },
    page,
    money: n => `$${Number(n || 0).toFixed(2)}`,
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    badge: (text, kind) => `<span class="badge ${kind}">${text}</span>`,
    withdrawalDisplayStatus: status => status === 'broadcasted' ? 'Confirming' : status || 'Pending',
    withdrawalStatusClass: () => 'unpaid',
    bscTxLink: hash => hash ? `<a class="tx-link" href="https://bscscan.com/tx/${hash}">${String(hash).slice(0,10)}...${String(hash).slice(-8)}</a>` : '-',
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

const longAddress = '0x2222222222222222222222222222222222222222';
const txHash = `0x${'a'.repeat(64)}`;
rendered = renderWithdraw({
  usdt: 51,
  withdrawals: [{
    createdAt: '2026-07-02T00:00:00.000Z',
    amount: 20,
    fee: 1,
    netAmount: 19,
    toAddress: longAddress,
    status: 'broadcasted',
    txHash,
    failureReason: 'mock failure reason'
  }]
});
assert(rendered.html.includes('withdraw-history-cards'), 'Withdrawal page should render mobile history cards');
assert(rendered.html.includes('withdraw-history-card'), 'Withdrawal page should render each withdrawal as a mobile card');
assert(rendered.html.includes('2026-07-02'), 'Mobile card should show date');
assert(rendered.html.includes('$20.00') && rendered.html.includes('$1.00') && rendered.html.includes('$19.00'), 'Mobile card should show amount, fee, and net');
assert(rendered.html.includes('0x222222...222222'), 'Mobile card should show a shortened BEP20 address');
assert(rendered.html.includes('Confirming'), 'Mobile card should show display status');
assert(rendered.html.includes('https://bscscan.com/tx/'), 'Mobile card should include tx explorer link when available');
assert(rendered.html.includes('mock failure reason'), 'Mobile card should show failureReason when available');

console.log('withdrawal-balance-ui-smoke ok');
