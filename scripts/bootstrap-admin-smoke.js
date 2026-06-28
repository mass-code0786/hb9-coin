const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const hash = (password, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') });

function request(port, requestPath, { method = 'GET', body = null, token = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      port,
      path: requestPath,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) {}
        resolve({ status: res.statusCode, raw, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`server did not become ready\n${output}`)), 12000);
    const onData = data => {
      output += String(data);
      if (output.includes('ADMIN_BOOTSTRAP_READY') && output.includes('HB9 Staking running')) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => {
      if (code) {
        clearTimeout(timer);
        reject(new Error(`server exited with ${code}\n${output}`));
      }
    });
  });
}

async function readJsonWhenStable(file) {
  let lastError;
  for (let i = 0; i < 30; i++) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb9-bootstrap-'));
  const dataFile = path.join(tempDir, 'db.json');
  const port = 4700 + Math.floor(Math.random() * 1000);
  const old = hash('OldPassword@123');
  const now = new Date().toISOString();
  fs.writeFileSync(dataFile, JSON.stringify({
    appUrl: 'https://coin.hb9.live',
    users: [{
      id: 'usr_existing',
      name: 'Existing User',
      email: 'bootstrap-admin@hb9.local',
      role: 'user',
      status: 'blocked',
      blocked: true,
      passwordHash: old.hash,
      salt: old.salt,
      walletAddress: null,
      createdAt: now
    }],
    deposits: [],
    conversions: [],
    stakes: [],
    directBusiness: [],
    incomeLedger: [],
    referralLedger: [],
    level_income_ledger: [],
    salary_ranks: [],
    salary_qualifications: [],
    salary_payouts: [],
    globalTeamRecords: [],
    flushRecords: [],
    withdrawals: [],
    transfers: [],
    transferLedger: [],
    directBusinessAudit: [],
    dailyRuns: [],
    salaryRuns: [],
    deposit_addresses: [],
    blockchain_transactions: [],
    sweep_transactions: [],
    auditLogs: [],
    reserve_ledger: [],
    burn_ledger: [],
    wallet_ledger: [],
    exchange_orders: [],
    income_emissions: [],
    reserve_wallets: [
      { id: 'res_hb9_exchange', asset: 'HB9', walletType: 'exchange', balance: 0, lockedBalance: 0, createdAt: now, updatedAt: now },
      { id: 'res_hb9_income', asset: 'HB9', walletType: 'income', balance: 0, lockedBalance: 0, createdAt: now, updatedAt: now },
      { id: 'res_usdt', asset: 'USDT', walletType: 'treasury', balance: 0, lockedBalance: 0, createdAt: now, updatedAt: now }
    ],
    hb9_supply: { asset: 'HB9', totalSupply: 1000000, fixed: true, createdAt: now },
    hb9_market_settings: { fallbackPrice: 0.2, priceOffset: 0.09, spreadPercent: 5, manualOverrideEnabled: false, updatedBy: 'system', updatedAt: now },
    hb9_price_history: [],
    settings: { dailyRoi: 2, directMultiplier: 2, referralPercent: 10, globalActivityMin: 5, globalActivityMax: 15, globalPointValue: 0.02, hb9Price: 0.2, fallbackPrice: 0.2, priceOffset: 0.09, spreadPercent: 5, minWithdrawal: 20, withdrawalFeePercent: 5 }
  }, null, 2));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: dataFile,
      NODE_ENV: 'production',
      BOOTSTRAP_ADMIN_EMAIL: 'bootstrap-admin@hb9.local',
      BOOTSTRAP_ADMIN_PASSWORD: 'NewAdmin@123456',
      BOOTSTRAP_ADMIN_NAME: 'Bootstrap Admin',
      MARKET_TEST_MODE: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    const output = await waitForReady(child);
    assert(output.includes('ADMIN_BOOTSTRAP_READY'), 'startup must log ADMIN_BOOTSTRAP_READY');
    assert(!output.includes('NewAdmin@123456'), 'startup log must not print password');

    const db = await readJsonWhenStable(dataFile);
    const matching = db.users.filter(user => String(user.email).toLowerCase() === 'bootstrap-admin@hb9.local');
    assert.strictEqual(matching.length, 1, 'bootstrap must not create duplicate admin users');
    assert.strictEqual(matching[0].id, 'usr_existing', 'bootstrap must reuse existing user');
    assert.strictEqual(matching[0].role, 'admin', 'existing user becomes admin');
    assert.strictEqual(matching[0].status, 'active', 'existing user becomes active');
    assert.strictEqual(matching[0].blocked, false, 'existing user is unblocked');

    const oldLogin = await request(port, '/api/auth/login', { method: 'POST', body: { email: 'bootstrap-admin@hb9.local', password: 'OldPassword@123' } });
    assert.strictEqual(oldLogin.status, 401, 'old password should no longer work');
    const login = await request(port, '/api/auth/login', { method: 'POST', body: { email: 'bootstrap-admin@hb9.local', password: 'NewAdmin@123456' } });
    assert.strictEqual(login.status, 200, 'bootstrapped admin can login with BOOTSTRAP_ADMIN_PASSWORD');
    assert.strictEqual(login.json.user.role, 'admin', 'login returns admin role');
    const overview = await request(port, '/api/admin/overview', { token: login.json.token });
    assert.strictEqual(overview.status, 200, 'bootstrapped admin can access admin API');
  } finally {
    child.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('BOOTSTRAP ADMIN SMOKE PASS: existing user promoted, activated, unblocked, password updated, no duplicate, login verified.');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
