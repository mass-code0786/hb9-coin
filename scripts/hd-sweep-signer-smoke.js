const assert = (condition, message) => { if (!condition) throw Error(message); };
const { HDNodeWallet, Interface, Transaction, parseUnits } = require('ethers');

const mnemonic = 'test test test test test test test test test test test junk';
const basePath = "m/44'/60'/0'/0";
process.env.HD_WALLET_MNEMONIC = mnemonic;
process.env.HD_WALLET_DERIVATION_PATH = basePath;
process.env.HD_WALLET_XPUB = HDNodeWallet.fromPhrase(mnemonic, '', basePath).neuter().extendedKey;
process.env.TREASURY_WALLET_BSC = '0x9999999999999999999999999999999999999999';
process.env.USDT_BEP20_CONTRACT = '0x55d398326f99059ff775485246999027b3197955';

const {
  depositPrivateSigner,
  depositSignerDiagnostics,
  ensureDepositAddress,
  hdWalletConsistencyStatus
} = require('../server');

async function main() {
  const db = { deposit_addresses: [], auditLogs: [] };
  const address = ensureDepositAddress(db, 'usr_1', 'BSC');
  const diagnostics = depositSignerDiagnostics(address).diagnostics;
  assert(hdWalletConsistencyStatus().configured, 'HD xpub and mnemonic must be consistent');
  assert(diagnostics.expectedDepositAddress === address.address, 'Expected deposit address must match generated address');
  assert(diagnostics.derivedSignerAddress === address.address, 'Derived signer address must match generated deposit address');
  assert(address.derivationPath === `${basePath}/0`, 'Generated deposit metadata must store the exact full derivation path');

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
  console.log('HD SWEEP SIGNER SMOKE PASS: generated deposit address is immediately sweepable by the derived HD signer.');
}

main().catch(error => {
  console.error(`HD SWEEP SIGNER SMOKE FAIL: ${error.message}`);
  process.exitCode = 1;
});
