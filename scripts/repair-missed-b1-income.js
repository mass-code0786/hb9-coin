const {
  readDB,
  writeDB,
  hb9PriceSource
} = require('../server');

const round = value => Math.round((Number(value) || 0) * 100) / 100;
const id = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
const dayBefore = date => {
  const d = new Date(`${date || new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
const targetDate = String(process.env.REPAIR_DATE || dayBefore()).slice(0, 10);
const dryRun = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

function log(db, type, details = {}) {
  const record = { id: id('aud'), type, details, createdAt: new Date().toISOString() };
  db.auditLogs = db.auditLogs || [];
  db.auditLogs.push(record);
  console.log(type, { ...details, createdAt: record.createdAt });
}

function stakeUsd(stake) {
  return round(Number(stake.usdValueAtStake) || Number(stake.stakeUsdValue) || Number(stake.amount) || 0);
}

function directBusiness(db, userId) {
  return round((db.directBusiness || []).filter(item => item.userId === userId).reduce((sum, item) => sum + (Number(item.amount) || 0), 0));
}

function activeStakeUsd(db, userId) {
  return round((db.stakes || []).filter(stake => stake.userId === userId && stake.status === 'active').reduce((sum, stake) => sum + stakeUsd(stake), 0));
}

function reserveWallet(db, asset, walletType) {
  db.reserve_wallets = db.reserve_wallets || [];
  let wallet = db.reserve_wallets.find(item => item.asset === asset && item.walletType === walletType);
  if (!wallet) {
    wallet = { id: id('res'), asset, walletType, balance: 0, lockedBalance: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    db.reserve_wallets.push(wallet);
  }
  return wallet;
}

function hasDuplicate(db, userId, stakeId, date) {
  return (db.incomeLedger || []).some(item =>
    item.userId === userId &&
    item.date === date &&
    item.type === 'B1_INCOME' &&
    (!item.stakeId || item.stakeId === stakeId || item.incomeKey === `${userId}:${stakeId}:${date}:B1`)
  );
}

function createB1(db, { user, stake, date, hb9Price, hb9Amount, usdAmount }) {
  const createdAt = new Date().toISOString();
  const incomeKey = `${user.id}:${stake.id}:${date}:B1`;
  const ledgerId = id('led');
  const reserve = reserveWallet(db, 'HB9', 'income');
  reserve.balance = round(reserve.balance - hb9Amount);
  reserve.updatedAt = createdAt;
  db.reserve_ledger = db.reserve_ledger || [];
  db.wallet_ledger = db.wallet_ledger || [];
  db.income_emissions = db.income_emissions || [];
  db.incomeLedger = db.incomeLedger || [];
  db.reserve_ledger.push({ id: id('rsv'), asset: 'HB9', walletType: 'income', direction: 'debit', amount: hb9Amount, balanceAfter: reserve.balance, reason: 'B1 repair income emission', userId: user.id, refId: incomeKey, createdAt, immutable: true });
  db.wallet_ledger.push({ id: id('wlt'), userId: user.id, asset: 'HB9', direction: 'credit', amount: hb9Amount, reason: 'B1 repair income credited', refId: incomeKey, createdAt, immutable: true });
  db.income_emissions.push({ id: id('iem'), userId: user.id, date, type: 'B1_INCOME', asset: 'HB9', amount: hb9Amount, valueUsd: usdAmount, status: 'credited', reason: 'Missed B1 income repair', refId: incomeKey, createdAt, immutable: true });
  db.incomeLedger.push({ id: ledgerId, userId: user.id, stakeId: stake.id, incomeKey, date, type: 'B1_INCOME', asset: 'HB9', amount: hb9Amount, hb9Amount, valueUsd: usdAmount, status: 'credited', note: 'Missed B1 income repair', activeStakeUsd: stakeUsd(stake), creditedB1Usd: usdAmount, creditedB1Hb9: hb9Amount, directBusinessUsd: directBusiness(db, user.id), hb9PriceAtPayout: hb9Price, createdAt, immutable: true });
  return ledgerId;
}

async function main() {
  const db = readDB();
  db.incomeLedger = db.incomeLedger || [];
  db.stakes = db.stakes || [];
  const activeStakes = db.stakes.filter(stake => stake.status === 'active');
  const price = Number((await hb9PriceSource(db, { interval: '1d', limit: 1 })).price);
  const summary = { date: targetDate, dryRun, eligibleUsers: 0, missingB1Rows: 0, createdRows: 0, skippedDuplicates: 0, totalHb9Credited: 0 };
  const eligibleUsers = new Set();
  log(db, 'B1_REPAIR_STARTED', { date: targetDate, activeStakes: activeStakes.length, dryRun });
  if (dryRun) log(db, 'B1_REPAIR_DRY_RUN', { date: targetDate });

  for (const stake of activeStakes) {
    const user = (db.users || []).find(item => item.id === stake.userId);
    if (!user || user.role !== 'user') continue;
    const userActiveStakeUsd = activeStakeUsd(db, user.id);
    const requiredBusiness = round(userActiveStakeUsd * (Number(db.settings?.directMultiplier) || 2));
    if (!userActiveStakeUsd || directBusiness(db, user.id) < requiredBusiness) continue;
    eligibleUsers.add(user.id);
    if (hasDuplicate(db, user.id, stake.id, targetDate)) {
      summary.skippedDuplicates++;
      log(db, 'B1_REPAIR_SKIPPED_DUPLICATE', { userId: user.id, stakeId: stake.id, date: targetDate });
      continue;
    }
    const usdAmount = round(stakeUsd(stake) * (Number(db.settings?.dailyRoi) || 0) / 100);
    const hb9Amount = price > 0 ? round(usdAmount / price) : 0;
    if (hb9Amount <= 0) continue;
    summary.missingB1Rows++;
    if (!dryRun) {
      const ledgerId = createB1(db, { user, stake, date: targetDate, hb9Price: price, hb9Amount, usdAmount });
      summary.createdRows++;
      summary.totalHb9Credited = round(summary.totalHb9Credited + hb9Amount);
      log(db, 'B1_REPAIR_CREATED', { userId: user.id, stakeId: stake.id, ledgerId, date: targetDate, hb9Amount, usdAmount });
    }
  }

  summary.eligibleUsers = eligibleUsers.size;
  log(db, 'B1_REPAIR_COMPLETED', summary);
  if (!dryRun) writeDB(db);
  else console.log('DRY_RUN summary only. No database changes written.');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
