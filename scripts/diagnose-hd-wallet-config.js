try { require('dotenv').config(); } catch (_) {}
const fs = require('fs');
const crypto = require('crypto');
const { HDNodeWallet, getAddress } = require('ethers');
const { dataFile: DATA_FILE } = require('../server');

const DEFAULT_TX_HASH = '0x7e48bbba885ab4c786d6d20305b5e93f7f16baf5a903f2a754bff246425bb114';
const DEFAULT_EXPECTED_DEPOSIT_ADDRESS = '0xeb513f05b51fbe4c4acedef60ae9ef1ee8f694c7a';
const TARGET_TX_HASH = String(process.env.TX_HASH || DEFAULT_TX_HASH).toLowerCase();
const EXPECTED_DEPOSIT_ADDRESS = String(process.env.EXPECTED_DEPOSIT_ADDRESS || DEFAULT_EXPECTED_DEPOSIT_ADDRESS).toLowerCase();
const DEFAULT_HD_PATH = "m/44'/60'/0'/0";

const sha256 = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const fingerprint = value => value ? sha256(value).slice(0, 16) : null;
const sameAddress = (a, b) => {
  try { return getAddress(a) === getAddress(b); } catch (_) { return false; }
};
const normalizeAddress = value => {
  try { return getAddress(value); } catch (_) { return value || null; }
};
const deriveSafely = fn => {
  try { return { address: normalizeAddress(fn().address), error: null }; }
  catch (error) { return { address: null, error: error.message }; }
};
const loadDB = () => {
  if (!fs.existsSync(DATA_FILE)) throw Error(`Database file not found: ${DATA_FILE}`);
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
};

function findTargetContext(db) {
  const transactions = (db.blockchain_transactions || []).filter(tx => String(tx.txHash || '').toLowerCase() === TARGET_TX_HASH);
  const deposits = (db.deposits || []).filter(dep => String(dep.txHash || '').toLowerCase() === TARGET_TX_HASH);
  const transaction = transactions.length === 1 ? transactions[0] : null;
  const deposit = deposits.length === 1 ? deposits[0] : null;
  const address = deposit ? (db.deposit_addresses || []).find(item => item.id === deposit.depositAddressId) : null;
  const sweeps = deposit ? (db.sweep_transactions || []).filter(sweep => sweep.depositId === deposit.id || String(sweep.depositTxHash || '').toLowerCase() === TARGET_TX_HASH) : [];
  return { transactions, deposits, transaction, deposit, address, sweeps };
}

function verdict(report) {
  const stored = report.storedDepositAddress;
  const expected = report.expectedDepositAddress;
  const m = report.addressDerivedFromMnemonic;
  const xprv = report.addressDerivedFromXprv;
  const xpub = report.addressDerivedFromXpub;
  const hasMnemonic = Boolean(report.hdWalletMnemonicFingerprint);
  const hasXprv = report.hdWalletXprvConfigured;
  const issues = [];

  if (!stored) issues.push('Database is wrong or incomplete: target deposit record has no stored deposit address.');
  if (expected && stored && !sameAddress(expected, stored)) issues.push('Target/input address does not match the deposit address stored for this tx. Verify EXPECTED_DEPOSIT_ADDRESS/TX_HASH before repairing metadata.');
  if (!Number.isInteger(report.depositWalletIndex)) issues.push('Database metadata is wrong: deposit wallet index is missing or not an integer.');
  if (!report.hdWalletXpub) issues.push('HD_WALLET_XPUB is missing.');
  if (!hasMnemonic && !hasXprv) issues.push('Signer configuration is missing: configure HD_WALLET_MNEMONIC or account-level HD_WALLET_XPRV.');

  if (stored && xpub.address && !sameAddress(xpub.address, stored)) issues.push('HD_WALLET_XPUB is incorrect for this stored deposit address/index, or the stored wallet index is incorrect.');
  if (stored && hasMnemonic && m.address && !sameAddress(m.address, stored)) issues.push('HD_WALLET_MNEMONIC and/or HD_WALLET_DERIVATION_PATH is incorrect for this stored deposit address/index.');
  if (stored && hasXprv && xprv.address && !sameAddress(xprv.address, stored)) issues.push('HD_WALLET_XPRV is incorrect for this stored deposit address/index, or it is not the account-level xprv for HD_WALLET_XPUB.');
  if (m.error) issues.push(`HD_WALLET_MNEMONIC derivation failed: ${m.error}`);
  if (xprv.error) issues.push(`HD_WALLET_XPRV derivation failed: ${xprv.error}`);
  if (xpub.error) issues.push(`HD_WALLET_XPUB derivation failed: ${xpub.error}`);

  const configuredAddresses = [m, xprv, xpub].filter(item => item.address).map(item => item.address);
  const allConfiguredMatch = configuredAddresses.length > 1 && configuredAddresses.every(addr => sameAddress(addr, configuredAddresses[0]));
  if (configuredAddresses.length > 1 && !allConfiguredMatch) {
    const signerAddresses = [m, xprv].filter(item => item.address).map(item => item.address);
    const signersAgree = signerAddresses.length <= 1 || signerAddresses.every(addr => sameAddress(addr, signerAddresses[0]));
    if (signersAgree && xpub.address && signerAddresses[0] && !sameAddress(xpub.address, signerAddresses[0])) issues.push('Exact mismatch: HD_WALLET_XPUB was generated from a different wallet/path than the configured signer.');
    if (!signersAgree) issues.push('Exact mismatch: HD_WALLET_MNEMONIC and HD_WALLET_XPRV do not derive the same address. One of the signer configs is wrong.');
  }

  if (!issues.length) return 'All configured HD sources derive the stored deposit address. HD wallet configuration is consistent.';
  return issues.join(' ');
}

