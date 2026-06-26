const { resolveDepositWatcherStart } = require('../server');

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

console.log('WATCHER SMOKE PASS: automatic/latest starts ignore legacy cursors, explicit starts are honored, and reset starts at latest.');
