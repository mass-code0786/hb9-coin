const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { HDNodeWallet } = require('ethers');
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
const TEST_HD_PATH = "m/44'/60'/0'/0";
const TEST_XPUB = HDNodeWallet.fromPhrase(TEST_MNEMONIC, '', TEST_HD_PATH).neuter().extendedKey;
const TEST_XPRV = HDNodeWallet.fromPhrase(TEST_MNEMONIC, '', TEST_HD_PATH).extendedKey;

const port = 3100 + (process.pid % 500);
const dataFile = path.join(os.tmpdir(), `hb9-smoke-${process.pid}.json`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw Error(message); };
const assertInteger = (value, message) => assert(Number.isInteger(value), message);
const cents = value => Math.round((value + Number.EPSILON) * 100) / 100;
const BASE_PRICE = 2.25;
const PRICE_OFFSET = 0.09;
const BUY_PRICE = cents(BASE_PRICE + PRICE_OFFSET);
const SELL_PRICE = cents(Math.max(BASE_PRICE - PRICE_OFFSET, 0));
const STAKE_HB9 = cents(100 / BUY_PRICE);
const REFERRAL_HB9 = cents(10 / BASE_PRICE);
const LEVEL_025_HB9 = cents(0.25 / BASE_PRICE);
const LEVEL_050_HB9 = cents(0.5 / BASE_PRICE);
const LEVEL_100_HB9 = cents(1 / BASE_PRICE);

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
          return reject(error);
        }
        resolve(json);
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

async function registerUser(name, email, walletAddress, sponsorEmail) {
  await request('POST', '/api/auth/register', {
    name,
    email,
    password: 'Smoke@123',
    walletAddress,
    ...(sponsorEmail ? { sponsorEmail } : {})
  });
  return login(email, 'Smoke@123');
}

async function depositConvertAndStake(token, adminToken, userId, expectedActiveHb9 = STAKE_HB9) {
  const addressResponse = await request('POST','/api/deposits',{amount:100},token);
  assert(addressResponse.deposit?.status === 'waiting_for_blockchain_transaction' && addressResponse.deposit?.txHash === null, 'Deposit request must create a waiting blockchain intent without a tx hash');
  const txHash = `0x${crypto.createHash('sha256').update(`${userId}:${Date.now()}`).digest('hex')}`;
  const event = {chain:'BSC',txHash,logIndex:0,fromAddress:'0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',toAddress:addressResponse.depositAddress.address,amount:100,blockNumber:100,currentBlock:100};
  const pending = await request('POST', '/api/internal/deposit-events', event, token);
  assert(pending.deposit.status === 'pending' && pending.deposit.confirmations === 1, 'Detected transfer must wait for confirmations');
  assert(pending.deposit.id === addressResponse.deposit.id && pending.deposit.txHash === txHash, 'Watcher must link the chain transfer to the pending deposit intent');
  const pendingDashboard = await request('GET', '/api/dashboard', null, token);
  assert(pendingDashboard.wallets.usdt === 0, 'Pending transfer must not credit the USDT wallet');
  const credited = await request('POST', '/api/internal/deposit-events', {...event,currentBlock:111}, token);
  assert(credited.deposit.status === 'credited', 'Confirmed transfer must credit automatically');
  await request('POST', '/api/internal/deposit-events', {...event,currentBlock:120}, token);
  const approved = await request('GET', '/api/dashboard', null, token);
  assert(approved.wallets.usdt === 100 && approved.wallets.hb9 === 0, 'Confirmed deposit must credit USDT exactly once');
  const overview = await request('GET', '/api/admin/overview', null, adminToken);
  const credits=overview.walletLedger.filter(item => item.userId === userId && item.reason === 'BEP20 deposit credited' && item.refId === `BSC:${txHash}:0`);
  assert(credits.length === 1, `Confirmed transfer must create one immutable USDT wallet ledger credit; found ${credits.length}`);
  await request('POST', '/api/convert', { amount: 100 }, token);
  const converted = await request('GET', '/api/dashboard', null, token);
  assert(converted.wallets.usdt === 0 && converted.wallets.hb9 === STAKE_HB9, `Conversion must credit ${STAKE_HB9} HB9`);
  await request('POST', '/api/stakes', { amount: STAKE_HB9 }, token);
  const staked = await request('GET', '/api/dashboard', null, token);
  const stake = staked.stakes.at(-1);
  assert(cents(staked.wallets.hb9) === 0 && cents(staked.stats.activeStakeHb9) === cents(expectedActiveHb9), `Staking must consume HB9 balance, got wallet ${staked.wallets.hb9} active ${staked.stats.activeStakeHb9}, expected active ${expectedActiveHb9}`);
  assert(stake.status === 'active' && !('endDate' in stake), 'Stake must be permanently active with no end date');
}

function mutateDb(mutator) {
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  mutator(db);
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2));
}

