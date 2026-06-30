const assert = require('assert');
process.env.MARKET_TEST_MODE = 'true';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  dailyB1Percent,
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
    settings: { globalActivityMin: 5, globalActivityMax: 15, dailyRoi: 2, directMultiplier: 2, fallbackPrice: null },
    hb9_market_settings: { fallbackPrice: null },
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
    let output = '';
    const onData = data => {
      const text = String(data);
      output += text;
      if (text.includes('HB9 Staking running')) {
        clearTimeout(timer);
        resolve(output);
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
  assert(types.includes('B1_DAILY_START'), 'B1 start log exists');
  assert(types.includes('B1_DAILY_COMPLETE'), 'B1 complete log exists');
  assert(types.includes('ROI_BACKFILL'), 'ROI backfill log exists');
  assert(types.includes('ROI_SKIP_DUPLICATE'), 'ROI duplicate log exists');

  const b1State = db();
  b1State.users.push({ id: 'usr_direct', name: 'Direct', email: 'direct@hb9.local', role: 'user', status: 'active', sponsorId: 'usr_user', createdAt: '2026-06-29T10:00:00.000Z' });
  b1State.stakes.push(
    { id: 'stk_sponsor_b1', userId: 'usr_user', stakeAsset: 'HB9', amount: 21, usdValueAtStake: 21, stakeUsdValue: 21, stakeAmount: 9.33, hb9EquivalentAmount: 9.33, status: 'active', startDate: '2026-06-29', createdAt: '2026-06-29T10:00:00.000Z' },
    { id: 'stk_direct_before_b1', userId: 'usr_direct', stakeAsset: 'HB9', amount: 42, usdValueAtStake: 42, stakeUsdValue: 42, stakeAmount: 18.66, hb9EquivalentAmount: 18.66, status: 'active', startDate: '2026-06-29', createdAt: '2026-06-29T17:59:00.000Z' }
  );
  const b1Today = await runRoiDaily(b1State, { now: new Date('2026-06-29T18:00:00.000Z'), fromDate: '2026-06-29', toDate: '2026-06-29' });
  assert.strictEqual(b1Today.createdDays, 2, 'daily B1 scheduler creates rows automatically without repair');
  const sponsorB1 = b1State.incomeLedger.find(row => row.userId === 'usr_user' && row.stakeId === 'stk_sponsor_b1' && row.date === '2026-06-29');
  assert(sponsorB1, 'automatic scheduler creates sponsor B1 row');
  assert.strictEqual(sponsorB1.totalDirectBusinessUsd, 42, 'direct business before scheduler cutoff is included');
  assert.strictEqual(sponsorB1.qualifiedStakeUsd, 21, 'direct business fully qualifies sponsor stake');
  assert(sponsorB1.paidB1Usd > 0, 'automatic scheduler pays B1 when qualified');
  assert.strictEqual(sponsorB1.dailyB1Percent, dailyB1Percent('2026-06-29'), 'scheduler uses dynamic B1 percent');
  assert(b1State.auditLogs.some(row => row.type === 'B1_CALCULATION_TRACE' && row.details.stakeId === 'stk_sponsor_b1'), 'automatic scheduler writes B1 trace');
  const duplicateB1 = await runRoiDaily(b1State, { now: new Date('2026-06-29T18:30:00.000Z'), fromDate: '2026-06-29', toDate: '2026-06-29' });
  assert.strictEqual(duplicateB1.createdDays, 0, 'rerun same B1 day does not duplicate');
  assert.strictEqual(b1State.incomeLedger.filter(row => row.userId === 'usr_user' && row.stakeId === 'stk_sponsor_b1' && row.date === '2026-06-29').length, 1, 'same-day B1 row remains unique');
  const b1Next = await runRoiDaily(b1State, { now: new Date('2026-06-30T18:00:00.000Z'), fromDate: '2026-06-30', toDate: '2026-06-30' });
  assert.strictEqual(b1Next.createdDays, 2, 'next day creates new automatic B1 rows');
  const nextSponsorB1 = b1State.incomeLedger.find(row => row.userId === 'usr_user' && row.stakeId === 'stk_sponsor_b1' && row.date === '2026-06-30');
  assert(nextSponsorB1, 'next-day B1 row exists');
  assert.strictEqual(nextSponsorB1.dailyB1Percent, dailyB1Percent('2026-06-30'), 'next-day row uses that day dynamic percent');
  assert.notStrictEqual(nextSponsorB1.incomeKey, sponsorB1.incomeKey, 'next-day B1 row has a distinct duplicate key');

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
    const startupOutput = await waitForServer(child);
    assert(startupOutput.includes('B1_SCHEDULER_ACTIVE'), 'startup logs active B1 scheduler');
    assert(startupOutput.includes('SALARY_SCHEDULER_ACTIVE'), 'startup logs active salary scheduler');
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
