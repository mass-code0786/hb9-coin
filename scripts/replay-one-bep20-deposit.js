try { require('dotenv').config(); } catch (_) { /* .env is optional */ }

const fs = require('fs');
const path = require('path');
const { JsonRpcProvider, getAddress } = require('ethers');
const {
  parseBep20TransferWatcherLog,
  recordBep20Transfer,
  updateDepositConfirmations
} = require('../server');

const TARGET_TX_HASH = '0xa90fadee77b0ec3fda2af57d1c4b71f18cc3309bcf14f85e10f00930748ece54';
const FROM_BLOCK = 106634524;
const TO_BLOCK = 106634528;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function assertConfig() {
  if (!process.env.BSC_RPC_URL) throw Error('BSC_RPC_URL is required');
  if (!process.env.USDT_BEP20_CONTRACT) throw Error('USDT_BEP20_CONTRACT is required');
}

function eventKeyFor(event) {
  return `${event.chain}:${String(event.txHash).toLowerCase()}:${Number(event.logIndex)}`;
}

async function main() {
  assertConfig();

  const dataFile = path.resolve(process.env.DATA_FILE || './data/db.json');
  if (!fs.existsSync(dataFile)) throw Error(`Database file not found: ${dataFile}`);

  const provider = new JsonRpcProvider(process.env.BSC_RPC_URL);
  const receipt = await provider.getTransactionReceipt(TARGET_TX_HASH);
  if (!receipt) throw Error(`Target receipt not found: ${TARGET_TX_HASH}`);
  if (Number(receipt.status) !== 1) throw Error(`Target receipt is not successful: status=${receipt.status}`);
  if (receipt.blockNumber < FROM_BLOCK || receipt.blockNumber > TO_BLOCK) {
    throw Error(`Target block ${receipt.blockNumber} is outside replay range ${FROM_BLOCK}-${TO_BLOCK}`);
  }

  const logs = await provider.getLogs({
    address: getAddress(process.env.USDT_BEP20_CONTRACT),
    topics: [TRANSFER_TOPIC],
    fromBlock: FROM_BLOCK,
    toBlock: TO_BLOCK
  });
  const targetLogs = logs.filter(log => String(log.transactionHash || '').toLowerCase() === TARGET_TX_HASH);
  if (!targetLogs.length) throw Error(`No USDT Transfer logs for target tx in replay range ${FROM_BLOCK}-${TO_BLOCK}`);

  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const cursorBefore = JSON.stringify(db.deposit_watcher || null);
  const beforeDeposits = (db.deposits || []).length;
  const beforeLedger = (db.wallet_ledger || []).length;
  const beforeCreditedRefs = new Set((db.wallet_ledger || []).filter(item => item.asset === 'USDT' && item.reason === 'BEP20 deposit credited').map(item => item.refId));
  const decoded = [];

  for (const log of targetLogs) {
    const parsed = parseBep20TransferWatcherLog(log);
    if (!parsed.event) throw Error(`Target log decode failed: ${parsed.reason}`);
    if (String(parsed.event.txHash).toLowerCase() !== TARGET_TX_HASH) throw Error('Replay guard failed: decoded tx hash mismatch');
    decoded.push(parsed.event);
    recordBep20Transfer(db, parsed.event);
  }

  const latestBlock = await provider.getBlockNumber();
  updateDepositConfirmations(db, latestBlock);

  const cursorAfter = JSON.stringify(db.deposit_watcher || null);
  if (cursorAfter !== cursorBefore) throw Error('Replay attempted to modify deposit_watcher cursor; aborting without write');

  const touchedEventKeys = decoded.map(eventKeyFor);
  const creditedRefs = (db.wallet_ledger || []).filter(item => item.asset === 'USDT' && item.reason === 'BEP20 deposit credited' && touchedEventKeys.includes(item.refId));
  for (const refId of touchedEventKeys) {
    if (creditedRefs.filter(item => item.refId === refId).length > 1) throw Error(`Duplicate credit detected for ${refId}; aborting without write`);
  }

  const backup = `${dataFile}.before-bep20-replay-${Date.now()}.bak`;
  fs.copyFileSync(dataFile, backup);
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2));

  const newCredits = creditedRefs.filter(item => !beforeCreditedRefs.has(item.refId));
  console.log('BEP20_ONE_TIME_REPLAY_COMPLETE', JSON.stringify({
    txHash: TARGET_TX_HASH,
    range: { fromBlock: FROM_BLOCK, toBlock: TO_BLOCK },
    receiptBlock: receipt.blockNumber,
    logsFound: logs.length,
    targetLogs: targetLogs.length,
    decodedEvents: decoded.length,
    depositsCreated: (db.deposits || []).length - beforeDeposits,
    ledgerEntriesCreated: (db.wallet_ledger || []).length - beforeLedger,
    newCredits: newCredits.length,
    touchedEventKeys,
    backup
  }));
}

main().catch(error => {
  console.error(`BEP20_ONE_TIME_REPLAY_FAILED: ${error.message}`);
  process.exitCode = 1;
});
