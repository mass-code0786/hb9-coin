const fs = require('fs');
const crypto = require('crypto');
const { dataFile } = require('../server');

const args = new Set(process.argv.slice(2));
const write = args.has('--write');
const creditQueued = args.has('--credit-queued');

if (!fs.existsSync(dataFile)) throw Error(`Database file not found: ${dataFile}`);
const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

const now = new Date().toISOString();
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const round = value => Math.round((Number(value) || 0) * 100) / 100;
const norm = value => String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
const status = row => String(row.status || 'credited').trim().toLowerCase();
const salaryUserId = row => row.userId || row.receiverUserId || row.memberId || row.beneficiaryUserId;
const salaryDate = row => String(row.salaryPeriodDate || row.salaryDate || row.incomeDate || row.cycleStart || row.date || row.createdAt || '').slice(0, 10);
const salaryAmount = row => round(Number(row.hb9Amount) || Number(row.salaryHb9Amount) || Number(row.payoutHb9Amount) || Number(row.amount) || Number(row.creditAmount) || 0);
const salaryKey = row => row.duplicateKey || row.incomeKey || `${salaryUserId(row)}:${salaryDate(row)}:SALARY`;
const isSalary = row => ['SALARY_INCOME', 'SALARY', 'SALARY_PAYOUT'].includes(norm(row.type || row.incomeType || row.income_type || row.kind));
const salaryRows = [
  ...(db.salary_payouts || []).map(row => ({ row, table: 'salary_payouts' })),
  ...(db.incomeLedger || []).filter(isSalary).map(row => ({ row, table: 'incomeLedger' }))
];

db.reserve_wallets = db.reserve_wallets || [];
db.reserve_ledger = db.reserve_ledger || [];
db.wallet_ledger = db.wallet_ledger || [];
db.income_emissions = db.income_emissions || [];

const incomeReserve = () => db.reserve_wallets.find(row => row.asset === 'HB9' && row.walletType === 'income');
const walletCredited = key => db.wallet_ledger.some(row => row.asset === 'HB9' && row.direction === 'credit' && row.refId === key);
const report = {
  dataFile,
  write,
  creditQueued,
  totalSalaryRows: salaryRows.length,
  rows: [],
  normalizedRows: 0,
  markedCreditedFromWalletLedger: 0,
  creditedQueuedRows: 0,
  skippedQueuedRows: 0,
  duplicateKeys: []
};

const seen = new Map();
for (const item of salaryRows) {
  const { row, table } = item;
  const key = salaryKey(row);
  const amount = salaryAmount(row);
  const currentStatus = status(row);
  const shape = {
    table,
    id: row.id || null,
    userId: salaryUserId(row) || null,
    type: row.type || row.incomeType || row.income_type || null,
    status: row.status || null,
    amount,
    salaryPeriodDate: row.salaryPeriodDate || null,
    salaryDate: row.salaryDate || null,
    incomeDate: row.incomeDate || null,
    date: row.date || null,
    cycleStart: row.cycleStart || null,
    incomeKey: row.incomeKey || null,
    duplicateKey: row.duplicateKey || null,
    normalizedKey: key
  };
  report.rows.push(shape);
  if (seen.has(key)) report.duplicateKeys.push(key);
  seen.set(key, row);

  const patch = {};
  if (!row.duplicateKey) patch.duplicateKey = key;
  if (!row.incomeKey) patch.incomeKey = key;
  if (!row.salaryPeriodDate && salaryDate(row)) patch.salaryPeriodDate = salaryDate(row);
  if (row.status && row.status !== currentStatus) patch.status = currentStatus;

  if (currentStatus === 'queued' && walletCredited(key)) {
    patch.status = 'credited';
    patch.reason = row.reason || 'Salary income credited';
    report.markedCreditedFromWalletLedger++;
  }

  if (Object.keys(patch).length) {
    Object.assign(row, patch, { updatedAt: now });
    report.normalizedRows++;
  }

  if (creditQueued && status(row) === 'queued' && amount > 0 && !walletCredited(key)) {
    const reserve = incomeReserve();
    if (!reserve || Number(reserve.balance || 0) < amount) {
      report.skippedQueuedRows++;
      continue;
    }
    reserve.balance = round(Number(reserve.balance || 0) - amount);
    reserve.updatedAt = now;
    db.reserve_ledger.push({ id: id('rsv'), asset: 'HB9', walletType: 'income', direction: 'debit', amount, balanceAfter: reserve.balance, reason: 'Salary income queued repair', userId: salaryUserId(row), refId: key, createdAt: now });
    db.wallet_ledger.push({ id: id('wlt'), userId: salaryUserId(row), asset: 'HB9', direction: 'credit', amount, reason: 'Salary income credited', refId: key, createdAt: now, type: 'SALARY_INCOME_REPAIR' });
    row.status = 'credited';
    row.reason = 'Salary income credited';
    row.updatedAt = now;
    report.creditedQueuedRows++;
  }
}

if (write) {
  const backup = `${dataFile}.before-salary-income-repair-${Date.now()}.bak`;
  fs.copyFileSync(dataFile, backup);
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2));
  report.backup = backup;
} else {
  report.note = 'Dry run only. Re-run with --write to normalize rows, or --write --credit-queued to credit queued rows when HB9 income reserve is funded.';
}

console.log('SALARY_INCOME_REPAIR', JSON.stringify(report, null, 2));