const db = loadDB();
const context = findTargetContext(db);
const derivationPath = process.env.HD_WALLET_DERIVATION_PATH || DEFAULT_HD_PATH;
const walletIndex = context.address ? Number(context.address.hdIndex) : NaN;
const fullPath = Number.isInteger(walletIndex) ? `${derivationPath}/${walletIndex}` : null;

const mnemonicDerived = process.env.HD_WALLET_MNEMONIC && fullPath
  ? deriveSafely(() => HDNodeWallet.fromPhrase(process.env.HD_WALLET_MNEMONIC, '', fullPath))
  : { address: null, error: process.env.HD_WALLET_MNEMONIC ? 'wallet index/path unavailable' : 'HD_WALLET_MNEMONIC is not configured' };

const xprvDerived = process.env.HD_WALLET_XPRV && Number.isInteger(walletIndex)
  ? deriveSafely(() => HDNodeWallet.fromExtendedKey(process.env.HD_WALLET_XPRV).deriveChild(walletIndex))
  : { address: null, error: process.env.HD_WALLET_XPRV ? 'wallet index unavailable' : 'HD_WALLET_XPRV is not configured' };

const xpubDerived = process.env.HD_WALLET_XPUB && Number.isInteger(walletIndex)
  ? deriveSafely(() => HDNodeWallet.fromExtendedKey(process.env.HD_WALLET_XPUB).deriveChild(walletIndex))
  : { address: null, error: process.env.HD_WALLET_XPUB ? 'wallet index unavailable' : 'HD_WALLET_XPUB is not configured' };

const report = {
  mode: 'READ_ONLY_NO_DATABASE_WRITES',
  txHash: TARGET_TX_HASH,
  expectedDepositAddress: normalizeAddress(EXPECTED_DEPOSIT_ADDRESS),
  dataFile: DATA_FILE,
  hdWalletMnemonicFingerprint: fingerprint(process.env.HD_WALLET_MNEMONIC),
  hdWalletDerivationPath: derivationPath,
  hdWalletXpub: process.env.HD_WALLET_XPUB || null,
  hdWalletXpubFingerprint: fingerprint(process.env.HD_WALLET_XPUB),
  hdWalletXprvConfigured: Boolean(process.env.HD_WALLET_XPRV),
  hdWalletXprv: process.env.PRINT_HD_WALLET_XPRV === 'true' ? (process.env.HD_WALLET_XPRV || null) : (process.env.HD_WALLET_XPRV ? '[configured: hidden; rerun with PRINT_HD_WALLET_XPRV=true to print]' : null),
  hdWalletXprvFingerprint: fingerprint(process.env.HD_WALLET_XPRV),
  depositId: context.deposit?.id || null,
  depositStatus: context.deposit?.status || null,
  depositSweepStatus: context.deposit?.sweepStatus || null,
  depositAddressId: context.address?.id || null,
  depositWalletIndex: Number.isInteger(walletIndex) ? walletIndex : null,
  storedDepositAddress: normalizeAddress(context.address?.address),
  storedDerivationPath: context.address?.derivationPath || null,
  storedHdBasePath: context.address?.hdBasePath || null,
  storedHdFingerprint: context.address?.hdFingerprint || null,
  effectiveMnemonicDerivationPath: fullPath,
  addressDerivedFromMnemonic: mnemonicDerived,
  addressDerivedFromXprv: xprvDerived,
  addressDerivedFromXpub: xpubDerived,
  allThreeMatch: Boolean(mnemonicDerived.address && xprvDerived.address && xpubDerived.address && sameAddress(mnemonicDerived.address, xprvDerived.address) && sameAddress(mnemonicDerived.address, xpubDerived.address)),
  mnemonicMatchesStored: Boolean(mnemonicDerived.address && context.address?.address && sameAddress(mnemonicDerived.address, context.address.address)),
  xprvMatchesStored: Boolean(xprvDerived.address && context.address?.address && sameAddress(xprvDerived.address, context.address.address)),
  xpubMatchesStored: Boolean(xpubDerived.address && context.address?.address && sameAddress(xpubDerived.address, context.address.address)),
  transactionMatchesFound: context.transactions.length,
  depositMatchesFound: context.deposits.length,
  sweepMatchesFound: context.sweeps.length
};

report.incorrectConfigurationVerdict = verdict(report);

console.log('HD_WALLET_CONFIGURATION_DIAGNOSTIC');
console.log(JSON.stringify(report, null, 2));
