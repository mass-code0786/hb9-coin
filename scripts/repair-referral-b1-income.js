const fs = require('fs');
const {
  dashboard,
  dataFile,
  readDB,
  repairReferralB1Income,
  writeDB
} = require('../server');

const args = process.argv.slice(2);
const has = flag => args.includes(flag);
const valueOf = name => {
  const prefix = `${name}=`;
  const item = args.find(arg => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : null;
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function userMatches(user, query) {
  return `${user.id || ''} ${user.name || ''} ${user.email || ''}`.toLowerCase().includes(query);
}

function inspectUser(db, queryText) {
  const query = String(queryText || 'Bismillah').toLowerCase();
  const users = db.users || [];
  const matches = users.filter(user => userMatches(user, query));
  return matches.map(user => {
    const sponsor = users.find(item => item.id === user.sponsorId) || null;
    const stakes = (db.stakes || []).filter(stake => stake.userId === user.id);
    return {
      user: { id: user.id, name: user.name, email: user.email, status: user.status, sponsorId: user.sponsorId, createdAt: user.createdAt },
      sponsor: sponsor ? { id: sponsor.id, name: sponsor.name, email: sponsor.email } : null,
      stakes: stakes.map(stake => ({
        id: stake.id,
        stakeAsset: stake.stakeAsset || 'HB9',
        stakeAmount: stake.stakeAmount,
        amount: stake.amount,
        usdValueAtStake: stake.usdValueAtStake,
        hb9EquivalentAmount: stake.hb9EquivalentAmount,
        status: stake.status,
        startDate: stake.startDate,
        createdAt: stake.createdAt
      })),
      referralLedger: (db.referralLedger || []).filter(item => item.referredUserId === user.id || item.sponsorId === user.sponsorId),
      directBusiness: (db.directBusiness || []).filter(item => item.sourceUserId === user.id || item.userId === user.sponsorId),
      levelIncome: (db.level_income_ledger || []).filter(item => item.sourceUserId === user.id || item.receiverUserId === user.sponsorId),
      b1Income: (db.incomeLedger || []).filter(item => item.userId === user.id),
      sponsorDashboard: sponsor ? {
        income: dashboard(db, sponsor).income,
        team: dashboard(db, sponsor).team
      } : null
    };
  });
}

(async () => {
  const dryRun = has('--dry-run');
  const query = valueOf('--user') || valueOf('--query') || 'Bismillah';
  const fromDate = valueOf('--from');
  const toDate = valueOf('--to');
  const runB1 = !has('--no-b1');
  const db = readDB();
  const working = dryRun ? clone(db) : db;

  console.log('REPAIR_REFERRAL_B1_DATA_FILE', dataFile);
  console.log('REPAIR_REFERRAL_B1_DRY_RUN', dryRun);
  console.log('REPAIR_REFERRAL_B1_INSPECT_BEFORE', JSON.stringify(inspectUser(working, query), null, 2));
  console.log('REPAIR_REFERRAL_B1_SCHEDULER_BEFORE', JSON.stringify({
    schedulerRuns: working.schedulerRuns || null,
    recentDailyAudits: (working.auditLogs || []).filter(item => /ROI_DAILY|GLOBAL_TEAM_DAILY|B1_INCOME/.test(item.type)).slice(-20)
  }, null, 2));

  const summary = await repairReferralB1Income(working, { userSearch: query, fromDate, toDate, runB1 });
  console.log('REPAIR_REFERRAL_B1_SUMMARY', JSON.stringify(summary, null, 2));
  console.log('REPAIR_REFERRAL_B1_INSPECT_AFTER', JSON.stringify(inspectUser(working, query), null, 2));

  if (dryRun) {
    console.log('REPAIR_REFERRAL_B1_NOT_WRITTEN dry-run mode');
    return;
  }

  writeDB(working);
  const stat = fs.statSync(dataFile);
  console.log('REPAIR_REFERRAL_B1_WRITTEN', JSON.stringify({ dataFile, bytes: stat.size }, null, 2));
})().catch(error => {
  console.error('REPAIR_REFERRAL_B1_FAILED', error);
  process.exit(1);
});
