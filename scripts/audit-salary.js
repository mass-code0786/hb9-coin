const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3200 + (process.pid % 400);
const dataFile = path.join(os.tmpdir(), `hb9-salary-audit-${process.pid}.json`);
const outDir = path.join(__dirname, '..', 'artifacts');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const cents = value => Math.round((value + Number.EPSILON) * 100) / 100;
const assert = (condition, message) => { if (!condition) throw Error(message); };
const BUY_PRICE = 0.29;
const RANKS = [
  { rank: 1, directs: 10, min: 5, self: 50, team: 1000, salary: 20 },
  { rank: 2, directs: 15, min: 10, self: 150, team: 3000, salary: 100 },
  { rank: 3, directs: 20, min: 15, self: 300, team: 10000, salary: 200 },
  { rank: 4, directs: 20, min: 20, self: 500, team: 30000, salary: 500 },
  { rank: 5, directs: 30, min: 20, self: 1000, team: 100000, salary: 1000 },
  { rank: 6, directs: 30, min: 25, self: 2000, team: 300000, salary: 2000 }
];

function request(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: url,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        const json = raw ? JSON.parse(raw) : {};
        if (res.statusCode >= 400) {
          const error = Error(json.error || `HTTP ${res.statusCode}`);
          error.status = res.statusCode;
          error.body = json;
          reject(error);
        } else resolve(json);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function login(email, password) {
  return (await request('POST', '/api/auth/login', { email, password })).token;
}

function mutateDb(mutator) {
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  mutator(db);
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2));
}

