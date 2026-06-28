const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const mobileCss = fs.readFileSync(path.join(root, 'public', 'mobile-defi-dashboard.css'), 'utf8');

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

console.log('dashboard-responsive-smoke ok');
