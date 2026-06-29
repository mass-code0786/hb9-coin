const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

process.env.MARKET_TEST_MODE = 'true';
process.env.DATA_FILE = path.join(os.tmpdir(), `hb9-team-levels-${process.pid}.json`);
process.env.BOOTSTRAP_ADMIN_EMAIL = 'team-level-admin@example.com';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'Admin@123456';
process.env.BOOTSTRAP_ADMIN_NAME = 'Team Level Admin';

const { readDB, server, teamLevelsReport, writeDB } = require('../server');

function makeDb() {
  const users = [{ id: 'usr_root', name: 'Root User', email: 'root@example.com', role: 'user', status: 'active', sponsorId: 'usr_l2', createdAt: '2026-06-01T00:00:00.000Z' }];
  for (let level = 1; level <= 20; level++) {
    users.push({
      id: `usr_l${level}`,
      name: `Level ${level}`,
      email: `level${level}@example.com`,
      role: 'user',
      status: level === 2 ? 'inactive' : 'active',
      sponsorId: level === 1 ? 'usr_root' : `usr_l${level - 1}`,
      createdAt: `2026-06-${String(Math.min(level, 28)).padStart(2, '0')}T00:00:00.000Z`
    });
  }
  users.push({ id: 'usr_admin', name: 'Admin', email: 'admin@example.com', role: 'admin', status: 'active', createdAt: '2026-06-01T00:00:00.000Z' });
  return {
    users,
    stakes: [
      { id: 'stk_l1', userId: 'usr_l1', stakeAsset: 'HB9', stakeAmount: 50, usdValueAtStake: 100, amount: 100, hb9EquivalentAmount: 50, coinAmount: 50, status: 'active', createdAt: '2026-06-02T00:00:00.000Z' },
      { id: 'stk_l2', userId: 'usr_l2', stakeAsset: 'HB9', stakeAmount: 20, usdValueAtStake: 40, amount: 40, hb9EquivalentAmount: 20, coinAmount: 20, status: 'active', createdAt: '2026-06-03T00:00:00.000Z' },
      { id: 'stk_l3_bnb', userId: 'usr_l3', stakeAsset: 'BNB', stakeAmount: 0.5, usdValueAtStake: 300, amount: 300, hb9EquivalentAmount: 133.33, coinAmount: 133.33, status: 'active', createdAt: '2026-06-04T00:00:00.000Z' },
      { id: 'stk_l20', userId: 'usr_l20', stakeAsset: 'HB9', stakeAmount: 10, usdValueAtStake: 25, amount: 25, hb9EquivalentAmount: 10, coinAmount: 10, status: 'inactive', createdAt: '2026-06-21T00:00:00.000Z' }
    ]
  };
}

const report = teamLevelsReport(makeDb(), 'usr_root', 20);
assert.strictEqual(report.summary.totalLevels, 20, 'response includes 20 levels');
assert.strictEqual(report.summary.totalMembers, 20, '20 reachable downline users are included');
assert.strictEqual(report.summary.activeMembers, 19, 'inactive users are included but not counted active');
assert.strictEqual(report.levels[0].memberCount, 1, 'level 1 direct member is shown');
assert.strictEqual(report.levels[1].memberCount, 1, 'level 2 nested member is shown');
assert.strictEqual(report.levels[2].memberCount, 1, 'level 3 nested member is shown');
assert.strictEqual(report.levels[19].members[0].userId, 'usr_l20', 'level 20 is supported');
assert.strictEqual(report.levels[1].members[0].status, 'inactive', 'inactive users are included');
assert.strictEqual(report.levels[2].members[0].stakeAsset, 'BNB', 'BNB stake asset is reported');
assert.strictEqual(report.levels[2].members[0].hb9EquivalentAmount, 133.33, 'BNB stake HB9 equivalent is counted');
assert.strictEqual(report.levels[2].members[0].totalStakeAmount, 0.5, 'BNB original stake amount is reported');
assert.strictEqual(report.levels[0].members[0].activeStake, 100, 'active stake USD is reported per member');
assert.strictEqual(report.summary.totalInvestmentUsd, 465, 'investment totals include active and inactive stakes');
assert.strictEqual(report.summary.totalHb9Equivalent, 213.33, 'HB9 equivalent totals include BNB-derived equivalent');
assert(!report.levels.some(level => level.members.some(member => member.userId === 'usr_root')), 'visited guard prevents loop duplicate root user');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'latin1');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'withdraw-redesign.css'), 'utf8');
assert(app.includes("api('/api/team/levels')"), 'Team page fetches level team API');
assert(app.includes('Level Team') && app.includes('Total Team') && app.includes('HB9 Equivalent'), 'Team page renders summary labels');
assert(app.includes('levels.map(levelCard).join') && app.includes('team-level-card'), 'Team page renders all returned level cards');
assert(app.includes('member.totalInvestmentUsd') && app.includes('member.activeStake') && app.includes('member.stakeAsset'), 'Team page renders required member investment fields');
assert(css.includes('.team-level-card') && css.includes('@media(max-width:800px)') && css.includes('overflow-wrap:anywhere'), 'mobile level team CSS exists without horizontal overflow');

function request(port, requestPath, { method = 'GET', token = null, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ port, path: requestPath, method, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, res => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        const json = responseBody ? JSON.parse(responseBody) : {};
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await request(port, '/api/auth/register', { method: 'POST', body: { name: 'Root User', email: 'root-route@example.com', password: 'User@123456' } });
    let db = readDB();
    const root = db.users.find(user => user.email === 'root-route@example.com');
    const fixture = makeDb();
    db.users.push(...fixture.users.filter(user => user.id !== 'usr_root' && user.role === 'user'));
    root.id = 'usr_root';
    root.sponsorId = 'usr_l2';
    db.stakes = fixture.stakes;
    writeDB(db);

    const login = await request(port, '/api/auth/login', { method: 'POST', body: { email: 'root-route@example.com', password: 'User@123456' } });
    assert.strictEqual(login.status, 200, 'root user can log in');
    const userReport = await request(port, '/api/team/levels', { token: login.json.token });
    assert.strictEqual(userReport.status, 200, 'user can load own 20-level team report');
    assert.strictEqual(userReport.json.levels.length, 20, 'route returns 20 levels');
    assert.strictEqual(userReport.json.levels[0].members[0].email, 'level1@example.com', 'route includes level 1 direct member');
    assert.strictEqual(userReport.json.levels[19].members[0].email, 'level20@example.com', 'route includes level 20 member');

    const adminLogin = await request(port, '/api/auth/login', { method: 'POST', body: { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD } });
    assert.strictEqual(adminLogin.status, 200, 'admin can log in');
    const adminReport = await request(port, '/api/team/levels?userId=usr_root', { token: adminLogin.json.token });
    assert.strictEqual(adminReport.status, 200, 'admin can load any user team tree');
    assert.strictEqual(adminReport.json.summary.totalMembers, 20, 'admin route returns target user team summary');
  } finally {
    await new Promise(resolve => server.close(resolve));
    try { fs.unlinkSync(process.env.DATA_FILE); } catch (_) {}
  }

  console.log('team-levels-smoke ok');
})().catch(error => {
  try { server.close(); } catch (_) {}
  try { fs.unlinkSync(process.env.DATA_FILE); } catch (_) {}
  console.error(error);
  process.exit(1);
});
