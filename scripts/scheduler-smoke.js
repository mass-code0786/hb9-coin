const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  runGlobalTeamDaily,
  runRoiDaily,
  lastDueDate,
  nextDueTime,
  server
} = require('../server');

const datePlus = (date, days) => { const d = new Date(`${date}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

function db() {
  const createdAt = '2026-06-25T00:00:00.000Z';
  return {
    users: [
      { id: 'usr_admin', name: 'Admin', email: 'admin@hb9.local', role: 'admin', status: 'active', createdAt },
      { id: 'usr_user', name: 'User', email: 'user@hb9.local', role: 'user', status: 'active', createdAt }
    ],
    settings: { globalActivityMin: 5, globalActivityMax: 15, dailyRoi: 2, directMultiplier: 2, fallbackPrice: 0.2 },
    hb9_market_settings: { fallbackPrice: 0.2 },
    directBusiness: [],
    deposits: [],
    stakes: [],
    globalTeamRecords: [],
    flushRecords: [],
    incomeLedger: [],
    reserve_wallets: [],
    reserve_ledger: [],
    burn_ledger: [],
    wallet_ledger: [],
    exchange_orders: [],
    income_emissions: [],
    level_income_ledger: [],
    referralLedger: [],
    salary_ranks: [],
    salary_qualifications: [],
    salary_payouts: [],
    auditLogs: []
  };
}

function request(port, requestPath, { method = 'GET', body = null, token = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ port, path: requestPath, method, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, res => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        let json = null;
        try { json = responseBody ? JSON.parse(responseBody) : null; } catch (_) {}
        resolve({ status: res.statusCode, body: responseBody, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 12000);
    const onData = data => {
      const text = String(data);
      if (text.includes('HB9 Staking running')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', data => {
      const text = String(data);
      if (/EADDRINUSE|SyntaxError|TypeError/.test(text)) {
        clearTimeout(timer);
        reject(new Error(text));
      }
    });
    child.on('exit', code => {
      if (code) {
        clearTimeout(timer);
        reject(new Error(`server exited with ${code}`));
      }
    });
  });
}

(async () => {
  assert.strictEqual(lastDueDate(new Date('2026-06-28T17:29:59.000Z'), 17, 30), '2026-06-27');
  assert.strictEqual(lastDueDate(new Date('2026-06-28T17:30:00.000Z'), 17, 30), '2026-06-28');
  assert.strictEqual(nextDueTime(new Date('2026-06-28T17:30:00.000Z'), 17, 30).toISOString(), '2026-06-29T17:30:00.000Z');

  const state = db();
  const now = new Date('2026-06-28T18:30:00.000Z');
  let global = await runGlobalTeamDaily(state, { now, backfill: true });
  assert.strictEqual(global.createdDays, 4, 'startup backfills missed Global Team days once');
  assert.strictEqual(state.globalTeamRecords.length, 4, 'one Global Team record per day');
  global = await runGlobalTeamDaily(state, { now, fromDate: '2026-06-28', toDate: '2026-06-28' });
  assert.strictEqual(global.createdDays, 0, 'Global Team does not duplicate same dates');
  assert.strictEqual(state.globalTeamRecords.length, 4, 'duplicate Global Team run creates no records');

  let roi = await runRoiDaily(state, { now, backfill: true });
  assert.strictEqual(roi.createdDays, 4, 'startup backfills missed ROI days once');
  assert.strictEqual(state.flushRecords.length, 4, 'one ROI/flush record per day');
  roi = await runRoiDaily(state, { now, fromDate: '2026-06-28', toDate: '2026-06-28' });
  assert.strictEqual(roi.createdDays, 0, 'ROI does not duplicate same dates');
  assert.strictEqual(state.flushRecords.length, 4, 'duplicate ROI run creates no records');

  const types = state.auditLogs.map(x => x.type);
  assert(types.includes('GLOBAL_TEAM_DAILY_START'), 'Global Team start log exists');
  assert(types.includes('GLOBAL_TEAM_DAILY_COMPLETE'), 'Global Team complete log exists');
  assert(types.includes('GLOBAL_TEAM_BACKFILL'), 'Global Team backfill log exists');
  assert(types.includes('GLOBAL_TEAM_SKIP_DUPLICATE'), 'Global Team duplicate log exists');
  assert(types.includes('ROI_DAILY_START'), 'ROI start log exists');
  assert(types.includes('ROI_DAILY_COMPLETE'), 'ROI complete log exists');
  assert(types.includes('ROI_BACKFILL'), 'ROI backfill log exists');
  assert(types.includes('ROI_SKIP_DUPLICATE'), 'ROI duplicate log exists');

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const adminPage = await request(port, '/admin');
  const missingPage = await request(port, '/missing-route');
  await new Promise(resolve => server.close(resolve));
  assert.strictEqual(adminPage.status, 200, '/admin serves SPA');
  assert(adminPage.body.includes('public/app.js') || adminPage.body.includes('app.js'), '/admin returns index.html');
  assert.strictEqual(missingPage.status, 404, 'unknown static route remains 404');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb9-scheduler-'));
  const dataFile = path.join(tempDir, 'db.json');
  const childPort = 3600 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(childPort),
      DATA_FILE: dataFile,
      NODE_ENV: 'production',
      BOOTSTRAP_ADMIN_EMAIL: 'admin-scheduler@hb9.local',
      BOOTSTRAP_ADMIN_PASSWORD: 'Admin@123456',
      BOOTSTRAP_ADMIN_NAME: 'Scheduler Admin',
      MARKET_TEST_MODE: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitForServer(child);
    const route = await request(childPort, '/admin');
    assert.strictEqual(route.status, 200, 'child /admin route works');
    const adminLogin = await request(childPort, '/api/auth/login', { method: 'POST', body: { email: 'admin-scheduler@hb9.local', password: 'Admin@123456' } });
    assert.strictEqual(adminLogin.status, 200, 'admin can log in');
    const adminOverview = await request(childPort, '/api/admin/overview', { token: adminLogin.json.token });
    assert.strictEqual(adminOverview.status, 200, 'admin is allowed through /api/admin guard');
    const register = await request(childPort, '/api/auth/register', { method: 'POST', body: { name: 'Plain User', email: 'plain-user@hb9.local', password: 'User@123456', walletAddress: '0x1111111111111111111111111111111111111111' } });
    assert.strictEqual(register.status, 201, 'non-admin test user registered');
    const userLogin = await request(childPort, '/api/auth/login', { method: 'POST', body: { email: 'plain-user@hb9.local', password: 'User@123456' } });
    assert.strictEqual(userLogin.status, 200, 'non-admin can log in');
    const denied = await request(childPort, '/api/admin/overview', { token: userLogin.json.token });
    assert.strictEqual(denied.status, 403, 'non-admin is blocked from /api/admin');
  } finally {
    child.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('SCHEDULER SMOKE PASS: UTC schedule gates, backfill, idempotency, logs, and /admin SPA route verified.');
})().catch(error => {
  try { server.close(); } catch (_) {}
  console.error(error);
  process.exit(1);
});
