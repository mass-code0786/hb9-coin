try { require('dotenv').config(); } catch (_) {}
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { HDNodeWallet, getAddress } = require('ethers');
const { dataFile: DATA_FILE } = require('../server');

const DEFAULT_TX_HASH = '0x7e48bbba885ab4c786d6d20305b5e93f7f16baf5a903f2a754bff246425bb114';
const DEFAULT_EXPECTED_ADDRESS = '0xeb513f05b51fbe4c4acedef60ae9ef1ee8f694c7a';
const TARGET_TX_HASH = String(process.env.TX_HASH || DEFAULT_TX_HASH).toLowerCase();
const EXPECTED_ADDRESS = String(process.env.EXPECTED_DEPOSIT_ADDRESS || DEFAULT_EXPECTED_ADDRESS);
const DEFAULT_HD_PATH = "m/44'/60'/0'/0";
const HD_PATTERN = 'HD_WALLET_XPUB|HD_WALLET_MNEMONIC|HD_WALLET_XPRV|HD_WALLET_DERIVATION_PATH|deposit address|deposit_addresses|derivedDepositAddress|ensureDepositAddress|fromPhrase|fromExtendedKey|deriveChild|neuter';

const sha256 = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const fingerprint = value => value ? sha256(value).slice(0, 16) : null;
const normalizeAddress = value => {
  try { return getAddress(value); } catch (_) { return value || null; }
};
const sameAddress = (a, b) => {
  try { return getAddress(a) === getAddress(b); } catch (_) { return false; }
};
const runGit = args => {
  try { return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 8 }).trim(); }
  catch (error) { return `ERROR: ${error.message}`; }
};
const deriveSafely = fn => {
  try { return { address: normalizeAddress(fn().address), error: null }; }
  catch (error) { return { address: null, error: error.message }; }
};

