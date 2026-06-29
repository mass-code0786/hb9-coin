const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'latin1');
const themeSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'hb9-purple-theme.css'), 'utf8');
const oldSuccessCopy = ['Account created', 'Sign in to continue.'].join('. ');

assert(!appSource.includes(oldSuccessCopy), 'old registration success copy must be removed');
assert(appSource.includes('function renderRegistrationSuccess'), 'registration should render a dedicated success screen');
assert(appSource.includes('renderRegistrationSuccess()'), 'successful register call should switch to the success screen');
assert(appSource.includes('Congratulations!'), 'success screen should include the required title');
assert(appSource.includes('Your HB9 account has been created successfully.'), 'success screen should include the required lead copy');
assert(
  appSource.includes('Your registration has been completed successfully. You can now sign in to access your dashboard and start using the HB9 ecosystem.'),
  'success screen should include the required body copy'
);
assert(appSource.includes('data-auth-success-login'), 'success screen should expose a single sign-in action');
assert(appSource.includes("auth('login')"), 'success sign-in action should switch immediately to login');

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
