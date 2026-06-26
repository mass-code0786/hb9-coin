try { require('dotenv').config(); } catch (_) {}
const { HDNodeWallet, getAddress } = require('ethers');

const DEFAULT_DERIVATION_PATH = "m/44'/60'/0'/0";
const mnemonic = process.env.HD_WALLET_MNEMONIC;
const derivationPath = process.env.HD_WALLET_DERIVATION_PATH || DEFAULT_DERIVATION_PATH;

if (!mnemonic) {
  console.error('HD_WALLET_MNEMONIC is not configured.');
  process.exit(1);
}

try {
  const node = HDNodeWallet.fromPhrase(mnemonic, '', derivationPath);
  const xprv = node.extendedKey;
  const xpub = node.neuter().extendedKey;
  const index0FromXprv = getAddress(HDNodeWallet.fromExtendedKey(xprv).deriveChild(0).address);
  const index0FromXpub = getAddress(HDNodeWallet.fromExtendedKey(xpub).deriveChild(0).address);
  const verified = index0FromXprv === index0FromXpub;

  console.log(`HD_WALLET_DERIVATION_PATH=${derivationPath}`);
  console.log(`HD_WALLET_XPUB=${xpub}`);
  console.log(`HD_WALLET_XPRV=${xprv}`);
  console.log(`INDEX_0_FROM_XPRV=${index0FromXprv}`);
  console.log(`INDEX_0_FROM_XPUB=${index0FromXpub}`);
  console.log(`INDEX_0_MATCH=${verified}`);

  if (!verified) {
    console.error('Verification failed: index 0 derived from XPRV does not match index 0 derived from XPUB.');
    process.exit(1);
  }
} catch (error) {
  console.error(`Unable to derive HD xprv/xpub: ${error.message}`);
  process.exit(1);
}