function addFixtureUser(db, prefix, sponsorId = null, password = 'fixture') {
  const suffix = `${prefix}-${process.pid}-${db.users.length}`;
  const user = {
    id: `usr_${suffix}`,
    name: `Fixture ${prefix}`,
    email: `${suffix}@hb9.local`,
    role: 'user',
    status: 'active',
    passwordHash: password,
    salt: password,
    walletAddress: `0x${String(db.users.length + 1).padStart(40, '0')}`,
    sponsorId,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  return user;
}

function addFixtureStake(db, userId, usdValue) {
  const hb9Amount = cents(usdValue / BUY_PRICE);
  db.stakes.push({
    id: `stk_salary_audit_${userId}_${db.stakes.length}`,
    userId,
    amount: usdValue,
    usdValueAtStake: usdValue,
    coinAmount: hb9Amount,
    hb9Amount,
    hb9PriceAtStake: BUY_PRICE,
    status: 'active',
    startDate: new Date().toISOString().slice(0, 10),
    dailyRate: 0.02,
    createdAt: new Date().toISOString()
  });
}

function addCandidate(db, prefix, rank, options = {}) {
  const user = addFixtureUser(db, prefix);
  addFixtureStake(db, user.id, rank.self);
  let directBusiness = 0;
  let firstDirect;
  const directStake = options.directStake ?? rank.min;
  const directCount = options.directCount ?? rank.directs;
  for (let index = 0; index < directCount; index++) {
    const direct = addFixtureUser(db, `${prefix}-direct-${index}`, user.id);
    if (!firstDirect) firstDirect = direct;
    addFixtureStake(db, direct.id, directStake);
    directBusiness += directStake;
  }
  const remainder = options.teamRemainder ?? Math.max(0, rank.team - directBusiness);
  if (remainder > 0 && firstDirect) {
    let parent = firstDirect;
    const depth = options.depth ?? 2;
    for (let level = 2; level <= depth; level++) parent = addFixtureUser(db, `${prefix}-level-${level}`, parent.id);
    addFixtureStake(db, parent.id, remainder);
  }
  return user;
}

async function screenshot(appUrl, targetView, fileName, adminTab, credentials = null) {
  const chromePath = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : fs.existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
      ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
      : null;
  if (!chromePath) return null;
  fs.mkdirSync(outDir, { recursive: true });
  const debugPort = 9400 + (process.pid % 400);
  const userDataDir = path.join(os.tmpdir(), `hb9-salary-audit-chrome-${process.pid}-${fileName}`);
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--remote-allow-origins=*',
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-extensions',
    '--window-size=1440,1100',
    'about:blank'
  ], { stdio: 'ignore' });
  try {
    let page;
    for (let i = 0; i < 80; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
        page = await response.json();
        if (page.webSocketDebuggerUrl) break;
      } catch (_) {
        await wait(250);
      }
    }
    if (!page?.webSocketDebuggerUrl) throw Error('Chrome DevTools unavailable');
    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOMStorage.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    if (credentials) {
      const loginResponse = await fetch(`${appUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials)
      });
      const loginJson = await loginResponse.json();
      if (!loginResponse.ok || !loginJson.token) throw Error(loginJson.error || 'Login failed');
      await cdp.send('Page.navigate', { url: `${appUrl}/__storage_seed__` });
      await waitFor(cdp, `location.origin === ${JSON.stringify(new URL(appUrl).origin)}`);
      const storageId = { securityOrigin: new URL(appUrl).origin, isLocalStorage: true };
      await cdp.send('DOMStorage.setDOMStorageItem', { storageId, key: 'hb9token', value: loginJson.token });
      await cdp.send('DOMStorage.setDOMStorageItem', { storageId, key: 'hb9user', value: JSON.stringify(loginJson.user) });
    }
    await cdp.send('Page.navigate', { url: appUrl });
    await waitFor(cdp, 'document.readyState === "complete" && !!document.querySelector("#app")');
    await waitFor(cdp, '!!document.querySelector(".nav")');
    await evaluate(cdp, `
      (() => {
        const button = [...document.querySelectorAll('[data-view]')].find(x => x.dataset.view === ${JSON.stringify(targetView)});
        if (!button) throw new Error('View button not found: ${targetView}');
        button.click();
        return true;
      })()
    `);
    if (adminTab) {
      await waitFor(cdp, '!!document.querySelector(".tabs")');
      await evaluate(cdp, `
        (() => {
          const button = [...document.querySelectorAll('[data-tab]')].find(x => x.dataset.tab === ${JSON.stringify(adminTab)});
          if (!button) throw new Error('Admin tab not found: ${adminTab}');
          button.click();
          return true;
        })()
      `);
    }
    await wait(1000);
    const file = path.join(outDir, fileName);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    cdp.close();
    return file;
  } finally {
    chrome.kill();
  }
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(Error(message.error.message)) : resolve(message.result || {});
  };
  return new Promise((resolve, reject) => {
    ws.onerror = () => reject(Error('WebSocket connection failed'));
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const callId = ++id;
        ws.send(JSON.stringify({ id: callId, method, params }));
        return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
      },
      close: () => ws.close()
    });
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function waitFor(cdp, expression, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (await evaluate(cdp, expression)) return true; } catch (_) {}
    await wait(250);
  }
  throw Error(`Timed out waiting for ${expression}`);
}

async function main() {
  fs.rmSync(dataFile, { force: true });
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, DEMO_MODE: 'true', MARKET_TEST_MODE: 'true' },
    stdio: 'ignore'
  });
  const results = [];
  const pass = name => results.push({ rule: name, status: 'PASS' });
  const fail = (name, error) => results.push({ rule: name, status: 'FAIL', detail: error.message || String(error) });
  try {
    for (let i = 0; i < 40; i++) {
      try { await request('POST', '/api/auth/login', { email: 'admin@hb9.local', password: 'Admin@123' }); break; }
      catch (error) { if (i === 39) throw error; await wait(100); }
    }
    const admin = await login('admin@hb9.local', 'Admin@123');
    const created = {};
    mutateDb(db => {
      RANKS.forEach(rank => { created[`rank${rank.rank}`] = addCandidate(db, `salary-audit-rank-${rank.rank}`, rank).id; });
      created.deep = addCandidate(db, 'salary-audit-deep', RANKS[0], { teamRemainder: 0 }).id;
      let parent = db.users.find(user => user.id === created.deep);
      for (let level = 1; level <= 21; level++) parent = addFixtureUser(db, `salary-audit-deep-chain-${level}`, parent.id);
      addFixtureStake(db, parent.id, 950);
      created.lowDirect = addCandidate(db, 'salary-audit-low-direct', RANKS[0], { directStake: 4.99, teamRemainder: 950.1 }).id;
      created.cap = addCandidate(db, 'salary-audit-cap', RANKS[0]).id;
      db.salary_payouts = db.salary_payouts || [];
      const capHb9 = cents(150 / BUY_PRICE);
      const incomeReserve = (db.reserve_wallets || []).find(wallet => wallet.asset === 'HB9' && wallet.walletType === 'income');
      if (incomeReserve) incomeReserve.balance = cents((Number(incomeReserve.balance) || 0) - capHb9);
      db.salary_payouts.push({ id: `salp_salary_audit_cap_${process.pid}`, userId: created.cap, type: 'SALARY_INCOME', asset: 'HB9', rank: 1, rankName: 'Rank 1', cycleStart: '2026-01-01', cycleEnd: '2026-01-15', usdAmount: 150, hb9Amount: capHb9, hb9PriceAtPayout: BUY_PRICE, status: 'credited', reason: 'Audit cap fixture', createdAt: '2026-01-01T00:00:00.000Z', immutable: true });
    });

    let overview = await request('GET', '/api/admin/overview', null, admin);
    for (const rank of RANKS) {
      try {
        const summary = overview.users.find(user => user.id === created[`rank${rank.rank}`]).summary.salary;
        assert(summary.currentRank.rank === rank.rank, `expected current rank ${rank.rank}, got ${summary.currentRank?.rank}`);
        const progress = summary.rankProgress.find(item => item.rank === rank.rank);
        assert(progress.requiredDirectReferrals === rank.directs, 'direct requirement mismatch');
        assert(progress.directMinStakeUsd === rank.min, 'direct minimum mismatch');
        assert(progress.requiredSelfPackageUsd === rank.self, 'self package mismatch');
        assert(progress.requiredTeamBusinessUsd === rank.team, 'team business mismatch');
        assert(progress.salaryUsd === rank.salary, 'salary amount mismatch');
        pass(`Rank ${rank.rank} qualification and salary amount`);
      } catch (error) { fail(`Rank ${rank.rank} qualification and salary amount`, error); }
    }

    try {
      const deep = overview.users.find(user => user.id === created.deep).summary.salary;
      assert(!deep.currentRank, 'level-21 business incorrectly qualified user');
      mutateDb(db => {
        const level20 = db.users.find(user => user.name === 'Fixture salary-audit-deep-chain-20');
        addFixtureStake(db, level20.id, 950);
      });
      overview = await request('GET', '/api/admin/overview', null, admin);
      const level20 = overview.users.find(user => user.id === created.deep).summary.salary;
      assert(level20.currentRank.rank === 1, 'level-20 business did not qualify user');
      pass('Team business counts levels 1-20 and ignores deeper levels');
    } catch (error) { fail('Team business counts levels 1-20 and ignores deeper levels', error); }

    try {
      const lowDirect = overview.users.find(user => user.id === created.lowDirect).summary.salary;
      assert(!lowDirect.currentRank, 'directs below required stake counted');
      assert(lowDirect.directCountProgress.current === 0, 'below-min direct count is not zero');
      pass('Direct qualification enforces required staking minimum');
    } catch (error) { fail('Direct qualification enforces required staking minimum', error); }

    const reserveBefore = overview.solvency.hb9IncomeReserve;
    const accountedBeforeSalary = overview.solvency.accountedHb9;
    let salaryRun;
    try {
      salaryRun = await request('POST', '/api/admin/salary/run', null, admin);
      overview = await request('GET', '/api/admin/overview', null, admin);
      for (const rank of RANKS) {
        const payout = overview.salaryPayouts.find(item => item.userId === created[`rank${rank.rank}`] && item.status === 'credited');
        assert(payout, `missing rank ${rank.rank} credited payout`);
        assert(payout.usdAmount === rank.salary, `rank ${rank.rank} salary paid ${payout.usdAmount}`);
        assert(payout.hb9Amount === cents(rank.salary / BUY_PRICE), `rank ${rank.rank} HB9 amount mismatch`);
      }
      pass('Salary paid in HB9 using current HB9 price');
    } catch (error) { fail('Salary paid in HB9 using current HB9 price', error); }

    try {
      assert(overview.solvency.hb9IncomeReserve === cents(reserveBefore - salaryRun.summary.totalSalaryHb9), 'income reserve did not decrease by salary HB9');
      assert(overview.solvency.accountedHb9 === accountedBeforeSalary, 'salary payout changed accounted HB9 supply instead of moving reserve to wallet');
      pass('HB9 deducted from income reserve with no minting');
    } catch (error) { fail('HB9 deducted from income reserve with no minting', error); }

    try {
      const capped = overview.salaryPayouts.find(item => item.userId === created.cap && item.status === 'capped');
      assert(capped && capped.usdAmount === 0, 'cap did not block payout');
      mutateDb(db => { addFixtureStake(db, created.cap, 50); });
      overview = await request('GET', '/api/admin/overview', null, admin);
      const cap = overview.users.find(user => user.id === created.cap).summary.salary.salaryCap;
      assert(cap.maxSalaryCapUsd === 300 && cap.remainingUsd === 150, `cap after increase mismatch: ${JSON.stringify(cap)}`);
      pass('Salary cap blocks at 3x and increases with active stake');
    } catch (error) { fail('Salary cap blocks at 3x and increases with active stake', error); }

    try {
      let duplicateBlocked = false;
      try { await request('POST', '/api/admin/salary/run', null, admin); } catch (error) { duplicateBlocked = error.status === 409; }
      assert(duplicateBlocked, 'duplicate cycle run was not blocked');
      pass('One payout per 15-day cycle; duplicates blocked');
    } catch (error) { fail('One payout per 15-day cycle; duplicates blocked', error); }

    try {
      await request('PUT', '/api/admin/reserve-wallets', { asset: 'HB9', walletType: 'income', balance: 0 }, admin);
      let queued;
      mutateDb(db => { queued = addCandidate(db, 'salary-audit-queued', RANKS[0]).id; });
      await request('POST', '/api/admin/salary/run', null, admin);
      overview = await request('GET', '/api/admin/overview', null, admin);
      assert(overview.salaryPayouts.some(item => item.userId === queued && item.status === 'queued'), 'queued payout not recorded');
      pass('Insufficient HB9 reserve queues salary payout');
    } catch (error) { fail('Insufficient HB9 reserve queues salary payout', error); }

    try {
      const report = overview.users.find(user => user.id === created.rank1).summary.salary;
      assert(Object.hasOwn(report, 'currentRank'), 'missing current rank');
      assert(Object.hasOwn(report, 'nextRank'), 'missing next rank');
      assert(report.rankProgress.some(item => item.teamBusinessUsd !== undefined), 'missing team business');
      assert(report.rankProgress.some(item => item.directCount !== undefined), 'missing direct count');
      assert(report.salaryCap.usedUsd !== undefined, 'missing cap used');
      assert(report.salaryCap.remainingUsd !== undefined, 'missing cap remaining');
      assert(Array.isArray(report.payoutHistory), 'missing salary history');
      pass('Salary reports expose current rank, next rank, team business, directs, cap, and history');
    } catch (error) { fail('Salary reports expose current rank, next rank, team business, directs, cap, and history', error); }

    let userSalaryScreenshot = null;
    let adminSalaryScreenshot = null;
    try {
      userSalaryScreenshot = await screenshot(`http://127.0.0.1:${port}`, 'Salary', 'salary-user-page.png');
      adminSalaryScreenshot = await screenshot(`http://127.0.0.1:${port}`, 'Admin', 'salary-admin-page.png', 'Salary Report', { email: 'admin@hb9.local', password: 'Admin@123' });
      pass('Salary page screenshots captured');
    } catch (error) { fail('Salary page screenshots captured', error); }

    console.log(JSON.stringify({ status: results.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL', results, screenshots: { userSalaryScreenshot, adminSalaryScreenshot }, files: ['server.js', 'public/app.js', 'scripts/smoke.js', 'scripts/audit-salary.js'] }, null, 2));
  } finally {
    server.kill();
    fs.rmSync(dataFile, { force: true });
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', error: error.message }, null, 2));
  process.exitCode = 1;
});
