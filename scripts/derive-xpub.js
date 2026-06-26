const fs = require('fs');
const path = require('path');
const { HDNodeWallet } = require('ethers');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).reduce((values, line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trimStart().startsWith('#')) return values;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
    return values;
  }, {});
}

try {
  const fileEnv = loadEnvFile(path.join(__dirname, '..', '.env'));
  const mnemonic = process.env.HD_WALLET_MNEMONIC || fileEnv.HD_WALLET_MNEMONIC;
  const derivationPath = process.env.HD_WALLET_DERIVATION_PATH || fileEnv.HD_WALLET_DERIVATION_PATH || "m/44'/60'/0'/0";
  if (!mnemonic) throw Error('HD_WALLET_MNEMONIC is not configured');
  const xpub = HDNodeWallet.fromPhrase(mnemonic, '', derivationPath).neuter().extendedKey;
  console.log(`HD_WALLET_XPUB=${xpub}`);
} catch (error) {
  console.error(`Unable to derive HD wallet xpub: ${error.message}`);
  process.exitCode = 1;
}
