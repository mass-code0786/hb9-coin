try { require('dotenv').config(); } catch (_) {}
const fs = require('fs');
const crypto = require('crypto');
const {
  dataFile,
  depositDerivationPath,
  depositSignerDiagnostics,
  derivedDepositAddress,
  hdBaseDerivationPath,
  hdFingerprint,
  hdWalletConsistencyStatus
} = require('../server');

const TARGET_TX_HASH = '0x7e48bbba885ab4c786d6d20305b5e93f7f16baf5a903f2a754bff246425bb114';
const TARGET_DEPOSIT_ADDRESS = '0xeb513f05b51fbe4c4acedef60ae9ef1ee8f694c7a';
const now = new Date().toISOString();
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const matchesHash = value => String(value || '').toLowerCase() === TARGET_TX_HASH;
const sameAddress = (a,b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

if (!fs.existsSync(dataFile)) throw Error(`Database file not found: ${dataFile}`);
const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

const transactions = (db.blockchain_transactions || []).filter(tx => matchesHash(tx.txHash));
if (transactions.length !== 1) throw Error(`Expected exactly one blockchain transaction for ${TARGET_TX_HASH}; found ${transactions.length}. No changes made.`);
const transaction = transactions[0];

const deposits = (db.deposits || []).filter(deposit => matchesHash(deposit.txHash) && Number(deposit.logIndex) === Number(transaction.logIndex));
if (deposits.length !== 1) throw Error(`Expected exactly one matching deposit for log index ${transaction.logIndex}; found ${deposits.length}. No changes made.`);
const deposit = deposits[0];

const address = (db.deposit_addresses || []).find(item => item.id === deposit.depositAddressId);
if (!address) throw Error(`Deposit address ${deposit.depositAddressId} was not found. No changes made.`);

const basePath = hdBaseDerivationPath();
const fullPath = depositDerivationPath(address.hdIndex, basePath);
const hdStatus = hdWalletConsistencyStatus();
let xpubDerivedAddress = null;
try { xpubDerivedAddress = derivedDepositAddress(address.chain, address.hdIndex); } catch (error) { xpubDerivedAddress = `ERROR: ${error.message}`; }
const diagnosticAddress = { ...address, hdBasePath: basePath, derivationPath: fullPath, hdFingerprint: hdFingerprint() };
const { diagnostics } = depositSignerDiagnostics(diagnosticAddress);

const report = {
  txHash: TARGET_TX_HASH,
  depositId: deposit.id,
  depositStatus: deposit.status,
  depositSweepStatus: deposit.sweepStatus || null,
  storedDepositAddress: address.address,
  targetDepositAddress: TARGET_DEPOSIT_ADDRESS,
  targetAddressMatchesStored: sameAddress(address.address, TARGET_DEPOSIT_ADDRESS),
  walletIndex: Number(address.hdIndex),
  configuredBaseDerivationPath: basePath,
  storedDerivationPath: address.derivationPath || null,
  repairedDerivationPath: fullPath,
  storedHdFingerprint: address.hdFingerprint || null,
  configuredHdFingerprint: hdFingerprint(),
  xpubDerivedAddress,
  expectedDepositAddress: diagnostics.expectedDepositAddress,
  derivedSignerAddress: diagnostics.derivedSignerAddress,
  sweepDerivationPath: diagnostics.sweepDerivationPath,
  hdWalletConfigured: hdStatus.configured,
  hdWalletConfigError: hdStatus.error || null,
  mismatchReason: diagnostics.reason
};

console.log('TREASURY_SWEEP_SIGNER_DIAGNOSTIC', JSON.stringify(report, null, 2));

if (!report.targetAddressMatchesStored) throw Error('Target deposit address does not match the stored deposit address for this transaction. No changes made.');
if (!hdStatus.configured) throw Error(`${hdStatus.error}. Fix HD_WALLET_XPUB, HD_WALLET_MNEMONIC, or HD_WALLET_DERIVATION_PATH. No changes made.`);
if (!sameAddress(xpubDerivedAddress, address.address)) throw Error('HD_WALLET_XPUB + wallet index does not derive the stored deposit address. The stored hdIndex or HD_WALLET_XPUB is wrong. No changes made.');
if (!sameAddress(diagnostics.derivedSignerAddress, address.address)) throw Error('HD_WALLET_MNEMONIC + HD_WALLET_DERIVATION_PATH does not derive the stored deposit address. No changes made.');

const needsRepair = address.hdBasePath !== basePath || address.derivationPath !== fullPath || address.hdFingerprint !== hdFingerprint();
if (!needsRepair) {
  console.log('Deposit signer metadata already matches configured HD wallet. No db changes needed.');
  process.exit(0);
}

const backup = `${dataFile}.before-sweep-signer-metadata-${Date.now()}.bak`;
fs.copyFileSync(dataFile, backup);
Object.assign(address, { hdBasePath: basePath, derivationPath: fullPath, hdFingerprint: hdFingerprint(), updatedAt: now });
db.auditLogs = db.auditLogs || [];
db.auditLogs.push({
  id: id('aud'),
  type: 'DEPOSIT_DERIVATION_METADATA_REPAIRED',
  details: { txHash: TARGET_TX_HASH, depositId: deposit.id, depositAddressId: address.id, address: address.address, hdIndex: address.hdIndex, derivationPath: fullPath, hdFingerprint: hdFingerprint(), backup },
  createdAt: now
});
fs.writeFileSync(dataFile, JSON.stringify(db, null, 2));
console.log(`Repaired deposit signer metadata only. Backup created at: ${backup}`);
