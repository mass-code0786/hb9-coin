const { isZeroValueBep20Transfer, parseBep20TransferWatcherLog, repairBep20RawUnitAmounts, resolveDepositWatcherStart, validateBep20TransferEvent } = require('../server');

function assert(condition, message) { if (!condition) throw Error(message); }

const base = { latestBlock: 1000, confirmations: 12 };

// A legacy db.json cursor must not force an archive-node scan in automatic mode.
for (const startBlock of [undefined, '', 'latest', ' LATEST ']) {
  const result = resolveDepositWatcherStart({ ...base, startBlock, state: { lastScannedBlock: 42, lastProcessedBlock: 42 } });
  assert(result.nextBlock === 988 && result.cursorMode === 'latest', `Automatic start must ignore old cursor for ${String(startBlock)}`);
}

const explicit = resolveDepositWatcherStart({ ...base, startBlock: '500', state: { lastProcessedBlock: 42 } });
assert(explicit.nextBlock === 500 && explicit.cursorMode === 'configured', 'An explicit start block must opt into historical scanning');

const resumed = resolveDepositWatcherStart({ ...base, startBlock: 'latest', state: { cursorMode: 'latest', lastProcessedBlock: 997 } });
assert(resumed.nextBlock === 998, 'A current automatic cursor must continue forward');

const reset = resolveDepositWatcherStart({ ...base, startBlock: '500', resetCursor: true, state: { cursorMode: 'configured', lastProcessedBlock: 500 } });
assert(reset.reset && reset.nextBlock === 1000, 'Reset must position the cursor at the latest block');

const validLog = { topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${'0'.repeat(24)}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, `0x${'0'.repeat(24)}bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`], data: `0x${'0'.repeat(63)}1`, transactionHash: `0x${'c'.repeat(64)}`, index: 0, blockNumber: 1000 };
assert(parseBep20TransferWatcherLog(validLog).event?.amount === 0.000000000000000001, 'A valid Transfer log must be decoded using 18 decimals');
const decodedValidLog = parseBep20TransferWatcherLog(validLog).event;
assert(validateBep20TransferEvent(decodedValidLog).length === 0, 'A valid USDT Transfer log must pass event recording validation');
const oneUsdtLog = { ...validLog, data: `0x${(10n ** 18n).toString(16).padStart(64, '0')}` };
assert(parseBep20TransferWatcherLog(oneUsdtLog).event?.amount === 1, '1e18 raw USDT units must decode to exactly 1 USDT');
const zeroValueLog = { ...validLog, data: `0x${'0'.repeat(64)}` };
const decodedZeroValueLog = parseBep20TransferWatcherLog(zeroValueLog).event;
assert(decodedZeroValueLog?.amount === 0 && validateBep20TransferEvent(decodedZeroValueLog).length === 0 && isZeroValueBep20Transfer(decodedZeroValueLog.amount), 'A zero-value Transfer must be valid and skipped rather than rejected');
for (const [name, log] of [
  ['missing topics', { ...validLog, topics: [] }],
  ['wrong signature', { ...validLog, topics: ['0x1234', validLog.topics[1], validLog.topics[2]] }],
  ['invalid amount data', { ...validLog, data: '0x01' }]
]) assert(!parseBep20TransferWatcherLog(log).event, `Malformed ${name} must be rejected without throwing`);

const legacyDb = { auditLogs: [], blockchain_transactions: [{ id: 'tx_legacy', eventKey: 'BSC:legacy:0', chain: 'BSC', amount: 1000000000000000000 }], deposits: [{ id: 'dep_legacy', chain: 'BSC', amount: 1000000000000000000, creditedAmount: 1000000000000000000 }], wallet_ledger: [{ asset: 'USDT', reason: 'BEP20 deposit credited', refId: 'BSC:legacy:0', amount: 1000000000000000000 }], sweep_transactions: [{ id: 'swp_legacy', depositId: 'dep_legacy', amount: 1000000000000000000 }], reserve_ledger: [{ asset: 'USDT', walletType: 'treasury', direction: 'credit', refId: 'swp_legacy', amount: 1000000000000000000 }], reserve_wallets: [{ asset: 'USDT', walletType: 'treasury', balance: 1000000000000000000 }] };
assert(repairBep20RawUnitAmounts(legacyDb).corrected, 'Legacy raw-unit records must be repaired');
assert(legacyDb.deposits[0].amount === 1 && legacyDb.deposits[0].creditedAmount === 1 && legacyDb.wallet_ledger[0].amount === 1 && legacyDb.reserve_wallets[0].balance === 1, 'Raw-unit deposits, credits, and reserve balance must repair to 1 USDT');

console.log('WATCHER SMOKE PASS: automatic/latest starts ignore legacy cursors, explicit starts are honored, reset starts at latest, 1e18 decodes to 1 USDT, legacy raw credits repair safely, zero-value events are skipped, and malformed logs are rejected safely.');
