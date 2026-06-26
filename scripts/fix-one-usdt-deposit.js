const fs = require('fs');
const path = require('path');

const TARGET_TX_HASH = '0x7e48bbba885ab4c786d6d20305b5e93f7f16baf5a903f2a754bff246425bb114';
const FIXED_AMOUNT = 1;
const dataFile = path.resolve(process.env.DATA_FILE || './data/db.json');

if (!fs.existsSync(dataFile)) throw Error(`Database file not found: ${dataFile}`);
const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const matchesHash = value => String(value || '').toLowerCase() === TARGET_TX_HASH;
const transactions = (db.blockchain_transactions || []).filter(tx => matchesHash(tx.txHash));
if (transactions.length !== 1) throw Error(`Expected exactly one blockchain transaction for ${TARGET_TX_HASH}; found ${transactions.length}. No changes made.`);

const transaction = transactions[0];
const deposits = (db.deposits || []).filter(deposit => matchesHash(deposit.txHash) && Number(deposit.logIndex) === Number(transaction.logIndex));
if (deposits.length !== 1) throw Error(`Expected exactly one matching deposit for log index ${transaction.logIndex}; found ${deposits.length}. No changes made.`);

const deposit = deposits[0];
const sweeps = (db.sweep_transactions || []).filter(sweep => sweep.depositId === deposit.id || (matchesHash(sweep.depositTxHash) && Number(sweep.depositLogIndex) === Number(transaction.logIndex)));
const reserveWallets = (db.reserve_wallets || []).filter(wallet => wallet.asset === 'USDT' && wallet.walletType === 'treasury');
if (reserveWallets.length !== 1) throw Error(`Expected exactly one USDT treasury reserve wallet; found ${reserveWallets.length}. No changes made.`);

const now = new Date().toISOString();
const backup = `${dataFile}.before-one-usdt-fix-${Date.now()}.bak`;
fs.copyFileSync(dataFile, backup);

transaction.amount = FIXED_AMOUNT;
transaction.updatedAt = now;
deposit.amount = FIXED_AMOUNT;
deposit.creditedAmount = FIXED_AMOUNT;
deposit.updatedAt = now;

for (const ledger of db.wallet_ledger || []) {
  if (ledger.asset === 'USDT' && ledger.reason === 'BEP20 deposit credited' && ledger.refId === transaction.eventKey) ledger.amount = FIXED_AMOUNT;
}
for (const sweep of sweeps) {
  sweep.amount = FIXED_AMOUNT;
  sweep.updatedAt = now;
}
const sweepIds = new Set(sweeps.map(sweep => sweep.id));
for (const entry of db.reserve_ledger || []) {
  if (entry.asset === 'USDT' && sweepIds.has(entry.refId)) entry.amount = FIXED_AMOUNT;
}
const reserveWallet = reserveWallets[0];
reserveWallet.balance = FIXED_AMOUNT;
reserveWallet.updatedAt = now;

db.auditLogs = db.auditLogs || [];
db.auditLogs.push({
  id: `aud_one_usdt_fix_${Date.now()}`,
  type: 'BEP20_SINGLE_DEPOSIT_AMOUNT_REPAIRED',
  details: { txHash: TARGET_TX_HASH, logIndex: transaction.logIndex, depositId: deposit.id, amount: FIXED_AMOUNT, backup },
  createdAt: now
});
fs.writeFileSync(dataFile, JSON.stringify(db, null, 2));
console.log(`Repaired ${TARGET_TX_HASH} to 1 USDT. Backup created at: ${backup}`);