function loadDB() {
  if (!fs.existsSync(DATA_FILE)) throw Error(`Database file not found: ${DATA_FILE}`);
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function currentSourceMatches() {
  const files = runGit(['grep', '-nE', HD_PATTERN, '--', 'server.js', 'scripts', '.env.example']);
  return files.split(/\r?\n/).filter(Boolean).map(line => line.replace(process.cwd() + path.sep, ''));
}

function historyMatches() {
  const commits = runGit(['log', '--all', '--oneline', '-G', HD_PATTERN, '--', 'server.js', 'scripts', '.env.example']);
  const patch = runGit(['log', '--all', '--date=iso-strict', '--pretty=format:COMMIT %H %ad %s', '-G', HD_PATTERN, '-p', '--', 'server.js', 'scripts', '.env.example']);
  const interestingPatchLines = patch.split(/\r?\n/)
    .filter(line => /^COMMIT /.test(line) || /^[+-].*(HD_WALLET_|derivedDepositAddress|ensureDepositAddress|fromPhrase|fromExtendedKey|deriveChild|neuter|TEST_XPUB|deposit_addresses)/.test(line))
    .slice(0, 500);
  return {
    commits: commits.split(/\r?\n/).filter(Boolean),
    relevantPatchLines: interestingPatchLines
  };
}

function findContext(db) {
  const transactions = (db.blockchain_transactions || []).filter(tx => String(tx.txHash || '').toLowerCase() === TARGET_TX_HASH);
  const deposits = (db.deposits || []).filter(dep => String(dep.txHash || '').toLowerCase() === TARGET_TX_HASH);
  const expectedRecords = (db.deposit_addresses || []).filter(addr => sameAddress(addr.address, EXPECTED_ADDRESS));
  const transaction = transactions.length === 1 ? transactions[0] : null;
  const deposit = deposits.length === 1 ? deposits[0] : null;
  const linkedAddress = deposit ? (db.deposit_addresses || []).find(addr => addr.id === deposit.depositAddressId) : null;
  const toAddressRecords = transaction?.toAddress ? (db.deposit_addresses || []).filter(addr => sameAddress(addr.address, transaction.toAddress)) : [];
  const audits = (db.auditLogs || []).filter(log => {
    const text = JSON.stringify(log);
    return text.toLowerCase().includes(TARGET_TX_HASH) || text.toLowerCase().includes(String(EXPECTED_ADDRESS).toLowerCase()) || (linkedAddress && text.includes(linkedAddress.id));
  }).slice(-20);
  return { transactions, deposits, expectedRecords, transaction, deposit, linkedAddress, toAddressRecords, audits };
}

function deriveAll(index) {
  const basePath = process.env.HD_WALLET_DERIVATION_PATH || DEFAULT_HD_PATH;
  const fullPath = Number.isInteger(index) ? `${basePath}/${index}` : null;
  const fromMnemonic = process.env.HD_WALLET_MNEMONIC && fullPath
    ? deriveSafely(() => HDNodeWallet.fromPhrase(process.env.HD_WALLET_MNEMONIC, '', fullPath))
    : { address: null, error: process.env.HD_WALLET_MNEMONIC ? 'wallet index unavailable' : 'HD_WALLET_MNEMONIC is not configured' };
  const fromXprv = process.env.HD_WALLET_XPRV && Number.isInteger(index)
    ? deriveSafely(() => HDNodeWallet.fromExtendedKey(process.env.HD_WALLET_XPRV).deriveChild(index))
    : { address: null, error: process.env.HD_WALLET_XPRV ? 'wallet index unavailable' : 'HD_WALLET_XPRV is not configured' };
  const fromXpub = process.env.HD_WALLET_XPUB && Number.isInteger(index)
    ? deriveSafely(() => HDNodeWallet.fromExtendedKey(process.env.HD_WALLET_XPUB).deriveChild(index))
    : { address: null, error: process.env.HD_WALLET_XPUB ? 'wallet index unavailable' : 'HD_WALLET_XPUB is not configured' };
  return { basePath, fullPath, fromMnemonic, fromXprv, fromXpub };
}

function rootCause(report) {
  const lines = [];
  const stored = report.database.linkedDepositAddress?.address;
  const expected = report.expectedDepositAddress;
  const txTo = report.database.blockchainTransaction?.toAddress;
  const idx = report.database.walletIndex;
  const d = report.currentDerivationAtWalletIndex;

  if (!report.database.singleTransactionFound || !report.database.singleDepositFound) {
    lines.push('The target tx does not resolve to exactly one blockchain transaction and one deposit in db.json; provenance cannot be exact until duplicate/missing records are resolved.');
    return lines;
  }
  if (!stored) {
    lines.push('The target deposit has no linked deposit address record. The database linkage, not HD derivation, is the immediate provenance failure.');
    return lines;
  }
  if (expected && !sameAddress(expected, stored)) {
    lines.push('The expected address supplied for diagnosis does not match the deposit address linked to this tx in db.json. This means either EXPECTED_DEPOSIT_ADDRESS/TX_HASH pairing is wrong, or deposit.depositAddressId points to the wrong deposit_addresses row.');
  }
  if (txTo && !sameAddress(txTo, stored)) {
    lines.push('blockchain_transactions.toAddress does not match the deposit address linked to the deposit record. The tx/deposit/address database linkage is inconsistent.');
  }
  if (!Number.isInteger(idx)) {
    lines.push('The linked deposit address has no valid hdIndex, so its HD origin cannot be reproduced from config.');
    return lines;
  }

  const configMatchesStored = [d.fromMnemonic, d.fromXprv, d.fromXpub].filter(x => x.address).some(x => sameAddress(x.address, stored));
  if (!configMatchesStored) {
    lines.push(`No currently configured HD source derives the linked stored deposit address at hdIndex ${idx}. Therefore the stored address came from a different HD_WALLET_XPUB/HD_WALLET_MNEMONIC/HD_WALLET_XPRV or a different derivation path than the current VPS configuration.`);
  }
  if (d.fromMnemonic.address && d.fromXpub.address && sameAddress(d.fromMnemonic.address, d.fromXpub.address) && !sameAddress(d.fromXpub.address, stored)) {
    lines.push('Current HD_WALLET_MNEMONIC and HD_WALLET_XPUB are internally consistent with each other, but they are not the wallet that generated the stored deposit address. The incorrect configuration is the current HD wallet material as a set: HD_WALLET_MNEMONIC/HD_WALLET_XPUB were replaced or regenerated after the deposit address was created.');
  } else if (d.fromMnemonic.address && d.fromXpub.address && !sameAddress(d.fromMnemonic.address, d.fromXpub.address)) {
    lines.push('Current HD_WALLET_MNEMONIC and HD_WALLET_XPUB do not match each other. At least one of those two variables is wrong; compare which one derives the stored address to identify the valid source.');
  }
  if (d.fromXpub.address && sameAddress(d.fromXpub.address, stored) && d.fromMnemonic.address && !sameAddress(d.fromMnemonic.address, stored)) {
    lines.push('HD_WALLET_XPUB derives the stored deposit address, but HD_WALLET_MNEMONIC does not. The wrong configuration is HD_WALLET_MNEMONIC and/or HD_WALLET_DERIVATION_PATH.');
  }
  if (d.fromMnemonic.address && sameAddress(d.fromMnemonic.address, stored) && d.fromXpub.address && !sameAddress(d.fromXpub.address, stored)) {
    lines.push('HD_WALLET_MNEMONIC derives the stored deposit address, but HD_WALLET_XPUB does not. The wrong configuration is HD_WALLET_XPUB.');
  }
  if (!lines.length) lines.push('The linked stored deposit address is derivable from current configuration. The root cause is not HD wallet provenance; inspect sweep state/provider/token balance next.');
  return lines;
}

const db = loadDB();
const context = findContext(db);
const linkedIndex = context.linkedAddress ? Number(context.linkedAddress.hdIndex) : NaN;
const expectedIndex = context.expectedRecords.length === 1 ? Number(context.expectedRecords[0].hdIndex) : NaN;
const currentDerivationAtWalletIndex = deriveAll(Number.isInteger(linkedIndex) ? linkedIndex : expectedIndex);
const history = historyMatches();

const report = {
  mode: 'READ_ONLY_NO_DATABASE_OR_ENV_WRITES',
  txHash: TARGET_TX_HASH,
  expectedDepositAddress: normalizeAddress(EXPECTED_ADDRESS),
  dataFile: DATA_FILE,
  environmentFingerprints: {
    hdWalletMnemonicFingerprint: fingerprint(process.env.HD_WALLET_MNEMONIC),
    hdWalletXpubFingerprint: fingerprint(process.env.HD_WALLET_XPUB),
    hdWalletXprvFingerprint: fingerprint(process.env.HD_WALLET_XPRV),
    hdWalletDerivationPath: process.env.HD_WALLET_DERIVATION_PATH || DEFAULT_HD_PATH,
    hdWalletXpubConfigured: Boolean(process.env.HD_WALLET_XPUB),
    hdWalletMnemonicConfigured: Boolean(process.env.HD_WALLET_MNEMONIC),
    hdWalletXprvConfigured: Boolean(process.env.HD_WALLET_XPRV)
  },
  database: {
    transactionMatchesFound: context.transactions.length,
    depositMatchesFound: context.deposits.length,
    expectedAddressRecordsFound: context.expectedRecords.length,
    singleTransactionFound: context.transactions.length === 1,
    singleDepositFound: context.deposits.length === 1,
    blockchainTransaction: context.transaction ? {
      id: context.transaction.id,
      txHash: context.transaction.txHash,
      toAddress: normalizeAddress(context.transaction.toAddress),
      depositAddressId: context.transaction.depositAddressId,
      amount: context.transaction.amount,
      status: context.transaction.status
    } : null,
    deposit: context.deposit ? {
      id: context.deposit.id,
      txHash: context.deposit.txHash,
      depositAddressId: context.deposit.depositAddressId,
      status: context.deposit.status,
      sweepStatus: context.deposit.sweepStatus || null,
      amount: context.deposit.amount,
      creditedAmount: context.deposit.creditedAmount
    } : null,
    linkedDepositAddress: context.linkedAddress ? {
      id: context.linkedAddress.id,
      address: normalizeAddress(context.linkedAddress.address),
      hdIndex: Number(context.linkedAddress.hdIndex),
      derivationPath: context.linkedAddress.derivationPath || null,
      hdBasePath: context.linkedAddress.hdBasePath || null,
      hdFingerprint: context.linkedAddress.hdFingerprint || null,
      createdAt: context.linkedAddress.createdAt || null,
      updatedAt: context.linkedAddress.updatedAt || null
    } : null,
    expectedAddressRecords: context.expectedRecords.map(addr => ({
      id: addr.id,
      userId: addr.userId,
      address: normalizeAddress(addr.address),
      hdIndex: Number(addr.hdIndex),
      derivationPath: addr.derivationPath || null,
      createdAt: addr.createdAt || null
    })),
    walletIndex: Number.isInteger(linkedIndex) ? linkedIndex : null,
    recentRelevantAuditLogs: context.audits
  },
  currentDerivationAtWalletIndex,
  repositorySearch: {
    currentMatches: currentSourceMatches(),
    historyCommitsTouchingHdGeneration: history.commits,
    historyRelevantPatchLines: history.relevantPatchLines
  }
};
report.rootCause = rootCause(report);

console.log('DEPOSIT_ADDRESS_ORIGIN_DIAGNOSTIC');
console.log(JSON.stringify(report, null, 2));
