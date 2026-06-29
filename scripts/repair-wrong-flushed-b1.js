const {
  b1IncomeKey,
  calculateB1IncomeForStake,
  dataFile,
  hb9PriceSource,
  incomeContext,
  readDB,
  writeDB
} = require('../server');

const round = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const stakeUsd = stake => round(Number(stake?.usdValueAtStake) || Number(stake?.stakeUsdValue) || Number(stake?.amount) || 0);
const id = prefix => `${prefix}_${cryptoRandom()}`;
const cryptoRandom = () => require('crypto').randomUUID();
const yesterday = () => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};

function log(type, details) {
  console.log(type, JSON.stringify(details));
}

function hasPaidB1(db, userId, stakeId, date) {
  const key = b1IncomeKey(userId, stakeId, date);
  return (db.incomeLedger || []).some(row =>
    (row.incomeKey === key || (row.userId === userId && row.stakeId === stakeId && row.date === date && String(row.type || row.incomeType || '').toUpperCase().replace(/\s+/g, '_') === 'B1_INCOME')) &&
    Number(row.amount || row.hb9Amount || row.paidB1Hb9 || 0) > 0
  );
}

function zeroPaidB1Row(db, userId, stakeId, date) {
  const key = b1IncomeKey(userId, stakeId, date);
  return (db.incomeLedger || []).find(row =>
    (row.incomeKey === key || (row.userId === userId && (!row.stakeId || row.stakeId === stakeId) && row.date === date && String(row.type || row.incomeType || '').toUpperCase().replace(/\s+/g, '_') === 'B1_INCOME')) &&
    Number(row.amount || row.hb9Amount || row.paidB1Hb9 || 0) <= 0
  );
}

function reserveCredit(db, userId, row, createdAt) {
  db.reserve_wallets = db.reserve_wallets || [];
  db.reserve_ledger = db.reserve_ledger || [];
  db.wallet_ledger = db.wallet_ledger || [];
  db.income_emissions = db.income_emissions || [];
  const reserve = db.reserve_wallets.find(item => item.asset === 'HB9' && item.walletType === 'income');
  if (reserve) reserve.balance = round(Number(reserve.balance) - row.paidB1Hb9);
  db.reserve_ledger.push({ id: id('rsv'), asset: 'HB9', walletType: 'income', direction: 'debit', amount: row.paidB1Hb9, balanceAfter: reserve ? reserve.balance : 0, reason: 'Wrong flushed B1 repair income emission', userId, refId: row.incomeKey, createdAt, immutable: true });
  db.wallet_ledger.push({ id: id('wlt'), userId, asset: 'HB9', direction: 'credit', amount: row.paidB1Hb9, reason: 'Wrong flushed B1 repair income credited', refId: row.incomeKey, createdAt, immutable: true });
  db.income_emissions.push({ id: id('iem'), userId, stakeId: row.stakeId, incomeKey: row.incomeKey, date: row.date, type: 'B1_INCOME', asset: 'HB9', amount: row.paidB1Hb9, valueUsd: row.paidB1Usd, status: row.status, reason: 'Wrong flushed B1 repair', createdAt, immutable: true });
}

