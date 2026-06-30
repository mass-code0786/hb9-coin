const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'latin1');

assert(appSource.includes('function referralLink'), 'frontend should expose a readable referral link helper');
assert(appSource.includes('function referralParam'), 'frontend should parse referral params through one helper');
assert(appSource.includes('function storeReferralCode'), 'frontend should persist referral code locally');
assert(appSource.includes('function currentReferralCode'), 'frontend should resolve stored referral code for registration');
assert(appSource.includes("localStorage.setItem('referralCode',value)"), 'referral code should use non-auth localStorage key');
assert(appSource.includes('if(urlReferral)storeReferralCode(urlReferral)'), 'boot should store referral from URL');
assert(appSource.includes("auth(urlReferral?'register':authMode)"), 'referral URL should open registration by default');
assert(appSource.includes("if(token)load();else auth()"), 'normal no-ref boot should still open login by default');
assert(appSource.includes("auth(referralParam()?'register':'login')"), 'bfcache refresh should preserve referral registration mode');
assert(appSource.includes('function referralMessage'), 'frontend should build one full referral share message');
assert(appSource.includes('function referralShareUrls'), 'frontend should build WhatsApp and Telegram share URLs');
assert(appSource.includes('function openReferralShare'), 'frontend should expose referral share modal behavior');
assert(appSource.includes('link=referralLink(data.user.email)'), 'Profile referral link should use the readable helper');
assert(!appSource.includes('encodeURIComponent(data.user.email)'), 'Profile referral link must not percent-encode @');
assert(appSource.includes('copyReferralMessage(link)'), 'copy referral button should copy the full share message');
assert(appSource.includes('id="share-referral"'), 'Profile referral card should include a Share button');
assert(appSource.includes('WhatsApp') && appSource.includes('Telegram'), 'share modal should include WhatsApp and Telegram options');
assert(appSource.includes('const sponsorEmail=currentReferralCode();'), 'registration should prefill sponsor from stored/current referral code');
assert(appSource.includes('sponsorInput=document.querySelector'), 'registration should distinguish visible sponsor field from hidden/internal sponsor');
assert(appSource.includes('sponsorEmail=storeReferralCode(sponsorInput?sponsorInput.value.trim():currentReferralCode())'), 'registration should submit sponsor internally and allow user removal');
assert(appSource.includes('clearReferralCode();renderRegistrationSuccess()'), 'successful registration should clear stored referral and show success screen');

const referralLinkSource = appSource.match(/function referralLink[^\n]+/)?.[0];
const referralParamSource = appSource.match(/function referralParam[^\n]+/)?.[0];
const referralStorageSource = appSource.match(/function referralStorage[^\n]+/)?.[0];
const storeReferralCodeSource = appSource.match(/function storeReferralCode[^\n]+/)?.[0];
const captureReferralCodeSource = appSource.match(/function captureReferralCode[^\n]+/)?.[0];
const currentReferralCodeSource = appSource.match(/function currentReferralCode[^\n]+/)?.[0];
const clearReferralCodeSource = appSource.match(/function clearReferralCode[^\n]+/)?.[0];
const referralMessageSource = appSource.match(/function referralMessage[^\n]+/)?.[0];
const referralShareUrlsSource = appSource.match(/function referralShareUrls[^\n]+/)?.[0];
assert(
  referralLinkSource && referralParamSource && referralStorageSource && storeReferralCodeSource &&
  captureReferralCodeSource && currentReferralCodeSource && clearReferralCodeSource && referralMessageSource && referralShareUrlsSource,
  'referral helpers should be extractable for regression checks'
);

const store = new Map();
const context = {
  URLSearchParams,
  location: { search: '?ref=sadiq@gmail.com' },
  localStorage: {
    getItem: key => store.get(key) || null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
  },
  result: null
};
vm.createContext(context);
vm.runInContext(`${referralLinkSource}\n${referralParamSource}\n${referralStorageSource}\n${storeReferralCodeSource}\n${captureReferralCodeSource}\n${currentReferralCodeSource}\n${clearReferralCodeSource}\n${referralMessageSource}\n${referralShareUrlsSource}
const link = referralLink('sadiq@gmail.com', 'https://coin.hb9.live');
const message = referralMessage(link);
const urls = referralShareUrls(link);
const captured = captureReferralCode('?ref=sadiq@gmail.com');
location.search = '';
const refreshKept = currentReferralCode();
clearReferralCode();
const cleared = currentReferralCode();
result = {
  link,
  message,
  whatsapp: urls.whatsapp,
  telegram: urls.telegram,
  captured,
  refreshKept,
  cleared,
  raw: referralParam('?ref=sadiq@gmail.com'),
  encoded: referralParam('?ref=sadiq%40gmail.com')
};`, context);

assert.strictEqual(context.result.link, 'https://coin.hb9.live/?ref=sadiq@gmail.com', 'generated referral link should keep @ visible');
assert(!context.result.link.includes('%40'), 'generated referral link should not contain %40');
assert(context.result.message.includes('Join HB9 Coin Ecosystem'), 'share message should include company/project message');
assert(context.result.message.includes('Use my referral link:\nhttps://coin.hb9.live/?ref=sadiq@gmail.com'), 'share message should include readable referral link');
assert.strictEqual(context.result.whatsapp, `https://wa.me/?text=${encodeURIComponent(context.result.message)}`, 'WhatsApp URL should encode the full share message');
assert.strictEqual(context.result.telegram, `https://t.me/share/url?url=${encodeURIComponent(context.result.link)}&text=${encodeURIComponent(context.result.message)}`, 'Telegram URL should include encoded link and message');
assert.strictEqual(context.result.captured, 'sadiq@gmail.com', 'referral link should store raw @ referral code');
assert.strictEqual(context.result.refreshKept, 'sadiq@gmail.com', 'refresh should keep referral code in local state');
assert.strictEqual(context.result.cleared, '', 'successful registration or user removal should clear referral code');
assert.strictEqual(context.result.raw, 'sadiq@gmail.com', 'raw @ referral param should be accepted');
assert.strictEqual(context.result.encoded, 'sadiq@gmail.com', 'existing %40 referral param should remain accepted');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert(indexSource.includes('<meta property="og:title" content="HB9 Coin Ecosystem">'), 'Open Graph title should exist');
assert(indexSource.includes('<meta property="og:description" content="Join HB9 Coin Ecosystem and start your crypto earning journey.">'), 'Open Graph description should exist');
assert(indexSource.includes('<meta property="og:image" content="https://coin.hb9.live/assets/hb9-og.svg">'), 'Open Graph image should use public banner URL');
assert(indexSource.includes('<meta property="og:url" content="https://coin.hb9.live">'), 'Open Graph URL should exist');
assert(indexSource.includes('<meta name="twitter:card" content="summary_large_image">'), 'Twitter large card meta should exist');
assert(fs.existsSync(path.join(__dirname, '..', 'public', 'assets', 'hb9-og.svg')), 'Open Graph image asset should exist');
assert(cssSource.includes('.referral-share-modal') && cssSource.includes('@media(max-width:600px)'), 'share modal should include mobile bottom-sheet styling');
assert(serverSource.includes("String(sponsorEmail||'').trim().toLowerCase()"), 'backend should normalize submitted sponsor code');
assert(serverSource.includes("String(x.email||'').toLowerCase()===sponsorCode"), 'backend should attach sponsor case-insensitively');

console.log('referral-link-smoke ok');
