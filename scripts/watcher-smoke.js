process.env.USDT_BEP20_CONTRACT = '0x55d398326f99059ff775485246999027b3197955';
process.env.TREASURY_WALLET_BSC = '0x9999999999999999999999999999999999999999';

const { isZeroValueBep20Transfer, parseBep20TransferWatcherLog, processDepositWatcherLogs, recordBep20Transfer, repairBep20RawUnitAmounts, resolveDepositWatcherLiveScanRange, resolveDepositWatcherStart, validateBep20TransferEvent } = require('../server');

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

const cursorAheadRange = resolveDepositWatcherLiveScanRange({ latestBlock: 1100, confirmations: 12, lookbackBlocks: 50, state: { cursorMode: 'latest', lastProcessedBlock: 1095 } });
assert(cursorAheadRange.nextBlock === 1050 && cursorAheadRange.toBlock === 1088 && cursorAheadRange.cursorNextBlock === 1096, 'Live watcher must scan from lookback start when cursor is ahead of confirmed deposit block');

const validLog = { address: process.env.USDT_BEP20_CONTRACT, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${'0'.repeat(24)}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, `0x${'0'.repeat(24)}bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`], data: `0x${'0'.repeat(63)}1`, transactionHash: `0x${'c'.repeat(64)}`, index: 0, blockNumber: 1000 };
assert(parseBep20TransferWatcherLog(validLog).event?.amount === 0.000000000000000001, 'A valid Transfer log must be decoded using 18 decimals');
const decodedValidLog = parseBep20TransferWatcherLog(validLog).event;
assert(validateBep20TransferEvent(decodedValidLog).length === 0, 'A valid USDT Transfer log must pass event recording validation');
const oneUsdtLog = { ...validLog, data: `0x${(10n ** 18n).toString(16).padStart(64, '0')}` };
assert(parseBep20TransferWatcherLog(oneUsdtLog).event?.amount === 1, '1e18 raw USDT units must decode to exactly 1 USDT');
const logIndexOnlyLog = { ...oneUsdtLog };
delete logIndexOnlyLog.index;
logIndexOnlyLog.logIndex = 7;
assert(parseBep20TransferWatcherLog(logIndexOnlyLog).event?.logIndex === 7, 'Watcher must accept raw RPC logIndex as well as ethers index');
const wrongContractLog = { ...oneUsdtLog, address: '0x9999999999999999999999999999999999999999' };
assert(!parseBep20TransferWatcherLog(wrongContractLog).event, 'Transfer logs from a non-USDT contract must be rejected');
const zeroValueLog = { ...validLog, data: `0x${'0'.repeat(64)}` };
const decodedZeroValueLog = parseBep20TransferWatcherLog(zeroValueLog).event;
assert(decodedZeroValueLog?.amount === 0 && validateBep20TransferEvent(decodedZeroValueLog).length === 0 && isZeroValueBep20Transfer(decodedZeroValueLog.amount), 'A zero-value Transfer must be valid and skipped rather than rejected');
for (const [name, log] of [
  ['missing topics', { ...validLog, topics: [] }],
  ['wrong signature', { ...validLog, topics: ['0x1234', validLog.topics[1], validLog.topics[2]] }],
  ['invalid amount data', { ...validLog, data: '0x01' }]
]) assert(!parseBep20TransferWatcherLog(log).event, `Malformed ${name} must be rejected without throwing`);

