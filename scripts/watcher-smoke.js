const { parseBep20TransferWatcherLog, resolveDepositWatcherStart } = require('../server');

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
assert(parseBep20TransferWatcherLog(validLog).event?.amount === 0.000001, 'A valid Transfer log must be decoded');
for (const [name, log] of [
  ['missing topics', { ...validLog, topics: [] }],
  ['wrong signature', { ...validLog, topics: ['0x1234', validLog.topics[1], validLog.topics[2]] }],
  ['invalid amount data', { ...validLog, data: '0x01' }]
]) assert(!parseBep20TransferWatcherLog(log).event, `Malformed ${name} must be rejected without throwing`);

console.log('WATCHER SMOKE PASS: automatic/latest starts ignore legacy cursors, explicit starts are honored, reset starts at latest, and malformed logs are rejected safely.');