function addFixtureUser(db, prefix, sponsorId = null) {
  const suffix = `${prefix}-${process.pid}-${db.users.length}`;
  const user = {
    id: `usr_${suffix}`,
    name: `Fixture ${prefix}`,
    email: `${suffix}@hb9.local`,
    role: 'user',
    status: 'active',
    passwordHash: 'fixture',
    salt: 'fixture',
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
    id: `stk_fixture_${userId}_${db.stakes.length}`,
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

function addQualifiedDirects(db, receiverId, count, stakeUsd = 2) {
  for (let index = 0; index < count; index++) {
    const direct = addFixtureUser(db, `qualified-${receiverId}-${index}`, receiverId);
    addFixtureStake(db, direct.id, stakeUsd);
  }
}

function addSalaryCandidate(db, prefix, selfStakeUsd, directCount, directStakeUsd, teamRemainderUsd = 0, extraDepth = 2) {
  const user = addFixtureUser(db, prefix);
  addFixtureStake(db, user.id, selfStakeUsd);
  let firstDirect = null;
  for (let index = 0; index < directCount; index++) {
    const direct = addFixtureUser(db, `${prefix}-direct-${index}`, user.id);
    if (!firstDirect) firstDirect = direct;
    addFixtureStake(db, direct.id, directStakeUsd);
  }
  if (teamRemainderUsd > 0 && firstDirect) {
    let parent = firstDirect;
    for (let level = 2; level <= extraDepth; level++) parent = addFixtureUser(db, `${prefix}-depth-${level}`, parent.id);
    addFixtureStake(db, parent.id, teamRemainderUsd);
  }
  return user;
}

function addLevelChain(prefix, unlockedThroughLevel) {
  const chain = [];
  mutateDb(db => {
    for (let level = 20; level >= 1; level--) {
      const sponsorId = level === 20 ? null : chain[level + 1].id;
      chain[level] = addFixtureUser(db, `${prefix}-level-${level}`, sponsorId);
    }
    for (let level = 1; level <= 20; level++) {
      addQualifiedDirects(db, chain[level].id, level <= unlockedThroughLevel ? level : 0);
    }
  });
  return chain;
}

function expectedFor(record) {
  const extra = Math.round(record.baseGlobalTeam * record.dailyExtraPercent / 100);
  return {
    extra,
    total: record.baseGlobalTeam + extra,
    extraFlush: cents(extra * 0.02)
  };
}

async function main() {
  try {
    fs.rmSync(dataFile, { force: true });
    const server = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, DEMO_MODE: 'true', AUTH_ENABLED: 'true', AUTH_BYPASS: 'false', MARKET_TEST_MODE: 'true', HB9_PRICE_FALLBACK: String(BASE_PRICE), HD_WALLET_XPUB: TEST_XPUB, HD_WALLET_XPRV: TEST_XPRV, HD_WALLET_MNEMONIC: TEST_MNEMONIC, HD_WALLET_DERIVATION_PATH: TEST_HD_PATH, DEPOSIT_WATCHER_TEST_MODE: 'true' },
      stdio: 'ignore'
    });

    try {
      for (let i = 0; i < 30; i++) {
        try {
          await request('POST', '/api/auth/login', { email: 'admin@hb9.local', password: 'Admin@123' });
          break;
        } catch (error) {
          if (i === 29) throw error;
          await wait(100);
        }
      }

      let dashboardBlocked = false;
      try { await request('GET', '/api/dashboard'); } catch (error) { dashboardBlocked = error.status === 401; }
      assert(dashboardBlocked, 'Dashboard must require login');
      let tickerBlocked = false;
      try { await request('GET', '/api/market/hb9-ticker'); } catch (error) { tickerBlocked = error.status === 401; }
      assert(tickerBlocked, 'Exchange ticker must require login');

      const admin = await login('admin@hb9.local', 'Admin@123');
      const partialEmail = `partial-${process.pid}@hb9.local`;
      const fullEmail = `full-${process.pid}@hb9.local`;
      const childEmail = `child-${process.pid}@hb9.local`;
      const queuedEmail = `queued-${process.pid}@hb9.local`;

      let overview = await request('GET', '/api/admin/overview', null, admin);
      assert(overview.solvency.totalHb9Supply === 1000000 && overview.solvency.hb9ExchangeReserve === 899500 && overview.solvency.hb9IncomeReserve === 100000, 'Seed supply and reserves must be initialized');
      let excessiveSupplyBlocked = false;
      try { await request('PUT', '/api/admin/reserve-wallets', { asset: 'HB9', walletType: 'exchange', balance: 1000001 }, admin); } catch (error) { excessiveSupplyBlocked = /fixed total supply/.test(error.body?.error || ''); }
      assert(excessiveSupplyBlocked, 'System must not allow more than 1,000,000 HB9 to be accounted');

      const partialToken = await registerUser('Partial Smoke', partialEmail, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      overview = await request('GET', '/api/admin/overview', null, admin);
      let partial = overview.users.find(user => user.email === partialEmail);
      await depositConvertAndStake(partialToken, admin, partial.id);
      overview = await request('GET', '/api/admin/overview', null, admin);
      assert(overview.solvency.hb9ExchangeReserve === cents(899500 - STAKE_HB9) && overview.solvency.usdtReserve === 200, 'HB9 buy must reduce HB9 reserve and increase USDT reserve');
      const incomeReserveBeforeDaily = overview.solvency.hb9IncomeReserve;
      await request('POST', '/api/admin/direct-business', { userId: partial.id, amount: 10, note: 'Partial qualification smoke' }, admin);
      await request('POST', '/api/admin/daily-income/run', null, admin);

      let partialDash = await request('GET', '/api/dashboard', null, partialToken);
      overview = await request('GET', '/api/admin/overview', null, admin);
      let partialGlobal = overview.globals.find(item => item.userId === partial.id);
      let partialFlush = overview.flushes.find(item => item.userId === partial.id);
      let partialExpected = expectedFor(partialGlobal);
      assert(partialGlobal.activeStakeUsd === 100 && partialGlobal.businessRequiredUsd === 200 && partialGlobal.directBusinessUsd === 10, 'Partial case business fields are incorrect');
      assert(partialGlobal.qualifiedStakeUsd === 5 && partialGlobal.unqualifiedStakeUsd === 95, 'Partial case stake qualification is incorrect');
      assert(partialGlobal.qualificationPercent === 5, 'Partial case qualification percent is incorrect');
      assert(partialGlobal.b1EligibleUsd === 2 && partialGlobal.creditedB1Usd === 0.1, 'Partial case credited B1 is incorrect');
      assert(partialGlobal.unqualifiedB1FlushUsd === 1.9, 'Partial case unqualified B1 flush is incorrect');
      assertInteger(partialGlobal.dailyExtraPercent, 'Daily extra percent must be integer');
      assert(partialGlobal.dailyExtraPercent >= 5 && partialGlobal.dailyExtraPercent <= 10, 'Daily extra percent must be 5-10%');
      assert(partialGlobal.baseGlobalTeam === 100 && partialGlobal.extraGlobalTeam === partialExpected.extra && partialGlobal.totalGlobalTeam === partialExpected.total, 'Partial case Global Team counts are incorrect');
      assertInteger(partialGlobal.totalGlobalTeam, 'Partial Global Team count must be integer');
      assert(partialFlush.extraGlobalFlushUsd === partialExpected.extraFlush, 'Partial case extra Global Team flush is incorrect');
      assert(partialFlush.totalFlushUsd === cents(1.9 + partialExpected.extraFlush), 'Partial case total flush is incorrect');
      assert(partialFlush.burnStatus === 'Burned Forever' && partialFlush.withdrawable === false && partialFlush.recoverable === false, 'Partial flush must be permanent burn');
      assert(partialDash.wallets.hb9 === 0.5 && partialDash.wallets.withdrawal === 0, 'Partial credited B1 must be paid in HB9 and not directly withdrawable as USDT');
      overview = await request('GET', '/api/admin/overview', null, admin);
      assert(overview.solvency.hb9IncomeReserve <= incomeReserveBeforeDaily - 0.5, 'B1 income must deduct from HB9 income reserve');

      await request('POST', '/api/admin/direct-business', { userId: partial.id, amount: 190, note: 'Complete after burned flush' }, admin);
      const partialAfter2x = await request('GET', '/api/dashboard', null, partialToken);
      assert(partialAfter2x.income.eligible && partialAfter2x.wallets.hb9 === 0.5 && partialAfter2x.income.totalFlush === partialFlush.totalFlushUsd, 'Previous burned flush must not recover after later 2X completion');

      const fullToken = await registerUser('Full Smoke', fullEmail, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', partialEmail);
      overview = await request('GET', '/api/admin/overview', null, admin);
      const full = overview.users.find(user => user.email === fullEmail);
      const incomeReserveBeforeReferral = overview.solvency.hb9IncomeReserve;
      await depositConvertAndStake(fullToken, admin, full.id);
      let sponsorDash = await request('GET', '/api/dashboard', null, partialToken);
      assert(sponsorDash.income.totalReferral === REFERRAL_HB9 && sponsorDash.income.totalLevelIncome === 0 && sponsorDash.wallets.hb9 === cents(REFERRAL_HB9 + 0.5) && sponsorDash.wallets.withdrawal === 0, 'Referral must be paid in HB9, but level income must remain locked until the receiver has qualified directs before the source stake');
      overview = await request('GET', '/api/admin/overview', null, admin);
      assert(overview.referrals.every(item => item.asset === 'HB9'), 'Referral income ledger asset must be HB9');
      assert(overview.walletLedger.filter(item => /income credited/i.test(item.reason || '')).every(item => item.asset === 'HB9'), 'Income wallet credits must use HB9 only');
      assert(overview.solvency.hb9IncomeReserve === cents(incomeReserveBeforeReferral - REFERRAL_HB9), 'Referral income must deduct from HB9 income reserve while locked level income must not');
      await request('POST', '/api/admin/direct-business', { userId: full.id, amount: 200, note: 'Full qualification smoke' }, admin);
      const run = await request('POST', '/api/admin/daily-income/run', null, admin);
      assert(run.summary.usersProcessed === 1, 'Only the newly created full case user should process');

      const fullDash = await request('GET', '/api/dashboard', null, fullToken);
      overview = await request('GET', '/api/admin/overview', null, admin);
      assert(overview.ledger.every(item => item.asset === 'HB9'), 'B1 income ledger asset must be HB9');
      const fullGlobal = overview.globals.find(item => item.userId === full.id);
      const fullFlush = overview.flushes.find(item => item.userId === full.id);
      const fullExpected = expectedFor(fullGlobal);
      assert(fullGlobal.qualifiedStakeUsd === 100 && fullGlobal.unqualifiedStakeUsd === 0, 'Full case stake qualification is incorrect');
      assert(fullGlobal.qualificationPercent === 100, 'Full case qualification percent is incorrect');
      assert(fullGlobal.creditedB1Usd === 2 && fullGlobal.unqualifiedB1FlushUsd === 0, 'Full case B1 split is incorrect');
      assert(fullGlobal.baseGlobalTeam === 100 && fullGlobal.extraGlobalTeam === fullExpected.extra && fullGlobal.totalGlobalTeam === fullExpected.total, 'Full case Global Team counts are incorrect');
      assert(fullDash.income.totalB1 === 10 && fullDash.wallets.hb9 === 10 && fullDash.wallets.withdrawal === 0, 'Full case credited B1 must be paid in HB9');
      assert(fullFlush.totalFlushUsd === fullExpected.extraFlush && fullFlush.extraGlobalFlushUsd === fullExpected.extraFlush, 'Full case must flush only extra Global Team value');
      assert(fullFlush.burnStatus === 'Burned Forever' && fullFlush.withdrawable === false && fullFlush.recoverable === false, 'Full case flush must be permanent burn');

      let duplicateBlocked = false;
      try { await request('POST', '/api/admin/daily-income/run', null, admin); } catch (error) { duplicateBlocked = error.body?.error === 'Already processed today'; }
      assert(duplicateBlocked, 'Duplicate daily processing must be blocked');

      const childToken = await registerUser('Child Smoke', childEmail, '0xcccccccccccccccccccccccccccccccccccccccc', partialEmail);
      overview = await request('GET', '/api/admin/overview', null, admin);
      const child = overview.users.find(user => user.email === childEmail);
      await depositConvertAndStake(childToken, admin, child.id);
      sponsorDash = await request('GET', '/api/dashboard', null, partialToken);
      assert(sponsorDash.income.totalReferral === cents(REFERRAL_HB9 * 2) && sponsorDash.income.totalLevelIncome === LEVEL_025_HB9 && sponsorDash.wallets.hb9 === cents(REFERRAL_HB9 * 2 + LEVEL_025_HB9 + 0.5), 'Additional referral and unlocked level income must remain HB9 wallet income');
      overview = await request('GET', '/api/admin/overview', null, admin);
      assert(overview.levelIncomeLedger.every(item => item.asset === 'HB9'), 'Level income ledger asset must be HB9');

      overview = await request('GET', '/api/admin/overview', null, admin);
      const count = overview.ledger.length;
      let immutable = false;
      try { await request('PUT', '/api/income-ledger/test', { amount: 999 }, admin); } catch (error) { immutable = error.status === 404; }
      overview = await request('GET', '/api/admin/overview', null, admin);
      assert(immutable && overview.ledger.length === count, 'Ledger mutation must be unavailable');

      const ticker = await request('GET', '/api/market/hb9-ticker', null, fullToken);
      const klines = await request('GET', '/api/market/hb9-klines?interval=1d', null, fullToken);
      assert(ticker.symbol === 'HB9/USDT' && ticker.source === 'icp_proxy' && ticker.icpPrice === BASE_PRICE && ticker.priceOffset === PRICE_OFFSET && ticker.hb9BuyPrice === BUY_PRICE && ticker.hb9SellPrice === SELL_PRICE && ticker.manualOverrideEnabled === false, 'Exchange ticker must follow ICP proxy plus/minus fixed offset by default');
      assert(klines.symbol === 'HB9/USDT' && klines.source === 'icp_proxy' && Array.isArray(klines.candles), 'Exchange klines must return ICP proxy candle data');
      await request('POST', '/api/exchange/sell', { amount: 10 }, fullToken);
      const soldIncome = await request('GET', '/api/dashboard', null, fullToken);
      assert(soldIncome.wallets.hb9 === 0 && soldIncome.wallets.usdt === cents(10 * SELL_PRICE) && soldIncome.wallets.withdrawal === cents(10 * SELL_PRICE), 'HB9 income must become withdrawable only after selling to USDT');
      overview = await request('GET', '/api/admin/overview', null, admin);
      assert(overview.solvency.totalBurnedHb9 === 10 && overview.solvency.hb9ExchangeReserve === cents(899500 - STAKE_HB9 * 3) && overview.solvency.usdtReserve === cents(400 - 10 * SELL_PRICE), 'Sell must burn HB9 permanently, not return it to reserve, and reduce USDT reserve');
      const marketUpdate = await request('PUT', '/api/admin/market-settings', { fallbackPrice: 0.25, priceOffset: PRICE_OFFSET, spreadPercent: 4, manualOverrideEnabled: true }, admin);
      assert(marketUpdate.marketSettings.fallbackPrice === 0.25 && marketUpdate.marketSettings.priceOffset === PRICE_OFFSET && marketUpdate.marketSettings.spreadPercent === 4 && marketUpdate.marketSettings.manualOverrideEnabled === true, 'Admin manual override settings must update');
      const manualTicker = await request('GET', '/api/market/hb9-ticker', null, fullToken);
      assert(manualTicker.source === 'manual_override' && manualTicker.hb9BasePrice === 0.25 && manualTicker.hb9BuyPrice === 0.34 && manualTicker.hb9SellPrice === 0.16, 'Manual override must apply fixed offset only when enabled');
      await request('PUT', '/api/admin/market-settings', { fallbackPrice: BASE_PRICE, priceOffset: PRICE_OFFSET, spreadPercent: 5, manualOverrideEnabled: false }, admin);
      await request('PUT', '/api/admin/reserve-wallets', { asset: 'USDT', walletType: 'treasury', balance: 0 }, admin);
      let insufficientUsdtBlocked = false;
      try { await request('POST', '/api/exchange/sell', { amount: 1 }, partialToken); } catch (error) { insufficientUsdtBlocked = /USDT reserve/.test(error.body?.error || ''); }
      assert(insufficientUsdtBlocked, 'Insufficient USDT reserve must block HB9 sells');
      await request('PUT', '/api/admin/reserve-wallets', { asset: 'USDT', walletType: 'treasury', balance: 1000 }, admin);
      await request('PUT', '/api/admin/reserve-wallets', { asset: 'HB9', walletType: 'income', balance: 0 }, admin);
      const queuedToken = await registerUser('Queued Smoke', queuedEmail, '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', partialEmail);
      overview = await request('GET', '/api/admin/overview', null, admin);
      const queued = overview.users.find(user => user.email === queuedEmail);
      await depositConvertAndStake(queuedToken, admin, queued.id);
      overview = await request('GET', '/api/admin/overview', null, admin);
      assert(overview.referrals.some(item => item.referredUserId === queued.id && item.status === 'queued'), 'Insufficient HB9 income reserve must queue referral income');
      assert(overview.levelIncomeLedger.some(item => item.sourceUserId === queued.id && item.level === 1 && item.status === 'queued'), 'Insufficient HB9 income reserve must queue level income');

      const hdEmail = `hd-${process.pid}@hb9.local`;
      const hdToken = await registerUser('HD Smoke', hdEmail, '0xdddddddddddddddddddddddddddddddddddddddd');
      const firstAddress = (await request('GET', '/api/deposit-address?chain=BSC', null, hdToken)).depositAddress;
      const secondAddress = (await request('GET', '/api/deposit-address?chain=BSC', null, hdToken)).depositAddress;
      assert(firstAddress.address === secondAddress.address && firstAddress.hdIndex === secondAddress.hdIndex, 'Deposit address must be permanent and reused');
      const txHash = `0x${'d'.repeat(64)}`, event = {chain:'BSC',txHash,logIndex:3,fromAddress:'0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',toAddress:firstAddress.address,amount:25,blockNumber:100,currentBlock:100};
      let watched = await request('POST', '/api/internal/deposit-events', event, hdToken);
      assert(watched.deposit.status === 'pending', 'Blockchain deposit must wait for confirmations');
      watched = await request('POST', '/api/internal/deposit-events', {...event,currentBlock:111}, hdToken);
      assert(watched.deposit.status === 'credited', 'Blockchain deposit must credit after required confirmations');
      let hdDash = await request('GET', '/api/dashboard', null, hdToken);
      assert(hdDash.wallets.usdt === 25, 'Credited blockchain deposit must increase USDT wallet');
      await request('POST', '/api/internal/deposit-events', {...event,currentBlock:120}, hdToken);
      hdDash = await request('GET', '/api/dashboard', null, hdToken);
      assert(hdDash.wallets.usdt === 25, 'Duplicate transaction/log index must not credit twice');
      const byTx = await request('GET', `/api/admin/deposits/search?q=${txHash}`, null, admin);
      const byAddress = await request('GET', `/api/admin/deposits/search?q=${firstAddress.address}`, null, admin);
      assert(byTx.deposits.length === 1 && byAddress.deposits.length === 1, 'Admin deposit search must find tx hash and address');

      await request('PUT', '/api/admin/reserve-wallets', { asset: 'HB9', walletType: 'income', balance: 500 }, admin);
      let zeroReceiver;
      mutateDb(db => { zeroReceiver = addFixtureUser(db, 'level-zero'); });
      const zeroSourceEmail = `level-zero-source-${process.pid}@hb9.local`;
      const zeroSourceToken = await registerUser('Level Zero Source', zeroSourceEmail, '0x1212121212121212121212121212121212121212', zeroReceiver.email);
      overview = await request('GET', '/api/admin/overview', null, admin);
      const zeroSource = overview.users.find(user => user.email === zeroSourceEmail);
      await depositConvertAndStake(zeroSourceToken, admin, zeroSource.id);
      overview = await request('GET', '/api/admin/overview', null, admin);
      let zeroRecords = overview.levelIncomeLedger.filter(item => item.sourceUserId === zeroSource.id);
      assert(zeroRecords.length === 1 && zeroRecords[0].status === 'locked' && zeroRecords[0].qualifiedDirectReferralCount === 0 && zeroRecords[0].unlockedLevel === 0, 'Receiver with 0 qualified directs must earn no level income');

      let belowReceiver;
      mutateDb(db => { belowReceiver = addFixtureUser(db, 'level-below'); addQualifiedDirects(db, belowReceiver.id, 1, 1.99); });
      const belowSourceEmail = `level-below-source-${process.pid}@hb9.local`;
      const belowSourceToken = await registerUser('Level Below Source', belowSourceEmail, '0x1313131313131313131313131313131313131313', belowReceiver.email);
      overview = await request('GET', '/api/admin/overview', null, admin);
      const belowSource = overview.users.find(user => user.email === belowSourceEmail);
      await depositConvertAndStake(belowSourceToken, admin, belowSource.id);
      overview = await request('GET', '/api/admin/overview', null, admin);
      const belowRecords = overview.levelIncomeLedger.filter(item => item.sourceUserId === belowSource.id);
      assert(belowRecords.length === 1 && belowRecords[0].status === 'locked' && belowRecords[0].qualifiedDirectReferralCount === 0, 'Direct referral with stake below $2 must not count');

      let oneReceiver;
      mutateDb(db => { oneReceiver = addFixtureUser(db, 'level-one'); addQualifiedDirects(db, oneReceiver.id, 1, 2); });
      const oneSourceEmail = `level-one-source-${process.pid}@hb9.local`;
      const oneSourceToken = await registerUser('Level One Source', oneSourceEmail, '0x1414141414141414141414141414141414141414', oneReceiver.email);
      overview = await request('GET', '/api/admin/overview', null, admin);
      const oneSource = overview.users.find(user => user.email === oneSourceEmail);
      await depositConvertAndStake(oneSourceToken, admin, oneSource.id);
      overview = await request('GET', '/api/admin/overview', null, admin);
      const oneRecords = overview.levelIncomeLedger.filter(item => item.sourceUserId === oneSource.id);
      assert(oneRecords.length === 1 && oneRecords[0].status === 'credited' && oneRecords[0].level === 1 && oneRecords[0].hb9Amount === LEVEL_025_HB9 && oneRecords[0].qualifiedDirectReferralCount === 1 && oneRecords[0].unlockedLevel === 1, 'Receiver with one $2 qualified direct must earn only Level 1');

      const fiveChain = addLevelChain('five-unlock', 5);
      const fiveSourceEmail = `level-five-source-${process.pid}@hb9.local`;
      const fiveSourceToken = await registerUser('Level Five Source', fiveSourceEmail, '0x1515151515151515151515151515151515151515', fiveChain[1].email);
      overview = await request('GET', '/api/admin/overview', null, admin);
      const fiveSource = overview.users.find(user => user.email === fiveSourceEmail);
      await depositConvertAndStake(fiveSourceToken, admin, fiveSource.id);
      overview = await request('GET', '/api/admin/overview', null, admin);
      const fiveRecords = overview.levelIncomeLedger.filter(item => item.sourceUserId === fiveSource.id);
      assert(fiveRecords.filter(item => item.status === 'credited').length === 5 && fiveRecords.filter(item => item.status === 'locked').length === 15, 'Sponsor chain with five unlocked levels must pay only Levels 1-5');
      assert(fiveRecords.filter(item => item.status === 'credited').every(item => item.level >= 1 && item.level <= 5), 'Locked upper levels must be skipped from payout');

      const fullChain = addLevelChain('twenty-unlock', 20);
      const levelSourceEmail = `level-source-${process.pid}@hb9.local`;
      const levelSourceToken = await registerUser('Level Source', levelSourceEmail, '0xffffffffffffffffffffffffffffffffffffffff', fullChain[1].email);
      overview = await request('GET', '/api/admin/overview', null, admin);
      const levelSource = overview.users.find(user => user.email === levelSourceEmail);
      const levelReserveBefore = overview.solvency.hb9IncomeReserve;
      await depositConvertAndStake(levelSourceToken, admin, levelSource.id);
      overview = await request('GET', '/api/admin/overview', null, admin);
      const sourceStake = overview.stakes.find(stake => stake.userId === levelSource.id);
      const levelRecords = overview.levelIncomeLedger.filter(item => item.stakeId === sourceStake.id);
      assert(levelRecords.length === 20 && levelRecords.every(item => item.status === 'credited'), 'Twenty unlocked levels must create 20 credited level income records');
      assert(levelRecords.every(item => item.asset === 'HB9'), 'Credited level income records must use HB9 asset');
      assert(levelRecords.find(item => item.level === 1).hb9Amount === LEVEL_025_HB9 && levelRecords.find(item => item.level === 7).hb9Amount === LEVEL_050_HB9 && levelRecords.find(item => item.level === 14).hb9Amount === LEVEL_100_HB9 && levelRecords.find(item => item.level === 20).hb9Amount === LEVEL_100_HB9, 'Level income percentages must match the 0.25%, 0.50%, and 1.00% tiers');
      assert(levelRecords.find(item => item.level === 20).qualifiedDirectReferralCount === 20 && levelRecords.find(item => item.level === 20).unlockedLevel === 20 && levelRecords.find(item => item.level === 20).requiredDirectsForLevel === 20, 'Level income report fields must expose qualified directs, unlocked level, and required directs');
      const levelReserveAfterFirst = overview.solvency.hb9IncomeReserve;
      assert(levelReserveAfterFirst === cents(levelReserveBefore - levelRecords.reduce((sum, item) => sum + item.hb9Amount, 0) - REFERRAL_HB9), 'First-stake level income must deduct from HB9 income reserve');
      await depositConvertAndStake(levelSourceToken, admin, levelSource.id, cents(STAKE_HB9 * 2));
      overview = await request('GET', '/api/admin/overview', null, admin);
      assert(overview.levelIncomeLedger.filter(item => item.sourceUserId === levelSource.id).length === 20, 'Second stake must not create duplicate level income');
      assert(new Set(overview.levelIncomeLedger.filter(item => item.sourceUserId === levelSource.id).map(item => `${item.stakeId}:${item.level}`)).size === 20, 'Level income must be unique by stakeId and level');

      await request('PUT', '/api/admin/reserve-wallets', { asset: 'HB9', walletType: 'income', balance: 10000 }, admin);
      let salaryRank1, salaryRank2, salaryDepth, salaryMinDirect, salaryCap;
      mutateDb(db => {
        salaryRank1 = addSalaryCandidate(db, 'salary-rank1', 50, 10, 5, 950, 2);
        salaryRank2 = addSalaryCandidate(db, 'salary-rank2', 150, 15, 10, 2850, 2);
        salaryDepth = addSalaryCandidate(db, 'salary-depth', 50, 10, 5, 0, 2);
        let parent = db.users.find(user => user.id === salaryDepth.id);
        for (let level = 1; level <= 21; level++) parent = addFixtureUser(db, `salary-depth-chain-${level}`, parent.id);
        addFixtureStake(db, parent.id, 950);
        salaryMinDirect = addSalaryCandidate(db, 'salary-min-direct', 50, 10, 4.99, 950.1, 2);
        salaryCap = addSalaryCandidate(db, 'salary-cap', 50, 10, 5, 950, 2);
        db.salary_payouts = db.salary_payouts || [];
        db.salary_payouts.push({ id: `salp_cap_fixture_${process.pid}`, userId: salaryCap.id, type: 'SALARY_INCOME', asset: 'HB9', rank: 1, rankName: 'Rank 1', cycleStart: '2026-01-01', cycleEnd: '2026-01-15', usdAmount: 150, hb9Amount: cents(150 / BASE_PRICE), hb9PriceAtPayout: BASE_PRICE, status: 'credited', reason: 'Cap fixture', createdAt: '2026-01-01T00:00:00.000Z', immutable: true });
      });
      overview = await request('GET', '/api/admin/overview', null, admin);
      const rank1Summary = overview.users.find(user => user.id === salaryRank1.id).summary.salary;
      const rank2Summary = overview.users.find(user => user.id === salaryRank2.id).summary.salary;
      const depthSummary = overview.users.find(user => user.id === salaryDepth.id).summary.salary;
      const minDirectSummary = overview.users.find(user => user.id === salaryMinDirect.id).summary.salary;
      assert(rank1Summary.currentRank.rank === 1 && rank1Summary.nextRank.rank === 2, 'Salary Rank 1 qualification must work');
      assert(rank2Summary.currentRank.rank === 2 && rank2Summary.nextRank.rank === 3, 'Salary Rank 2 qualification must work');
      assert(!depthSummary.currentRank && depthSummary.teamBusinessProgress.current < 1000, 'Salary team business beyond 20 levels must not qualify');
      mutateDb(db => {
        const level20 = db.users.find(user => user.name === 'Fixture salary-depth-chain-20');
        addFixtureStake(db, level20.id, 950);
      });
      overview = await request('GET', '/api/admin/overview', null, admin);
      const depthQualified = overview.users.find(user => user.id === salaryDepth.id).summary.salary;
      assert(depthQualified.currentRank.rank === 1, 'Salary team business at level 20 must qualify');
      assert(!minDirectSummary.currentRank && minDirectSummary.directCountProgress.current === 0, 'Salary direct staking minimum must be enforced');

      const salaryReserveBefore = overview.solvency.hb9IncomeReserve;
      const salaryRun = await request('POST', '/api/admin/salary/run', null, admin);
      assert(salaryRun.summary.creditedUsers >= 3, 'Salary payout run must credit qualified users');
      overview = await request('GET', '/api/admin/overview', null, admin);
      const rank1Payouts = overview.salaryPayouts.filter(item => item.userId === salaryRank1.id);
      assert(rank1Payouts.length === 1 && rank1Payouts[0].status === 'credited' && rank1Payouts[0].asset === 'HB9' && rank1Payouts[0].usdAmount === 20 && rank1Payouts[0].hb9Amount === cents(20 / BASE_PRICE), 'Rank 1 salary must be paid in HB9');
      assert(overview.salaryPayouts.every(item => item.asset === 'HB9'), 'Salary payout asset must be HB9');
      assert(overview.walletLedger.some(item => item.userId === salaryRank1.id && item.asset === 'HB9' && item.direction === 'credit' && item.amount === cents(20 / BASE_PRICE) && item.reason === 'Salary income credited'), 'Salary payout must credit the user HB9 wallet ledger');
      assert(overview.solvency.hb9IncomeReserve <= cents(salaryReserveBefore - cents(20 / BASE_PRICE)), 'Salary payout must deduct from HB9 income reserve');
      const cappedRecord = overview.salaryPayouts.find(item => item.userId === salaryCap.id && item.status === 'capped');
      assert(cappedRecord && cappedRecord.usdAmount === 0, 'Salary cap must block payout after 3x personal investment');
      let duplicateSalaryBlocked = false;
      try { await request('POST', '/api/admin/salary/run', null, admin); } catch (error) { duplicateSalaryBlocked = /Salary cycle/.test(error.body?.error || ''); }
      assert(duplicateSalaryBlocked, 'Salary payout must happen only once per 15-day cycle per qualified user');
      mutateDb(db => { addFixtureStake(db, salaryCap.id, 50); });
      overview = await request('GET', '/api/admin/overview', null, admin);
      const capAfterIncrease = overview.users.find(user => user.id === salaryCap.id).summary.salary.salaryCap;
      assert(capAfterIncrease.maxSalaryCapUsd === 300 && capAfterIncrease.remainingUsd === 150, 'Increasing personal investment must increase salary cap automatically');
      await request('PUT', '/api/admin/reserve-wallets', { asset: 'HB9', walletType: 'income', balance: 0 }, admin);
      let salaryQueued;
      mutateDb(db => { salaryQueued = addSalaryCandidate(db, 'salary-queued', 50, 10, 5, 950, 2); });
      const queuedRun = await request('POST', '/api/admin/salary/run', null, admin);
      overview = await request('GET', '/api/admin/overview', null, admin);
      assert(queuedRun.summary.queuedUsers >= 1 && overview.salaryPayouts.some(item => item.userId === salaryQueued.id && item.status === 'queued'), 'Insufficient HB9 income reserve must queue salary payout');

      const resetResult = await request('POST', '/api/admin/demo/reset', null, admin).catch(error => error);
      assert(resetResult.status === 404 && resetResult.body?.error === 'Route not found', 'Demo reset route must be removed');
      console.log('SMOKE PASS: HD xpub address reuse, deposit intent linking, simulated BEP20 confirmation credit, tx/log-index idempotency, wallet ledger credit, and existing HB9 financial flows.');
    } finally {
      server?.kill();
      fs.rmSync(dataFile, { force: true });
    }
  } catch (error) {
    console.error(`SMOKE FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