async function repairWrongFlushedB1({ date = process.env.B1_REPAIR_DATE || process.env.DATE || yesterday(), dryRun = String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false', userId = process.env.USER_ID || null, db: providedDb = null } = {}) {
  const db = providedDb || readDB();
  db.incomeLedger = db.incomeLedger || [];
  db.flushRecords = db.flushRecords || [];
  db.globalTeamRecords = db.globalTeamRecords || [];
  db.auditLogs = db.auditLogs || [];
  const price = (await hb9PriceSource(db, { interval: '1d', limit: 1 })).price;
  const summary = { date, dryRun, inspectedUsers: 0, adjustedFlushRecords: 0, adjustedGlobalRecords: 0, updatedRows: 0, createdRows: 0, skippedDuplicates: 0, skippedNoPaidB1: 0, totalPaidB1Hb9: 0, totalPaidB1Usd: 0 };
  log('WRONG_FLUSHED_B1_REPAIR_STARTED', { date, dryRun, dataFile });

  for (const user of (db.users || []).filter(item => item.role === 'user' && (!userId || item.id === userId))) {
    const context = incomeContext(db, user.id, date, price);
    if (context.activeStakeUsd <= 0) continue;
    const existingFlush = db.flushRecords.find(row => row.userId === user.id && row.date === date && row.incomeType === 'B1 / Global Team');
    const existingLedger = db.incomeLedger.filter(row => row.userId === user.id && row.date === date && String(row.type || row.incomeType || '').toUpperCase().replace(/\s+/g, '_') === 'B1_INCOME');
    if (!existingFlush && !existingLedger.length) continue;
    summary.inspectedUsers++;
    if (context.paidB1Usd <= 0) {
      summary.skippedNoPaidB1++;
      continue;
    }

    const stakeRows = (db.stakes || [])
      .filter(stake => stake.userId === user.id && stake.status === 'active')
      .sort((a, b) => String(a.startDate || a.createdAt || a.id).localeCompare(String(b.startDate || b.createdAt || b.id)))
      .map(stake => {
        const calculation = calculateB1IncomeForStake({ db, userId: user.id, stakeId: stake.id, date, hb9PriceOverride: price });
        const stakeValueUsd = stakeUsd(stake);
        return {
          stake,
          incomeKey: b1IncomeKey(user.id, stake.id, date),
          stakeUsd: stakeValueUsd,
          stakeQualifiedUsd: calculation.qualifiedStakeUsd,
          stakeUnqualifiedUsd: calculation.unqualifiedStakeUsd,
          grossB1Usd: round(stakeValueUsd * calculation.dailyB1Percent / 100),
          ...calculation
        };
      })
      .filter(row => row.paidB1Usd > 0);
    const createdAt = new Date().toISOString();
    const paidIncome = round(stakeRows.reduce((sum, row) => sum + row.paidB1Usd, 0));

    if (!dryRun) {
      if (existingFlush) {
        Object.assign(existingFlush, { eligibleIncome: context.grossB1Usd, paidIncome, flushedIncome: context.flushUsd, ...context, repairedAt: createdAt });
        summary.adjustedFlushRecords++;
      }
      const existingGlobal = db.globalTeamRecords.find(row => row.userId === user.id && row.date === date);
      if (existingGlobal) {
        Object.assign(existingGlobal, { paid: paidIncome, unpaid: context.flushUsd, paidGlobalTeam: Math.round(paidIncome / 0.02), unpaidGlobalTeam: Math.round(context.flushUsd / 0.02), ...context, repairedAt: createdAt });
        summary.adjustedGlobalRecords++;
      }
      existingLedger.filter(row => !Number(row.amount || row.hb9Amount || row.paidB1Hb9 || 0) && row.stakeId && !stakeRows.some(item => item.stake.id === row.stakeId)).forEach(row => {
        row.status = 'superseded';
        row.type = 'B1_INCOME_SUPERSEDED';
        row.supersededBy = 'repair-wrong-flushed-b1';
        row.repairedAt = createdAt;
      });
    }

    for (const row of stakeRows) {
      if (hasPaidB1(db, user.id, row.stake.id, date)) {
        summary.skippedDuplicates++;
        log('WRONG_FLUSHED_B1_REPAIR_SKIPPED_DUPLICATE', { userId: user.id, stakeId: row.stake.id, date, incomeKey: row.incomeKey });
        continue;
      }
      const { stake, ...calculatedRow } = row;
      const ledgerRow = { id: id('led'), userId: user.id, stakeId: stake.id, incomeKey: row.incomeKey, date, type: 'B1_INCOME', asset: 'HB9', amount: row.paidB1Hb9, hb9Amount: row.paidB1Hb9, valueUsd: row.paidB1Usd, status: row.status, note: 'Wrong flushed B1 repair', immutable: true, ...context, ...calculatedRow, stakeUsd: row.stakeUsd, stakeQualifiedUsd: row.stakeQualifiedUsd, stakeUnqualifiedUsd: row.stakeUnqualifiedUsd, grossB1Usd: row.grossB1Usd, paidB1Usd: row.paidB1Usd, flushedB1Usd: row.flushedB1Usd, paidB1Hb9: row.paidB1Hb9, creditedB1Hb9: row.paidB1Hb9, creditedB1Usd: row.paidB1Usd, createdAt };
      const existingZero = zeroPaidB1Row(db, user.id, row.stake.id, date);
      if (existingZero) summary.updatedRows++;
      else summary.createdRows++;
      summary.totalPaidB1Hb9 = round(summary.totalPaidB1Hb9 + row.paidB1Hb9);
      summary.totalPaidB1Usd = round(summary.totalPaidB1Usd + row.paidB1Usd);
      if (!dryRun) {
        reserveCredit(db, user.id, ledgerRow, createdAt);
        if (existingZero) Object.assign(existingZero, ledgerRow, { id: existingZero.id, repairedAt: createdAt });
        else db.incomeLedger.push(ledgerRow);
      }
      log(dryRun ? 'WRONG_FLUSHED_B1_REPAIR_WOULD_UPSERT' : (existingZero ? 'WRONG_FLUSHED_B1_REPAIR_UPDATED' : 'WRONG_FLUSHED_B1_REPAIR_CREATED'), { userId: user.id, stakeId: row.stake.id, date, incomeKey: row.incomeKey, paidB1Usd: row.paidB1Usd, paidB1Hb9: row.paidB1Hb9 });
    }
  }

  db.auditLogs.push({ id: id('aud'), type: 'WRONG_FLUSHED_B1_REPAIR_COMPLETED', details: summary, createdAt: new Date().toISOString() });
  if (!dryRun && !providedDb) writeDB(db);
  log('WRONG_FLUSHED_B1_REPAIR_COMPLETED', summary);
  return summary;
}

if (require.main === module) {
  repairWrongFlushedB1().catch(error => {
    console.error('WRONG_FLUSHED_B1_REPAIR_FAILED', error);
    process.exit(1);
  });
}

module.exports = { repairWrongFlushedB1 };
