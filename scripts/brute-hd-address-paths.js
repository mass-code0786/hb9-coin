try { require('dotenv').config(); } catch (_) {}
const { HDNodeWallet, getAddress } = require('ethers');

const TARGET_ADDRESS = getAddress(process.env.TARGET_ADDRESS || '0xeb513f05b51fbe4c4acedef60ae9ef1ee8f694c7a');
const mnemonic = process.env.HD_WALLET_MNEMONIC;
const maxIndex = Number(process.env.MAX_INDEX || 200);

const pathTemplates = [
  "m/44'/60'/0'/0/i",
  "m/44'/60'/0'/i",
  "m/44'/60'/0'/0/0/i",
  "m/44'/60'/1'/0/i",
  "m/44'/60'/0'/1/i"
];

if (!mnemonic) {
  console.error('HD_WALLET_MNEMONIC is not configured.');
  process.exit(1);
}
if (!Number.isInteger(maxIndex) || maxIndex < 0) {
  console.error('MAX_INDEX must be a non-negative integer.');
  process.exit(1);
}

const derive = fullPath => getAddress(HDNodeWallet.fromPhrase(mnemonic, '', fullPath).address);
const matches = [];
const previews = {};

console.log(`HD_BRUTE_DIAGNOSTIC_TARGET=${TARGET_ADDRESS}`);
console.log(`HD_BRUTE_DIAGNOSTIC_MAX_INDEX=${maxIndex}`);

for (const template of pathTemplates) {
  previews[template] = [];
  for (let index = 0; index <= maxIndex; index += 1) {
    const fullPath = template.replace(/i$/, String(index));
    try {
      const address = derive(fullPath);
      if (index < 5) previews[template].push({ index, path: fullPath, address });
      if (address === TARGET_ADDRESS) matches.push({ template, index, path: fullPath, address });
    } catch (error) {
      if (index < 5) previews[template].push({ index, path: fullPath, error: error.message });
      if (index === 0) console.warn(`Unable to derive template ${template}: ${error.message}`);
      break;
    }
  }
}

console.log('FIRST_5_ADDRESSES_BY_PATH');
console.log(JSON.stringify(previews, null, 2));

console.log('MATCHES');
console.log(JSON.stringify(matches, null, 2));

if (!matches.length) console.log('NO_MATCH_FOUND_IN_COMMON_EVM_PATHS_0_TO_200');