const targetTxHash = '0xa90fadee77b0ec3fda2af57d1c4b71f18cc3309bcf14f85e10f00930748ece54';
const targetAddress = '0xE0C9e2843f53b79A7C0632116f805a26061DADaA';
const topicAddress = address => `0x${'0'.repeat(24)}${address.toLowerCase().slice(2)}`;
const targetLog = {
  address: process.env.USDT_BEP20_CONTRACT,
  topics: [validLog.topics[0], topicAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), topicAddress(targetAddress)],
  data: `0x${(25n * 10n ** 18n).toString(16).padStart(64, '0')}`,
  transactionHash: targetTxHash,
  logIndex: 3,
  blockNumber: 123456
};
const decodedTarget = parseBep20TransferWatcherLog(targetLog).event;
assert(decodedTarget.toAddress === targetAddress && decodedTarget.fromAddress === '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa' && decodedTarget.amount === 25, 'Target tx/address-pattern Transfer must decode from topic1, to topic2, and non-zero data correctly');
const depositDb = { deposit_addresses: [{ id: 'addr_target', userId: 'usr_target', chain: 'BSC', address: targetAddress, signerVerified: true, disabled: false }], blockchain_transactions: [], deposits: [], auditLogs: [] };
recordBep20Transfer(depositDb, decodedTarget);
assert(depositDb.deposits.length === 1 && depositDb.deposits[0].txHash === targetTxHash && depositDb.deposits[0].depositAddressId === 'addr_target' && depositDb.deposits[0].amount === 25, 'Non-zero USDT transfer to an active signerVerified deposit address must create a deposit');
assert(depositDb.auditLogs.some(item => item.type === 'BEP20_DEPOSIT_DETECTED'), 'Detected transfer must write a BEP20_DEPOSIT_DETECTED audit log');
const inactiveDb = { deposit_addresses: [{ id: 'addr_inactive', userId: 'usr_target', chain: 'BSC', address: targetAddress, signerVerified: false, disabled: false }], blockchain_transactions: [], deposits: [], auditLogs: [] };
assert(recordBep20Transfer(inactiveDb, decodedTarget) === null && inactiveDb.deposits.length === 0, 'Inactive or unverified deposit address must not create a deposit');
const normalizedLookupDb = { deposit_addresses: [{ id: 'addr_normalized', userId: 'usr_normalized', chain: ' bsc ', address: ` ${targetAddress.toLowerCase()} `, signerVerified: true, disabled: false }], blockchain_transactions: [], deposits: [], auditLogs: [] };
recordBep20Transfer(normalizedLookupDb, decodedTarget);
assert(normalizedLookupDb.deposits.length === 1 && normalizedLookupDb.deposits[0].depositAddressId === 'addr_normalized', 'Deposit lookup must normalize DB chain/address before matching decoded recipient');

const liveLookbackDb = { deposit_addresses: [{ id: 'addr_live', userId: 'usr_live', chain: 'BSC', address: targetAddress, signerVerified: true, disabled: false }], blockchain_transactions: [], deposits: [], wallet_ledger: [], auditLogs: [] };
const liveLookbackLog = { ...targetLog, blockNumber: 1070 };
const liveFirst = processDepositWatcherLogs(liveLookbackDb, [liveLookbackLog], 1100, targetTxHash);
assert(liveFirst.decoded === 1 && liveLookbackDb.deposits.length === 1 && liveLookbackDb.wallet_ledger.length === 1 && liveLookbackDb.deposits[0].status === 'credited', 'Cursor-ahead live lookback scan must detect and credit a confirmed deposit inside the lookback window');
assert((liveLookbackDb.sweep_transactions || []).length === 1, 'Credited live deposit must create exactly one sweep candidate');
processDepositWatcherLogs(liveLookbackDb, [liveLookbackLog], 1100, targetTxHash);
assert(liveLookbackDb.deposits.length === 1 && liveLookbackDb.wallet_ledger.length === 1, 'Second live lookback scan must not duplicate deposit or credit');
assert((liveLookbackDb.sweep_transactions || []).length === 1, 'Second live lookback scan must not duplicate sweep candidate');

const legacyDb = { auditLogs: [], blockchain_transactions: [{ id: 'tx_legacy', eventKey: 'BSC:legacy:0', chain: 'BSC', amount: 1000000000000000000 }], deposits: [{ id: 'dep_legacy', chain: 'BSC', amount: 1000000000000000000, creditedAmount: 1000000000000000000 }], wallet_ledger: [{ asset: 'USDT', reason: 'BEP20 deposit credited', refId: 'BSC:legacy:0', amount: 1000000000000000000 }], sweep_transactions: [{ id: 'swp_legacy', depositId: 'dep_legacy', amount: 1000000000000000000 }], reserve_ledger: [{ asset: 'USDT', walletType: 'treasury', direction: 'credit', refId: 'swp_legacy', amount: 1000000000000000000 }], reserve_wallets: [{ asset: 'USDT', walletType: 'treasury', balance: 1000000000000000000 }] };
assert(repairBep20RawUnitAmounts(legacyDb).corrected, 'Legacy raw-unit records must be repaired');
assert(legacyDb.deposits[0].amount === 1 && legacyDb.deposits[0].creditedAmount === 1 && legacyDb.wallet_ledger[0].amount === 1 && legacyDb.reserve_wallets[0].balance === 1, 'Raw-unit deposits, credits, and reserve balance must repair to 1 USDT');

console.log('WATCHER SMOKE PASS: Transfer logs decode contract/topic1/topic2/data correctly, non-zero active deposit transfers are detected, automatic/latest starts ignore legacy cursors, and malformed/zero-value logs are handled safely.');
