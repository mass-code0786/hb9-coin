const assert = (condition,message) => { if(!condition)throw Error(message); };
process.env.TREASURY_WALLET_BSC='0x9999999999999999999999999999999999999999';
process.env.MIN_SWEEP_USDT='0.1';
process.env.SWEEP_CONFIRMATIONS='12';
const { createSweepCandidates, updateBroadcastedSweep, retrySweep } = require('../server');

const now=new Date().toISOString();
const db={
  deposits:[{id:'dep_1',userId:'usr_1',depositAddressId:'addr_1',txHash:`0x${'1'.repeat(64)}`,logIndex:0,amount:25,creditedAmount:25,status:'credited',createdAt:now}],
  deposit_addresses:[{id:'addr_1',userId:'usr_1',chain:'BSC',address:'0x1111111111111111111111111111111111111111',hdIndex:0}],
  sweep_transactions:[],auditLogs:[],reserve_wallets:[{id:'res_usdt',asset:'USDT',walletType:'treasury',balance:0,lockedBalance:0,createdAt:now,updatedAt:now}],reserve_ledger:[],burn_ledger:[],wallet_ledger:[],exchange_orders:[],income_emissions:[],level_income_ledger:[],salary_ranks:[],salary_qualifications:[],salary_payouts:[]
};

async function main(){
  const oneUsdtDb={
    deposits:[{id:'dep_one',userId:'usr_1',depositAddressId:'addr_1',txHash:`0x${'5'.repeat(64)}`,logIndex:0,amount:1,creditedAmount:1,status:'credited',createdAt:now}],
    deposit_addresses:[{id:'addr_1',userId:'usr_1',chain:'BSC',address:'0x1111111111111111111111111111111111111111',hdIndex:0}],
    sweep_transactions:[],auditLogs:[]
  };
  createSweepCandidates(oneUsdtDb);
  assert(oneUsdtDb.sweep_transactions.length===1&&oneUsdtDb.sweep_transactions[0].amount===1,'Credited 1 USDT deposit must create a sweep candidate when MIN_SWEEP_USDT=0.1');
  assert(oneUsdtDb.auditLogs.some(entry=>entry.type==='TREASURY_SWEEP_CANDIDATE_CREATED'),'Sweep candidate creation must emit TREASURY_SWEEP_CANDIDATE_CREATED');

  createSweepCandidates(db);
  assert(db.sweep_transactions.length===1&&db.sweep_transactions[0].status==='not_started','Credited deposit must create one sweep candidate');
  createSweepCandidates(db);
  assert(db.sweep_transactions.length===1,'Restart candidate scan must not duplicate a sweep');
  const sweep=db.sweep_transactions[0],provider={getTransactionReceipt:async hash=>hash===sweep.gasTopupTxHash?{status:1,blockNumber:89}:{status:1,blockNumber:89}};
  sweep.status='gas_topup_broadcasted';sweep.gasTopupStatus='broadcasted';sweep.gasTopupTxHash=`0x${'2'.repeat(64)}`;
  await updateBroadcastedSweep(db,sweep,provider,100);
  assert(sweep.status==='gas_funded'&&sweep.gasTopupStatus==='confirmed','Confirmed gas top-up must fund the sweep state');
  sweep.status='broadcasted';sweep.sweepTxHash=`0x${'3'.repeat(64)}`;
  await updateBroadcastedSweep(db,sweep,provider,100);
  assert(sweep.status==='confirmed'&&db.reserve_wallets[0].balance===25,'Confirmed token sweep must mark swept and credit treasury reserve once');
  await updateBroadcastedSweep(db,sweep,provider,110);
  assert(db.reserve_wallets[0].balance===25,'Restart confirmation check must not credit treasury twice');
  const failed={id:'swp_failed',depositId:'dep_1',userId:'usr_1',status:'broadcasted',sweepTxHash:`0x${'4'.repeat(64)}`,amount:1};db.sweep_transactions.push(failed);
  const failedProvider={getTransactionReceipt:async()=>({status:0,blockNumber:100})};
  await updateBroadcastedSweep(db,failed,failedProvider,100);
  assert(failed.status==='failed_retryable','Failed token receipt must become retryable without a new broadcast');
  retrySweep(db,failed);
  assert(failed.status==='not_started'&&failed.sweepTxHash===null&&failed.failedSweepTxHashes.length===1,'Manual retry must preserve failed hash history and never overwrite it');
  const requeueDb={
    deposits:[{id:'dep_retry',userId:'usr_1',depositAddressId:'addr_1',txHash:`0x${'6'.repeat(64)}`,logIndex:0,amount:1,creditedAmount:1,status:'credited',sweepStatus:'not_started',createdAt:now}],
    deposit_addresses:[{id:'addr_1',userId:'usr_1',chain:'BSC',address:'0x1111111111111111111111111111111111111111',hdIndex:0}],
    sweep_transactions:[{id:'swp_retry',depositId:'dep_retry',userId:'usr_1',status:'failed_retryable',amount:1,sweepTxHash:`0x${'7'.repeat(64)}`,gasTopupStatus:'not_required'}],auditLogs:[]
  };
  createSweepCandidates(requeueDb);
  assert(requeueDb.sweep_transactions.length===1&&requeueDb.sweep_transactions[0].status==='not_started'&&requeueDb.sweep_transactions[0].sweepTxHash===null,'Credited deposit with retryable sweep must be requeued without duplicate or user credit');
  console.log('SWEEP STATE SMOKE PASS: 1 USDT candidate, candidate uniqueness, gas confirmation, token confirmation, restart idempotency, failure, and retry state.');
}
main().catch(error=>{console.error(`SWEEP STATE SMOKE FAIL: ${error.message}`);process.exitCode=1;});
