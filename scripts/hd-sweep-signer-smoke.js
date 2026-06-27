const assert = (condition, message) => { if (!condition) throw Error(message); };
const { HDNodeWallet, Interface, Transaction, parseUnits } = require('ethers');

const mnemonic = 'test test test test test test test test test test test junk';
const basePath = "m/44'/60'/0'/0";
process.env.HD_WALLET_MNEMONIC = mnemonic;
process.env.HD_WALLET_DERIVATION_PATH = basePath;
process.env.HD_WALLET_XPUB = HDNodeWallet.fromPhrase(mnemonic, '', basePath).neuter().extendedKey;
process.env.HD_WALLET_XPRV = HDNodeWallet.fromPhrase(mnemonic, '', basePath).extendedKey;
process.env.TREASURY_WALLET_BSC = '0x9999999999999999999999999999999999999999';
process.env.USDT_BEP20_CONTRACT = '0x55d398326f99059ff775485246999027b3197955';

const {
  depositPrivateSigner,
  depositSignerDiagnostics,
  ensureDepositAddress,
  hdWalletConsistencyStatus,
  migrateUnsafeDepositAddresses
} = require('../server');

async function main() {
  const db = { deposit_addresses: [], auditLogs: [] };
  const address = ensureDepositAddress(db, 'usr_1', 'BSC');
  const diagnostics = depositSignerDiagnostics(address).diagnostics;
  assert(hdWalletConsistencyStatus().configured, 'HD xpub and mnemonic must be consistent');
  assert(diagnostics.expectedDepositAddress === address.address, 'Expected deposit address must match generated address');
  assert(diagnostics.derivedSignerAddress === address.address, 'Derived signer address must match generated deposit address');
  assert(address.derivationPath === `${basePath}/0`, 'Generated deposit metadata must store the exact full derivation path');
  assert(address.hdBasePath === basePath, 'Generated deposit metadata must store the HD base path');
  assert(address.walletIndex === 0, 'Generated deposit metadata must store walletIndex');
  assert(address.hdFingerprint, 'Generated deposit metadata must store hdFingerprint');
  assert(address.signerVerified === true, 'Generated deposit address must be marked signerVerified');

  const signer = depositPrivateSigner(address);
  const token = new Interface(['function transfer(address,uint256) returns (bool)']);
  const signed = await signer.signTransaction({
    chainId: 56,
    nonce: 0,
    gasLimit: 65000,
    gasPrice: 1_000_000_000,
    to: process.env.USDT_BEP20_CONTRACT,
    value: 0,
    data: token.encodeFunctionData('transfer', [process.env.TREASURY_WALLET_BSC, parseUnits('1', 18)])
  });
  const tx = Transaction.from(signed);
  assert(tx.from === address.address, 'Signed sweep simulation must be signed by the deposit address');

  const unsafe = '0xeb513f05b51fbe4c4acedef60ae9ef1ee8f694c7a';
  const unsafeDb = { deposit_addresses: [{ id: 'addr_unsafe', userId: 'usr_2', chain: 'BSC', address: unsafe, hdIndex: 0, createdAt: new Date().toISOString() }], auditLogs: [] };
  const replacement = ensureDepositAddress(unsafeDb, 'usr_2', 'BSC');
  assert(replacement.address.toLowerCase() !== unsafe, 'Unsafe old address must never be returned');
  assert(replacement.signerVerified === true, 'Replacement address must be signer verified');
  assert(unsafeDb.deposit_addresses[0].disabled === true, 'Existing unsafe address must be disabled');
  assert(unsafeDb.deposit_addresses[0].unsafeReason, 'Existing unsafe address must store unsafeReason');
  assert(unsafeDb.auditLogs.some(item => item.type === 'DEPOSIT_ADDRESS_DISABLED_UNSAFE'), 'Unsafe disable log must be recorded');
  assert(unsafeDb.auditLogs.some(item => item.type === 'DEPOSIT_ADDRESS_REPLACED'), 'Replacement log must be recorded');

  const migrationDb = { deposit_addresses: [{ id: 'addr_migrate_unsafe', userId: 'usr_3', chain: 'BSC', address: unsafe, hdIndex: 2, createdAt: new Date().toISOString() }], auditLogs: [] };
  const migration = migrateUnsafeDepositAddresses(migrationDb);
  const migratedReplacement = migrationDb.deposit_addresses.find(item => item.userId === 'usr_3' && item.signerVerified === true && !item.disabled);
  assert(migration.replacements === 1, 'Migration must create one replacement for an affected user');
  assert(migrationDb.deposit_addresses[0].disabled === true, 'Migration must disable unsafe address');
  assert(migratedReplacement && migratedReplacement.address.toLowerCase() !== unsafe, 'Migration replacement must not reuse unsafe address');

  console.log('HD SWEEP SIGNER SMOKE PASS: unsafe addresses are disabled/replaced and generated addresses are sweepable by the derived HD signer.');
}

main().catch(error => {
  console.error(`HD SWEEP SIGNER SMOKE FAIL: ${error.message}`);
  process.exitCode = 1;
});
