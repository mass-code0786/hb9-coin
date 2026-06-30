const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'latin1');
const themeSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'hb9-purple-theme.css'), 'utf8');
const oldSuccessCopy = ['Account created', 'Sign in to continue.'].join('. ');

assert(!appSource.includes(oldSuccessCopy), 'old registration success copy must be removed');
assert(appSource.includes('function renderRegistrationSuccess'), 'registration should render a dedicated success screen');
assert(appSource.includes('renderRegistrationSuccess()'), 'successful register call should switch to the success screen');
assert(!appSource.includes('id="rwallet"'), 'registration form should not render a BEP20 wallet field');
assert(!appSource.includes("document.querySelector('#rwallet')"), 'registration should not read a BEP20 wallet field');
assert(!appSource.includes('walletAddress:wallet'), 'registration request should not send walletAddress');
assert(!appSource.includes('42-character BEP20 wallet address'), 'registration should not validate a BEP20 wallet address');
assert(appSource.includes('function storeAuthSession'), 'registration should reuse normal auth token storage');
assert(appSource.includes('storeAuthSession(x);renderRegistrationSuccess()'), 'successful registration should store token before success screen');
assert(appSource.includes('Congratulations!'), 'success screen should include the required title');
assert(appSource.includes('Your HB9 account has been created successfully.'), 'success screen should include the required lead copy');
assert(
  appSource.includes('Redirecting you to your dashboard...'),
  'success screen should show redirecting copy'
);
assert(appSource.includes('data-auth-success-login'), 'success screen should expose a single sign-in action');
assert(appSource.includes('Continue to Dashboard'), 'success screen should expose a continue fallback button');
assert(appSource.includes('setTimeout(()=>load(),1400)'), 'success screen should auto-load dashboard after a short delay');
assert(appSource.includes('Account created successfully. Please sign in to continue.'), 'auto-login failure should show sign-in fallback copy');
assert(appSource.includes("renderRegistrationSuccess({autoLogin:false})"), 'auto-login failure should render fallback success state');

const successStart = appSource.indexOf('function renderRegistrationSuccess');
const successEnd = appSource.indexOf('register=async function', successStart);
assert(successStart >= 0 && successEnd > successStart, 'success renderer should be defined before the register override');
const successRenderer = appSource.slice(successStart, successEnd);
for (const forbidden of ['register-form', 'rname', 'remail', 'rwallet', 'rpass', 'rconfirm', 'rterms']) {
  assert(!successRenderer.includes(forbidden), `success screen should not render registration field ${forbidden}`);
}

assert(themeSource.includes('.auth-premium[data-auth-mode="success"] .auth-card'), 'success screen should have card sizing styles');
assert(themeSource.includes('.auth-success'), 'success screen should have centered layout styles');
assert(themeSource.includes('.auth-success-icon'), 'success screen should have a celebration/check icon style');
assert(themeSource.includes('.auth-success-signin'), 'success screen should style the primary sign-in button');
assert(themeSource.includes('@media(max-width:430px)'), 'success screen should be covered by mobile responsive rules');
assert(themeSource.includes('min-height:calc(100vh - 96px)'), 'mobile success screen should remain vertically centered');

console.log('register-success-smoke ok');
