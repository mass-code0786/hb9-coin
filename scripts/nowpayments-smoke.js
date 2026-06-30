const assert = require('assert');

process.env.NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY || 'test_api_key';
process.env.NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || 'test_ipn_secret';
process.env.NOWPAYMENTS_MOCK = 'true';
process.env.APP_URL = process.env.APP_URL || 'https://coin.hb9.live';

const crypto = require('crypto');
const {
  createNowPaymentsDeposit,
  creditNowPaymentsDeposit,
  markExpiredNowPaymentsDeposits,
  verifyNowPaymentsSignature,
  sortedJson
} = require('../server');

function db() {
  const now = new Date().toISOString();
  return {
    users: [{ id: 'usr_1', name: 'NOWPayments User', email: 'nowpayments@hb9.local', role: 'user', status: 'active', createdAt: now }],
    deposits: [],
    wallet_ledger: [],
    auditLogs: [],
    reserve_wallets: [],
    reserve_ledger: [],
    burn_ledger: [],
    exchange_orders: [],
    income_emissions: [],
    salary_ranks: [],
    salary_qualifications: [],
    salary_payouts: []
  };
}

function sign(payload) {
  return crypto.createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET).update(JSON.stringify(sortedJson(payload))).digest('hex');
}

(async () => {
  const store = db();
  const created = await createNowPaymentsDeposit(store, 'usr_1', 25);
  assert.strictEqual(store.deposits.length, 1, 'Create deposit payment mock must save one deposit');
  assert.strictEqual(created.deposit.provider, 'NOWPayments', 'Deposit provider must be NOWPayments');
  assert.strictEqual(created.deposit.status, 'pending', 'New NOWPayments deposit must be pending');
  assert.strictEqual(created.deposit.network, 'USDT BEP20', 'NOWPayments deposit must be BEP20 only');
  assert.strictEqual(created.deposit.payCurrency, 'usdtbsc', 'NOWPayments pay_currency must be USDT on BSC/BEP20');
  assert.strictEqual(created.payment.pay_currency, 'usdtbsc', 'Payment response must expose BEP20 USDT currency');
  assert(created.deposit.payAddress, 'Payment response must expose an on-site pay address');
  assert.strictEqual(created.deposit.payAmount, 25, 'Payment response must expose the pay amount');
  assert(created.deposit.paymentUrl, 'Payment page URL may exist only as fallback');
  assert(created.deposit.expiresAt, 'Payment response must expose a deposit expiry');
  assert(Math.abs((Date.parse(created.deposit.expiresAt) - Date.parse(created.deposit.createdAt)) - 20 * 60 * 1000) < 2000, 'Deposit expiry must be 20 minutes after creation');

  const ipn = {
    payment_id: created.deposit.paymentId,
    invoice_id: created.deposit.invoiceId,
    order_id: created.deposit.orderId,
    payment_status: 'finished',
    price_amount: 25,
    price_currency: 'usd'
  };
  assert(verifyNowPaymentsSignature('', ipn, sign(ipn)), 'Valid IPN signature must verify');
  assert(!verifyNowPaymentsSignature('', ipn, '00'), 'Invalid IPN signature must be rejected');

  const first = creditNowPaymentsDeposit(store, ipn);
  assert.strictEqual(first.credited, true, 'Valid finished IPN must credit once');
  assert.strictEqual(store.deposits[0].status, 'credited', 'Finished IPN must mark deposit credited');
  assert.strictEqual(store.wallet_ledger.filter(x => x.reason === 'NOWPayments deposit credited').length, 1, 'Finished IPN must write one wallet ledger credit');

  const duplicate = creditNowPaymentsDeposit(store, ipn);
  assert.strictEqual(duplicate.duplicate, true, 'Duplicate IPN must be detected');
  assert.strictEqual(store.wallet_ledger.filter(x => x.reason === 'NOWPayments deposit credited').length, 1, 'Duplicate IPN must not double credit');

  const expiringStore = db();
  const expiringCreated = await createNowPaymentsDeposit(expiringStore, 'usr_1', 15);
  expiringCreated.deposit.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual(markExpiredNowPaymentsDeposits(expiringStore), true, 'Pending deposit must expire after 20 minutes');
  assert.strictEqual(expiringStore.deposits[0].status, 'expired', 'Expired deposit must be marked expired');
  const late = creditNowPaymentsDeposit(expiringStore, { payment_id: expiringCreated.deposit.paymentId, order_id: expiringCreated.deposit.orderId, payment_status: 'finished', price_amount: 15, updated_at: new Date().toISOString() });
  assert.strictEqual(late.credited, false, 'Late finished IPN after expiry must not credit');
  assert.strictEqual(late.reason, 'late_after_expiry', 'Late finished IPN must be recorded as late after expiry');
  assert.strictEqual(expiringStore.wallet_ledger.length, 0, 'Expired deposit cannot be reused for wallet credit');

  const paidBeforeExpiryStore = db();
  const paidBeforeExpiryCreated = await createNowPaymentsDeposit(paidBeforeExpiryStore, 'usr_1', 18);
  paidBeforeExpiryCreated.deposit.expiresAt = new Date(Date.now() - 1000).toISOString();
  const paidBeforeExpiry = creditNowPaymentsDeposit(paidBeforeExpiryStore, { payment_id: paidBeforeExpiryCreated.deposit.paymentId, order_id: paidBeforeExpiryCreated.deposit.orderId, payment_status: 'finished', price_amount: 18, updated_at: new Date(Date.now() - 60 * 1000).toISOString() });
  assert.strictEqual(paidBeforeExpiry.credited, true, 'IPN finalized before expiresAt must credit even if received later');
  assert.strictEqual(paidBeforeExpiryStore.wallet_ledger.filter(x => x.reason === 'NOWPayments deposit credited').length, 1, 'Before-expiry IPN must write one wallet credit');

  const failedStore = db();
  const failedCreated = await createNowPaymentsDeposit(failedStore, 'usr_1', 10);
  const failed = creditNowPaymentsDeposit(failedStore, { payment_id: failedCreated.deposit.paymentId, order_id: failedCreated.deposit.orderId, payment_status: 'expired', price_amount: 10 });
  assert.strictEqual(failed.credited, false, 'Expired payment must not credit');
  assert.strictEqual(failedStore.deposits[0].status, 'expired', 'Expired payment must mark deposit expired');
  assert.strictEqual(failedStore.wallet_ledger.length, 0, 'Expired payment must not write wallet ledger credit');

  console.log('NOWPAYMENTS SMOKE PASS: on-site payment address mock, valid IPN credit, duplicate idempotency, invalid signature rejection, and expired payment handling verified.');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
