const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getAddress } = require('ethers');

const TARGET_TX_HASH = '0x7e48bbba885ab4c786d6d20305b5e93f7f16baf5a903f2a754bff246425bb114';
const dataFile = path.resolve(process.env.DATA_FILE || './data/db.json');
const now = new Date().toISOString();
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const matchesHash = value => String(value || '').toLowerCase() === TARGET_TX_HASH;

if (!fs.existsSync(dataFile)) throw Error(`Database file not found: ${dataFile}`);
const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
db.sweep_transactions = db.sweep_transactions || [];
db.auditLogs = db.auditLogs || [];

const transactions = (db.blockchain_transactions || []).filter(tx => matchesHash(tx.txHash));
if (transactions.length !== 1) throw Error(`Expected exactly one blockchain transaction for ${TARGET_TX_HASH}; found ${transactions.length}. No changes made.`);

const transaction = transactions[0];
const deposits = (db.deposits || []).filter(deposit => matchesHash(deposit.txHash) && Number(deposit.logIndex) === Number(transaction.logIndex));
if (deposits.length !== 1) throw Error(`Expected exactly one matching deposit for log index ${transaction.logIndex}; found ${deposits.length}. No changes made.`);

const deposit = deposits[0];
if (deposit.status !== 'credited') throw Error(`Target deposit status is ${deposit.status}; expected credited. No changes made.`);

const amount = Number(deposit.creditedAmount ?? deposit.amount);
if (!Number.isFinite(amount) || amount <= 0) throw Error(`Target deposit amount is invalid: ${deposit.creditedAmount ?? deposit.amount}. No changes made.`);

const address = (db.deposit_addresses || []).find(item => item.id === deposit.depositAddressId);
if (!address) throw Error(`Deposit address ${deposit.depositAddressId} was not found. No changes made.`);

const sweeps = db.sweep_transactions.filter(sweep => sweep.depositId === deposit.id || (matchesHash(sweep.depositTxHash) && Number(sweep.depositLogIndex) === Number(transaction.logIndex)));
if (sweeps.length > 1) throw Error(`Expected at most one matching sweep for ${TARGET_TX_HASH}; found ${sweeps.length}. No changes made.`);

let sweep = sweeps[0];
let action = 'created';
if (!sweep) {
  if (!process.env.TREASURY_WALLET_BSC) throw Error('TREASURY_WALLET_BSC is required to create a new sweep. Backup was created but no db changes were written.');
  sweep = {
    id: id('swp'),
    depositId: deposit.id,
    userId: deposit.userId,
    chain: 'BSC',
    depositTxHash: deposit.txHash,
    depositLogIndex: deposit.logIndex,
    fromAddress: address.address,
    toAddress: getAddress(process.env.TREASURY_WALLET_BSC),
    amount,
    status: 'not_started',
    gasTopupStatus: 'not_required',
    createdAt: now,
    updatedAt: now
  };
  db.sweep_transactions.push(sweep);
} else {
  if (['confirmed','broadcasted','gas_topup_broadcasted','gas_funded'].includes(sweep.status)) throw Error(`Sweep ${sweep.id} is already ${sweep.status}; no retry state was changed.`);
  action = 'requeued';
  if (sweep.sweepTxHash) (sweep.failedSweepTxHashes ||= []).push(sweep.sweepTxHash);
  if (sweep.gasTopupTxHash) (sweep.failedGasTopupTxHashes ||= []).push(sweep.gasTopupTxHash);
  Object.assign(sweep, {
    depositId: deposit.id,
    userId: deposit.userId,
    chain: 'BSC',
    depositTxHash: deposit.txHash,
    depositLogIndex: deposit.logIndex,
    fromAddress: sweep.fromAddress || address.address,
    amount,
    status: 'not_started',
    gasTopupStatus: 'not_required',
    sweepTxHash: null,
    gasTopupTxHash: null,
    failureReason: null,
    failedPhase: null,
    retryRequestedAt: now,
    updatedAt: now
  });
  if (!sweep.toAddress && process.env.TREASURY_WALLET_BSC) sweep.toAddress = getAddress(process.env.TREASURY_WALLET_BSC);
}

if (!sweep.toAddress) throw Error('Sweep destination address is missing. Set TREASURY_WALLET_BSC before running this script. No changes made.');
Object.assign(deposit, { sweepStatus: 'not_started', sweepId: sweep.id, updatedAt: now });
const backup = `${dataFile}.before-one-usdt-sweep-requeue-${Date.now()}.bak`;
fs.copyFileSync(dataFile, backup);
db.auditLogs.push({
  id: id('aud'),
  type: 'TREASURY_SWEEP_CANDIDATE_CREATED',
  details: { txHash: TARGET_TX_HASH, depositId: deposit.id, sweepId: sweep.id, amount, action, backup },
  createdAt: now
});

fs.writeFileSync(dataFile, JSON.stringify(db, null, 2));
console.log(`TREASURY_SWEEP_CANDIDATE_CREATED ${JSON.stringify({ txHash: TARGET_TX_HASH, depositId: deposit.id, sweepId: sweep.id, amount, action, backup })}`);
