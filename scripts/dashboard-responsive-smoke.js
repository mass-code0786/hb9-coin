const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const mobileCss = fs.readFileSync(path.join(root, 'public', 'mobile-defi-dashboard.css'), 'utf8');
const incomeStackCss = fs.readFileSync(path.join(root, 'public', 'income-stack.css'), 'utf8');

const expectedDashboardContent = [
  'Total Deposit',
  'Total Withdrawal',
  'Total Stake',
  'Active Stake',
  'Direct Team',
  'Direct Business',
  'Required Business',
  'Remaining Business',
  'USDT Wallet',
  'HB9 Wallet',
  'B1 Income',
  'Salary Income',
  'Global Team',
  'Flush Income',
  'Total Volume USDT',
  'Total Volume HB9',
  'Income Summary',
  '2X Business Progress',
  'Deposit',
  'Stake',
  'Exchange',
  'Withdraw'
];

for (const label of expectedDashboardContent) {
  assert(app.includes(label), `dashboard source must render ${label}`);
}

const compactIncomeStart = app.indexOf('const hb9IncomeAmount=');
const compactIncomeEnd = app.indexOf('function applyMobileDefiDashboard', compactIncomeStart);
assert(compactIncomeStart >= 0 && compactIncomeEnd > compactIncomeStart, 'compact income summary should define HB9 icon amount formatter');
const compactIncome = app.slice(compactIncomeStart, compactIncomeEnd);
for (const label of ['Referral Income', 'Level Income', 'B1 Income', 'Salary Income']) {
  assert(
    new RegExp(`card\\('[^']+','${label}'[\\s\\S]*?hb9IncomeAmount\\(`).test(compactIncome),
    `${label} should render number values with the HB9 icon formatter`
  );
}
assert(/card\('global','Global Team'[\s\S]*?globalTeam\(i\.paidGlobal\)[\s\S]*?globalTeam\(i\.unpaidGlobal\)/.test(compactIncome), 'Global Team should remain number only');
assert(!/card\('global','Global Team'[\s\S]*?hb9IncomeAmount/.test(compactIncome), 'Global Team should not render an HB9 icon');
assert(/card\('flush-pair','Flush Income'[\s\S]*?money\(i\.todayFlush\)[\s\S]*?money\(i\.totalFlush\)/.test(compactIncome), 'Flush Income should remain USD');
assert(!/card\('flush-pair','Flush Income'[\s\S]*?hb9IncomeAmount/.test(compactIncome), 'Flush Income should not render an HB9 icon');
assert(!/todayReferral\)} HB9|todayLevelIncome\)} HB9|todayB1\)} HB9|todaySalary\)} HB9/.test(compactIncome), 'compact income values should not append HB9 text');
assert(app.includes("HB9CoinLogo('hb9-coin-logo hb9-coin-logo--income')"), 'HB9 income rows should render the small coin icon');

assert(!app.includes('const supplyDashboardPage=pages.Dashboard'), 'user dashboard must not wrap Dashboard to inject HB9 Supply');
assert(!/pages\.Dashboard=function\(\)\{[^}]*HB9 Supply/.test(app), 'user dashboard must not render an HB9 Supply section');

const adminReserves = /adminTab==='Reserves'[\s\S]*?body=`([\s\S]*?)`;/.exec(app)?.[1] || '';
for (const label of ['Total HB9 Supply', 'HB9 Reserve', 'Circulating HB9', 'Total Burned HB9', 'Remaining Supply', 'USDT Reserve']) {
  assert(adminReserves.includes(label), `admin reserves must still render ${label}`);
}

assert(
  /\.defi-dashboard-page>\.grid\.stats\s*\{[\s\S]*?display:\s*grid\s*!important/.test(mobileCss),
  'mobile dashboard must display the desktop stats grid instead of hiding it'
);

assert(
  !/\.defi-dashboard-page>\.grid\.stats\s*\{[\s\S]*?display:\s*none\s*!important[\s\S]*?\}/.test(mobileCss),
  'mobile dashboard stats grid must not be display:none'
);

assert(
  /\.defi-dashboard-active \.card\.income:not\(:has\(\.income-pairs\)\),\s*\.defi-dashboard-active \.card\.income:has\(\.incomegrid\)\s*\{[\s\S]*?display:\s*block\s*!important/.test(mobileCss),
  'mobile dashboard must display income/progress cards that are not the compact income-pairs card'
);

assert(
  !/\.defi-dashboard-active \.card\.income:not\(:has\(\.income-pairs\)\),\s*\.defi-dashboard-active \.card\.income:has\(\.incomegrid\)\s*\{[\s\S]*?display:\s*none\s*!important[\s\S]*?\}/.test(mobileCss),
  'mobile dashboard income/progress cards must not be display:none'
);

assert(
  /\.defi-dashboard-active \.incomegrid,[\s\S]*?\.defi-dashboard-active \.progress-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\)\s*!important/.test(mobileCss),
  'mobile dashboard income and progress grids must have responsive mobile columns'
);

assert(
  /@media\(max-width:390px\)[\s\S]*?\.defi-dashboard-page>\.grid\.stats,[\s\S]*?\.defi-dashboard-active \.incomegrid,[\s\S]*?\.defi-dashboard-active \.progress-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr\s*!important/.test(mobileCss),
  'narrow mobile dashboard must stack stats, income, and progress cards without overflow'
);

assert(/\.defi-dashboard-active \.income-pair\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,1fr\) auto\s*!important/.test(mobileCss), 'mobile income cards should keep label and amount in non-overlapping grid columns');
assert(/\.defi-dashboard-active \.income-pair strong\s*\{[\s\S]*?font-size:\s*15px\s*!important/.test(mobileCss), 'mobile income values should use reduced font size');
assert(/@media\(max-width:390px\)[\s\S]*?\.defi-dashboard-active \.income-pair strong\{font-size:14px!important\}/.test(mobileCss), 'narrow mobile income values should shrink further');
assert(mobileCss.includes('.defi-dashboard-active .hb9-coin-logo--income'), 'mobile income cards should size the HB9 icon');
assert(incomeStackCss.includes('.hb9-income-amount'), 'desktop income cards should align HB9 number and icon cleanly');

console.log('dashboard-responsive-smoke ok');
