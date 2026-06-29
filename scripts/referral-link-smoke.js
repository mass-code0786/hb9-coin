const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'latin1');

assert(appSource.includes('function referralLink'), 'frontend should expose a readable referral link helper');
assert(appSource.includes('function referralParam'), 'frontend should parse referral params through one helper');
assert(appSource.includes('link=referralLink(data.user.email)'), 'Profile referral link should use the readable helper');
assert(!appSource.includes('encodeURIComponent(data.user.email)'), 'Profile referral link must not percent-encode @');
assert(appSource.includes('navigator.clipboard.writeText(link)'), 'copy referral button should copy the same readable link');
assert(appSource.includes('const sponsorEmail=referralParam();'), 'registration should read sponsor email through referralParam');

const referralLinkSource = appSource.match(/function referralLink[^\n]+/)?.[0];
const referralParamSource = appSource.match(/function referralParam[^\n]+/)?.[0];
assert(referralLinkSource && referralParamSource, 'referral helpers should be extractable for regression checks');

const context = { URLSearchParams, result: null };
vm.createContext(context);
vm.runInContext(`${referralLinkSource}\n${referralParamSource}
result = {
  link: referralLink('sadiq@gmail.com', 'https://coin.hb9.live'),
  raw: referralParam('?ref=sadiq@gmail.com'),
  encoded: referralParam('?ref=sadiq%40gmail.com')
};`, context);

assert.strictEqual(context.result.link, 'https://coin.hb9.live/?ref=sadiq@gmail.com', 'generated referral link should keep @ visible');
assert(!context.result.link.includes('%40'), 'generated referral link should not contain %40');
assert.strictEqual(context.result.raw, 'sadiq@gmail.com', 'raw @ referral param should be accepted');
assert.strictEqual(context.result.encoded, 'sadiq@gmail.com', 'existing %40 referral param should remain accepted');

console.log('referral-link-smoke ok');
