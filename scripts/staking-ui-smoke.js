const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const mobileCss = fs.readFileSync(path.join(root, 'public', 'hb9-purple-theme.css'), 'utf8');

const stakingRenderers = [
  ...app.matchAll(/^.*(?:pages\['My Staking'\]=function\(\)|'My Staking'\(\)).*$/gm)
].map(match => match[0]);

assert(stakingRenderers.length >= 1, 'user My Staking renderer must exist');

for (const renderer of stakingRenderers) {
  for (const label of ['Stake Date', 'Status', 'Stake Asset', 'Stake Amount', 'HB9 Equivalent']) {
    assert(renderer.includes(`'${label}'`), `user My Staking table must include ${label}`);
  }
  assert(!renderer.includes("'B1 %'"), 'user My Staking table must not include B1 % column');
  assert(!renderer.includes("'Rule'"), 'user My Staking table must not include Rule column');
  assert(!renderer.includes("'No Unstake'"), 'user My Staking table must not include No Unstake text');
  assert(/badge\(status/.test(renderer), 'user My Staking table must still render stake status badges');
}

assert(/adminTab==='Stakes'[\s\S]*Daily B1/.test(app), 'admin stakes report should remain unchanged');
assert(/\.hb9-purple-theme \.tablewrap,[\s\S]*overflow:\s*auto\s*!important/.test(mobileCss), 'mobile tables must remain horizontally safe if content needs it');

console.log('staking-ui-smoke ok');
