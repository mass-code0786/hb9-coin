const assert = require('assert');
process.env.MARKET_TEST_MODE = 'true';
const { accrueGlobalPoints, globalPointSummary } = require('../server');

const today = () => new Date().toISOString().slice(0, 10);
const datePlus = (date, days) => { const d = new Date(`${date}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

function db(users) {
  return {
    users,
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
    salary_payouts: []
  };
}

const now = today();

const noRegistrations = db([{ id: 'usr_zero_new', name: 'Zero New', email: 'zero@hb9.local', role: 'user', status: 'active', createdAt: `${now}T00:00:00.000Z` }]);
let result = accrueGlobalPoints(noRegistrations, { userId: 'usr_zero_new', toDate: now });
assert.strictEqual(result.createdDays, 1, 'user gets global point even with zero new registrations');
assert(globalPointSummary(noRegistrations, 'usr_zero_new').globalPoints > 0, 'global points must be greater than zero');

const inactiveRegistrations = db([{ id: 'usr_blocked', name: 'Blocked User', email: 'blocked@hb9.local', role: 'user', status: 'blocked', createdAt: `${now}T00:00:00.000Z` }]);
result = accrueGlobalPoints(inactiveRegistrations, { toDate: now });
assert.strictEqual(result.createdDays, 1, 'inactive registrations are counted because rule is registration based, not active-status based');

const afterOneDay = db([{ id: 'usr_day_one', name: 'Day One', email: 'day1@hb9.local', role: 'user', status: 'active', createdAt: `${datePlus(now, -1)}T00:00:00.000Z` }]);
result = accrueGlobalPoints(afterOneDay, { toDate: now });
assert(result.createdDays >= 2, 'active user gets points after 1 day');
assert.strictEqual(globalPointSummary(afterOneDay, 'usr_day_one').lastGlobalPointUpdate, now, 'last global point update should be current accrual date');

const backfill = db([{ id: 'usr_backfill', name: 'Backfill User', email: 'backfill@hb9.local', role: 'user', status: 'active', createdAt: `${datePlus(now, -2)}T00:00:00.000Z` }]);
result = accrueGlobalPoints(backfill, { toDate: now });
assert(result.createdDays >= 3, 'backfill gives missing 2 days plus current day points');
const before = backfill.globalTeamRecords.length;
result = accrueGlobalPoints(backfill, { toDate: now });
assert.strictEqual(result.createdDays, 0, 'no duplicate points for same day');
assert.strictEqual(backfill.globalTeamRecords.length, before, 'second accrual run must not duplicate records');

console.log('GLOBAL POINTS SMOKE PASS: zero-registration accrual, inactive registration accrual, day-one accrual, backfill, and idempotency verified.');
