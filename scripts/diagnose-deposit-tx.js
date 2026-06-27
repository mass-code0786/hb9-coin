try { require('dotenv').config(); } catch (_) { /* .env is optional */ }

const fs = require('fs');
const { JsonRpcProvider, getAddress, isAddress, formatUnits } = require('ethers');
const {
  dataFile,
  hdWalletConsistencyStatus,
  resolveDepositWatcherLiveScanRange
} = require('../server');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BSC_CHAIN = 'BSC';

function argValue(name) {
  const prefix = `${name}=`;
  const direct = process.argv.find(item => item.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const dashed = process.argv.findIndex(item => item === `--${name.toLowerCase()}` || item === `--${name}`);
  return dashed >= 0 ? process.argv[dashed + 1] : undefined;
}

function pass(stage, details = {}) {
  console.log(`PASS ${stage} ${JSON.stringify(details)}`);
}

function fail(stage, reason, details = {}) {
  console.log(`FAIL ${stage} ${JSON.stringify({ reason, ...details })}`);
  process.exitCode = 1;
}

function normAddress(address) {
  try {
    const value = String(address || '').trim();
    return isAddress(value) ? getAddress(value).toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

function normalizeChain(chain) {
  return String(chain || BSC_CHAIN).trim().toUpperCase();
}

function receiptLogIndex(log, fallback) {
  return Number.isInteger(log?.index) ? log.index : Number.isInteger(log?.logIndex) ? log.logIndex : fallback;
}

function decodeTransferLog(log, fallbackIndex) {
  return {
    txHash: String(log.transactionHash || '').toLowerCase(),
    logIndex: receiptLogIndex(log, fallbackIndex),
    contractAddress: getAddress(log.address),
    fromAddress: getAddress(`0x${String(log.topics[1]).slice(-40)}`),
    toAddress: getAddress(`0x${String(log.topics[2]).slice(-40)}`),
    amount: Number(formatUnits(BigInt(log.data), 18)),
    rawAmount: BigInt(log.data).toString(),
    blockNumber: Number(log.blockNumber)
  };
}

async function main() {
  const txHash = String(process.env.TX_HASH || argValue('TX_HASH') || argValue('tx') || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(txHash)) throw Error('Set TX_HASH=0x... or pass --tx 0x...');
  if (!process.env.BSC_RPC_URL) throw Error('BSC_RPC_URL is required');
  if (!isAddress(process.env.USDT_BEP20_CONTRACT || '')) throw Error('USDT_BEP20_CONTRACT must be a valid EVM address');

  if (!fs.existsSync(dataFile)) throw Error(`Database file not found: ${dataFile}`);

  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const provider = new JsonRpcProvider(process.env.BSC_RPC_URL);
  const receipt = await provider.getTransactionReceipt(txHash);

  if (!receipt) {
    fail('receipt found', 'provider.getTransactionReceipt returned null', { txHash });
    return;
  }
  pass('receipt found', { txHash, blockNumber: receipt.blockNumber });

  if (Number(receipt.status) !== 1) fail('receipt successful', 'receipt status is not 1', { status: Number(receipt.status) });
  else pass('receipt successful', { status: Number(receipt.status) });

  const transferLogs = (receipt.logs || []).map((log, index) => ({ log, index })).filter(item => String(item.log.topics?.[0] || '').toLowerCase() === TRANSFER_TOPIC);
  if (!transferLogs.length) fail('USDT Transfer found', 'receipt has no ERC20 Transfer topic logs', { logCount: receipt.logs?.length || 0 });

  const configuredUsdt = getAddress(process.env.USDT_BEP20_CONTRACT);
  const decoded = [];
  for (const item of transferLogs) {
    try {
      const event = decodeTransferLog(item.log, item.index);
      if (normAddress(event.contractAddress) === normAddress(configuredUsdt)) decoded.push(event);
    } catch (error) {
      fail('USDT Transfer found', `Transfer decode failed: ${error.message}`, { logIndex: item.index });
    }
  }

  if (!decoded.length) fail('USDT Transfer found', 'no Transfer logs matched USDT_BEP20_CONTRACT', { configuredUsdt, transferContracts: transferLogs.map(item => item.log.address) });
  else pass('USDT Transfer found', { configuredUsdt, matches: decoded.length });

  const targetEvent = decoded[0] || null;
  if (targetEvent) pass('decoded toAddress', { toAddress: targetEvent.toAddress, amount: targetEvent.amount, logIndex: targetEvent.logIndex });
  else fail('decoded toAddress', 'no decoded USDT transfer event');

  const addressRows = targetEvent ? (db.deposit_addresses || []).filter(item => normalizeChain(item.chain) === BSC_CHAIN && normAddress(item.address) === normAddress(targetEvent.toAddress)) : [];
  if (!addressRows.length) fail('address exists in DB', 'recipient is not present in deposit_addresses', { toAddress: targetEvent?.toAddress || null, dataFile });
  else pass('address exists in DB', { count: addressRows.length, rows: addressRows.map(item => ({ id: item.id, userId: item.userId, chain: item.chain, address: item.address, disabled: Boolean(item.disabled), signerVerified: item.signerVerified === true, hdIndex: item.hdIndex, walletIndex: item.walletIndex })) });

  const activeRows = addressRows.filter(item => !item.disabled);
  if (!activeRows.length) fail('active', 'all matching deposit address rows are disabled', { rows: addressRows.map(item => ({ id: item.id, disabled: Boolean(item.disabled), unsafeReason: item.unsafeReason || null })) });
  else pass('active', { count: activeRows.length });

  const verifiedRows = activeRows.filter(item => item.signerVerified === true);
  if (!verifiedRows.length) fail('signerVerified', 'no active matching row has signerVerified=true', { rows: activeRows.map(item => ({ id: item.id, signerVerified: item.signerVerified })) });
  else pass('signerVerified', { count: verifiedRows.length });

  const eventKey = targetEvent ? `${BSC_CHAIN}:${txHash}:${targetEvent.logIndex}` : null;
  const deposits = (db.deposits || []).filter(item => String(item.txHash || '').toLowerCase() === txHash || (eventKey && `${normalizeChain(item.chain)}:${String(item.txHash || '').toLowerCase()}:${Number(item.logIndex)}` === eventKey));
  if (!deposits.length) fail('credited or not', 'no deposit record is linked to txHash/logIndex', { eventKey });
  else {
    const credits = (db.wallet_ledger || []).filter(item => item.asset === 'USDT' && item.reason === 'BEP20 deposit credited' && item.refId === eventKey);
    if (credits.length === 1) pass('credited or not', { credited: true, eventKey, deposit: deposits.map(item => ({ id: item.id, status: item.status, amount: item.amount, confirmations: item.confirmations, requiredConfirmations: item.requiredConfirmations })), creditId: credits[0].id });
    else if (credits.length === 0) fail('credited or not', 'deposit exists but no wallet ledger credit exists', { eventKey, deposit: deposits.map(item => ({ id: item.id, status: item.status, amount: item.amount, confirmations: item.confirmations, requiredConfirmations: item.requiredConfirmations })) });
    else fail('credited or not', 'duplicate wallet ledger credits exist for eventKey', { eventKey, credits });
  }

  const depositIds = new Set(deposits.map(item => item.id));
  const sweeps = (db.sweep_transactions || []).filter(item => depositIds.has(item.depositId));
  if (!sweeps.length) fail('sweep created or not', 'no sweep candidate exists for linked deposit', { depositIds: [...depositIds] });
  else pass('sweep created or not', { sweeps: sweeps.map(item => ({ id: item.id, depositId: item.depositId, status: item.status, amount: item.amount, sweepTxHash: item.sweepTxHash || null })) });

  const latestBlock = await provider.getBlockNumber();
  const range = resolveDepositWatcherLiveScanRange({
    latestBlock,
    confirmations: process.env.REQUIRED_DEPOSIT_CONFIRMATIONS,
    state: db.deposit_watcher || {},
    lookbackBlocks: process.env.DEPOSIT_WATCHER_LOOKBACK_BLOCKS
  });
  const block = Number(receipt.blockNumber);
  const inRange = block >= Number(range.nextBlock) && block <= Number(range.toBlock);
  if (inRange) pass('current watcher range includes tx block or lookback covers it', { latestBlock, txBlock: block, nextBlock: range.nextBlock, toBlock: range.toBlock, lookbackBlocks: range.lookbackBlocks, cursorNextBlock: range.cursorNextBlock });
  else fail('current watcher range includes tx block or lookback covers it', 'tx block is outside current watcher scan range', { latestBlock, txBlock: block, nextBlock: range.nextBlock, toBlock: range.toBlock, lookbackBlocks: range.lookbackBlocks, cursorNextBlock: range.cursorNextBlock, distanceFromLatest: latestBlock - block });

  const hd = hdWalletConsistencyStatus();
  if (hd.configured) pass('HD wallet config', { address0: hd.address0, hdFingerprint: hd.hdFingerprint, derivationPath: hd.derivationPath });
  else fail('HD wallet config', hd.error || 'HD wallet config is not consistent');
}

main().catch(error => {
  console.error(`DIAGNOSE_DEPOSIT_TX_FAILED ${error.message}`);
  process.exitCode = process.exitCode || 1;
});
