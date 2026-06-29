try { require('dotenv').config(); } catch (_) { /* .env is optional in the dependency-free demo */ }
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HDNodeWallet, Interface, JsonRpcProvider, Wallet, Contract, getAddress, isAddress, formatUnits, parseUnits, parseEther } = require('ethers');

const PORT = Number(process.env.PORT || 3000);
function resolveDataFile(value = process.env.DATA_FILE) {
  const configured = String(value || '').trim();
  if (!configured) return path.join(__dirname, 'data', 'db.json');
  return path.isAbsolute(configured) ? configured : path.resolve(__dirname, configured);
}
const DATA = resolveDataFile();
const PUBLIC = path.join(__dirname, 'public');
const APP_URL = process.env.APP_URL || (process.env.NODE_ENV === 'production' ? 'https://coin.hb9.live' : `http://localhost:${PORT}`);
const NOWPAYMENTS_BASE_URL = String(process.env.NOWPAYMENTS_BASE_URL || 'https://api.nowpayments.io/v1').replace(/\/+$/, '');
const NOWPAYMENTS_SUCCESS_URL = process.env.NOWPAYMENTS_SUCCESS_URL || 'https://coin.hb9.live/deposit/success';
const NOWPAYMENTS_CANCEL_URL = process.env.NOWPAYMENTS_CANCEL_URL || 'https://coin.hb9.live/deposit/cancel';
const PRODUCTION_DOMAIN = /^https:\/\/coin\.hb9\.live\/?$/i.test(APP_URL);
const DEV_ONLY_DEMO = process.env.NODE_ENV !== 'production' && process.env.DEMO_MODE === 'true';
const DEMO_MODE = DEV_ONLY_DEMO;
const BSC_CHAIN = 'BSC';
const DEFAULT_HD_DERIVATION_PATH = "m/44'/60'/0'/0";
const BLOCKED_UNSAFE_DEPOSIT_ADDRESSES = new Set(['0xeb513f05b51fbe4c4acedef60ae9ef1ee8f694c7a']);
const USDT_BEP20_DECIMALS = 18;
const RAW_USDT_MIGRATION_THRESHOLD = 1000000000;
const USDT_BEP20_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];
const usdtInterface = new Interface(USDT_BEP20_ABI);
const TRANSFER_TOPIC = usdtInterface.getEvent('Transfer').topicHash;
const WATCHER_POLL_MS = Math.max(5000, Number(process.env.DEPOSIT_WATCHER_POLL_MS || 15000));
const TARGET_WATCHER_DEBUG_TX_HASH = '0xa90fadee77b0ec3fda2af57d1c4b71f18cc3309bcf14f85e10f00930748ece54';
let watcherTimer = null;
let watcherRunning = false;
let watcherResetApplied = false;
let sweepTimer = null;
let sweepRunning = false;
const HB9_TOTAL_SUPPLY = 1000000;
const HB9_EXCHANGE_RESERVE_TOTAL = Math.max(0, Number(process.env.HB9_EXCHANGE_RESERVE_TOTAL || HB9_TOTAL_SUPPLY));
const BNB_EXCHANGE_RESERVE_TOTAL = process.env.BNB_EXCHANGE_RESERVE_TOTAL === undefined ? null : Math.max(0, Number(process.env.BNB_EXCHANGE_RESERVE_TOTAL || 0));
const DEFAULT_PRICE_OFFSET = 0.09;
const LEVEL_INCOME_PERCENTS = [0.25,0.25,0.25,0.25,0.25,0.25,0.5,0.5,0.5,0.5,0.5,0.5,0.5,1,1,1,1,1,1,1];
const LEVEL_DIRECT_MIN_STAKE_USD = 2;
const SALARY_CYCLE_DAYS = 15;
const DEFAULT_SALARY_RANKS = [
  {rank:1,name:'Rank 1',requiredDirectReferrals:10,directMinStakeUsd:5,requiredSelfPackageUsd:50,requiredTeamBusinessUsd:1000,salaryUsd:20},
  {rank:2,name:'Rank 2',requiredDirectReferrals:15,directMinStakeUsd:10,requiredSelfPackageUsd:150,requiredTeamBusinessUsd:3000,salaryUsd:100},
  {rank:3,name:'Rank 3',requiredDirectReferrals:20,directMinStakeUsd:15,requiredSelfPackageUsd:300,requiredTeamBusinessUsd:10000,salaryUsd:200},
  {rank:4,name:'Rank 4',requiredDirectReferrals:20,directMinStakeUsd:20,requiredSelfPackageUsd:500,requiredTeamBusinessUsd:30000,salaryUsd:500},
  {rank:5,name:'Rank 5',requiredDirectReferrals:30,directMinStakeUsd:20,requiredSelfPackageUsd:1000,requiredTeamBusinessUsd:100000,salaryUsd:1000},
  {rank:6,name:'Rank 6',requiredDirectReferrals:30,directMinStakeUsd:25,requiredSelfPackageUsd:2000,requiredTeamBusinessUsd:300000,salaryUsd:2000}
];
const sessions = new Map();
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const today = () => new Date().toISOString().slice(0, 10);
const datePlus = (date, days) => { const d = new Date(date); d.setDate(d.getDate() + days); return d.toISOString().slice(0,10); };
const roundCurrency = value => Math.round((value + Number.EPSILON) * 100) / 100;
const roundDecimals = (value, decimals) => Math.round((Number(value) + Number.EPSILON) * 10 ** decimals) / 10 ** decimals;
const truncateDecimals = (value, decimals) => Math.trunc(Number(value) * 10 ** decimals) / 10 ** decimals;
const roundAssetAmount = (asset, value) => String(asset||'').toUpperCase()==='BNB' ? truncateDecimals(value, 8) : roundCurrency(Number(value));
const hash = (password, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') });
const check = (password, user) => crypto.timingSafeEqual(Buffer.from(hash(password, user.salt).hash, 'hex'), Buffer.from(user.passwordHash, 'hex'));
let adminBootstrapLogged=false;
function ensureBootstrapAdmin(db){
  const email=String(process.env.BOOTSTRAP_ADMIN_EMAIL||'').trim().toLowerCase(), password=process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if(!email)return false;
  db.users=db.users||[];
  const now=new Date().toISOString();
  let changed=false, created=false, user=db.users.find(item=>String(item.email||'').toLowerCase()===email);
  if(!user){
    if(!password)return false;
    const admin=hash(password);
    user={id:'usr_admin',name:process.env.BOOTSTRAP_ADMIN_NAME||'HB9 Admin',email,role:'admin',status:'active',blocked:false,passwordHash:admin.hash,salt:admin.salt,walletAddress:null,createdAt:now};
    db.users.push(user);
    changed=true;created=true;
  }
  if(user.role!=='admin'){user.role='admin';changed=true;}
  if(user.status!=='active'){user.status='active';changed=true;}
  if(user.blocked!==false){user.blocked=false;changed=true;}
  let passwordUpdated=false;
  if(password){let matches=false;try{matches=Boolean(user.passwordHash&&user.salt&&check(password,user));}catch(_){matches=false;}if(!matches){const admin=hash(password);user.passwordHash=admin.hash;user.salt=admin.salt;changed=true;passwordUpdated=true;}}
  if(!adminBootstrapLogged){console.log('ADMIN_BOOTSTRAP_READY',{email:user.email,userId:user.id,created,passwordUpdated});adminBootstrapLogged=true;}
  return changed;
}
function readDB() { if (!fs.existsSync(DATA)) initializeDB(); const db=JSON.parse(fs.readFileSync(DATA, 'utf8')); ensureSupply(db); const repaired=repairBep20RawUnitAmounts(db).corrected, bnbRepaired=repairBnbConversionPrecision(db).corrected, bootstrapped=ensureBootstrapAdmin(db); if(repaired||bnbRepaired||bootstrapped)writeDB(db); return db; }
function writeDB(db) { fs.mkdirSync(path.dirname(DATA), {recursive:true}); fs.writeFileSync(DATA, JSON.stringify(db, null, 2)); }
function normalizeRuntimeAddress(address){try{const value=String(address||'').trim();return isAddress(value)?getAddress(value).toLowerCase():null;}catch(_){return null;}}
function runtimeStorageDiagnostics(db=readDB()){
  const target='0xE0C9e2843f53b79A7C0632116f805a26061DADaA';
  const normalizedTarget=normalizeRuntimeAddress(target);
  const rows=(db.deposit_addresses||[]).filter(item=>normalizeRuntimeAddress(item.address)===normalizedTarget);
  return {
    dataFile:DATA,
    envDataFile:process.env.DATA_FILE||null,
    cwd:process.cwd(),
    appDir:__dirname,
    depositAddressCount:(db.deposit_addresses||[]).length,
    targetAddress:target,
    targetAddressExists:rows.length>0,
    targetMatches:rows.map(item=>({id:item.id,userId:item.userId,chain:item.chain,address:item.address,disabled:Boolean(item.disabled),signerVerified:item.signerVerified===true,hdIndex:item.hdIndex,walletIndex:item.walletIndex}))
  };
}
function initializeDB(){ DEV_ONLY_DEMO ? seedDevOnlyDemo() : seedProductionEmpty(); }
function baseSettings(){
  return {dailyRoi:2,directMultiplier:2,referralPercent:10,globalActivityMin:5,globalActivityMax:15,globalPointValue:0.02,hb9Price:0.2,priceMode:'icp_proxy',exchangeEnabled:true,tradingFeePercent:0,buyFeePercent:0,sellFeePercent:0,fallbackPrice:0.2,priceOffset:DEFAULT_PRICE_OFFSET,spreadPercent:5,manualOverrideEnabled:false,minWithdrawal:20,withdrawalFeePercent:5,minHb9Transfer:1,hb9TransferFeePercent:0,manualWithdrawalApproval:true,treasuryWalletBSC:process.env.TREASURY_WALLET_BSC||''};
}
function emptyDB(){
  const now = new Date().toISOString();
  return {
    appUrl:APP_URL,
    users:[], deposits:[], conversions:[], stakes:[], directBusiness:[],
    incomeLedger:[], referralLedger:[], level_income_ledger:[], salary_ranks:DEFAULT_SALARY_RANKS.map(x=>({...x})), salary_qualifications:[], salary_payouts:[], globalTeamRecords:[], flushRecords:[], withdrawals:[], transfers:[], transferLedger:[], directBusinessAudit:[], dailyRuns:[], salaryRuns:[],
    deposit_addresses:[], blockchain_transactions:[], sweep_transactions:[], auditLogs:[],
    hb9_supply:{asset:'HB9',totalSupply:HB9_TOTAL_SUPPLY,fixed:true,createdAt:now},
    reserve_wallets:[
      {id:'res_hb9_exchange',asset:'HB9',walletType:'exchange',balance:0,lockedBalance:0,createdAt:now,updatedAt:now},
      {id:'res_hb9_income',asset:'HB9',walletType:'income',balance:0,lockedBalance:0,createdAt:now,updatedAt:now},
      {id:'res_usdt',asset:'USDT',walletType:'treasury',balance:0,lockedBalance:0,createdAt:now,updatedAt:now}
    ],
    reserve_ledger:[], burn_ledger:[], wallet_ledger:[], exchange_orders:[], income_emissions:[],
    hb9_market_settings:{fallbackPrice:0.2,priceOffset:DEFAULT_PRICE_OFFSET,spreadPercent:5,manualOverrideEnabled:false,updatedBy:'system',updatedAt:now},
    hb9_price_history:[],
    settings:baseSettings()
  };
}
function seedProductionEmpty() {
  const db=emptyDB();
  const email=process.env.BOOTSTRAP_ADMIN_EMAIL, password=process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if(email&&password){
    const admin=hash(password);
    db.users.push({id:'usr_admin',name:process.env.BOOTSTRAP_ADMIN_NAME||'HB9 Admin',email:String(email).toLowerCase(),role:'admin',status:'active',passwordHash:admin.hash,salt:admin.salt,walletAddress:null,createdAt:new Date().toISOString()});
  }
  writeDB(db);
}
function seed() { seedDevOnlyDemo(); }
function seedDevOnlyDemo() {
  const admin = hash('Admin@123'), alice = hash('Demo@123'), bob = hash('Demo@123');
  const now = new Date().toISOString();
  writeDB({
    appUrl:APP_URL,
    users:[
      {id:'usr_admin',name:'HB9 Admin',email:'admin@hb9.local',role:'admin',status:'active',passwordHash:admin.hash,salt:admin.salt,walletAddress:null,createdAt:now},
      {id:'usr_alice',name:'Alice Demo',email:'alice@hb9.local',role:'user',status:'active',passwordHash:alice.hash,salt:alice.salt,walletAddress:'0x1111111111111111111111111111111111111111',sponsorId:null,createdAt:now},
      {id:'usr_bob',name:'Bob Direct',email:'bob@hb9.local',role:'user',status:'active',passwordHash:bob.hash,salt:bob.salt,walletAddress:'0x2222222222222222222222222222222222222222',sponsorId:'usr_alice',createdAt:now}
    ],
    deposits:[{id:'dep_demo',userId:'usr_alice',amount:100,status:'approved',asset:'USDT',chain:'BSC',network:'USDT BEP20 (Demo)',createdAt:now,approvedAt:now,approvedBy:'usr_admin'}],
    conversions:[{id:'cnv_demo',userId:'usr_alice',direction:'buy',usdtAmount:100,hb9Amount:500,rate:0.2,buyPrice:0.2,sellPrice:0.19,createdAt:now}],
    stakes:[{id:'stk_demo',userId:'usr_alice',amount:100,usdValueAtStake:100,coinAmount:500,hb9Amount:500,hb9PriceAtStake:0.2,status:'active',startDate:datePlus(today(),-8),dailyRate:0.02,createdAt:now}],
    directBusiness:[{id:'biz_demo',userId:'usr_alice',sourceUserId:'usr_bob',amount:75,reason:'Demo direct business',createdAt:now}],
    incomeLedger:[], referralLedger:[], level_income_ledger:[], salary_ranks:DEFAULT_SALARY_RANKS, salary_qualifications:[], salary_payouts:[], globalTeamRecords:[], flushRecords:[], withdrawals:[], transfers:[], transferLedger:[], directBusinessAudit:[], dailyRuns:[],
    deposit_addresses:[],
    blockchain_transactions:[], sweep_transactions:[], auditLogs:[],
    hb9_supply:{asset:'HB9',totalSupply:HB9_TOTAL_SUPPLY,fixed:true,createdAt:now},
    reserve_wallets:[
      {id:'res_hb9_exchange',asset:'HB9',walletType:'exchange',balance:899500,lockedBalance:0,createdAt:now,updatedAt:now},
      {id:'res_hb9_income',asset:'HB9',walletType:'income',balance:100000,lockedBalance:0,createdAt:now,updatedAt:now},
      {id:'res_usdt',asset:'USDT',walletType:'treasury',balance:100,lockedBalance:0,createdAt:now,updatedAt:now}
    ],
    reserve_ledger:[
      {id:'rsv_seed_hb9_exchange',asset:'HB9',walletType:'exchange',direction:'seed',amount:899500,balanceAfter:899500,reason:'Initial HB9 exchange reserve',createdAt:now,immutable:true},
      {id:'rsv_seed_hb9_income',asset:'HB9',walletType:'income',direction:'seed',amount:100000,balanceAfter:100000,reason:'Initial HB9 income reserve',createdAt:now,immutable:true},
      {id:'rsv_seed_usdt_buy',asset:'USDT',walletType:'treasury',direction:'credit',amount:100,balanceAfter:100,reason:'Seed HB9 buy USDT reserve',createdAt:now,immutable:true}
    ],
    burn_ledger:[], wallet_ledger:[
      {id:'wlt_seed_buy_usdt',userId:'usr_alice',asset:'USDT',direction:'debit',amount:100,reason:'Seed HB9 buy',createdAt:now,immutable:true},
      {id:'wlt_seed_buy_hb9',userId:'usr_alice',asset:'HB9',direction:'credit',amount:500,reason:'Seed HB9 buy',createdAt:now,immutable:true},
      {id:'wlt_seed_stake_hb9',userId:'usr_alice',asset:'HB9',direction:'lock',amount:500,reason:'Seed HB9 stake',createdAt:now,immutable:true}
    ], exchange_orders:[], income_emissions:[],
    hb9_market_settings:{fallbackPrice:0.2,priceOffset:DEFAULT_PRICE_OFFSET,spreadPercent:5,manualOverrideEnabled:false,updatedBy:'usr_admin',updatedAt:now},
    hb9_price_history:[],
    settings:{...baseSettings(),treasuryWalletBSC:'0x9999999999999999999999999999999999999999'}
  });
}
function setting(db, key) { return db.settings[key] ?? (key==='hb9Price' ? 0.2 : undefined); }
function ensureSupply(db){
  const now=new Date().toISOString();
  db.hb9_supply=db.hb9_supply||{asset:'HB9',totalSupply:HB9_TOTAL_SUPPLY,fixed:true,createdAt:now};
  db.hb9_supply.totalSupply=HB9_TOTAL_SUPPLY;
  db.hb9_supply.fixed=true;
  db.reserve_wallets=db.reserve_wallets||[];
  const ensure=(asset,walletType,balance=0)=>{let wallet=db.reserve_wallets.find(x=>x.asset===asset&&x.walletType===walletType);if(!wallet){wallet={id:id('res'),asset,walletType,balance,lockedBalance:0,createdAt:now,updatedAt:now};db.reserve_wallets.push(wallet);}wallet.balance=roundAssetAmount(asset,Number(wallet.balance)||0);wallet.lockedBalance=roundAssetAmount(asset,Number(wallet.lockedBalance)||0);return wallet;};
  ensure('HB9','exchange',0);ensure('HB9','income',0);ensure('USDT','treasury',0);ensure('BNB','exchange',0);
  db.reserve_ledger=db.reserve_ledger||[];db.burn_ledger=db.burn_ledger||[];db.wallet_ledger=db.wallet_ledger||[];db.exchange_orders=db.exchange_orders||[];db.income_emissions=db.income_emissions||[];db.level_income_ledger=db.level_income_ledger||[];
  ensureSalaryTables(db);
  return db.hb9_supply;
}
function ensureSalaryTables(db){
  db.salary_ranks=Array.isArray(db.salary_ranks)&&db.salary_ranks.length?db.salary_ranks:DEFAULT_SALARY_RANKS.map(x=>({...x}));
  db.salary_ranks.sort((a,b)=>Number(a.rank)-Number(b.rank));
  db.salary_qualifications=db.salary_qualifications||[];
  db.salary_payouts=db.salary_payouts||[];
}
function reserveWallet(db,asset,walletType){ensureSupply(db);return db.reserve_wallets.find(x=>x.asset===asset&&x.walletType===walletType);}
function reserveMove(db,{asset,walletType,direction,amount,reason,refId,userId}){
  const value=roundAssetAmount(asset,Number(amount));
  if(!Number.isFinite(value)||value<0)throw Error('Invalid reserve amount');
  const wallet=reserveWallet(db,asset,walletType), sign=direction==='credit'?1:-1, next=roundAssetAmount(asset,wallet.balance+(value*sign));
  if(next<0)throw Error(`${asset} ${walletType} reserve is insufficient`);
  wallet.balance=next;wallet.updatedAt=new Date().toISOString();
  const entry={id:id('rsv'),asset,walletType,direction,amount:value,balanceAfter:wallet.balance,reason,refId,userId,createdAt:wallet.updatedAt,immutable:true};
  db.reserve_ledger.push(entry);
  return entry;
}
function burnHb9(db,{amount,reason,refId,userId}){
  ensureSupply(db);
  const value=roundAssetAmount(normalizedAsset,Number(amount));
  if(!Number.isFinite(value)||value<=0)throw Error('Invalid burn amount');
  const burned=roundCurrency((db.burn_ledger||[]).reduce((n,x)=>n+(Number(x.amount)||0),0)+value);
  if(burned>HB9_TOTAL_SUPPLY)throw Error('HB9 burn exceeds total supply');
  const entry={id:id('brn'),asset:'HB9',amount:value,reason,refId,userId,createdAt:new Date().toISOString(),immutable:true};
  db.burn_ledger.push(entry);
  return entry;
}
function walletEntry(db,{userId,asset,direction,amount,reason,refId,type}) {
  ensureSupply(db);
  const entry={id:id('wlt'),userId,asset,direction,amount:roundAssetAmount(asset,Number(amount)),reason,refId,type,createdAt:new Date().toISOString(),immutable:true};
  db.wallet_ledger.push(entry);
  return entry;
}
function repairBnbConversionPrecision(db){
  ensureSupply(db);
  let corrected=0;
  const repaired=[];
  for(const conversion of db.conversions||[]){
    const toAsset=String(conversion.toAsset||'').toUpperCase();
    const fromAsset=String(conversion.fromAsset||'USDT').toUpperCase();
    const current=Number(conversion.toAmount??conversion.bnbAmount??0);
    const paid=Number(conversion.fromAmount??conversion.usdtAmount??0);
    const price=Number(conversion.price??conversion.buyPrice??conversion.rate??0);
    if(fromAsset!=='USDT'||toAsset!=='BNB'||current!==0||!(paid>0)||!(price>0)||conversion.status==='failed')continue;
    const expected=roundAssetAmount('BNB',paid/price*(1-(Number(conversion.feePercent)||0)/100));
    if(!(expected>0))continue;
    conversion.toAmount=expected;
    conversion.bnbAmount=expected;
    const refs=new Set([conversion.orderId,conversion.id].filter(Boolean));
    const order=(db.exchange_orders||[]).find(item=>item.id===conversion.orderId||item.conversionId===conversion.id||item.id===conversion.id);
    if(order){
      refs.add(order.id);
      order.toAmount=expected;
      order.bnbAmount=expected;
    }
    for(const entry of db.wallet_ledger||[])if(refs.has(entry.refId)&&String(entry.asset||'').toUpperCase()==='BNB'&&Number(entry.amount||0)===0)entry.amount=expected;
    const reserveEntries=(db.reserve_ledger||[]).filter(entry=>refs.has(entry.refId)&&String(entry.asset||'').toUpperCase()==='BNB'&&entry.walletType==='exchange'&&Number(entry.amount||0)===0);
    for(const entry of reserveEntries){
      const wallet=reserveWallet(db,'BNB','exchange');
      wallet.balance=roundAssetAmount('BNB',Number(wallet.balance||0)-expected);
      if(wallet.balance<0)wallet.balance=0;
      wallet.updatedAt=new Date().toISOString();
      entry.amount=expected;
      entry.balanceAfter=wallet.balance;
    }
    corrected++;
    repaired.push({conversionId:conversion.id,orderId:conversion.orderId||order?.id||null,fromAmount:paid,price,bnbAmount:expected});
  }
  return {corrected,repaired};
}
function circulatingHb9(db){
  return roundCurrency((db.users||[]).filter(u=>u.role==='user').reduce((sum,u)=>sum+walletBalances(db,u.id).hb9+(db.stakes||[]).filter(s=>s.userId===u.id&&s.status==='active').reduce((n,s)=>n+(Number(s.coinAmount)||0),0),0));
}
function reserveTotal(db,asset){ensureSupply(db);return roundAssetAmount(asset,db.reserve_wallets.filter(x=>x.asset===asset).reduce((n,x)=>n+(Number(x.balance)||0),0));}
function burnTotal(db){ensureSupply(db);return roundCurrency(db.burn_ledger.reduce((n,x)=>n+(Number(x.amount)||0),0));}
function exchangeReserveReport(db){
  ensureSupply(db);
  const buyConversions=(db.conversions||[]).filter(x=>(!x.direction||x.direction==='buy')&&x.status!=='failed');
  const sellConversions=(db.conversions||[]).filter(x=>x.direction==='sell'&&x.status!=='failed');
  const hb9Bought=buyConversions.filter(x=>(x.toAsset||'HB9')==='HB9').reduce((n,x)=>n+(Number(x.hb9Amount)||Number(x.toAmount)||0),0);
  const hb9Returned=sellConversions.filter(x=>(x.fromAsset||'HB9')==='HB9').reduce((n,x)=>n+(Number(x.hb9Amount)||Number(x.fromAmount)||0),0);
  const hb9Sold=roundCurrency(Math.max(0,hb9Bought-hb9Returned));
  const bnbSold=roundAssetAmount('BNB',buyConversions.filter(x=>x.toAsset==='BNB').reduce((n,x)=>n+(Number(x.bnbAmount)||Number(x.toAmount)||0),0));
  const bnbWallet=reserveWallet(db,'BNB','exchange');
  const bnbRemaining=roundAssetAmount('BNB',Number(bnbWallet?.balance)||0);
  const bnbConfiguredTotal=BNB_EXCHANGE_RESERVE_TOTAL!==null&&BNB_EXCHANGE_RESERVE_TOTAL>0?BNB_EXCHANGE_RESERVE_TOTAL:(bnbRemaining>0||bnbSold>0?roundAssetAmount('BNB',bnbRemaining+bnbSold):0);
  return {
    hb9:{asset:'HB9',total:roundCurrency(HB9_EXCHANGE_RESERVE_TOTAL),sold:hb9Sold,remaining:roundCurrency(Math.max(0,HB9_EXCHANGE_RESERVE_TOTAL-hb9Sold)),configured:true},
    bnb:{asset:'BNB',total:roundCurrency(bnbConfiguredTotal),sold:bnbSold,remaining:bnbRemaining,configured:bnbConfiguredTotal>0||bnbRemaining>0}
  };
}
function solvencyReport(db){
  ensureSupply(db);
  const exchangeReserve=exchangeReserveReport(db), circulating=circulatingHb9(db), burned=burnTotal(db), hb9Reserve=reserveTotal(db,'HB9'), usdtReserve=reserveTotal(db,'USDT'), withdrawableUsdt=roundCurrency((db.users||[]).filter(u=>u.role==='user').reduce((n,u)=>n+walletBalances(db,u.id).withdrawableUsdt,0));
  const accounted=roundCurrency(circulating+burned+hb9Reserve);
  return {totalHb9Supply:HB9_TOTAL_SUPPLY,hb9Reserve,hb9ExchangeReserve:exchangeReserve.hb9.remaining,hb9ExchangeReserveTotal:exchangeReserve.hb9.total,hb9ExchangeReserveSold:exchangeReserve.hb9.sold,hb9IncomeReserve:reserveWallet(db,'HB9','income').balance,bnbExchangeReserveTotal:exchangeReserve.bnb.total,bnbExchangeReserveSold:exchangeReserve.bnb.sold,bnbExchangeReserveRemaining:exchangeReserve.bnb.remaining,bnbExchangeReserveConfigured:exchangeReserve.bnb.configured,exchangeReserve,circulatingHb9:circulating,totalBurnedHb9:burned,remainingHb9Supply:roundCurrency(HB9_TOTAL_SUPPLY-burned),accountedHb9:accounted,usdtReserve,withdrawableUsdtLiability:withdrawableUsdt,solvent:accounted<=HB9_TOTAL_SUPPLY&&usdtReserve>=withdrawableUsdt};
}
function marketSettings(db){
  db.hb9_market_settings=db.hb9_market_settings||{};
  db.hb9_market_settings.fallbackPrice=Number(db.hb9_market_settings.fallbackPrice ?? db.settings?.fallbackPrice ?? db.settings?.hb9Price ?? 0.2);
  db.hb9_market_settings.priceOffset=Number(db.hb9_market_settings.priceOffset ?? db.settings?.priceOffset ?? DEFAULT_PRICE_OFFSET);
  db.hb9_market_settings.spreadPercent=Number(db.hb9_market_settings.spreadPercent ?? db.settings?.spreadPercent ?? 0);
  db.hb9_market_settings.manualOverrideEnabled=Boolean(db.hb9_market_settings.manualOverrideEnabled ?? db.settings?.manualOverrideEnabled);
  db.hb9_market_settings.updatedBy=db.hb9_market_settings.updatedBy||'system';
  db.hb9_market_settings.updatedAt=db.hb9_market_settings.updatedAt||new Date().toISOString();
  db.hb9_price_history=db.hb9_price_history||[];
  return db.hb9_market_settings;
}
function offsetPrices(basePrice, settings){
  const base=roundCurrency(Number(basePrice)||0), offset=roundCurrency(Number(settings.priceOffset ?? DEFAULT_PRICE_OFFSET));
  return {basePrice:base,priceOffset:offset,buyPrice:roundCurrency(base+offset),sellPrice:roundCurrency(Math.max(base-offset,0))};
}
function setMarketSettings(db,{fallbackPrice,buyPrice,priceOffset,spreadPercent,manualOverrideEnabled,buyFeePercent,sellFeePercent},updatedBy){
  const current=marketSettings(db), fallback=Number(fallbackPrice ?? buyPrice), offset=Number(priceOffset ?? current.priceOffset ?? DEFAULT_PRICE_OFFSET), spread=Number(spreadPercent ?? current.spreadPercent), buyFee=buyFeePercent===undefined?db.settings.buyFeePercent:Number(buyFeePercent), sellFee=sellFeePercent===undefined?db.settings.sellFeePercent:Number(sellFeePercent);
  if(!Number.isFinite(fallback)||fallback<=0)return {error:'Fallback/manual price must be greater than zero'};
  if(!Number.isFinite(offset)||offset<0)return {error:'Price offset must be zero or greater'};
  if(!Number.isFinite(spread)||spread<0||spread>100)return {error:'Spread percent must be 0-100'};
  if(!Number.isFinite(buyFee)||buyFee<0||buyFee>100||!Number.isFinite(sellFee)||sellFee<0||sellFee>100)return {error:'Buy/sell fees must be 0-100'};
  const manual=manualOverrideEnabled===true||manualOverrideEnabled==='true'||manualOverrideEnabled===1||manualOverrideEnabled==='1';
  const updatedAt=new Date().toISOString();
  db.hb9_market_settings={fallbackPrice:roundCurrency(fallback),priceOffset:roundCurrency(offset),spreadPercent:spread,manualOverrideEnabled:manual,updatedBy,updatedAt};
  Object.assign(db.settings,{fallbackPrice:roundCurrency(fallback),priceOffset:roundCurrency(offset),spreadPercent:spread,manualOverrideEnabled:manual,buyFeePercent:buyFee,sellFeePercent:sellFee,hb9Price:roundCurrency(fallback),priceMode:manual?'manual_override':'icp_proxy'});
  db.hb9_price_history=db.hb9_price_history||[];
  db.hb9_price_history.push({id:id('mph'),...db.hb9_market_settings,buyFeePercent:buyFee,sellFeePercent:sellFee});
  audit(db,'HB9_MARKET_PRICE_UPDATED',db.hb9_market_settings);
  return {settings:db.hb9_market_settings};
}
function hb9MarketReport(db){
  const conversions=db.conversions||[];
  const buys=conversions.filter(x=>!x.direction||x.direction==='buy');
  const sells=conversions.filter(x=>x.direction==='sell');
  return {
    totalHb9Bought:roundCurrency(buys.reduce((n,x)=>n+(Number(x.hb9Amount)||0),0)),
    totalHb9Sold:roundCurrency(sells.reduce((n,x)=>n+(Number(x.hb9Amount)||0),0)),
    netHb9Supply:roundCurrency(buys.reduce((n,x)=>n+(Number(x.hb9Amount)||0),0)-sells.reduce((n,x)=>n+(Number(x.hb9Amount)||0),0)),
    totalUsdtIn:roundCurrency(buys.reduce((n,x)=>n+(Number(x.usdtAmount)||0),0)),
    totalUsdtOut:roundCurrency(sells.reduce((n,x)=>n+(Number(x.usdtAmount)||0),0))
  };
}
async function exchangeMarket(db,interval='1d',limit=120){
  const settings=marketSettings(db), manual=Boolean(settings.manualOverrideEnabled);
  if(process.env.MARKET_TEST_MODE==='true'){
    const icpPrice=Number(settings.fallbackPrice)||0.2, candles=Array.from({length:limit},(_,index)=>{const open=icpPrice+(index%5)*.001,close=open+(index%2?.0015:-.001);return {time:Date.now()-(limit-index)*86400000,open,high:open+.003,low:open-.003,close,volume:1000+index}});
    const prices=offsetPrices(manual?settings.fallbackPrice:icpPrice,settings);
    return {source:manual?'manual_override':'icp_proxy',price:prices.basePrice,icpPrice:prices.basePrice,hb9BasePrice:prices.basePrice,priceOffset:prices.priceOffset,hb9BuyPrice:prices.buyPrice,hb9SellPrice:prices.sellPrice,buyPrice:prices.buyPrice,sellPrice:prices.sellPrice,spreadPercent:settings.spreadPercent,manualOverrideEnabled:manual,high24h:.21,low24h:.19,baseVolume:100000,quoteVolume:20000,changePercent:1.25,candles};
  }
  if(manual){
    const prices=offsetPrices(settings.fallbackPrice,settings);
    return {source:'manual_override',price:prices.basePrice,icpPrice:null,hb9BasePrice:prices.basePrice,priceOffset:prices.priceOffset,hb9BuyPrice:prices.buyPrice,hb9SellPrice:prices.sellPrice,buyPrice:prices.buyPrice,sellPrice:prices.sellPrice,spreadPercent:settings.spreadPercent,manualOverrideEnabled:true,high24h:prices.buyPrice,low24h:prices.sellPrice,baseVolume:0,quoteVolume:0,changePercent:0,candles:[]};
  }
  try{
    const base='https://api.binance.com/api/v3',[tickerResponse,klinesResponse]=await Promise.all([fetch(`${base}/ticker/24hr?symbol=ICPUSDT`),fetch(`${base}/klines?symbol=ICPUSDT&interval=${interval}&limit=${limit}`)]);
    if(!tickerResponse.ok||!klinesResponse.ok)throw Error('Market request failed');
    const [ticker,candles]=await Promise.all([tickerResponse.json(),klinesResponse.json()]);
    const icpPrice=Number(ticker.lastPrice);
    if(!Number.isFinite(icpPrice)||!Array.isArray(candles)||!candles.length)throw Error('Invalid market response');
    const prices=offsetPrices(icpPrice,settings);
    return {source:'icp_proxy',price:prices.basePrice,icpPrice:prices.basePrice,hb9BasePrice:prices.basePrice,priceOffset:prices.priceOffset,hb9BuyPrice:prices.buyPrice,hb9SellPrice:prices.sellPrice,buyPrice:prices.buyPrice,sellPrice:prices.sellPrice,spreadPercent:settings.spreadPercent,manualOverrideEnabled:false,high24h:Number(ticker.highPrice),low24h:Number(ticker.lowPrice),baseVolume:Number(ticker.volume),quoteVolume:Number(ticker.quoteVolume),changePercent:Number(ticker.priceChangePercent),candles:candles.map(x=>({time:x[0],open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[5])}))};
  }catch(_){
    const prices=offsetPrices(Number(settings.fallbackPrice)||0.2,settings);
    return {source:'fallback',price:prices.basePrice,icpPrice:prices.basePrice,hb9BasePrice:prices.basePrice,priceOffset:prices.priceOffset,hb9BuyPrice:prices.buyPrice,hb9SellPrice:prices.sellPrice,buyPrice:prices.buyPrice,sellPrice:prices.sellPrice,spreadPercent:settings.spreadPercent,manualOverrideEnabled:false,high24h:prices.buyPrice,low24h:prices.sellPrice,baseVolume:0,quoteVolume:0,changePercent:0,candles:[]};
  }
}
async function bnbMarket(interval='1d',limit=120){
  const fallback=Number(process.env.BNB_USDT_FALLBACK_PRICE||process.env.BNB_PRICE_FALLBACK||600);
  if(process.env.MARKET_TEST_MODE==='true'){
    const candles=Array.from({length:limit},(_,index)=>{const open=fallback+(index%5),close=open+(index%2?2:-1);return {time:Date.now()-(limit-index)*86400000,open,high:open+3,low:open-3,close,volume:1000+index}});
    return {source:'test_fallback',symbol:'BNBUSDT',pair:'BNB/USDT',price:fallback,buyPrice:fallback,sellPrice:fallback,high24h:fallback+10,low24h:fallback-10,baseVolume:100000,quoteVolume:fallback*100000,changePercent:1.1,candles};
  }
  try{
    const base=process.env.BNB_PRICE_API_BASE||'https://api.binance.com/api/v3';
    const [tickerResponse,klinesResponse]=await Promise.all([fetch(`${base}/ticker/24hr?symbol=BNBUSDT`),fetch(`${base}/klines?symbol=BNBUSDT&interval=${interval}&limit=${limit}`)]);
    if(!tickerResponse.ok||!klinesResponse.ok)throw Error('BNB market request failed');
    const [ticker,candles]=await Promise.all([tickerResponse.json(),klinesResponse.json()]);
    const price=Number(ticker.lastPrice);
    if(!Number.isFinite(price)||price<=0||!Array.isArray(candles))throw Error('Invalid BNB market response');
    return {source:'binance',symbol:'BNBUSDT',pair:'BNB/USDT',price:roundCurrency(price),buyPrice:roundCurrency(price),sellPrice:roundCurrency(price),high24h:Number(ticker.highPrice),low24h:Number(ticker.lowPrice),baseVolume:Number(ticker.volume),quoteVolume:Number(ticker.quoteVolume),changePercent:Number(ticker.priceChangePercent),candles:candles.map(k=>({time:Number(k[0]),open:Number(k[1]),high:Number(k[2]),low:Number(k[3]),close:Number(k[4]),volume:Number(k[5])}))};
  }catch(error){
    const candles=Array.from({length:limit},(_,index)=>({time:Date.now()-(limit-index)*86400000,open:fallback,high:fallback,low:fallback,close:fallback,volume:0}));
    return {source:'fallback',symbol:'BNBUSDT',pair:'BNB/USDT',price:fallback,buyPrice:fallback,sellPrice:fallback,high24h:fallback,low24h:fallback,baseVolume:0,quoteVolume:0,changePercent:0,candles};
  }
}
function userById(db, userId) { return db.users.find(u => u.id === userId); }
function activeStakes(db, userId) { return db.stakes.filter(s=>s.userId===userId && s.status==='active'); }
function activeStakeUsd(db,userId){return activeStakes(db,userId).reduce((n,s)=>n+(Number(s.usdValueAtStake)||Number(s.amount)||0),0);}
function activeStakeHb9(db,userId){return activeStakes(db,userId).reduce((n,s)=>n+(Number(s.coinAmount)||Number(s.hb9Amount)||0),0);}
function qualifiedDirectReferralCount(db,userId,excludeUserId=null){return (db.users||[]).filter(u=>u.id!==excludeUserId&&u.sponsorId===userId&&activeStakeUsd(db,u.id)>=LEVEL_DIRECT_MIN_STAKE_USD).length;}
function salaryCycleStart(date=today()){const d=new Date(`${date}T00:00:00.000Z`),days=Math.floor(d.getTime()/86400000),startDays=days-(days%SALARY_CYCLE_DAYS),start=new Date(startDays*86400000);return start.toISOString().slice(0,10);}
function salaryCycleEnd(cycleStart){return datePlus(cycleStart,SALARY_CYCLE_DAYS-1);}
function salaryDirectCount(db,userId,minStakeUsd){return (db.users||[]).filter(u=>u.sponsorId===userId&&activeStakeUsd(db,u.id)>=minStakeUsd).length;}
function downlineUsers(db,userId,maxLevel=20){
  const result=[], queue=[{userId,level:0}];
  while(queue.length){
    const current=queue.shift();
    if(current.level>=maxLevel)continue;
    (db.users||[]).filter(u=>u.sponsorId===current.userId&&u.role==='user').forEach(child=>{const level=current.level+1;result.push({user:child,level});queue.push({userId:child.id,level});});
  }
  return result;
}
function salaryTeamBusinessUsd(db,userId){return roundCurrency(downlineUsers(db,userId,20).reduce((sum,item)=>sum+activeStakeUsd(db,item.user.id),0));}
function totalSalaryPaidUsd(db,userId){ensureSalaryTables(db);return roundCurrency(db.salary_payouts.filter(x=>x.userId===userId&&x.status==='credited').reduce((n,x)=>n+(Number(x.usdAmount)||0),0));}
function salaryProgressForRank(db,userId,rank){
  const personalInvestment=roundCurrency(activeStakeUsd(db,userId)), directCount=salaryDirectCount(db,userId,rank.directMinStakeUsd), teamBusiness=salaryTeamBusinessUsd(db,userId);
  const qualified=directCount>=rank.requiredDirectReferrals&&personalInvestment>=rank.requiredSelfPackageUsd&&teamBusiness>=rank.requiredTeamBusinessUsd;
  return {rank:rank.rank,rankName:rank.name,qualified,directCount,requiredDirectReferrals:rank.requiredDirectReferrals,directMinStakeUsd:rank.directMinStakeUsd,selfPackageUsd:personalInvestment,requiredSelfPackageUsd:rank.requiredSelfPackageUsd,teamBusinessUsd:teamBusiness,requiredTeamBusinessUsd:rank.requiredTeamBusinessUsd,salaryUsd:rank.salaryUsd};
}
function salaryReport(db,userId){
  ensureSalaryTables(db);
  const ranks=db.salary_ranks.map(rank=>salaryProgressForRank(db,userId,rank));
  const current=[...ranks].reverse().find(x=>x.qualified)||null, next=ranks.find(x=>!x.qualified)||null;
  const personalInvestment=roundCurrency(activeStakeUsd(db,userId)), maxSalaryCapUsd=roundCurrency(personalInvestment*3), totalPaidUsd=totalSalaryPaidUsd(db,userId), remainingCapUsd=roundCurrency(Math.max(0,maxSalaryCapUsd-totalPaidUsd));
  const now=new Date().toISOString();
  ranks.forEach(progress=>{
    const existing=db.salary_qualifications.find(x=>x.userId===userId&&x.rank===progress.rank);
    const record={...progress,userId,status:progress.qualified?'qualified':'pending',checkedAt:now,immutable:true};
    if(existing)Object.assign(existing,record);else db.salary_qualifications.push({id:id('salq'),createdAt:now,...record});
  });
  return {currentRank:current,nextRank:next,rankProgress:ranks,directCountProgress:next?{current:next.directCount,required:next.requiredDirectReferrals,minStakeUsd:next.directMinStakeUsd}:null,selfPackageProgress:next?{current:next.selfPackageUsd,required:next.requiredSelfPackageUsd}:null,teamBusinessProgress:next?{current:next.teamBusinessUsd,required:next.requiredTeamBusinessUsd,levels:20}:null,salaryCap:{personalInvestmentUsd:personalInvestment,maxSalaryCapUsd,totalSalaryPaidUsd:totalPaidUsd,usedUsd:totalPaidUsd,remainingUsd:remainingCapUsd},payoutHistory:db.salary_payouts.filter(x=>x.userId===userId)};
}
async function processSalaryPayouts(db,date=today()){
  ensureSalaryTables(db);
  const market=await exchangeMarket(db,'1d',1), price=Number(market.hb9BasePrice||market.price||market.icpPrice||marketSettings(db).fallbackPrice), cycleStart=salaryCycleStart(date), cycleEnd=salaryCycleEnd(cycleStart), createdAt=new Date().toISOString();
  const summary={date,cycleStart,cycleEnd,hb9Price:price,processedUsers:0,creditedUsers:0,queuedUsers:0,cappedUsers:0,totalSalaryUsd:0,totalSalaryHb9:0,skippedUsers:0};
  for(const user of (db.users||[]).filter(x=>x.role==='user')){
    const report=salaryReport(db,user.id), rank=report.currentRank;
    if(!rank){summary.skippedUsers++;continue;}
    if(db.salary_payouts.some(x=>x.userId===user.id&&x.cycleStart===cycleStart&&x.status!=='superseded')){summary.skippedUsers++;continue;}
    summary.processedUsers++;
    const remainingCap=report.salaryCap.remainingUsd, payableUsd=roundCurrency(Math.min(rank.salaryUsd,remainingCap)), payoutId=id('salp');
    if(payableUsd<=0){
      db.salary_payouts.push({id:payoutId,userId:user.id,type:'SALARY_INCOME',asset:'HB9',rank:rank.rank,rankName:rank.rankName,cycleStart,cycleEnd,usdAmount:0,hb9Amount:0,hb9PriceAtPayout:price,status:'capped',reason:'Salary cap reached',personalInvestmentUsd:report.salaryCap.personalInvestmentUsd,maxSalaryCapUsd:report.salaryCap.maxSalaryCapUsd,totalSalaryPaidUsd:report.salaryCap.totalSalaryPaidUsd,createdAt,immutable:true});
      summary.cappedUsers++;
      continue;
    }
    const hb9Amount=price>0?roundCurrency(payableUsd/price):0;
    let status='credited', reason='Salary income credited';
    try{
      reserveMove(db,{asset:'HB9',walletType:'income',direction:'debit',amount:hb9Amount,reason:'Salary income emission',userId:user.id,refId:payoutId});
      walletEntry(db,{userId:user.id,asset:'HB9',direction:'credit',amount:hb9Amount,reason:'Salary income credited',refId:payoutId});
      summary.creditedUsers++;summary.totalSalaryUsd=roundCurrency(summary.totalSalaryUsd+payableUsd);summary.totalSalaryHb9=roundCurrency(summary.totalSalaryHb9+hb9Amount);
    }catch(error){
      status='queued';reason='HB9 income reserve insufficient';summary.queuedUsers++;
    }
    db.salary_payouts.push({id:payoutId,userId:user.id,type:'SALARY_INCOME',asset:'HB9',rank:rank.rank,rankName:rank.rankName,cycleStart,cycleEnd,usdAmount:payableUsd,hb9Amount,status,reason,hb9PriceAtPayout:price,personalInvestmentUsd:report.salaryCap.personalInvestmentUsd,maxSalaryCapUsd:report.salaryCap.maxSalaryCapUsd,totalSalaryPaidUsd:report.salaryCap.totalSalaryPaidUsd,createdAt,immutable:true});
    db.income_emissions.push({id:id('iem'),userId:user.id,type:'SALARY_INCOME',asset:'HB9',amount:hb9Amount,valueUsd:payableUsd,status,reason,createdAt,immutable:true});
  }
  return summary;
}
function unlockedLevel(db,userId){return Math.min(qualifiedDirectReferralCount(db,userId),LEVEL_INCOME_PERCENTS.length);}
function business(db, userId) { return db.directBusiness.filter(x=>x.userId===userId).reduce((n,x)=>n+x.amount,0); }
function ledgerTotal(db,userId,type) { return db.incomeLedger.filter(x=>x.userId===userId && x.type===type).reduce((n,x)=>n+x.amount,0); }
function referralTotal(db,userId) { return (db.referralLedger||[]).filter(x=>x.sponsorId===userId).reduce((n,x)=>n+x.referralAmount,0); }
function levelIncomeTotal(db,userId) { return (db.level_income_ledger||[]).filter(x=>x.receiverUserId===userId&&x.status==='credited').reduce((n,x)=>n+(Number(x.hb9Amount)||0),0); }
function payLevelIncome(db,sourceUser,stake,payoutPrice){
  db.level_income_ledger=db.level_income_ledger||[];
  db.income_emissions=db.income_emissions||[];
  let receiverId=sourceUser.sponsorId;
  for(let index=0;index<LEVEL_INCOME_PERCENTS.length;index++){
    const level=index+1, percent=LEVEL_INCOME_PERCENTS[index];
    if(!receiverId)break;
    const receiver=userById(db,receiverId);
    if(!receiver)break;
    if(db.level_income_ledger.some(x=>x.stakeId===stake.id&&x.level===level)){receiverId=receiver.sponsorId;continue;}
    const qualifiedDirects=qualifiedDirectReferralCount(db,receiver.id,sourceUser.id), receiverUnlockedLevel=Math.min(qualifiedDirects,LEVEL_INCOME_PERCENTS.length), requiredDirectsForLevel=level;
    if(receiverUnlockedLevel<level){
      const createdAt=new Date().toISOString(), recordId=id('lvl');
      db.level_income_ledger.push({id:recordId,type:'LEVEL_INCOME',asset:'HB9',receiverUserId:receiver.id,sourceUserId:sourceUser.id,stakeId:stake.id,level,percent,usdValue:0,hb9Amount:0,status:'locked',qualifiedDirectReferralCount:qualifiedDirects,unlockedLevel:receiverUnlockedLevel,requiredDirectsForLevel,levelLockedReason:`Level ${level} requires ${requiredDirectsForLevel} qualified direct referrals with at least $${LEVEL_DIRECT_MIN_STAKE_USD} staked`,createdAt,immutable:true});
      receiverId=receiver.sponsorId;
      continue;
    }
    const usdValue=roundCurrency(stake.usdValueAtStake*percent/100), hb9Amount=payoutPrice>0?roundCurrency(usdValue/payoutPrice):0, createdAt=new Date().toISOString(), recordId=id('lvl');
    let status='credited';
    try{
      reserveMove(db,{asset:'HB9',walletType:'income',direction:'debit',amount:hb9Amount,reason:`Level ${level} income emission`,userId:receiver.id,refId:recordId});
      walletEntry(db,{userId:receiver.id,asset:'HB9',direction:'credit',amount:hb9Amount,reason:`Level ${level} income credited`,refId:recordId});
    }catch(error){
      status='queued';
    }
    db.level_income_ledger.push({id:recordId,type:'LEVEL_INCOME',asset:'HB9',receiverUserId:receiver.id,sourceUserId:sourceUser.id,stakeId:stake.id,level,percent,usdValue,hb9Amount,hb9PriceAtPayout:payoutPrice,status,qualifiedDirectReferralCount:qualifiedDirects,unlockedLevel:receiverUnlockedLevel,requiredDirectsForLevel,levelLockedReason:null,createdAt,immutable:true});
    db.income_emissions.push({id:id('iem'),userId:receiver.id,type:'LEVEL_INCOME',asset:'HB9',amount:hb9Amount,valueUsd:usdValue,status,reason:status==='queued'?'HB9 income reserve insufficient':`Level ${level} income credited`,createdAt,immutable:true});
    receiverId=receiver.sponsorId;
  }
}
function distributeStakeIncome(db,user,stake,payoutPrice,isFirstStake){
  if(!stake||!user)return;
  db.referralLedger=db.referralLedger||[];
  db.income_emissions=db.income_emissions||[];
  db.directBusiness=db.directBusiness||[];
  const stakeUsd=Number(stake.usdValueAtStake)||Number(stake.amount)||0;
  if(user.sponsorId){
    if(!db.referralLedger.some(x=>x.stakeId===stake.id&&x.type==='REFERRAL_INCOME')){
      const referralPercent=setting(db,'referralPercent'),referralUsdAmount=roundCurrency(stakeUsd*referralPercent/100),referralHb9Amount=payoutPrice>0?roundCurrency(referralUsdAmount/payoutPrice):0,refId=id('ref'),createdAt=new Date().toISOString();
      let status='credited',creditedHb9=referralHb9Amount,note='Referral income credited';
      try{reserveMove(db,{asset:'HB9',walletType:'income',direction:'debit',amount:referralHb9Amount,reason:'Referral income emission',userId:user.sponsorId,refId});walletEntry(db,{userId:user.sponsorId,asset:'HB9',direction:'credit',amount:referralHb9Amount,reason:'Referral income credited',refId});}catch(error){status='queued';creditedHb9=0;note='HB9 income reserve insufficient';}
      db.referralLedger.push({id:refId,type:'REFERRAL_INCOME',asset:'HB9',sponsorId:user.sponsorId,referredUserId:user.id,stakeId:stake.id,stakeAsset:stake.stakeAsset||'HB9',stakeAmount:stakeUsd,stakeCoinAmount:Number(stake.hb9EquivalentAmount)||Number(stake.coinAmount)||0,referralPercent,referralAmount:creditedHb9,referralHb9Amount:creditedHb9,queuedHb9Amount:status==='queued'?referralHb9Amount:0,referralUsdAmount,hb9PriceAtCredit:payoutPrice,hb9PriceAtPayout:payoutPrice,status,note,date:today(),createdAt,immutable:true});
      db.income_emissions.push({id:id('iem'),userId:user.sponsorId,type:'REFERRAL_INCOME',asset:'HB9',amount:referralHb9Amount,valueUsd:referralUsdAmount,status,reason:note,createdAt,immutable:true});
    }
    if(!db.directBusiness.some(x=>x.userId===user.sponsorId&&x.sourceUserId===user.id&&x.stakeId===stake.id)){
      db.directBusiness.push({id:id('biz'),userId:user.sponsorId,sourceUserId:user.id,stakeId:stake.id,amount:roundCurrency(stakeUsd),reason:'Direct referral stake business',createdAt:new Date().toISOString(),immutable:true});
    }
  }
  if(isFirstStake)payLevelIncome(db,user,stake,payoutPrice);
}
function walletBalances(db,userId) {
  const deposits=db.deposits.filter(x=>x.userId===userId&&(x.status==='approved'||x.status==='credited')).reduce((n,x)=>n+x.amount,0);
  const adminUsdt=(db.wallet_ledger||[]).filter(x=>x.userId===userId&&x.asset==='USDT'&&x.type==='ADMIN_FUND_TRANSFER').reduce((n,x)=>n+(x.direction==='credit'?1:-1)*(Number(x.amount)||0),0);
  const adminHb9=(db.wallet_ledger||[]).filter(x=>x.userId===userId&&x.asset==='HB9'&&x.type==='ADMIN_FUND_TRANSFER').reduce((n,x)=>n+(x.direction==='credit'?1:-1)*(Number(x.amount)||0),0);
  const adminBnb=(db.wallet_ledger||[]).filter(x=>x.userId===userId&&x.asset==='BNB'&&x.type==='ADMIN_FUND_TRANSFER').reduce((n,x)=>n+(x.direction==='credit'?1:-1)*(Number(x.amount)||0),0);
  const conversions=(db.conversions||[]).filter(x=>x.userId===userId), buys=conversions.filter(x=>!x.direction||x.direction==='buy'), sells=conversions.filter(x=>x.direction==='sell');
  const convertedUsdt=buys.reduce((n,x)=>n+(Number(x.usdtAmount)||Number(x.fromAmount)||0),0), receivedHb9=buys.reduce((n,x)=>n+(Number(x.hb9Amount)||((x.toAsset==='HB9'||!x.toAsset)?Number(x.toAmount)||0:0)),0), receivedBnb=buys.reduce((n,x)=>n+(Number(x.bnbAmount)||((x.toAsset==='BNB')?Number(x.toAmount)||0:0)),0), soldHb9=sells.reduce((n,x)=>n+x.hb9Amount,0), receivedUsdt=sells.reduce((n,x)=>n+x.usdtAmount,0), transfers=db.transfers||[], sentHb9=transfers.filter(x=>x.senderId===userId).reduce((n,x)=>n+x.amount+x.fee,0), receivedTransferHb9=transfers.filter(x=>x.receiverId===userId).reduce((n,x)=>n+x.amount,0);
  const stakedHb9=db.stakes.filter(x=>x.userId===userId&&(x.stakeAsset||'HB9')==='HB9').reduce((n,x)=>n+(Number(x.stakeAmount)||Number(x.coinAmount)||0),0);
  const stakedBnb=db.stakes.filter(x=>x.userId===userId&&x.stakeAsset==='BNB').reduce((n,x)=>n+(Number(x.stakeAmount)||0),0);
  const withdrawals=(db.withdrawals||[]).filter(x=>x.userId===userId&&x.status!=='rejected').reduce((n,x)=>n+x.amount,0);
  const b1Hb9=(db.incomeLedger||[]).filter(x=>x.userId===userId&&x.type==='B1_INCOME'&&x.status==='credited').reduce((n,x)=>n+(Number(x.hb9Amount) || Number(x.amount) || 0),0);
  const referralHb9=(db.referralLedger||[]).filter(x=>x.sponsorId===userId&&(!x.status||x.status==='credited')).reduce((n,x)=>n+(Number(x.referralHb9Amount) || Number(x.referralAmount) || 0),0);
  const levelHb9=levelIncomeTotal(db,userId);
  const salaryHb9=(db.salary_payouts||[]).filter(x=>x.userId===userId&&x.status==='credited').reduce((n,x)=>n+(Number(x.hb9Amount)||0),0);
  const bnbLedger=(db.wallet_ledger||[]).filter(x=>x.userId===userId&&String(x.asset||'').toUpperCase()==='BNB');
  const bnbFromLedger=bnbLedger.reduce((n,x)=>n+(['credit','unlock'].includes(x.direction)?1:-1)*(Number(x.amount)||0),0);
  return {usdt:roundCurrency(deposits+adminUsdt-convertedUsdt+receivedUsdt-withdrawals),withdrawableUsdt:roundCurrency(receivedUsdt+adminUsdt-withdrawals),hb9:roundCurrency(receivedHb9+adminHb9+b1Hb9+referralHb9+levelHb9+salaryHb9-soldHb9-stakedHb9-sentHb9+receivedTransferHb9),bnb:roundAssetAmount('BNB',bnbLedger.length?bnbFromLedger:receivedBnb+adminBnb-stakedBnb),totalDeposit:roundCurrency(deposits)};
}
function bnbLedgerDiagnostic(db,userId){
  const entries=(db.wallet_ledger||[]).filter(x=>x.userId===userId&&String(x.asset||'').toUpperCase()==='BNB');
  const credits=roundAssetAmount('BNB',entries.filter(x=>x.direction==='credit'||x.direction==='unlock').reduce((n,x)=>n+(Number(x.amount)||0),0));
  const debits=roundAssetAmount('BNB',entries.filter(x=>!['credit','unlock'].includes(x.direction)).reduce((n,x)=>n+(Number(x.amount)||0),0));
  return {userId,asset:'BNB',credits,debits,computedBalance:roundAssetAmount('BNB',credits-debits),dashboardBalance:walletBalances(db,userId).bnb,entries};
}
function flushTotal(db,userId) { return db.flushRecords.filter(x=>x.userId===userId).reduce((n,x)=>n+x.flushedIncome,0); }
function deterministicInt(seed, min, max) {
  const low=Math.ceil(Number(min)), high=Math.floor(Number(max));
  const span=Math.max(1,high-low+1), seedNum=[...seed].reduce((n,c)=>n+c.charCodeAt(0),0);
  return low+(seedNum%span);
}
function globalTeamUnits(valueUsd){return Math.round((Number(valueUsd)||0)/0.02);}
function audit(db,type,details){db.auditLogs=db.auditLogs||[];const record={id:id('aud'),type,details,createdAt:new Date().toISOString()};db.auditLogs.push(record);if(/^(GLOBAL_TEAM|ROI)_/.test(type))console.log(type,{...details,createdAt:record.createdAt});}
function emitDepositAddressLog(db,type,details){console.warn(type,details);audit(db,type,details);}
function normalizeChain(chain){return String(chain||'BSC').trim().toUpperCase();}
function nextHdIndex(db,chain){return (db.deposit_addresses||[]).filter(x=>x.chain===chain).reduce((max,x)=>Math.max(max,Number(x.hdIndex)||0),-1)+1;}
function hdBaseDerivationPath(){return String(process.env.HD_WALLET_DERIVATION_PATH||DEFAULT_HD_DERIVATION_PATH).trim()||DEFAULT_HD_DERIVATION_PATH;}
function depositDerivationPath(index,basePath=hdBaseDerivationPath()){return `${basePath}/${Number(index)}`;}
function hdFingerprint(value=process.env.HD_WALLET_XPUB||''){return value?crypto.createHash('sha256').update(String(value)).digest('hex').slice(0,16):null;}
function configuredDepositXpub(){return HDNodeWallet.fromExtendedKey(process.env.HD_WALLET_XPUB);}
function configuredHdSignerSource(){return process.env.HD_WALLET_MNEMONIC?'HD_WALLET_MNEMONIC':process.env.HD_WALLET_XPRV?'HD_WALLET_XPRV':null;}
function currentHdWalletIndexAddress(index=0){
  const walletIndex=Number(index);
  return {
    mnemonic:getAddress(HDNodeWallet.fromPhrase(process.env.HD_WALLET_MNEMONIC,'',depositDerivationPath(walletIndex)).address),
    xpub:getAddress(HDNodeWallet.fromExtendedKey(process.env.HD_WALLET_XPUB).deriveChild(walletIndex).address),
    xprv:getAddress(HDNodeWallet.fromExtendedKey(process.env.HD_WALLET_XPRV).deriveChild(walletIndex).address)
  };
}
function expectedXpubFromSigner(){
  if(process.env.HD_WALLET_MNEMONIC)return HDNodeWallet.fromPhrase(process.env.HD_WALLET_MNEMONIC,'',hdBaseDerivationPath()).neuter().extendedKey;
  if(process.env.HD_WALLET_XPRV)return HDNodeWallet.fromExtendedKey(process.env.HD_WALLET_XPRV).neuter().extendedKey;
  return null;
}
function hdWalletConsistencyStatus(){
  const missing=['HD_WALLET_MNEMONIC','HD_WALLET_XPUB','HD_WALLET_XPRV','HD_WALLET_DERIVATION_PATH'].filter(name=>!String(process.env[name]||'').trim());
  if(missing.length)return {configured:false,error:`Missing HD wallet configuration: ${missing.join(', ')}`,missing};
  try{
    const addresses=currentHdWalletIndexAddress(0),unique=new Set(Object.values(addresses).map(x=>x.toLowerCase()));
    if(unique.size!==1)return {configured:false,error:'HD_WALLET_MNEMONIC, HD_WALLET_XPUB, HD_WALLET_XPRV, and HD_WALLET_DERIVATION_PATH do not derive the same address at index 0',addresses,hdFingerprint:hdFingerprint(),derivationPath:hdBaseDerivationPath(),signerSource:'HD_WALLET_MNEMONIC+HD_WALLET_XPRV'};
    const expected=HDNodeWallet.fromPhrase(process.env.HD_WALLET_MNEMONIC,'',hdBaseDerivationPath()).neuter().extendedKey;
    if(expected!==process.env.HD_WALLET_XPUB)return {configured:false,error:'HD_WALLET_XPUB does not match HD_WALLET_MNEMONIC at HD_WALLET_DERIVATION_PATH',addresses,hdFingerprint:hdFingerprint(),derivationPath:hdBaseDerivationPath(),signerSource:'HD_WALLET_MNEMONIC+HD_WALLET_XPRV'};
    if(HDNodeWallet.fromExtendedKey(process.env.HD_WALLET_XPRV).neuter().extendedKey!==process.env.HD_WALLET_XPUB)return {configured:false,error:'HD_WALLET_XPRV does not match HD_WALLET_XPUB at HD_WALLET_DERIVATION_PATH',addresses,hdFingerprint:hdFingerprint(),derivationPath:hdBaseDerivationPath(),signerSource:'HD_WALLET_MNEMONIC+HD_WALLET_XPRV'};
    return {configured:true,address0:addresses.mnemonic,addresses,hdFingerprint:hdFingerprint(),derivationPath:hdBaseDerivationPath(),signerSource:'HD_WALLET_MNEMONIC+HD_WALLET_XPRV'};
  }catch(error){return {configured:false,error:`HD wallet configuration is invalid: ${error.message}`,hdFingerprint:hdFingerprint(),derivationPath:hdBaseDerivationPath(),signerSource:'HD_WALLET_MNEMONIC+HD_WALLET_XPRV'};}
}
function depositServiceStatus(){
  const missing=[];
  if(!process.env.NOWPAYMENTS_API_KEY)missing.push('NOWPAYMENTS_API_KEY');
  if(!process.env.NOWPAYMENTS_IPN_SECRET)missing.push('NOWPAYMENTS_IPN_SECRET');
  return {configured:missing.length===0,provider:'NOWPayments',missing,message:missing.length?'NOWPayments deposit gateway is not configured yet.':'NOWPayments deposit gateway is active.'};
}
function depositAddressServiceStatus(){
  const status=hdWalletConsistencyStatus();
  return status.configured?status:{configured:false,error:status.error||'Deposit address service is not configured'};
}
function positiveEnvNumber(name,defaultValue){const value=Number(process.env[name]??defaultValue);return Number.isFinite(value)&&value>0?value:null;}
function configuredDepositWatcherStartBlock(value=process.env.DEPOSIT_WATCHER_START_BLOCK){
  const raw=String(value??'').trim();
  if(!raw||raw.toLowerCase()==='latest')return null;
  const block=Number(raw);
  return Number.isInteger(block)&&block>=0?block:null;
}
function resolveDepositWatcherStart({latestBlock,confirmations,state={},startBlock=process.env.DEPOSIT_WATCHER_START_BLOCK,resetCursor=false}){
  const latest=Math.max(0,Number(latestBlock)), required=Math.max(1,Number(confirmations)||12), configuredStart=configuredDepositWatcherStartBlock(startBlock), defaultStart=Math.max(0,latest-required);
  if(resetCursor)return {nextBlock:latest,cursorMode:'latest',configuredStartBlock:null,reset:true};
  const saved=Number(state.lastProcessedBlock);
  if(configuredStart!==null){
    const canResume=state.cursorMode==='configured'&&Number(state.configuredStartBlock)===configuredStart&&Number.isInteger(saved)&&saved>=configuredStart;
    return {nextBlock:canResume?saved+1:configuredStart,cursorMode:'configured',configuredStartBlock:configuredStart,reset:false};
  }
  // Legacy/unqualified cursors are deliberately ignored: automatic mode must never
  // resume an arbitrary historical scan after DEPOSIT_WATCHER_START_BLOCK is removed.
  const canResume=state.cursorMode==='latest'&&Number.isInteger(saved)&&saved>=defaultStart;
  return {nextBlock:canResume?saved+1:defaultStart,cursorMode:'latest',configuredStartBlock:null,reset:false};
}
function depositWatcherLookbackBlocks(value=process.env.DEPOSIT_WATCHER_LOOKBACK_BLOCKS){
  const blocks=Number(value??5000);
  return Number.isInteger(blocks)&&blocks>=0?blocks:5000;
}
function resolveDepositWatcherLiveScanRange({latestBlock,confirmations,state={},startBlock=process.env.DEPOSIT_WATCHER_START_BLOCK,resetCursor=false,lookbackBlocks=process.env.DEPOSIT_WATCHER_LOOKBACK_BLOCKS}){
  const latest=Math.max(0,Number(latestBlock)),required=Math.max(1,Number(confirmations)||12),lookback=depositWatcherLookbackBlocks(lookbackBlocks),confirmedToBlock=Math.max(0,latest-required);
  const start=resolveDepositWatcherStart({latestBlock:latest,confirmations:required,state,startBlock,resetCursor});
  if(start.reset)return {...start,nextBlock:latest,toBlock:latest,confirmedToBlock,lookbackBlocks:lookback,lookbackStartBlock:Math.max(0,latest-lookback),cursorNextBlock:latest};
  const cursorNextBlock=start.nextBlock,lookbackStartBlock=Math.max(0,latest-lookback),nextBlock=Math.min(cursorNextBlock,lookbackStartBlock);
  return {...start,nextBlock,toBlock:confirmedToBlock,confirmedToBlock,lookbackBlocks:lookback,lookbackStartBlock,cursorNextBlock};
}
function watcherLogContext(log){
  const logIndex=Number.isInteger(log?.index)?log.index:Number.isInteger(log?.logIndex)?log.logIndex:null;
  return {transactionHash:typeof log?.transactionHash==='string'?log.transactionHash:null,blockNumber:Number.isInteger(log?.blockNumber)?log.blockNumber:null,logIndex,contractAddress:log?.address??log?.contractAddress??null};
}
function watcherConfiguredTokenAddress(){
  try{return isAddress(process.env.USDT_BEP20_CONTRACT||'')?getAddress(process.env.USDT_BEP20_CONTRACT):null;}catch(_){return null;}
}
function normalizedAddressLower(address){
  try{return isAddress(String(address||'').trim())?getAddress(String(address||'').trim()).toLowerCase():null;}catch(_){return null;}
}
function watcherReject(log,reason,extra={}){
  console.warn('WATCHER_TRANSFER_REJECTED',{reason,...watcherLogContext(log),...extra});
  return {reason};
}
function parseBep20TransferWatcherLog(log){
  if(!log||typeof log!=='object')return watcherReject(log,'log is not an object');
  const contractAddress=log.address??log.contractAddress,configuredToken=watcherConfiguredTokenAddress();
  if(configuredToken){
    if(!isAddress(contractAddress||''))return watcherReject(log,'contract address is missing or invalid',{expectedContract:configuredToken});
    if(getAddress(contractAddress)!==configuredToken)return watcherReject(log,'contract address does not match USDT_BEP20_CONTRACT',{expectedContract:configuredToken,actualContract:getAddress(contractAddress)});
  }
  if(!Array.isArray(log.topics)||log.topics.length<3)return watcherReject(log,'Transfer log must contain at least three topics');
  if(String(log.topics[0]).toLowerCase()!==TRANSFER_TOPIC.toLowerCase())return watcherReject(log,'topic0 is not the ERC20 Transfer signature');
  if(!/^0x[0-9a-fA-F]{64}$/.test(String(log.data||'')))return watcherReject(log,'data is not a 32-byte hexadecimal amount');
  if(!/^0x[0-9a-fA-F]{64}$/.test(String(log.topics[1]))||!/^0x[0-9a-fA-F]{64}$/.test(String(log.topics[2])))return watcherReject(log,'from or to topic is not a 32-byte hexadecimal value');
  if(!/^0x[0-9a-fA-F]{64}$/.test(String(log.transactionHash||'')))return watcherReject(log,'transaction hash is invalid');
  const logIndex=Number.isInteger(log.index)?log.index:Number.isInteger(log.logIndex)?log.logIndex:null;
  if(!Number.isInteger(logIndex)||logIndex<0)return watcherReject(log,'log index is invalid');
  if(!Number.isInteger(log.blockNumber)||log.blockNumber<0)return watcherReject(log,'block number is invalid');
  try{
    const rawAmount=BigInt(log.data),event={chain:BSC_CHAIN,txHash:log.transactionHash.toLowerCase(),logIndex,blockNumber:log.blockNumber,fromAddress:getAddress(`0x${String(log.topics[1]).slice(-40)}`),toAddress:getAddress(`0x${String(log.topics[2]).slice(-40)}`),amount:Number(formatUnits(rawAmount,USDT_BEP20_DECIMALS)),rawAmount:rawAmount.toString(),contractAddress:contractAddress?getAddress(contractAddress):null,topics:log.topics,data:log.data};
    console.log('WATCHER_TRANSFER_DECODED',{txHash:event.txHash,logIndex:event.logIndex,fromAddress:event.fromAddress,toAddress:event.toAddress,amount:event.amount,rawAmount:event.rawAmount,contractAddress:event.contractAddress});
    return {event};
  }catch(error){return watcherReject(log,`unable to decode Transfer log: ${error.message}`);}
}
function warnRejectedDepositWatcherLog(log,reason){console.warn('WATCHER_TRANSFER_REJECTED',{reason,...watcherLogContext(log)});}
function watcherDebugTxHash(){const value=String(process.env.WATCHER_DEBUG_TX_HASH||TARGET_WATCHER_DEBUG_TX_HASH||'').trim().toLowerCase();return /^0x[a-f0-9]{64}$/.test(value)?value:null;}
function receiptLogIndex(log){return Number.isInteger(log?.index)?log.index:Number.isInteger(log?.logIndex)?log.logIndex:null;}
function receiptLogAddress(log){return log?.address??log?.contractAddress??null;}
function receiptLogTopics(log){return Array.isArray(log?.topics)?log.topics:[];}
function isTargetWatcherLog(log,targetTxHash=watcherDebugTxHash()){return Boolean(targetTxHash&&String(log?.transactionHash||'').toLowerCase()===targetTxHash);}
function watcherReceiptTransferSummary(receipt){
  const configuredToken=watcherConfiguredTokenAddress();
  return (receipt?.logs||[]).map(log=>({
    txHash:String(log.transactionHash||receipt.hash||'').toLowerCase(),
    blockNumber:receipt.blockNumber,
    logIndex:receiptLogIndex(log),
    contractAddress:receiptLogAddress(log),
    contractMatches:configuredToken&&isAddress(receiptLogAddress(log)||'')?getAddress(receiptLogAddress(log))===configuredToken:false,
    topic0:receiptLogTopics(log)[0]||null,
    topicMatches:String(receiptLogTopics(log)[0]||'').toLowerCase()===TRANSFER_TOPIC.toLowerCase(),
    topicsLength:receiptLogTopics(log).length,
    dataLength:String(log.data||'').length
  }));
}
async function debugTargetWatcherReceipt(provider,targetTxHash=watcherDebugTxHash()){
  if(!targetTxHash)return null;
  try{
    const receipt=await provider.getTransactionReceipt(targetTxHash);
    if(!receipt){console.warn('WATCHER_RECEIPT_SKIPPED',{txHash:targetTxHash,reason:'receipt not found'});return null;}
    const summary=watcherReceiptTransferSummary(receipt),matchingTransferLogs=summary.filter(item=>item.contractMatches&&item.topicMatches);
    console.log('WATCHER_RECEIPT_DECODED',{txHash:targetTxHash,status:Number(receipt.status),blockNumber:receipt.blockNumber,logs:summary.length,matchingTransferLogs:matchingTransferLogs.length,matchingTransferLogIndexes:matchingTransferLogs.map(item=>item.logIndex),summary});
    if(Number(receipt.status)!==1)console.warn('WATCHER_RECEIPT_SKIPPED',{txHash:targetTxHash,reason:'receipt status is not successful',status:Number(receipt.status),blockNumber:receipt.blockNumber});
    if(!matchingTransferLogs.length)console.warn('WATCHER_RECEIPT_SKIPPED',{txHash:targetTxHash,reason:'receipt has no USDT Transfer log matching current contract/topic filter',blockNumber:receipt.blockNumber,configuredContract:watcherConfiguredTokenAddress(),transferTopic:TRANSFER_TOPIC});
    return receipt;
  }catch(error){console.warn('WATCHER_RECEIPT_SKIPPED',{txHash:targetTxHash,reason:`receipt lookup failed: ${error.message}`});return null;}
}
function sweepServiceStatus(){
  return {configured:false,enabled:false,missing:[],message:'Treasury sweep flow is disabled. Deposits are handled by NOWPayments.'};
}
function depositSignerDiagnostics(addressRecord,provider=null){
  const expected=getAddress(addressRecord.address),walletIndex=Number(addressRecord.hdIndex),basePath=addressRecord.hdBasePath||hdBaseDerivationPath(),depositPath=addressRecord.derivationPath||depositDerivationPath(walletIndex,basePath),diagnostics={expectedDepositAddress:expected,derivedSignerAddress:null,depositDerivationPath:addressRecord.derivationPath||depositPath,sweepDerivationPath:depositPath,walletIndex,hdFingerprint:addressRecord.hdFingerprint||hdFingerprint(),hdSignerSource:configuredHdSignerSource(),reason:null};
  if(process.env.HD_WALLET_MNEMONIC){
    try{
      const signer=HDNodeWallet.fromPhrase(process.env.HD_WALLET_MNEMONIC,'',depositPath);
      diagnostics.derivedSignerAddress=getAddress(signer.address);
      diagnostics.reason=diagnostics.derivedSignerAddress===expected?'match':'derived signer address does not match expected deposit address';
      return {diagnostics,signer:provider?signer.connect(provider):signer};
    }catch(error){diagnostics.reason=`unable to derive signer: ${error.message}`;return {diagnostics,signer:null};}
  }
  if(process.env.HD_WALLET_XPRV){
    try{
      const signer=HDNodeWallet.fromExtendedKey(process.env.HD_WALLET_XPRV).deriveChild(walletIndex);
      diagnostics.derivedSignerAddress=getAddress(signer.address);
      diagnostics.reason=diagnostics.derivedSignerAddress===expected?'match':'derived signer address does not match expected deposit address';
      return {diagnostics,signer:provider?signer.connect(provider):signer};
    }catch(error){diagnostics.reason=`unable to derive signer from HD_WALLET_XPRV: ${error.message}`;return {diagnostics,signer:null};}
  }
  diagnostics.reason='HD_WALLET_MNEMONIC or HD_WALLET_XPRV is not configured';
  return {diagnostics,signer:null};
}
function depositPrivateSigner(addressRecord,provider){
  const {diagnostics,signer}=depositSignerDiagnostics(typeof addressRecord==='string'?{address:addressRecord,hdIndex:arguments[1]}:addressRecord,provider);
  if(signer&&diagnostics.derivedSignerAddress===diagnostics.expectedDepositAddress)return signer;
  console.warn('TREASURY_SWEEP_SIGNER_DIAGNOSTIC',diagnostics);
  throw Error(`No server-side signer controls this deposit address: ${diagnostics.reason}`);
}
function derivedDepositAddress(chain,index){
  if(normalizeChain(chain)!==BSC_CHAIN)throw Error('Unsupported deposit chain');
  const status=depositAddressServiceStatus();
  if(!status.configured)throw Error(status.error);
  return getAddress(configuredDepositXpub().deriveChild(index).address);
}
function addressIsBlockedUnsafe(address){const normalized=normalizedAddressLower(address);return normalized?BLOCKED_UNSAFE_DEPOSIT_ADDRESSES.has(normalized):BLOCKED_UNSAFE_DEPOSIT_ADDRESSES.has(String(address||'').trim().toLowerCase());}
function isActiveVerifiedDepositAddress(record){
  return Boolean(record&&!record.disabled&&record.signerVerified===true&&!addressIsBlockedUnsafe(record.address));
}
function signerControlsDepositAddress(record){
  if(!record||addressIsBlockedUnsafe(record.address))return false;
  try{
    const result=depositSignerDiagnostics(record);
    return Boolean(result.signer&&result.diagnostics.derivedSignerAddress===result.diagnostics.expectedDepositAddress&&result.diagnostics.hdFingerprint===hdFingerprint());
  }catch(_){return false;}
}
function disableUnsafeDepositAddress(db,record,reason='not controlled by current HD wallet'){
  if(!record||record.disabled&&record.unsafeReason===reason)return false;
  const now=new Date().toISOString();
  Object.assign(record,{disabled:true,signerVerified:false,unsafeReason:reason,disabledAt:record.disabledAt||now,updatedAt:now});
  emitDepositAddressLog(db,'DEPOSIT_ADDRESS_DISABLED_UNSAFE',{userId:record.userId,chain:record.chain,address:record.address,hdIndex:record.hdIndex,reason});
  return true;
}
function verifyExistingDepositAddress(db,record){
  const walletIndex=Number(record.walletIndex ?? record.hdIndex);
  const basePath=hdBaseDerivationPath(),now=new Date().toISOString();
  Object.assign(record,{hdIndex:walletIndex,walletIndex,hdBasePath:basePath,derivationPath:depositDerivationPath(walletIndex,basePath),hdFingerprint:hdFingerprint(),signerVerified:true,disabled:false,unsafeReason:null,updatedAt:now});
  delete record.disabledAt;
  emitDepositAddressLog(db,'DEPOSIT_ADDRESS_VERIFIED',{userId:record.userId,chain:record.chain,address:record.address,hdIndex:walletIndex,walletIndex,derivationPath:record.derivationPath,hdFingerprint:record.hdFingerprint,existing:true});
  return record;
}
function nextSafeHdIndex(db,chain){
  let hdIndex=nextHdIndex(db,chain);
  while(addressIsBlockedUnsafe(derivedDepositAddress(chain,hdIndex))||db.deposit_addresses.some(x=>x.chain===chain&&String(x.address||'').toLowerCase()===derivedDepositAddress(chain,hdIndex).toLowerCase()))hdIndex++;
  return hdIndex;
}
function createVerifiedDepositAddress(db,userId,chain,replacedAddress=null){
  const hdIndex=nextSafeHdIndex(db,chain), createdAt=new Date().toISOString(),basePath=hdBaseDerivationPath(),address=derivedDepositAddress(chain,hdIndex);
  const record={id:id('addr'),userId,chain,address,hdIndex,walletIndex:hdIndex,hdBasePath:basePath,derivationPath:depositDerivationPath(hdIndex,basePath),hdFingerprint:hdFingerprint(),signerVerified:true,createdAt};
  if(!signerControlsDepositAddress(record))throw Error('Generated deposit address is not controlled by current HD wallet signer');
  db.deposit_addresses.push(record);
  emitDepositAddressLog(db,'DEPOSIT_ADDRESS_VERIFIED',{userId,chain,address:record.address,hdIndex,walletIndex:hdIndex,derivationPath:record.derivationPath,hdFingerprint:record.hdFingerprint});
  if(replacedAddress)emitDepositAddressLog(db,'DEPOSIT_ADDRESS_REPLACED',{userId,chain,oldAddress:replacedAddress.address,newAddress:record.address,oldAddressId:replacedAddress.id,newAddressId:record.id,reason:replacedAddress.unsafeReason||'not controlled by current HD wallet'});
  return record;
}
function ensureDepositAddress(db,userId,chainInput='BSC'){
  const chain=normalizeChain(chainInput);
  db.deposit_addresses=db.deposit_addresses||[];
  const existing=db.deposit_addresses.find(x=>x.userId===userId&&x.chain===chain&&isActiveVerifiedDepositAddress(x)&&signerControlsDepositAddress(x));
  if(existing)return existing;
  const controlledLegacy=db.deposit_addresses.find(x=>x.userId===userId&&x.chain===chain&&!x.disabled&&signerControlsDepositAddress(x));
  if(controlledLegacy)return verifyExistingDepositAddress(db,controlledLegacy);
  let replaced=null;
  for(const record of db.deposit_addresses.filter(x=>x.userId===userId&&x.chain===chain)){
    if(!signerControlsDepositAddress(record)){disableUnsafeDepositAddress(db,record,addressIsBlockedUnsafe(record.address)?'blocked unsafe legacy address':'not controlled by current HD wallet');replaced=replaced||record;}
  }
  return createVerifiedDepositAddress(db,userId,chain,replaced);
}
function migrateUnsafeDepositAddresses(db){
  const status=depositAddressServiceStatus();
  if(!status.configured)throw Error(status.error);
  db.deposit_addresses=db.deposit_addresses||[];
  const affected=new Map();
  for(const record of db.deposit_addresses){
    if(!record.userId||normalizeChain(record.chain)!==BSC_CHAIN)continue;
    if(signerControlsDepositAddress(record)){
      if(!record.disabled)verifyExistingDepositAddress(db,record);
      continue;
    }
    disableUnsafeDepositAddress(db,record,addressIsBlockedUnsafe(record.address)?'blocked unsafe legacy address':'not controlled by current HD wallet');
    affected.set(`${record.userId}:${record.chain}`,{userId:record.userId,chain:record.chain,record});
  }
  const replacements=[];
  for(const item of affected.values()){
    const active=db.deposit_addresses.find(x=>x.userId===item.userId&&x.chain===item.chain&&isActiveVerifiedDepositAddress(x)&&signerControlsDepositAddress(x));
    if(active)continue;
    replacements.push(createVerifiedDepositAddress(db,item.userId,normalizeChain(item.chain),item.record));
  }
  return {scanned:db.deposit_addresses.length,affectedUsers:affected.size,replacements:replacements.length};
}
function validateBep20TransferEvent({chain,txHash,logIndex,toAddress,fromAddress,amount,blockNumber}){
  const failures=[];
  if(chain!==BSC_CHAIN)failures.push(`unsupported chain: ${chain}`);
  if(!/^0x[a-f0-9]{64}$/.test(txHash))failures.push('transaction hash must be a 32-byte hex value');
  if(!Number.isInteger(logIndex)||logIndex<0)failures.push('log index must be a non-negative integer');
  if(!isAddress(toAddress))failures.push('recipient address is invalid');
  if(!isAddress(fromAddress))failures.push('sender address is invalid');
  if(!Number.isFinite(amount)||amount<0)failures.push('amount must be a finite value greater than or equal to zero');
  if(!Number.isInteger(blockNumber)||blockNumber<0)failures.push('block number must be a non-negative integer');
  return failures;
}
function amountsMatch(a,b){return Math.abs(Number(a)-Number(b))<1e-9;}
function pendingDepositIntentForTransfer(db,{userId,depositAddressId,amount}){
  return (db.deposits||[]).find(item=>item.userId===userId&&item.depositAddressId===depositAddressId&&item.status==='waiting_for_blockchain_transaction'&&!item.txHash&&amountsMatch(item.amount,amount));
}
function sortedJson(value){
  if(Array.isArray(value))return value.map(sortedJson);
  if(value&&typeof value==='object'){
    return Object.keys(value).sort().reduce((out,key)=>{out[key]=sortedJson(value[key]);return out;},{});
  }
  return value;
}
function hmacSha512(value,secret){return crypto.createHmac('sha512',secret).update(value).digest('hex');}
function safeEqualHex(a,b){
  const left=Buffer.from(String(a||''),'hex'),right=Buffer.from(String(b||''),'hex');
  return left.length>0&&left.length===right.length&&crypto.timingSafeEqual(left,right);
}
function verifyNowPaymentsSignature(rawBody,payload,signature,secret=process.env.NOWPAYMENTS_IPN_SECRET){
  if(!secret||!signature)return false;
  const candidates=[rawBody,JSON.stringify(sortedJson(payload))].filter(Boolean).map(value=>hmacSha512(value,secret));
  return candidates.some(expected=>safeEqualHex(expected,signature));
}
function nowPaymentsIpnUrl(){return `${APP_URL.replace(/\/+$/,'')}/api/nowpayments/ipn`;}
async function nowPaymentsRequest(endpoint,payload){
  if(process.env.NOWPAYMENTS_MOCK==='true'){
    const invoiceId=`mock_inv_${crypto.randomUUID()}`,paymentId=`mock_pay_${crypto.randomUUID()}`;
    return {id:invoiceId,invoice_id:invoiceId,payment_id:paymentId,invoice_url:`https://nowpayments.io/payment/?iid=${invoiceId}`,pay_currency:'usdtbsc',pay_address:'TMockNowPaymentsAddress',price_amount:payload.price_amount,price_currency:payload.price_currency};
  }
  const response=await fetch(`${NOWPAYMENTS_BASE_URL}${endpoint}`,{method:'POST',headers:{'Content-Type':'application/json','x-api-key':process.env.NOWPAYMENTS_API_KEY},body:JSON.stringify(payload)});
  const text=await response.text();
  let data={};try{data=text?JSON.parse(text):{};}catch(_){data={raw:text};}
  if(!response.ok)throw Error(data.message||data.error||`NOWPayments request failed with ${response.status}`);
  return data;
}
async function createNowPaymentsDeposit(db,userId,amount){
  const status=depositServiceStatus();
  if(!status.configured)throw Error(status.message);
  const value=roundCurrency(Number(amount));
  if(!Number.isFinite(value)||value<=0)throw Error('Deposit amount must be greater than zero');
  const depositId=id('dep'),now=new Date().toISOString();
  const invoice=await nowPaymentsRequest('/invoice',{price_amount:value,price_currency:'usd',order_id:depositId,order_description:`HB9 USDT wallet deposit ${depositId}`,ipn_callback_url:nowPaymentsIpnUrl(),success_url:NOWPAYMENTS_SUCCESS_URL,cancel_url:NOWPAYMENTS_CANCEL_URL});
  const paymentId=String(invoice.payment_id||invoice.id||invoice.invoice_id||'');
  const invoiceId=String(invoice.invoice_id||invoice.id||'');
  const deposit={id:depositId,userId,amount:value,asset:'USDT',provider:'NOWPayments',network:'NOWPayments',status:'pending',paymentStatus:'pending',paymentId,payment_id:paymentId,invoiceId,invoice_id:invoiceId,invoiceUrl:invoice.invoice_url||invoice.payment_url||invoice.url||null,payAddress:invoice.pay_address||null,payCurrency:invoice.pay_currency||null,createdAt:now,credited:false,creditedAt:null};
  db.deposits=db.deposits||[];db.deposits.push(deposit);
  audit(db,'NOWPAYMENTS_DEPOSIT_CREATED',{depositId,userId,amount:value,paymentId,invoiceId,payCurrency:deposit.payCurrency});
  return {deposit,payment:invoice,service:status};
}
function nowPaymentMatches(deposit,payloadPaymentId,payloadInvoiceId){
  const paymentId=String(payloadPaymentId||''),invoiceId=String(payloadInvoiceId||'');
  return Boolean((paymentId&&[deposit.paymentId,deposit.payment_id].map(String).includes(paymentId))||(invoiceId&&[deposit.invoiceId,deposit.invoice_id].map(String).includes(invoiceId)));
}
function normalizeNowPaymentStatus(status){return String(status||'').trim().toLowerCase();}
function creditNowPaymentsDeposit(db,payload){
  db.deposits=db.deposits||[];db.nowpayments_ipn_events=db.nowpayments_ipn_events||[];
  const paymentId=String(payload.payment_id||payload.id||''),invoiceId=String(payload.invoice_id||payload.invoiceId||''),status=normalizeNowPaymentStatus(payload.payment_status),now=new Date().toISOString();
  const deposit=db.deposits.find(item=>item.provider==='NOWPayments'&&nowPaymentMatches(item,paymentId,invoiceId));
  if(!deposit)throw Error('Matching NOWPayments deposit was not found');
  deposit.paymentStatus=status||deposit.paymentStatus;
  deposit.lastIpnAt=now;
  deposit.nowpaymentsPayload=payload;
  if(['failed','expired','refunded'].includes(status)){
    Object.assign(deposit,{status:'failed',failedAt:deposit.failedAt||now});
    return {deposit,credited:false,reason:'terminal_failed_status'};
  }
  if(status==='confirming'||status==='confirmed')deposit.status='confirming';
  if(!['confirmed','finished'].includes(status))return {deposit,credited:false,reason:'not_final'};
  const incomingAmount=Number(payload.price_amount??payload.actually_paid??payload.pay_amount);
  if(Number.isFinite(incomingAmount)&&incomingAmount>0&&!amountsMatch(incomingAmount,deposit.amount))throw Error('NOWPayments amount does not match deposit invoice');
  const refId=paymentId||invoiceId||deposit.id;
  const alreadyCredited=deposit.credited||(db.wallet_ledger||[]).some(x=>x.userId===deposit.userId&&x.asset==='USDT'&&x.direction==='credit'&&x.reason==='NOWPayments deposit credited'&&x.refId===refId);
  if(!alreadyCredited)walletEntry(db,{userId:deposit.userId,asset:'USDT',direction:'credit',amount:deposit.amount,reason:'NOWPayments deposit credited',refId});
  Object.assign(deposit,{status:'credited',paymentStatus:status,credited:true,creditedAt:deposit.creditedAt||now,creditedAmount:deposit.amount,paymentId:deposit.paymentId||paymentId,invoiceId:deposit.invoiceId||invoiceId});
  audit(db,'NOWPAYMENTS_DEPOSIT_CREDITED',{depositId:deposit.id,userId:deposit.userId,amount:deposit.amount,paymentId,invoiceId,duplicate:alreadyCredited});
  return {deposit,credited:!alreadyCredited,duplicate:alreadyCredited};
}
function adminFundTransfer(db,admin,{userId,asset,action,amount,reason}){
  if(!admin||admin.role!=='admin')throw Error('Admin only action');
  const lookup=String(userId||'').trim().toLowerCase();
  const target=(db.users||[]).find(user=>user.role==='user'&&(String(user.id||'').toLowerCase()===lookup||String(user.email||'').toLowerCase()===lookup||String(user.name||'').toLowerCase()===lookup));
  if(!target||target.role!=='user')throw Error('User not found');
  const normalizedAsset=String(asset||'').trim().toUpperCase();
  const normalizedAction=String(action||'').trim().toLowerCase();
  const value=roundCurrency(Number(amount));
  const note=String(reason||'').trim();
  if(!['USDT','HB9','BNB'].includes(normalizedAsset))throw Error('Asset must be USDT, HB9, or BNB');
  if(!['credit','debit'].includes(normalizedAction))throw Error('Action must be credit or debit');
  if(!Number.isFinite(value)||value<=0)throw Error('Amount must be greater than zero');
  if(!note)throw Error('Reason is required');
  const before=walletBalances(db,target.id);
  const available=normalizedAsset==='USDT'?before.usdt:normalizedAsset==='BNB'?before.bnb:before.hb9;
  if(normalizedAction==='debit'&&value>available)throw Error('Debit cannot make user balance negative');
  const transferId=id('aft'),createdAt=new Date().toISOString(),direction=normalizedAction;
  const entry=walletEntry(db,{userId:target.id,asset:normalizedAsset,direction,amount:value,reason:note,refId:transferId,type:'ADMIN_FUND_TRANSFER'});
  const after=walletBalances(db,target.id);
  const record={id:transferId,type:'ADMIN_FUND_TRANSFER',adminId:admin.id,adminName:admin.name,userId:target.id,userName:target.name,userEmail:target.email,asset:normalizedAsset,action:normalizedAction,amount:value,reason:note,balanceBefore:available,balanceAfter:normalizedAsset==='USDT'?after.usdt:normalizedAsset==='BNB'?after.bnb:after.hb9,ledgerEntryId:entry.id,createdAt,immutable:true};
  db.admin_fund_transfers=db.admin_fund_transfers||[];
  db.admin_fund_transfers.push(record);
  audit(db,'ADMIN_FUND_TRANSFER',record);
  return {transfer:record,ledgerEntry:entry,balance:after};
}
async function assetBuyPrice(db,asset){
  const normalized=String(asset||'HB9').toUpperCase();
  if(normalized==='HB9'){const market=await exchangeMarket(db);return {asset:'HB9',price:Number(market.buyPrice),market};}
  if(normalized==='BNB'){const market=await bnbMarket('1d',1);return {asset:'BNB',price:Number(market.price),market};}
  throw Error('Unsupported conversion asset');
}
async function convertUsdtToAsset(db,user,{fromAsset='USDT',amount,toAsset='HB9',clientRequestId=null}={}){
  if(!db.settings.exchangeEnabled)throw Error('Exchange is disabled');
  const normalizedFrom=String(fromAsset||'USDT').toUpperCase(), normalized=String(toAsset||'HB9').toUpperCase(), value=roundAssetAmount(normalizedFrom,Number(amount));
  if(!((normalizedFrom==='USDT'&&['HB9','BNB'].includes(normalized))||(normalizedFrom==='HB9'&&normalized==='USDT')))throw Error('Conversion pair must be USDT/HB9, HB9/USDT, or USDT/BNB');
  if(!Number.isFinite(value)||value<=0)throw Error('Conversion amount is invalid');
  if(clientRequestId&&db.exchange_orders?.some(x=>x.userId===user.id&&x.clientRequestId===clientRequestId)){const order=db.exchange_orders.find(x=>x.userId===user.id&&x.clientRequestId===clientRequestId);return {duplicate:true,order,conversion:(db.conversions||[]).find(x=>x.id===order.conversionId||x.orderId===order.id||x.id===order.id),balance:walletBalances(db,user.id)};}
  const balances=walletBalances(db,user.id);
  if(value>Number(balances[normalizedFrom.toLowerCase()]||0))throw Error(`Not enough ${normalizedFrom} balance`);
  const priceAsset=normalizedFrom==='HB9'?'HB9':normalized;
  const {price,market}=await assetBuyPrice(db,priceAsset);
  if(!Number.isFinite(price)||price<=0)throw Error(`${priceAsset} price is unavailable`);
  const fee=normalizedFrom==='USDT'&&normalized==='HB9'?setting(db,'tradingFeePercent')+setting(db,'buyFeePercent'):0;
  const sellFee=normalizedFrom==='HB9'&&normalized==='USDT'?setting(db,'tradingFeePercent')+setting(db,'sellFeePercent'):0;
  const isHb9Sell=normalizedFrom==='HB9'&&normalized==='USDT';
  const reinvestAmountHb9=isHb9Sell?roundAssetAmount('HB9',value*.2):0;
  const convertedAmountHb9=isHb9Sell?roundAssetAmount('HB9',value-reinvestAmountHb9):0;
  const sellBaseAmount=isHb9Sell?convertedAmountHb9:value;
  const toAmount=isHb9Sell?roundAssetAmount(normalized,sellBaseAmount*price*(1-sellFee/100)):roundAssetAmount(normalized,value/price*(1-fee/100));
  const reserveReport=exchangeReserveReport(db);
  if(normalizedFrom==='USDT'&&normalized==='HB9'&&toAmount>reserveReport.hb9.remaining)throw Error('HB9 reserve is insufficient');
  if(normalized==='BNB'&&!reserveReport.bnb.configured)throw Error('BNB reserve not configured');
  if(normalized==='BNB'&&toAmount>reserveReport.bnb.remaining)throw Error('BNB reserve insufficient');
  if(normalizedFrom==='HB9'&&reserveWallet(db,'USDT','treasury').balance<toAmount)throw Error('USDT reserve is insufficient');
  const orderId=id('xord'),createdAt=new Date().toISOString();
  if(normalizedFrom==='USDT'&&normalized==='HB9')db.reserve_ledger.push({id:id('rsv'),asset:'HB9',walletType:'exchange',direction:'sold',amount:toAmount,balanceAfter:roundCurrency(reserveReport.hb9.remaining-toAmount),reason:'HB9 exchange reserve sold',refId:orderId,userId:user.id,createdAt,immutable:true});
  if(normalized==='BNB')reserveMove(db,{asset:'BNB',walletType:'exchange',direction:'debit',amount:toAmount,reason:'BNB buy',userId:user.id,refId:orderId});
  if(normalizedFrom==='HB9')reserveMove(db,{asset:'USDT',walletType:'treasury',direction:'debit',amount:toAmount,reason:'HB9 swap payout',userId:user.id,refId:orderId});
  else reserveMove(db,{asset:'USDT',walletType:'treasury',direction:'credit',amount:value,reason:`${normalized} buy`,userId:user.id,refId:orderId});
  walletEntry(db,{userId:user.id,asset:normalizedFrom,direction:'debit',amount:value,reason:`${normalizedFrom} to ${normalized} swap`,refId:orderId});
  walletEntry(db,{userId:user.id,asset:normalized,direction:'credit',amount:toAmount,reason:`${normalizedFrom} to ${normalized} swap`,refId:orderId});
  db.conversions=db.conversions||[];db.exchange_orders=db.exchange_orders||[];
  let autoReinvestStake=null;
  if(isHb9Sell&&reinvestAmountHb9>0){
    autoReinvestStake={id:id('stk'),userId:user.id,clientRequestId:clientRequestId?`${clientRequestId}:auto-reinvest`:null,stakeAsset:'HB9',stakeAmount:reinvestAmountHb9,stakeUsdValue:roundCurrency(reinvestAmountHb9*price),amount:roundCurrency(reinvestAmountHb9*price),usdValueAtStake:roundCurrency(reinvestAmountHb9*price),hb9EquivalentAmount:reinvestAmountHb9,coinAmount:reinvestAmountHb9,hb9Amount:reinvestAmountHb9,hb9PriceAtStake:price,bnbPriceAtStake:null,source:'AUTO_REINVEST_FROM_CONVERSION',relatedConversionId:null,status:'active',stakeDate:today(),startDate:today(),dailyRate:db.settings.dailyRoi/100,createdAt};
    db.stakes.push(autoReinvestStake);
  }
  const direction=normalizedFrom==='HB9'?'sell':'buy', conversionAmounts=isHb9Sell?{hb9Amount:convertedAmountHb9,usdtAmount:toAmount,reinvestAmountHb9,convertedAmountHb9}:{usdtAmount:value,[normalized==='HB9'?'hb9Amount':'bnbAmount']:toAmount};
  const conversionId=id('cnv'), order={id:orderId,conversionId,userId:user.id,direction,fromAsset:normalizedFrom,toAsset:normalized,fromAmount:value,toAmount,...conversionAmounts,rate:price,price,buyPrice:price,sellPrice:market.sellPrice||price,feePercent:normalizedFrom==='HB9'?sellFee:fee,status:'completed',clientRequestId,createdAt,immutable:true};
  const conversion={...order,id:conversionId,orderId};
  if(autoReinvestStake){autoReinvestStake.relatedConversionId=conversionId;order.autoReinvestStakeId=autoReinvestStake.id;conversion.autoReinvestStakeId=autoReinvestStake.id;}
  db.conversions.push(conversion);
  db.exchange_orders.push(order);
  return {duplicate:false,order,conversion,autoReinvestStake,balance:walletBalances(db,user.id)};
}
async function createStake(db,user,{amount,stakeAsset='HB9',clientRequestId=null}={}){
  const normalized=String(stakeAsset||'HB9').toUpperCase(), stakeAmount=roundAssetAmount(normalized,Number(amount)), balances=walletBalances(db,user.id);
  if(!['HB9','BNB'].includes(normalized))throw Error('Stake asset must be HB9 or BNB');
  if(clientRequestId){const existing=(db.stakes||[]).find(x=>x.userId===user.id&&x.clientRequestId===String(clientRequestId));if(existing)return existing;}
  if(!Number.isFinite(stakeAmount)||stakeAmount<=0)throw Error(`${normalized} stake amount is invalid`);
  if(stakeAmount>Number(balances[normalized.toLowerCase()]||0))throw Error(`Not enough ${normalized} balance`);
  const hb9Market=await exchangeMarket(db), hb9Price=Number(hb9Market.buyPrice||hb9Market.hb9BasePrice||hb9Market.price||marketSettings(db).fallbackPrice), payoutPrice=Number(hb9Market.hb9BasePrice||hb9Market.price||hb9Market.icpPrice||marketSettings(db).fallbackPrice);
  if(!Number.isFinite(hb9Price)||hb9Price<=0)throw Error('HB9 stake price is unavailable');
  let bnbPriceAtStake=null, usdAmount, hb9EquivalentAmount;
  if(normalized==='BNB'){
    const bnb=await bnbMarket('1d',1);
    bnbPriceAtStake=Number(bnb.price);
    if(!Number.isFinite(bnbPriceAtStake)||bnbPriceAtStake<=0)throw Error('BNB stake price is unavailable');
    usdAmount=roundCurrency(stakeAmount*bnbPriceAtStake);
    hb9EquivalentAmount=roundCurrency(usdAmount/hb9Price);
  }else{
    usdAmount=roundCurrency(stakeAmount*hb9Price);
    hb9EquivalentAmount=stakeAmount;
  }
  const isFirstStake=!db.stakes.some(s=>s.userId===user.id), createdAt=new Date().toISOString(), stake={id:id('stk'),userId:user.id,clientRequestId:clientRequestId?String(clientRequestId):null,stakeAsset:normalized,stakeAmount,stakeUsdValue:usdAmount,amount:usdAmount,usdValueAtStake:usdAmount,hb9EquivalentAmount,coinAmount:hb9EquivalentAmount,hb9Amount:hb9EquivalentAmount,hb9PriceAtStake:hb9Price,bnbPriceAtStake,status:'active',startDate:today(),dailyRate:db.settings.dailyRoi/100,createdAt};
  db.stakes.push(stake);
  walletEntry(db,{userId:user.id,asset:normalized,direction:'lock',amount:stakeAmount,reason:`${normalized} stake`,refId:stake.id});
  distributeStakeIncome(db,user,stake,payoutPrice,isFirstStake);
  return stake;
}
function depositAddressLookupDiagnostics(db,{chain,toAddress,txHash,logIndex,amount}){
  const normalizedChain=normalizeChain(chain),normalizedToAddress=normalizedAddressLower(toAddress),records=db.deposit_addresses||[];
  const candidates=records.map(record=>{
    const recordChain=normalizeChain(record.chain),recordAddressNormalized=normalizedAddressLower(record.address),addressMatches=Boolean(normalizedToAddress&&recordAddressNormalized===normalizedToAddress),chainMatches=recordChain===normalizedChain,signerVerified=record.signerVerified===true,disabled=Boolean(record.disabled),blockedUnsafe=addressIsBlockedUnsafe(record.address),active=Boolean(!disabled&&signerVerified&&!blockedUnsafe);
    return {id:record.id,userId:record.userId,chain:record.chain,recordChain,address:record.address,recordAddressNormalized,addressMatches,chainMatches,signerVerified,disabled,blockedUnsafe,active,hdIndex:record.hdIndex,walletIndex:record.walletIndex};
  });
  const sameAddress=candidates.filter(item=>item.addressMatches),sameChainAndAddress=sameAddress.filter(item=>item.chainMatches),activeMatch=sameChainAndAddress.find(item=>item.active);
  const details={txHash,logIndex,amount,decodedToAddress:toAddress,normalizedToAddress,decodedChain:chain,normalizedChain,totalDepositAddresses:records.length,sameAddressCount:sameAddress.length,sameChainAndAddressCount:sameChainAndAddress.length,activeMatchFound:Boolean(activeMatch),activeMatchId:activeMatch?.id||null,sameAddress,sameChainAndAddress};
  console.log('WATCHER_DEPOSIT_LOOKUP_DEBUG',details);
  return {details,record:activeMatch?records.find(record=>record.id===activeMatch.id):null,anySameChainAndAddress:sameChainAndAddress[0]||null};
}
function isZeroValueBep20Transfer(amount){return Number(amount)===0;}
function humanUsdtAmount(rawAmount){
  const value=Number(rawAmount);
  return Number.isFinite(value)&&value>=RAW_USDT_MIGRATION_THRESHOLD?value/10**USDT_BEP20_DECIMALS:null;
}
function repairBep20RawUnitAmounts(db){
  const correctedTransactions=new Map(), correctedDeposits=new Map(), correctedSweeps=new Map(), reserveDeltas=new Map();
  const correct=(record,field,collection)=>{const corrected=humanUsdtAmount(record?.[field]);if(corrected===null)return;const previous=Number(record[field]);record[field]=corrected;collection.set(record.id??record.eventKey,{previous,corrected,record});};
  for(const tx of db.blockchain_transactions||[])if(tx.chain===BSC_CHAIN)correct(tx,'amount',correctedTransactions);
  for(const deposit of db.deposits||[])if(deposit.chain===BSC_CHAIN){correct(deposit,'amount',correctedDeposits);correct(deposit,'creditedAmount',correctedDeposits);}
  const transactionAmounts=new Map((db.blockchain_transactions||[]).filter(tx=>tx.eventKey).map(tx=>[tx.eventKey,Number(tx.amount)]));
  for(const ledger of db.wallet_ledger||[]){
    if(ledger.asset!=='USDT'||ledger.reason!=='BEP20 deposit credited'||!transactionAmounts.has(ledger.refId))continue;
    const corrected=transactionAmounts.get(ledger.refId);if(humanUsdtAmount(ledger.amount)!==null)ledger.amount=corrected;
  }
  for(const sweep of db.sweep_transactions||[]){
    const deposit=correctedDeposits.get(sweep.depositId)?.record||(db.deposits||[]).find(item=>item.id===sweep.depositId);
    if(!deposit||humanUsdtAmount(sweep.amount)===null)continue;
    const previous=Number(sweep.amount), corrected=Number(deposit.creditedAmount??deposit.amount);sweep.amount=corrected;correctedSweeps.set(sweep.id,{previous,corrected,record:sweep});
  }
  for(const entry of db.reserve_ledger||[]){
    if(entry.asset!=='USDT'||!correctedSweeps.has(entry.refId)||humanUsdtAmount(entry.amount)===null)continue;
    const {corrected}=correctedSweeps.get(entry.refId),previous=Number(entry.amount);entry.amount=corrected;
    const key=`${entry.asset}:${entry.walletType}`, sign=entry.direction==='debit'?-1:1;reserveDeltas.set(key,(reserveDeltas.get(key)||0)+((corrected-previous)*sign));
  }
  for(const wallet of db.reserve_wallets||[]){
    const delta=reserveDeltas.get(`${wallet.asset}:${wallet.walletType}`);if(!delta)continue;
    // A reserve consisting of legacy raw units cannot be safely corrected with
    // floating-point subtraction (1e18 - 1e18 + 1 loses the final 1).
    const rawBalance=humanUsdtAmount(wallet.balance);
    wallet.balance=rawBalance===null?roundCurrency(Number(wallet.balance)+delta):rawBalance;
    wallet.updatedAt=new Date().toISOString();
  }
  const corrected=correctedTransactions.size>0||correctedDeposits.size>0||correctedSweeps.size>0;
  if(corrected){
    const now=new Date().toISOString();
    for(const record of [...correctedTransactions.values(),...correctedDeposits.values(),...correctedSweeps.values()])record.record.rawUnitMigrationAt=now;
    db.auditLogs=db.auditLogs||[];
    audit(db,'BEP20_RAW_UNIT_MIGRATED',{transactions:correctedTransactions.size,deposits:correctedDeposits.size,sweeps:correctedSweeps.size});
    console.warn('Repaired legacy BEP20 raw-unit amounts:',{transactions:correctedTransactions.size,deposits:correctedDeposits.size,sweeps:correctedSweeps.size});
  }
  return {corrected,transactions:correctedTransactions.size,deposits:correctedDeposits.size,sweeps:correctedSweeps.size};
}
function recordBep20Transfer(db,input){
  const chain=normalizeChain(input.chain), txHash=String(input.txHash||'').trim().toLowerCase(), logIndex=Number(input.logIndex), toAddress=normalizedAddressLower(input.toAddress)||String(input.toAddress||'').trim().toLowerCase(), fromAddress=normalizedAddressLower(input.fromAddress||input.from)||String(input.fromAddress||input.from||'').trim().toLowerCase(), amount=Number(input.amount), blockNumber=Number(input.blockNumber), requiredConfirmations=Number(process.env.REQUIRED_DEPOSIT_CONFIRMATIONS||12);
  const failures=validateBep20TransferEvent({chain,txHash,logIndex,toAddress,fromAddress,amount,blockNumber});
  const configuredToken=watcherConfiguredTokenAddress();
  if(configuredToken&&input.contractAddress){
    try{if(getAddress(input.contractAddress)!==configuredToken)failures.push('contractAddress does not match USDT_BEP20_CONTRACT');}catch(_){failures.push('contractAddress is invalid');}
  }
  if(failures.length){
    console.warn('WATCHER_TRANSFER_REJECTED',{reason:'invalid BEP20 transfer event',failures,topics:input.topics??null,data:input.data??null,from:fromAddress,to:toAddress,amount,contractAddress:input.contractAddress??null,transactionHash:txHash,logIndex,blockNumber});
    throw Error('Invalid BEP20 transfer event');
  }
  if(isZeroValueBep20Transfer(amount)){
    console.warn('WATCHER_TRANSFER_REJECTED',{reason:'zero-value Transfer event',topics:input.topics??null,data:input.data??null,from:fromAddress,to:toAddress,amount,contractAddress:input.contractAddress??null,transactionHash:txHash,logIndex,blockNumber});
    return null;
  }
  const lookup=depositAddressLookupDiagnostics(db,{chain,toAddress,txHash,logIndex,amount}),addressRecord=lookup.record;
  if(!addressRecord&&lookup.anySameChainAndAddress){
    const found=lookup.anySameChainAndAddress;
    console.warn('WATCHER_TRANSFER_REJECTED',{reason:'deposit address is disabled or not signerVerified',rejectionLine:'recordBep20Transfer: active/signerVerified/disabled check',toAddress:getAddress(toAddress),depositAddressId:found.id,disabled:found.disabled,signerVerified:found.signerVerified,active:found.active,blockedUnsafe:found.blockedUnsafe,chain:found.chain,recordChain:found.recordChain,chainMatches:found.chainMatches,addressMatches:found.addressMatches,txHash,logIndex,amount});
    return null;
  }
  const address=addressRecord;
  if(address)console.log('WATCHER_DEPOSIT_ADDRESS_MATCHED',{txHash,logIndex,userId:address.userId,depositAddressId:address.id,toAddress:address.address,amount});
  else console.warn('WATCHER_TRANSFER_REJECTED',{reason:'recipient is not an active signerVerified deposit address',rejectionLine:'recordBep20Transfer: normalized address+chain lookup returned no active record',toAddress:isAddress(toAddress)?getAddress(toAddress):toAddress,normalizedToAddress:toAddress,chain,lookup:lookup.details,txHash,logIndex,amount});
  if(!address)return null;
  db.blockchain_transactions=db.blockchain_transactions||[];db.deposits=db.deposits||[];
  const eventKey=`${chain}:${txHash}:${logIndex}`,now=new Date().toISOString();
  let tx=db.blockchain_transactions.find(x=>x.eventKey===eventKey);
  if(!tx){
    tx={id:id('btx'),eventKey,chain,txHash,logIndex,fromAddress:getAddress(fromAddress),toAddress:address.address,userId:address.userId,depositAddressId:address.id,amount,confirmations:0,requiredConfirmations,blockNumber,status:'detected',createdAt:now,updatedAt:now};
    db.blockchain_transactions.push(tx);
    const intent=pendingDepositIntentForTransfer(db,{userId:address.userId,depositAddressId:address.id,amount});
    const deposit=intent||{id:id('dep'),userId:address.userId,amount,asset:'USDT',chain,network:'USDT BEP20',depositAddressId:address.id,createdAt:now};
    Object.assign(deposit,{amount,asset:'USDT',chain,network:'USDT BEP20',txHash,logIndex,fromAddress:tx.fromAddress,depositAddressId:address.id,status:'detected',confirmations:0,requiredConfirmations,blockNumber,detectedAt:now});
    if(!intent)db.deposits.push(deposit);
    console.log('BEP20_DEPOSIT_DETECTED',{eventKey,txHash,logIndex,userId:address.userId,toAddress:address.address,amount,blockNumber});
    audit(db,'BEP20_DEPOSIT_DETECTED',{eventKey,txHash,logIndex,userId:address.userId,toAddress:address.address,amount,blockNumber,depositId:deposit.id,matchedIntent:Boolean(intent)});
  }
  return tx;
}
function processDepositWatcherLogs(db,logs,latestBlock,targetTxHash=watcherDebugTxHash()){
  let decoded=0,recorded=0,targetLogs=0;
  for(const log of logs){
    const targetMatch=isTargetWatcherLog(log,targetTxHash);
    if(targetMatch){
      targetLogs++;
      console.log('WATCHER_LIVE_TARGET_MATCHED',{txHash:targetTxHash,stage:'before_decode',blockNumber:log.blockNumber,logIndex:receiptLogIndex(log),contractAddress:receiptLogAddress(log),topic0:receiptLogTopics(log)[0]||null});
      console.log('WATCHER_LOG_FOUND',{txHash:targetTxHash,stage:'before_decode',blockNumber:log.blockNumber,logIndex:receiptLogIndex(log),contractAddress:receiptLogAddress(log),topic0:receiptLogTopics(log)[0]||null});
    }
    const parsed=parseBep20TransferWatcherLog(log);
    if(!parsed.event){warnRejectedDepositWatcherLog(log,parsed.reason);continue;}
    decoded++;
    try{if(recordBep20Transfer(db,parsed.event))recorded++;}catch(error){warnRejectedDepositWatcherLog(log,`recording event failed: ${error.message}`);}
  }
  updateDepositConfirmations(db,latestBlock);
  createSweepCandidates(db);
  return {decoded,recorded,targetLogs};
}
function updateDepositConfirmations(db,currentBlock){
  const now=new Date().toISOString();
  for(const tx of db.blockchain_transactions||[]){
    if(tx.chain!==BSC_CHAIN||tx.status==='credited')continue;
    tx.confirmations=Math.max(0,Number(currentBlock)-Number(tx.blockNumber)+1);tx.updatedAt=now;
    const deposit=(db.deposits||[]).find(x=>x.chain===tx.chain&&x.txHash===tx.txHash&&Number(x.logIndex)===Number(tx.logIndex));
    if(!deposit)continue;
    deposit.confirmations=tx.confirmations;deposit.requiredConfirmations=tx.requiredConfirmations;
    if(tx.confirmations<tx.requiredConfirmations){tx.status='pending';deposit.status='pending';continue;}
    const alreadyCredited=(db.wallet_ledger||[]).some(x=>x.userId===tx.userId&&x.asset==='USDT'&&x.direction==='credit'&&x.reason==='BEP20 deposit credited'&&x.refId===tx.eventKey);
    if(!alreadyCredited)walletEntry(db,{userId:tx.userId,asset:'USDT',direction:'credit',amount:tx.amount,reason:'BEP20 deposit credited',refId:tx.eventKey});
    tx.status='credited';tx.creditedAt=now;
    Object.assign(deposit,{status:'credited',creditedAt:now,creditedAmount:tx.amount});
    if(!deposit.auditCreditedAt){const details={eventKey:tx.eventKey,txHash:tx.txHash,logIndex:tx.logIndex,userId:tx.userId,amount:tx.amount,confirmations:tx.confirmations};console.log('BEP20_DEPOSIT_CREDITED',details);audit(db,'BEP20_DEPOSIT_CREDITED',details);deposit.auditCreditedAt=now;}
  }
}
async function pollDepositWatcher(){
  if(watcherRunning||!depositServiceStatus().configured)return;
  watcherRunning=true;
  try{
    const provider=new JsonRpcProvider(process.env.BSC_RPC_URL), latestBlock=await provider.getBlockNumber(), db=readDB();
    const targetTxHash=watcherDebugTxHash(),targetReceipt=await debugTargetWatcherReceipt(provider,targetTxHash),targetBlock=Number.isInteger(targetReceipt?.blockNumber)?targetReceipt.blockNumber:null;
    db.deposit_watcher=db.deposit_watcher||{};
    const start=resolveDepositWatcherLiveScanRange({latestBlock,confirmations:process.env.REQUIRED_DEPOSIT_CONFIRMATIONS,state:db.deposit_watcher,resetCursor:process.env.DEPOSIT_WATCHER_RESET_CURSOR==='true'&&!watcherResetApplied});
    if(start.reset){
      console.log('WATCHER_SCAN_BLOCK_START',{mode:'reset',latestBlock,nextBlock:latestBlock,toBlock:latestBlock,targetTxHash,targetBlock,targetInRange:targetBlock===latestBlock,cursorMode:start.cursorMode});
      Object.assign(db.deposit_watcher,{lastProcessedBlock:latestBlock,cursorMode:start.cursorMode,lastCursorResetAt:new Date().toISOString()});
      delete db.deposit_watcher.lastScannedBlock;
      delete db.deposit_watcher.configuredStartBlock;
      writeDB(db);
      watcherResetApplied=true;
      console.log('WATCHER_SCAN_BLOCK_END',{mode:'reset',latestBlock,nextBlock:latestBlock,toBlock:latestBlock,targetTxHash,targetBlock,targetInRange:targetBlock===latestBlock,processed:false,reason:'cursor reset'});
      console.log(`Deposit watcher starting from block ${latestBlock} to ${latestBlock} (cursor reset)`);
      return;
    }
    const nextBlock=start.nextBlock,toBlock=start.toBlock,range=Math.max(0,toBlock-nextBlock+1);
    const targetInRange=Number.isInteger(targetBlock)&&targetBlock>=nextBlock&&targetBlock<=toBlock;
    console.log('WATCHER_LIVE_SCAN_RANGE',{latestBlock,nextBlock,toBlock,range,confirmations:Number(process.env.REQUIRED_DEPOSIT_CONFIRMATIONS||12),lookbackBlocks:start.lookbackBlocks,lookbackStartBlock:start.lookbackStartBlock,cursorNextBlock:start.cursorNextBlock,cursorMode:start.cursorMode,configuredStartBlock:start.configuredStartBlock,lastProcessedBlock:db.deposit_watcher.lastProcessedBlock??null,targetTxHash,targetBlock,targetInRange,willScan:nextBlock<=toBlock});
    console.log('WATCHER_SCAN_BLOCK_START',{latestBlock,nextBlock,toBlock,range,cursorMode:start.cursorMode,configuredStartBlock:start.configuredStartBlock,lastProcessedBlock:db.deposit_watcher.lastProcessedBlock??null,targetTxHash,targetBlock,targetInRange,willScan:nextBlock<=toBlock});
    if(Number.isInteger(targetBlock)&&!targetInRange)console.warn('WATCHER_RECEIPT_SKIPPED',{txHash:targetTxHash,reason:'target block is outside current watcher scan range',targetBlock,nextBlock,toBlock,latestBlock,cursorMode:start.cursorMode,lastProcessedBlock:db.deposit_watcher.lastProcessedBlock??null});
    if(nextBlock<=toBlock){
      console.log(`Deposit watcher starting from block ${nextBlock} to ${toBlock}`);
      const logs=await provider.getLogs({address:getAddress(process.env.USDT_BEP20_CONTRACT),topics:[TRANSFER_TOPIC],fromBlock:nextBlock,toBlock});
      const targetLogs=logs.filter(log=>isTargetWatcherLog(log,targetTxHash));
      console.log('WATCHER_LOG_FOUND',{txHash:targetTxHash,fromBlock:nextBlock,toBlock,logsReturned:logs.length,targetLogsReturned:targetLogs.length,targetLogIndexes:targetLogs.map(receiptLogIndex),targetInRange});
      if(targetInRange&&!targetLogs.length)console.warn('WATCHER_RECEIPT_SKIPPED',{txHash:targetTxHash,reason:'target block was scanned but getLogs returned no target tx log',targetBlock,fromBlock:nextBlock,toBlock,configuredContract:watcherConfiguredTokenAddress(),transferTopic:TRANSFER_TOPIC});
      const processed=processDepositWatcherLogs(db,logs,latestBlock,targetTxHash);
      // Do not advance the cursor until getLogs and event handling have both succeeded.
      Object.assign(db.deposit_watcher,{lastProcessedBlock:toBlock,cursorMode:start.cursorMode});
      if(start.configuredStartBlock===null)delete db.deposit_watcher.configuredStartBlock;
      else db.deposit_watcher.configuredStartBlock=start.configuredStartBlock;
      delete db.deposit_watcher.lastScannedBlock;
      writeDB(db);
      console.log('WATCHER_SCAN_BLOCK_END',{latestBlock,nextBlock,toBlock,cursorMode:start.cursorMode,targetTxHash,targetBlock,targetInRange,logsReturned:logs.length,targetLogsReturned:targetLogs.length,decodedLogs:processed.decoded,recordedTransfers:processed.recorded,lastProcessedBlock:db.deposit_watcher.lastProcessedBlock});
      return;
    }
    updateDepositConfirmations(db,latestBlock);writeDB(db);
    console.log('WATCHER_SCAN_BLOCK_END',{latestBlock,nextBlock,toBlock,cursorMode:start.cursorMode,targetTxHash,targetBlock,targetInRange,processed:false,reason:'no new block range'});
  }catch(error){console.error('Deposit watcher error:',error.message);}finally{watcherRunning=false;}
}
function startDepositWatcher(){return false;}
function sweepRecordForDeposit(db,depositId){return (db.sweep_transactions||[]).find(item=>item.depositId===depositId);}
function emitSweepLog(db,type,details){console.log(type,details);audit(db,type,details);}
function createSweepCandidates(db){
  const minimum=positiveEnvNumber('MIN_SWEEP_USDT',1),now=new Date().toISOString();db.sweep_transactions=db.sweep_transactions||[];
  for(const deposit of db.deposits||[]){
    const amount=Number(deposit.creditedAmount??deposit.amount),existing=sweepRecordForDeposit(db,deposit.id);
    if(deposit.status!=='credited'||amount<minimum)continue;
    if(existing){
      if(!deposit.sweepStatus)Object.assign(deposit,{sweepStatus:existing.status||'not_started',sweepId:existing.id});
      const shouldRequeue=existing.status==='failed_retryable'&&(!deposit.sweepStatus||['not_started','failed_retryable'].includes(deposit.sweepStatus));
      if(shouldRequeue){
        const address=(db.deposit_addresses||[]).find(item=>item.id===deposit.depositAddressId);
        if(existing.sweepTxHash)(existing.failedSweepTxHashes||=[]).push(existing.sweepTxHash);
        if(existing.gasTopupTxHash)(existing.failedGasTopupTxHashes||=[]).push(existing.gasTopupTxHash);
        Object.assign(existing,{status:'not_started',amount,fromAddress:existing.fromAddress||address?.address,toAddress:existing.toAddress||getAddress(process.env.TREASURY_WALLET_BSC),gasTopupStatus:'not_required',sweepTxHash:null,gasTopupTxHash:null,failureReason:null,failedPhase:null,retryRequestedAt:now,updatedAt:now});
        Object.assign(deposit,{sweepStatus:'not_started',sweepId:existing.id});
        emitSweepLog(db,'TREASURY_SWEEP_CANDIDATE_CREATED',{depositId:deposit.id,sweepId:existing.id,amount:existing.amount,fromAddress:existing.fromAddress,toAddress:existing.toAddress,requeued:true});
      }
      continue;
    }
    const address=(db.deposit_addresses||[]).find(item=>item.id===deposit.depositAddressId);if(!address)continue;
    const sweep={id:id('swp'),depositId:deposit.id,userId:deposit.userId,chain:BSC_CHAIN,depositTxHash:deposit.txHash,depositLogIndex:deposit.logIndex,fromAddress:address.address,toAddress:getAddress(process.env.TREASURY_WALLET_BSC),amount,status:'not_started',gasTopupStatus:'not_required',createdAt:now,updatedAt:now};
    db.sweep_transactions.push(sweep);Object.assign(deposit,{sweepStatus:'not_started',sweepId:sweep.id});emitSweepLog(db,'TREASURY_SWEEP_CANDIDATE_CREATED',{depositId:deposit.id,sweepId:sweep.id,amount:sweep.amount,fromAddress:sweep.fromAddress,toAddress:sweep.toAddress,requeued:false});
  }
}
function sweepConfirmations(receipt,latestBlock){return receipt?Math.max(0,Number(latestBlock)-Number(receipt.blockNumber)+1):0;}
function failSweep(db,sweep,reason,phase){
  const now=new Date().toISOString();sweep.status='failed_retryable';sweep.failureReason=String(reason||'Sweep transaction failed');sweep.failedPhase=phase;sweep.failedAt=now;sweep.updatedAt=now;
  const deposit=(db.deposits||[]).find(item=>item.id===sweep.depositId);if(deposit)deposit.sweepStatus='failed_retryable';emitSweepLog(db,'TREASURY_SWEEP_FAILED',{sweepId:sweep.id,depositId:sweep.depositId,phase,reason:sweep.failureReason});
}
async function updateBroadcastedSweep(db,sweep,provider,latestBlock){
  const confirmationsRequired=Number(process.env.SWEEP_CONFIRMATIONS||12);
  if(sweep.gasTopupTxHash&&sweep.gasTopupStatus==='broadcasted'){
    const receipt=await provider.getTransactionReceipt(sweep.gasTopupTxHash);if(!receipt)return false;
    if(Number(receipt.status)!==1){failSweep(db,sweep,'Gas top-up reverted','gas_topup');return true;}
    sweep.gasTopupConfirmations=sweepConfirmations(receipt,latestBlock);if(sweep.gasTopupConfirmations<confirmationsRequired)return false;
    sweep.gasTopupStatus='confirmed';sweep.status='gas_funded';sweep.gasFundedAt=new Date().toISOString();sweep.updatedAt=sweep.gasFundedAt;emitSweepLog(db,'TREASURY_SWEEP_GAS_FUNDED',{sweepId:sweep.id,gasTopupTxHash:sweep.gasTopupTxHash});
  }
  if(!sweep.sweepTxHash||sweep.status!=='broadcasted')return false;
  const receipt=await provider.getTransactionReceipt(sweep.sweepTxHash);if(!receipt)return false;
  if(Number(receipt.status)!==1){failSweep(db,sweep,'USDT sweep reverted','token_sweep');return true;}
  sweep.confirmations=sweepConfirmations(receipt,latestBlock);if(sweep.confirmations<confirmationsRequired)return false;
  const now=new Date().toISOString();sweep.status='confirmed';sweep.sweptAt=now;sweep.updatedAt=now;
  const deposit=(db.deposits||[]).find(item=>item.id===sweep.depositId);if(deposit)Object.assign(deposit,{sweepStatus:'confirmed',sweptAt:now,sweepTxHash:sweep.sweepTxHash});
  reserveMove(db,{asset:'USDT',walletType:'treasury',direction:'credit',amount:sweep.amount,reason:'BEP20 treasury sweep confirmed',refId:sweep.id,userId:sweep.userId});emitSweepLog(db,'TREASURY_SWEEP_CONFIRMED',{sweepId:sweep.id,depositId:sweep.depositId,sweepTxHash:sweep.sweepTxHash,amount:sweep.amount,toAddress:sweep.toAddress});return true;
}
async function executeSweep(db,sweep,provider){
  if(sweep.sweepTxHash||sweep.status==='confirmed'||sweep.status==='failed_retryable')return;
  const deposit=(db.deposits||[]).find(item=>item.id===sweep.depositId),address=(db.deposit_addresses||[]).find(item=>item.id===deposit?.depositAddressId);if(!deposit||!address)return failSweep(db,sweep,'Deposit address is unavailable','configuration');
  try{
    const minimum=parseEther(String(positiveEnvNumber('MIN_DEPOSIT_ADDRESS_BNB'))),topup=parseEther(String(positiveEnvNumber('GAS_TOPUP_BNB_AMOUNT'))),bnbBalance=await provider.getBalance(address.address);
    if(bnbBalance<minimum){
      if(!sweep.gasTopupTxHash){const gasWallet=new Wallet(process.env.GAS_WALLET_PRIVATE_KEY,provider),tx=await gasWallet.sendTransaction({to:address.address,value:topup});if(!tx.hash)throw Error('Gas top-up broadcast did not return a transaction hash');Object.assign(sweep,{status:'gas_topup_broadcasted',gasTopupStatus:'broadcasted',gasTopupTxHash:tx.hash,gasTopupFrom:gasWallet.address,updatedAt:new Date().toISOString()});deposit.sweepStatus='gas_topup_broadcasted';emitSweepLog(db,'TREASURY_SWEEP_GAS_TOPUP_BROADCAST',{sweepId:sweep.id,txHash:tx.hash,toAddress:address.address,amountBnb:String(topup)});}return;
    }
    sweep.gasTopupStatus=sweep.gasTopupStatus==='not_required'?'available':sweep.gasTopupStatus;
    const signer=depositPrivateSigner(address,provider),token=new Contract(getAddress(process.env.USDT_BEP20_CONTRACT),['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)'],signer),available=await token.balanceOf(address.address),requested=parseUnits(String(deposit.creditedAmount??deposit.amount),USDT_BEP20_DECIMALS),amount=available<requested?available:requested;
    if(amount<=0n)throw Error('Deposit address has no USDT available to sweep');
    if(amount<requested)throw Error('Deposit address USDT balance is below the credited deposit amount');
    const tx=await token.transfer(getAddress(process.env.TREASURY_WALLET_BSC),amount);if(!tx.hash)throw Error('USDT sweep broadcast did not return a transaction hash');
    Object.assign(sweep,{status:'broadcasted',sweepTxHash:tx.hash,amount:Number(formatUnits(amount,USDT_BEP20_DECIMALS)),tokenContract:getAddress(process.env.USDT_BEP20_CONTRACT),updatedAt:new Date().toISOString(),broadcastAt:new Date().toISOString()});Object.assign(deposit,{sweepStatus:'broadcasted',sweepTxHash:tx.hash});emitSweepLog(db,'TREASURY_SWEEP_BROADCAST',{sweepId:sweep.id,depositId:deposit.id,txHash:tx.hash,fromAddress:address.address,toAddress:sweep.toAddress,amount:sweep.amount});
  }catch(error){failSweep(db,sweep,error.message,'broadcast');}
}
async function pollSweepWorker(){
  if(sweepRunning||!sweepServiceStatus().configured)return;sweepRunning=true;
  try{const provider=new JsonRpcProvider(process.env.BSC_RPC_URL),latestBlock=await provider.getBlockNumber(),db=readDB();createSweepCandidates(db);for(const sweep of db.sweep_transactions||[]){if(['broadcasted','gas_topup_broadcasted'].includes(sweep.status)||sweep.gasTopupStatus==='broadcasted')await updateBroadcastedSweep(db,sweep,provider,latestBlock);if(['not_started','gas_funded'].includes(sweep.status))await executeSweep(db,sweep,provider);}writeDB(db);}catch(error){console.error('Sweep worker error:',error.message);}finally{sweepRunning=false;}
}
function startSweepWorker(){return false;}
function retrySweep(db,sweep){if(!sweep||sweep.status!=='failed_retryable')throw Error('Only failed retryable sweeps can be retried');const now=new Date().toISOString();if(sweep.sweepTxHash)(sweep.failedSweepTxHashes||=[]).push(sweep.sweepTxHash);if(sweep.gasTopupTxHash&&sweep.failedPhase==='gas_topup')(sweep.failedGasTopupTxHashes||=[]).push(sweep.gasTopupTxHash);Object.assign(sweep,{status:'not_started',sweepTxHash:null,gasTopupTxHash:null,gasTopupStatus:'not_required',failureReason:null,failedPhase:null,retryRequestedAt:now,updatedAt:now});const deposit=(db.deposits||[]).find(item=>item.id===sweep.depositId);if(deposit)deposit.sweepStatus='not_started';audit(db,'TREASURY_SWEEP_RETRY_REQUESTED',{sweepId:sweep.id,depositId:sweep.depositId});}
function incomeContext(db,userId,date,hb9PriceOverride=null) {
  const activeStakeUsd=roundCurrency(activeStakes(db,userId).reduce((n,s)=>n+s.amount,0));
  const dailyRoiPercent=Number(setting(db,'dailyRoi'));
  const hb9Price=Number(hb9PriceOverride ?? marketSettings(db).fallbackPrice);
  const pointValue=0.02;
  const businessRequired=roundCurrency(activeStakeUsd*setting(db,'directMultiplier'));
  const businessCurrent=roundCurrency(business(db,userId));
  const qualifiedStakeUsd=activeStakeUsd>0?roundCurrency(Math.min(activeStakeUsd,businessCurrent/setting(db,'directMultiplier'))):0;
  const unqualifiedStakeUsd=roundCurrency(Math.max(0,activeStakeUsd-qualifiedStakeUsd));
  const qualificationPercent=activeStakeUsd>0?roundCurrency(qualifiedStakeUsd/activeStakeUsd*100):0;
  const businessCompleted=activeStakeUsd>0&&qualifiedStakeUsd>=activeStakeUsd;
  const b1EligibleUsd=roundCurrency(activeStakeUsd*dailyRoiPercent/100);
  const qualifiedB1Usd=roundCurrency(qualifiedStakeUsd*dailyRoiPercent/100);
  const unqualifiedB1FlushUsd=roundCurrency(unqualifiedStakeUsd*dailyRoiPercent/100);
  const baseGlobalTeam=activeStakeUsd>0?Math.round(b1EligibleUsd/pointValue):deterministicInt(`${userId}${date}`,setting(db,'globalActivityMin'),setting(db,'globalActivityMax'));
  const dailyExtraPercent=activeStakeUsd>0?deterministicInt(`${userId}${date}global-extra`,5,10):0;
  const extraGlobalTeam=activeStakeUsd>0?Math.round(baseGlobalTeam*dailyExtraPercent/100):0;
  const totalGlobalTeam=baseGlobalTeam+extraGlobalTeam;
  const globalTeamValueUsd=roundCurrency(totalGlobalTeam*pointValue);
  const creditedB1Usd=qualifiedB1Usd;
  const creditedB1Hb9=hb9Price>0?roundCurrency(creditedB1Usd/hb9Price):0;
  const extraGlobalFlushUsd=roundCurrency(activeStakeUsd>0?extraGlobalTeam*pointValue:0);
  const totalFlushUsd=roundCurrency(activeStakeUsd>0?unqualifiedB1FlushUsd+extraGlobalFlushUsd:globalTeamValueUsd);
  const flushUsd=totalFlushUsd;
  const reason=activeStakeUsd===0?'Free registered user global team flushed':businessCompleted?'Extra global team flushed':'Partial 2X qualification: unqualified B1 and extra global team flushed';
  return {activeStakeUsd,dailyRoiPercent,hb9Price,b1EligibleUsd,qualifiedB1Usd,baseGlobalTeam,dailyExtraPercent,extraGlobalPercent:dailyExtraPercent,extraGlobalTeam,totalGlobalTeam,globalTeamValueUsd,creditedB1Usd,creditedB1Hb9,unqualifiedB1FlushUsd,extraGlobalFlushUsd,totalFlushUsd,flushUsd,businessRequired,businessRequiredUsd:businessRequired,businessCurrent,businessCurrentUsd:businessCurrent,directBusinessUsd:businessCurrent,qualifiedStakeUsd,unqualifiedStakeUsd,qualificationPercent,businessCompleted,reason};
}
function globalForDate(db,userId,date,hb9PriceOverride=null,{roi=true,logDuplicates=false}={}) {
  const existing = db.globalTeamRecords.find(x=>x.userId===userId&&x.date===date);
  if(existing&&!roi){if(logDuplicates)audit(db,'GLOBAL_TEAM_SKIP_DUPLICATE',{userId,date});return {created:false,duplicate:true};}
  // A user can receive a non-investor activity record before an admin approves a
  // same-day deposit. Reconcile that activity record into the investment record,
  // but never create a second financial ledger entry for the same date.
  const existingRoi=db.incomeLedger.some(x=>x.userId===userId&&x.date===date&&x.type==='B1_INCOME')||db.flushRecords.some(x=>x.userId===userId&&x.date===date&&x.incomeType==='B1 / Global Team');
  if (existing && existingRoi) {if(logDuplicates)audit(db,roi?'ROI_SKIP_DUPLICATE':'GLOBAL_TEAM_SKIP_DUPLICATE',{userId,date});return {created:false,duplicate:true};}
  const context=incomeContext(db,userId,date,hb9PriceOverride), createdAt=new Date().toISOString();
  if(!roi){
    const globalRecord={activity:context.totalGlobalTeam,value:context.globalTeamValueUsd,paid:0,unpaid:context.globalTeamValueUsd,paidGlobalTeam:0,unpaidGlobalTeam:globalTeamUnits(context.globalTeamValueUsd),globalTeamCount:context.totalGlobalTeam,...context,roiPending:true};
    if (existing) Object.assign(existing,globalRecord,{reconciledAt:createdAt});
    else db.globalTeamRecords.push({id:id('gbl'),userId,date,...globalRecord,createdAt});
    return {created:!existing,duplicate:false};
  }
  let incomeStatus=context.creditedB1Hb9>0?'credited':'flushed', creditedB1Hb9=context.creditedB1Hb9, creditedB1Usd=context.creditedB1Usd, incomeQueuedReason=null;
  if(context.creditedB1Hb9>0){
    try{
      reserveMove(db,{asset:'HB9',walletType:'income',direction:'debit',amount:context.creditedB1Hb9,reason:'B1 income emission',userId,refId:`${userId}:${date}:B1`});
      walletEntry(db,{userId,asset:'HB9',direction:'credit',amount:context.creditedB1Hb9,reason:'B1 income credited',refId:`${userId}:${date}:B1`});
      db.income_emissions.push({id:id('iem'),userId,date,type:'B1_INCOME',asset:'HB9',amount:context.creditedB1Hb9,valueUsd:context.creditedB1Usd,status:'credited',createdAt,immutable:true});
    }catch(error){
      incomeStatus='queued';
      incomeQueuedReason='HB9 income reserve insufficient';
      db.income_emissions.push({id:id('iem'),userId,date,type:'B1_INCOME',asset:'HB9',amount:context.creditedB1Hb9,valueUsd:context.creditedB1Usd,status:'queued',reason:incomeQueuedReason,createdAt,immutable:true});
      creditedB1Hb9=0;
      creditedB1Usd=0;
    }
  }
  const paid=creditedB1Usd, unpaid=roundCurrency(context.flushUsd+(incomeStatus==='queued'?context.creditedB1Usd:0));
  const globalRecord={activity:context.totalGlobalTeam,value:context.globalTeamValueUsd,paid,unpaid,paidGlobalTeam:globalTeamUnits(paid),unpaidGlobalTeam:globalTeamUnits(unpaid),globalTeamCount:context.totalGlobalTeam,...context,roiPending:false,roiProcessedAt:createdAt};
  if (existing) Object.assign(existing,globalRecord,{reconciledAt:createdAt});
  else db.globalTeamRecords.push({id:id('gbl'),userId,date,...globalRecord,createdAt});
  const flushRecord={incomeType:'B1 / Global Team',eligibleIncome:context.b1EligibleUsd,paidIncome:paid,flushedIncome:context.flushUsd,burnStatus:'Burned Forever',withdrawable:false,recoverable:false,...context,createdAt};
  const existingFlush=db.flushRecords.find(x=>x.userId===userId&&x.date===date&&x.incomeType==='B1 / Global Team');
  if (existingFlush) Object.assign(existingFlush,flushRecord);
  else db.flushRecords.push({id:id('fls'),userId,date,...flushRecord});
  if (!context.activeStakeUsd) return {created:true,duplicate:false};
  db.incomeLedger.push({id:id('led'),userId,date,type:'B1_INCOME',asset:'HB9',amount:creditedB1Hb9,hb9Amount:creditedB1Hb9,valueUsd:creditedB1Usd,status:incomeStatus,note:incomeQueuedReason||context.reason,immutable:true,...context,creditedB1Hb9,creditedB1Usd,createdAt});
  return {created:true,duplicate:false};
}
function globalPointEligibilityDate(user){return String(user?.globalPointEligibleAt||user?.createdAt||today()).slice(0,10);}
function accrueGlobalPoints(db,{userId=null,fromDate=null,toDate=today(),hb9PriceOverride=null,roi=true,logDuplicates=false}={}){
  db.globalTeamRecords=db.globalTeamRecords||[];db.flushRecords=db.flushRecords||[];db.incomeLedger=db.incomeLedger||[];
  const users=(db.users||[]).filter(user=>user.role==='user'&&(!userId||user.id===userId));
  const end=String(toDate||today()).slice(0,10),before={ledger:db.incomeLedger.length,global:db.globalTeamRecords.length,flush:db.flushRecords.length};
  let processedUsers=0,createdDays=0,skippedDays=0;
  for(const user of users){
    const start=String(fromDate||globalPointEligibilityDate(user)).slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||start>end)continue;
    processedUsers++;
    for(let date=start;date<=end;date=datePlus(date,1)){
      const exists=roi?(db.incomeLedger.some(record=>record.userId===user.id&&record.date===date&&record.type==='B1_INCOME')||db.flushRecords.some(record=>record.userId===user.id&&record.date===date&&record.incomeType==='B1 / Global Team')):db.globalTeamRecords.some(record=>record.userId===user.id&&record.date===date);
      if(exists){skippedDays++;if(logDuplicates)audit(db,roi?'ROI_SKIP_DUPLICATE':'GLOBAL_TEAM_SKIP_DUPLICATE',{userId:user.id,date});continue;}
      const result=globalForDate(db,user.id,date,hb9PriceOverride,{roi,logDuplicates});
      if(result?.created)createdDays++;else skippedDays++;
    }
  }
  return {processedUsers,createdDays,skippedDays,globalGenerated:db.globalTeamRecords.length-before.global,flushGenerated:db.flushRecords.length-before.flush,b1Credited:db.incomeLedger.slice(before.ledger).filter(x=>x.status==='credited').reduce((n,x)=>n+(Number(x.amount)||0),0)};
}
function globalPointSummary(db,userId){
  const records=(db.globalTeamRecords||[]).filter(record=>record.userId===userId).slice().sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const current=records.at(-1)||null;
  return {currentGlobalTeam:current?.globalTeamCount??current?.activity??0,globalPoints:records.reduce((n,x)=>n+(Number(x.globalTeamCount)||Number(x.activity)||0),0),globalPointValue:roundCurrency(records.reduce((n,x)=>n+(Number(x.value)||0),0)),lastGlobalPointUpdate:current?.date||null,history:records};
}
async function processDaily(db) { return runRoiDaily(db,{now:new Date(),logStartComplete:false}); }
function utcDate(date=new Date()){return date.toISOString().slice(0,10);}
function utcDateTime(date,hour,minute){return new Date(`${date}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00.000Z`);}
function lastDueDate(now,hour,minute){const d=utcDate(now);return now>=utcDateTime(d,hour,minute)?d:datePlus(d,-1);}
function nextDueTime(now,hour,minute){const d=utcDate(now),todayRun=utcDateTime(d,hour,minute);return now<todayRun?todayRun:utcDateTime(datePlus(d,1),hour,minute);}
async function marketPayoutPrice(db){try{const market=await exchangeMarket(db,'1d',1);return Number(market.hb9BasePrice||market.price||market.icpPrice||marketSettings(db).fallbackPrice);}catch(_){return Number(marketSettings(db).fallbackPrice);}}
function schedulerRangeStart(db,kind){
  const users=(db.users||[]).filter(user=>user.role==='user');
  const firstUserDate=users.map(globalPointEligibilityDate).sort()[0]||today();
  const runs=db.schedulerRuns||{};
  return datePlus(runs[kind]?.lastRunDate||datePlus(firstUserDate,-1),1);
}
async function runGlobalTeamDaily(db,{now=new Date(),fromDate=null,toDate=null,backfill=false,logStartComplete=true}={}){
  db.schedulerRuns=db.schedulerRuns||{};
  const end=String(toDate||lastDueDate(now,17,30)).slice(0,10),start=String(fromDate||schedulerRangeStart(db,'globalTeam')).slice(0,10);
  if(logStartComplete)audit(db,'GLOBAL_TEAM_DAILY_START',{fromDate:start,toDate:end,backfill});
  if(start>end){if(logStartComplete)audit(db,'GLOBAL_TEAM_DAILY_COMPLETE',{fromDate:start,toDate:end,processedUsers:0,createdDays:0,skippedDays:0});return {fromDate:start,toDate:end,processedUsers:0,createdDays:0,skippedDays:0,globalGenerated:0};}
  if(backfill)audit(db,'GLOBAL_TEAM_BACKFILL',{fromDate:start,toDate:end});
  const summary=accrueGlobalPoints(db,{fromDate:start,toDate:end,roi:false,logDuplicates:true});
  db.schedulerRuns.globalTeam={lastRunDate:end,lastRunAt:new Date().toISOString()};
  if(logStartComplete)audit(db,'GLOBAL_TEAM_DAILY_COMPLETE',{fromDate:start,toDate:end,...summary});
  return {fromDate:start,toDate:end,...summary};
}
async function runRoiDaily(db,{now=new Date(),fromDate=null,toDate=null,backfill=false,logStartComplete=true}={}){
  db.schedulerRuns=db.schedulerRuns||{};
  const end=String(toDate||lastDueDate(now,18,0)).slice(0,10),start=String(fromDate||schedulerRangeStart(db,'roi')).slice(0,10);
  const hb9Price=await marketPayoutPrice(db);
  if(logStartComplete)audit(db,'ROI_DAILY_START',{fromDate:start,toDate:end,backfill,hb9Price});
  if(start>end){if(logStartComplete)audit(db,'ROI_DAILY_COMPLETE',{fromDate:start,toDate:end,processedUsers:0,createdDays:0,skippedDays:0,b1Credited:0});return {fromDate:start,toDate:end,hb9Price,processedUsers:0,createdDays:0,skippedDays:0,b1Credited:0};}
  if(backfill)audit(db,'ROI_BACKFILL',{fromDate:start,toDate:end});
  const summary=accrueGlobalPoints(db,{fromDate:start,toDate:end,hb9PriceOverride:hb9Price,roi:true,logDuplicates:true});
  db.schedulerRuns.roi={lastRunDate:end,lastRunAt:new Date().toISOString()};
  if(logStartComplete)audit(db,'ROI_DAILY_COMPLETE',{fromDate:start,toDate:end,hb9Price,...summary});
  return {fromDate:start,toDate:end,hb9Price,...summary};
}
async function executeScheduledRun(kind,options={}){
  const db=readDB(), summary=kind==='globalTeam'?await runGlobalTeamDaily(db,options):await runRoiDaily(db,options);
  writeDB(db);
  return summary;
}
let globalTeamTimer=null, roiTimer=null, schedulerRunning=false;
function scheduleDailyTimer(kind,hour,minute){
  const delay=Math.max(1000,nextDueTime(new Date(),hour,minute)-new Date());
  return setTimeout(async()=>{try{await executeScheduledRun(kind,{now:new Date()});}catch(error){console.error(`${kind} scheduler error:`,error.message);}finally{if(kind==='globalTeam')globalTeamTimer=scheduleDailyTimer(kind,hour,minute);else roiTimer=scheduleDailyTimer(kind,hour,minute);}},delay);
}
async function startDailySchedulers(){
  if(schedulerRunning)return;
  schedulerRunning=true;
  try{
    await executeScheduledRun('globalTeam',{now:new Date(),backfill:true});
    await executeScheduledRun('roi',{now:new Date(),backfill:true});
  }catch(error){console.error('Daily scheduler backfill error:',error.message);}
  globalTeamTimer=scheduleDailyTimer('globalTeam',17,30);
  roiTimer=scheduleDailyTimer('roi',18,0);
}
function auth(req, db) {
  const token=(req.headers.authorization||'').replace('Bearer ','');
  const session=sessions.get(token);
  if(session)return userById(db,session.userId);
  return null;
}
function send(res,status,payload) { res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(payload)); }
function body(req) { return new Promise((resolve,reject)=>{let b='';req.on('data',x=>b+=x);req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch(e){reject(e)}})}); }
function rawBody(req) { return new Promise((resolve,reject)=>{let b='';req.on('data',x=>b+=x);req.on('error',reject);req.on('end',()=>resolve(b));}); }
function safeUser(u){ const {passwordHash,salt,...safe}=u; return safe; }
function dashboard(db,u) {
  const stake=activeStakes(db,u.id).reduce((n,s)=>n+s.amount,0), completed=business(db,u.id), required=stake*setting(db,'directMultiplier');
  const globals=db.globalTeamRecords.filter(x=>x.userId===u.id), flushes=db.flushRecords.filter(x=>x.userId===u.id), b1=db.incomeLedger.filter(x=>x.userId===u.id&&x.type==='B1_INCOME'&&x.status==='credited');
  const referrals=(db.referralLedger||[]).filter(x=>x.sponsorId===u.id), levelIncome=(db.level_income_ledger||[]).filter(x=>x.receiverUserId===u.id);
  const creditedLevelIncome=levelIncome.filter(x=>x.status==='credited'), direct=db.users.filter(x=>x.sponsorId===u.id);
  const qualifiedDirects=qualifiedDirectReferralCount(db,u.id), levelUnlocked=unlockedLevel(db,u.id);
  const allStakes=db.stakes.filter(s=>s.userId===u.id), withdrawals=db.withdrawals.filter(x=>x.userId===u.id), deposits=db.deposits.filter(x=>x.userId===u.id), conversions=(db.conversions||[]).filter(x=>x.userId===u.id), balances=walletBalances(db,u.id);
  const salary=salaryReport(db,u.id);
  const globalPoints=globalPointSummary(db,u.id);
  const paidGlobalValue=roundCurrency(globals.reduce((n,x)=>n+(Number(x.paid)||0),0)), unpaidGlobalValue=roundCurrency(globals.reduce((n,x)=>n+(Number(x.unpaid)||0),0));
  const paidGlobal=globalTeamUnits(paidGlobalValue), unpaidGlobal=globalTeamUnits(unpaidGlobalValue);
  return {user:safeUser(u),settings:{...db.settings,market:marketSettings(db)},depositService:depositServiceStatus(),sweepService:sweepServiceStatus(),wallets:{...balances,withdrawal:balances.withdrawableUsdt},supply:solvencyReport(db),stats:{totalStake:allStakes.reduce((n,s)=>n+s.amount,0),activeStake:stake,totalStakeHb9:allStakes.reduce((n,s)=>n+(Number(s.hb9EquivalentAmount)||Number(s.coinAmount)||0),0),activeStakeHb9:activeStakeHb9(db,u.id),totalDeposit:balances.totalDeposit,totalWithdrawal:withdrawals.filter(x=>x.status!=='rejected').reduce((n,x)=>n+x.amount,0),directTeam:direct.length,qualifiedDirectReferralCount:qualifiedDirects,unlockedLevel:levelUnlocked,directBusiness:completed,requiredBusiness:required,remainingBusiness:Math.max(0,required-completed),currentGlobalTeam:globalPoints.currentGlobalTeam,globalPoints:globalPoints.globalPoints,lastGlobalPointUpdate:globalPoints.lastGlobalPointUpdate},globalPoints,income:{todayReferral:referrals.filter(x=>x.date===today()&&(!x.status||x.status==='credited')).reduce((n,x)=>n+(Number(x.referralHb9Amount)||Number(x.referralAmount)||0),0),totalReferral:referrals.filter(x=>!x.status||x.status==='credited').reduce((n,x)=>n+(Number(x.referralHb9Amount)||Number(x.referralAmount)||0),0),todayLevelIncome:creditedLevelIncome.filter(x=>String(x.createdAt||'').slice(0,10)===today()).reduce((n,x)=>n+(Number(x.hb9Amount)||0),0),totalLevelIncome:creditedLevelIncome.reduce((n,x)=>n+(Number(x.hb9Amount)||0),0),todaySalary:(db.salary_payouts||[]).filter(x=>x.userId===u.id&&x.status==='credited'&&String(x.createdAt||'').slice(0,10)===today()).reduce((n,x)=>n+(Number(x.hb9Amount)||0),0),totalSalary:(db.salary_payouts||[]).filter(x=>x.userId===u.id&&x.status==='credited').reduce((n,x)=>n+(Number(x.hb9Amount)||0),0),todayB1:b1.filter(x=>x.date===today()).reduce((n,x)=>n+(Number(x.hb9Amount)||Number(x.amount)||0),0),totalB1:b1.reduce((n,x)=>n+(Number(x.hb9Amount)||Number(x.amount)||0),0),paidGlobal,unpaidGlobal,paidGlobalValue,unpaidGlobalValue,todayFlush:flushes.filter(x=>x.date===today()).reduce((n,x)=>n+(Number(x.flushedIncome)||0),0),totalFlush:flushes.reduce((n,x)=>n+(Number(x.flushedIncome)||0),0),eligible:stake>0&&completed>=required},salary,levelUnlock:{qualifiedDirectReferralCount:qualifiedDirects,unlockedLevel:levelUnlocked,requiredStakeUsd:LEVEL_DIRECT_MIN_STAKE_USD,maxLevel:LEVEL_INCOME_PERCENTS.length},b1Records:b1.map(x=>({date:x.date,fromUser:u.name,amount:Number(x.hb9Amount)||Number(x.amount)||0,valueUsd:x.valueUsd,status:x.status})),levelIncomeRecords:levelIncome,deposits,conversions,stakes:allStakes,team:direct.map(x=>({id:x.id,name:x.name,email:x.email,joinedAt:x.createdAt,activeStakeUsd:activeStakeUsd(db,x.id)})),referrals,globals,flushes,withdrawals};
}
const server=http.createServer(async(req,res)=>{
  try {
    if (req.url.startsWith('/api/')) {
      const db=readDB(), url=new URL(req.url,`http://${req.headers.host}`), p=url.pathname, method=req.method;
      if(p==='/api/nowpayments/ipn'&&method==='POST'){
        const raw=await rawBody(req);
        let payload={};try{payload=raw?JSON.parse(raw):{};}catch(_){return send(res,400,{error:'Invalid JSON'});}
        const signature=req.headers['x-nowpayments-sig'];
        db.nowpayments_ipn_events=db.nowpayments_ipn_events||[];
        const event={id:id('npi'),paymentId:payload.payment_id||payload.id||null,invoiceId:payload.invoice_id||null,status:payload.payment_status||null,validSignature:false,createdAt:new Date().toISOString(),payload};
        if(!verifyNowPaymentsSignature(raw,payload,signature)){
          event.rejected=true;event.reason='invalid_signature';db.nowpayments_ipn_events.push(event);audit(db,'NOWPAYMENTS_IPN_REJECTED',{reason:event.reason,paymentId:event.paymentId,invoiceId:event.invoiceId,status:event.status});writeDB(db);return send(res,401,{error:'Invalid NOWPayments signature'});
        }
        event.validSignature=true;
        try{const result=creditNowPaymentsDeposit(db,payload);event.depositId=result.deposit.id;event.credited=result.credited;event.duplicate=Boolean(result.duplicate);db.nowpayments_ipn_events.push(event);audit(db,'NOWPAYMENTS_IPN_RECEIVED',{paymentId:event.paymentId,invoiceId:event.invoiceId,status:event.status,depositId:event.depositId,credited:event.credited,duplicate:event.duplicate});writeDB(db);return send(res,200,{ok:true,credited:result.credited,duplicate:Boolean(result.duplicate),status:result.deposit.status});}
        catch(error){event.rejected=true;event.reason=error.message;db.nowpayments_ipn_events.push(event);audit(db,'NOWPAYMENTS_IPN_REJECTED',{reason:event.reason,paymentId:event.paymentId,invoiceId:event.invoiceId,status:event.status});writeDB(db);return send(res,400,{error:error.message});}
      }
      if (p==='/api/auth/login'&&method==='POST') { const {email,password}=await body(req); if(typeof email!=='string'||typeof password!=='string')return send(res,400,{error:'Email and password are required'}); const u=db.users.find(x=>x.email.toLowerCase()===email.toLowerCase()); if(!u||!check(password,u)||u.status!=='active') return send(res,401,{error:'Invalid credentials or blocked account'}); const token=crypto.randomBytes(32).toString('hex'); sessions.set(token,{userId:u.id}); return send(res,200,{token,user:safeUser(u)}); }
      if (p==='/api/auth/logout'&&method==='POST') { const bearer=(req.headers.authorization||'').replace('Bearer ',''); if(bearer)sessions.delete(bearer); return send(res,200,{message:'Logged out'}); }
      if (p==='/api/auth/register'&&method==='POST') { const {name,email,password,sponsorEmail,walletAddress}=await body(req); if(!name||!email||!password||password.length<8)return send(res,400,{error:'Name, email and 8+ character password are required'}); if(walletAddress&&typeof walletAddress==='string'&&!/^0x[a-fA-F0-9]{40}$/.test(walletAddress))return send(res,400,{error:'Enter a valid 42-character BEP20 wallet address starting with 0x'}); if(db.users.some(x=>x.email.toLowerCase()===email.toLowerCase()))return send(res,409,{error:'Email already registered'}); const h=hash(password), sponsor=db.users.find(x=>x.email===sponsorEmail); const u={id:id('usr'),name,email:email.toLowerCase(),role:'user',status:'active',passwordHash:h.hash,salt:h.salt,walletAddress:walletAddress||null,sponsorId:sponsor?.id||null,createdAt:new Date().toISOString()}; db.users.push(u);writeDB(db);return send(res,201,{message:'Registration complete. Please log in.'}); }
      const u=auth(req,db); if(!u)return send(res,401,{error:'Authentication required'});
      if(p==='/api/market/hb9-ticker'&&method==='GET'){try{const market=await exchangeMarket(db,'1d',1);return send(res,200,{symbol:'HB9/USDT',pair:'HB9/USDT',source:market.source,price:market.price,icpPrice:market.icpPrice,hb9BasePrice:market.hb9BasePrice,priceOffset:market.priceOffset,hb9BuyPrice:market.hb9BuyPrice,hb9SellPrice:market.hb9SellPrice,buyPrice:market.buyPrice,sellPrice:market.sellPrice,spreadPercent:market.spreadPercent,manualOverrideEnabled:market.manualOverrideEnabled,high24h:market.high24h,low24h:market.low24h,volume24h:market.baseVolume,quoteVolume24h:market.quoteVolume,changePercent:market.changePercent});}catch(error){return send(res,503,{error:error.message});}}
      if(p==='/api/market/hb9-klines'&&method==='GET'){const interval={"15m":"15m","1h":"1h","4h":"4h","1d":"1d"}[url.searchParams.get('interval')]||'1d';try{const market=await exchangeMarket(db,interval,120);return send(res,200,{symbol:'HB9/USDT',pair:'HB9/USDT',source:market.source,candles:market.candles});}catch(error){return send(res,503,{error:error.message});}}
      if(p==='/api/market/hb9-usdt'&&method==='GET'){const market=await exchangeMarket(db);return send(res,200,{symbol:'HB9/USDT',...market});}
      if(p==='/api/market/bnb-ticker'&&method==='GET'){const market=await bnbMarket('1d',1);return send(res,200,market);}
      if(p==='/api/market/bnb-klines'&&method==='GET'){const interval={"15m":"15m","1h":"1h","4h":"4h","1d":"1d"}[url.searchParams.get('interval')]||'1d';const market=await bnbMarket(interval,120);return send(res,200,{symbol:'BNB/USDT',pair:'BNB/USDT',source:market.source,candles:market.candles});}
      if(p==='/api/dashboard'&&method==='GET'){return send(res,200,dashboard(db,u));}
      if(p==='/api/deposit-address'&&method==='GET')return send(res,410,{error:'HD wallet deposit addresses are disabled. Use NOWPayments deposits.'});
      if(p==='/api/deposits'&&method==='POST'){try{const input=await body(req),result=await createNowPaymentsDeposit(db,u.id,input.amount);writeDB(db);return send(res,201,{message:'NOWPayments deposit created',deposit:result.deposit,payment:result.payment,service:result.service});}catch(error){return send(res,400,{error:error.message});}}
      if(p==='/api/internal/deposit-events'&&method==='POST')return send(res,410,{error:'BEP20 watcher deposit ingestion is disabled'});
      if(p==='/api/convert'&&method==='POST'){let input={};try{input=await body(req);console.log('CONVERT_REQUEST_RECEIVED',{userId:u.id,fromAsset:input.fromAsset||'USDT',toAsset:input.toAsset||'HB9',amount:Number(input.amount),clientRequestId:input.clientRequestId||null,createdAt:new Date().toISOString()});const result=await convertUsdtToAsset(db,u,input);writeDB(db);console.log('CONVERT_SUCCESS',{userId:u.id,orderId:result.order.id,conversionId:result.conversion?.id||null,fromAsset:result.order.fromAsset,toAsset:result.order.toAsset,fromAmount:result.order.fromAmount,toAmount:result.order.toAmount,duplicate:result.duplicate,createdAt:new Date().toISOString()});return send(res,result.duplicate?200:201,{message:result.duplicate?'Conversion already completed':`${result.order.fromAsset} converted to ${result.order.toAsset}`,order:result.order,conversion:result.conversion,balance:result.balance,balances:result.balance,hb9Amount:result.order.hb9Amount,bnbAmount:result.order.bnbAmount,buyPrice:result.order.buyPrice});}catch(error){console.log('CONVERT_FAILED',{userId:u.id,fromAsset:input.fromAsset||'USDT',toAsset:input.toAsset||'HB9',amount:Number(input.amount),clientRequestId:input.clientRequestId||null,error:error.message,createdAt:new Date().toISOString()});return send(res,/disabled/.test(error.message)?403:400,{error:error.message});}}
      if(p==='/api/exchange/sell'&&method==='POST'){if(!db.settings.exchangeEnabled)return send(res,403,{error:'Exchange is disabled'});const {amount}=await body(req), hb9Amount=Number(amount), balances=walletBalances(db,u.id), market=await exchangeMarket(db), rate=market.sellPrice, fee=setting(db,'tradingFeePercent')+setting(db,'sellFeePercent');if(!Number.isFinite(hb9Amount)||hb9Amount<=0)return send(res,400,{error:'HB9 amount is invalid'});if(hb9Amount>balances.hb9)return send(res,400,{error:'Not enough HB9 wallet balance'});const usdtAmount=roundCurrency(hb9Amount*rate*(1-fee/100));if(reserveWallet(db,'USDT','treasury').balance<usdtAmount)return send(res,400,{error:'USDT reserve is insufficient'});const orderId=id('xord'),createdAt=new Date().toISOString();reserveMove(db,{asset:'USDT',walletType:'treasury',direction:'debit',amount:usdtAmount,reason:'HB9 sell payout',userId:u.id,refId:orderId});burnHb9(db,{amount:hb9Amount,reason:'HB9 sell burn',userId:u.id,refId:orderId});walletEntry(db,{userId:u.id,asset:'HB9',direction:'debit',amount:hb9Amount,reason:'HB9 sell burn',refId:orderId});walletEntry(db,{userId:u.id,asset:'USDT',direction:'credit',amount:usdtAmount,reason:'HB9 sell payout',refId:orderId});db.conversions=(db.conversions||[]);db.exchange_orders=db.exchange_orders||[];const order={id:orderId,userId:u.id,direction:'sell',hb9Amount,usdtAmount,rate,sellPrice:rate,buyPrice:market.buyPrice,feePercent:fee,status:'completed',burnedHb9:hb9Amount,createdAt,immutable:true};db.conversions.push({id:id('cnv'),...order});db.exchange_orders.push(order);writeDB(db);return send(res,201,{message:'HB9 converted to USDT and burned',usdtAmount,sellPrice:rate,burnedHb9:hb9Amount,totalBurnedHb9:burnTotal(db),remainingHb9Supply:solvencyReport(db).remainingHb9Supply,circulatingHb9:solvencyReport(db).circulatingHb9});}
      if(p==='/api/stakes'&&method==='POST'){try{const stake=await createStake(db,u,await body(req));writeDB(db);return send(res,201,{message:`${stake.stakeAsset} permanent stake created`,stake});}catch(error){return send(res,400,{error:error.message});}}
      if(p==='/api/transfers'&&method==='GET'){const records=(db.transferLedger||[]).filter(x=>x.userId===u.id).map(x=>({...x,counterparty:safeUser(userById(db,x.counterpartyId))}));return send(res,200,{transfers:records});}
      if(p==='/api/transfers'&&method==='POST'){const {receiver,amount,note}=await body(req), value=Number(amount), receiverUser=db.users.find(x=>x.id===receiver||x.email.toLowerCase()===String(receiver||'').toLowerCase());if(!receiverUser||receiverUser.role!=='user')return send(res,404,{error:'Receiver not found'});if(receiverUser.id===u.id)return send(res,400,{error:'You cannot transfer HB9 to yourself'});if(!Number.isFinite(value)||value<=0)return send(res,400,{error:'Transfer amount must be greater than zero'});if(value<setting(db,'minHb9Transfer'))return send(res,400,{error:`Minimum transfer is ${setting(db,'minHb9Transfer')} HB9`});const fee=roundCurrency(value*setting(db,'hb9TransferFeePercent')/100),available=walletBalances(db,u.id).hb9;if(value+fee>available)return send(res,400,{error:'Not enough available HB9 balance'});const createdAt=new Date().toISOString(),transfer={id:id('trf'),senderId:u.id,receiverId:receiverUser.id,amount:value,fee,status:'completed',note:String(note||''),createdAt};db.transfers=(db.transfers||[]);db.transferLedger=(db.transferLedger||[]);db.transfers.push(transfer);db.transferLedger.push({id:id('tlg'),transferId:transfer.id,userId:u.id,type:'HB9_TRANSFER_SENT',counterpartyId:receiverUser.id,amount:value,fee,createdAt,immutable:true},{id:id('tlg'),transferId:transfer.id,userId:receiverUser.id,type:'HB9_TRANSFER_RECEIVED',counterpartyId:u.id,amount:value,fee:0,createdAt,immutable:true});writeDB(db);return send(res,201,{message:'HB9 transfer completed',transfer});}
      if(p==='/api/withdrawals'&&method==='POST'){const {amount,address}=await body(req);const value=Number(amount),available=walletBalances(db,u.id).withdrawableUsdt;if(!Number.isFinite(value)||value<=0)return send(res,400,{error:'Withdrawal amount is invalid'});if(!/^0x[a-fA-F0-9]{40}$/.test(String(address||'')))return send(res,400,{error:'Valid USDT BEP20 address is required'});if(value<setting(db,'minWithdrawal'))return send(res,400,{error:`Minimum withdrawal is ${setting(db,'minWithdrawal')} USDT`});if(value>available)return send(res,400,{error:'Not enough USDT withdrawal balance. Convert HB9 to USDT before withdrawing.'});const withdrawal={id:id('wd'),userId:u.id,asset:'USDT',chain:'BSC',amount:value,address,status:'pending',fee:roundCurrency(value*setting(db,'withdrawalFeePercent')/100),createdAt:new Date().toISOString()};db.withdrawals.push(withdrawal);walletEntry(db,{userId:u.id,asset:'USDT',direction:'lock',amount:value,reason:'USDT withdrawal lock',refId:withdrawal.id});writeDB(db);return send(res,201,{message:'USDT BEP20 withdrawal request submitted for manual approval.'});}
      if(p==='/api/admin/diagnostics/bnb-wallet'&&method==='GET'){const userId=url.searchParams.get('userId')||u.id;if(u.role!=='admin'&&userId!==u.id)return send(res,403,{error:'Admin only action'});const target=userById(db,userId);if(!target)return send(res,404,{error:'User not found'});return send(res,200,bnbLedgerDiagnostic(db,target.id));}
      if(u.role!=='admin')return send(res,403,{error:'Admin only action'});
      if(p==='/api/admin/transfer-settings'&&method==='PUT'){const {minHb9Transfer,hb9TransferFeePercent}=await body(req),min=Number(minHb9Transfer),fee=Number(hb9TransferFeePercent);if(!Number.isFinite(min)||min<0||!Number.isFinite(fee)||fee<0||fee>100)return send(res,400,{error:'Invalid transfer settings'});db.settings.minHb9Transfer=min;db.settings.hb9TransferFeePercent=fee;writeDB(db);return send(res,200,{message:'Transfer settings saved',settings:db.settings});}
      if(p==='/api/admin/fund-transfer'&&method==='POST'){try{const result=adminFundTransfer(db,u,await body(req));writeDB(db);return send(res,201,{message:'Admin fund transfer completed',...result});}catch(error){return send(res,error.message==='Admin only action'?403:400,{error:error.message});}}
      if(p==='/api/admin/overview'&&method==='GET'){return send(res,200,{users:db.users.filter(x=>x.role==='user').map(x=>({...safeUser(x),summary:dashboard(db,x)})),settings:{...db.settings,market:marketSettings(db)},sweepService:sweepServiceStatus(),marketSettings:marketSettings(db),priceHistory:db.hb9_price_history||[],marketReport:hb9MarketReport(db),supply:db.hb9_supply,reserveWallets:db.reserve_wallets||[],reserveLedger:db.reserve_ledger||[],burnLedger:db.burn_ledger||[],walletLedger:db.wallet_ledger||[],exchangeOrders:db.exchange_orders||[],exchangeReserve:exchangeReserveReport(db),incomeEmissions:db.income_emissions||[],solvency:solvencyReport(db),deposits:db.deposits,depositAddresses:db.deposit_addresses||[],blockchainTransactions:db.blockchain_transactions||[],sweepTransactions:db.sweep_transactions||[],auditLogs:db.auditLogs||[],adminFundTransfers:db.admin_fund_transfers||[],conversions:db.conversions||[],stakes:db.stakes,withdrawals:db.withdrawals,transfers:db.transfers||[],ledger:db.incomeLedger,referrals:db.referralLedger||[],levelIncomeLedger:db.level_income_ledger||[],salaryRanks:db.salary_ranks||[],salaryQualifications:db.salary_qualifications||[],salaryPayouts:db.salary_payouts||[],globals:db.globalTeamRecords,flushes:db.flushRecords,directBusinessAudit:db.directBusinessAudit||[],dailyRuns:db.dailyRuns||[],schedulerRuns:db.schedulerRuns||{},demoMode:DEMO_MODE});}
      if(p==='/api/admin/reserve-wallets'&&method==='PUT'){const input=await body(req),asset=String(input.asset||'').toUpperCase(),walletType=String(input.walletType||''),balance=Number(input.balance);if(!['HB9','USDT','BNB'].includes(asset)||!walletType)return send(res,400,{error:'Valid asset and walletType are required'});if(!Number.isFinite(balance)||balance<0)return send(res,400,{error:'Reserve balance must be non-negative'});const wallet=reserveWallet(db,asset,walletType),old=wallet.balance;if(asset==='HB9'){const projected=roundCurrency(solvencyReport(db).accountedHb9-old+balance);if(projected>HB9_TOTAL_SUPPLY)return send(res,400,{error:'HB9 reserve adjustment exceeds fixed total supply'});}wallet.balance=roundCurrency(balance);wallet.updatedAt=new Date().toISOString();db.reserve_ledger.push({id:id('rsv'),asset,walletType,direction:'admin_set',amount:wallet.balance,balanceAfter:wallet.balance,reason:'Admin reserve adjustment',userId:u.id,createdAt:wallet.updatedAt,immutable:true});writeDB(db);return send(res,200,{message:'Reserve wallet updated',wallet,solvency:solvencyReport(db),exchangeReserve:exchangeReserveReport(db)});}
      if(p.startsWith('/api/admin/withdrawals/')&&p.endsWith('/reject')&&method==='POST'){const wd=db.withdrawals.find(x=>x.id===p.split('/')[4]);if(!wd||wd.status!=='pending')return send(res,400,{error:'Pending withdrawal not found'});wd.status='rejected';wd.rejectedAt=new Date().toISOString();wd.rejectedBy=u.id;walletEntry(db,{userId:wd.userId,asset:'USDT',direction:'unlock',amount:wd.amount,reason:'USDT withdrawal rejected',refId:wd.id});writeDB(db);return send(res,200,{message:'Withdrawal rejected and USDT unlocked',withdrawal:wd});}
      if(p.startsWith('/api/admin/withdrawals/')&&p.endsWith('/payout')&&method==='POST'){const wd=db.withdrawals.find(x=>x.id===p.split('/')[4]);if(!wd||wd.status!=='pending')return send(res,400,{error:'Pending withdrawal not found'});wd.status='approved';wd.paidAt=new Date().toISOString();wd.paidBy=u.id;walletEntry(db,{userId:wd.userId,asset:'USDT',direction:'payout',amount:wd.amount,reason:'USDT withdrawal payout',refId:wd.id});writeDB(db);return send(res,200,{message:'Withdrawal payout recorded',withdrawal:wd});}
      if(p==='/api/admin/market-settings'&&method==='PUT'){const result=setMarketSettings(db,await body(req),u.id);if(result.error)return send(res,400,{error:result.error});writeDB(db);return send(res,200,{message:'HB9 market prices saved',marketSettings:result.settings,priceHistory:db.hb9_price_history||[]});}
      if(p==='/api/admin/deposits/search'&&method==='GET'){const q=String(url.searchParams.get('q')||'').toLowerCase(),userId=url.searchParams.get('userId');const records=(db.deposits||[]).filter(x=>(!userId||x.userId===userId)&&(!q||String(x.userId||'').toLowerCase().includes(q)||String(x.txHash||'').toLowerCase().includes(q)||String(x.sweepTxHash||'').toLowerCase().includes(q)||String(x.depositAddressId||'').toLowerCase().includes(q)||String((db.deposit_addresses||[]).find(a=>a.id===x.depositAddressId)?.address||'').toLowerCase().includes(q)));return send(res,200,{deposits:records});}
      if(p==='/api/admin/sweeps'&&method==='GET')return send(res,410,{error:'Treasury sweep flow is disabled for NOWPayments deposits'});
      if(p.startsWith('/api/admin/sweeps/')&&p.endsWith('/retry')&&method==='POST')return send(res,410,{error:'Treasury sweep flow is disabled for NOWPayments deposits'});
      if(p==='/api/admin/settings'&&method==='PUT'){const input=await body(req); const allowed=['dailyRoi','directMultiplier','referralPercent','globalActivityMin','globalActivityMax','hb9Price','fallbackPrice','priceOffset','spreadPercent','buyFeePercent','sellFeePercent','manualOverrideEnabled','minWithdrawal','withdrawalFeePercent','manualWithdrawalApproval','treasuryWalletBSC']; for(const k of allowed)if(input[k]!==undefined)db.settings[k]=input[k];db.settings.globalPointValue=0.02;delete db.settings.globalExtraPercent; const numeric=['dailyRoi','directMultiplier','referralPercent','globalActivityMin','globalActivityMax','hb9Price','fallbackPrice','priceOffset','spreadPercent','buyFeePercent','sellFeePercent','minWithdrawal','withdrawalFeePercent']; if(!/^0x[a-fA-F0-9]{40}$/.test(String(db.settings.treasuryWalletBSC||'')))return send(res,400,{error:'Treasury wallet must be a valid EVM address'});if(numeric.some(k=>db.settings[k]!==undefined&&!Number.isFinite(Number(db.settings[k])))||db.settings.dailyRoi<1||db.settings.dailyRoi>4||db.settings.directMultiplier<1||db.settings.referralPercent<0||db.settings.referralPercent>100||db.settings.globalActivityMin<5||db.settings.globalActivityMax>15||db.settings.globalActivityMax<db.settings.globalActivityMin||Number(db.settings.fallbackPrice||db.settings.hb9Price)<=0||Number(db.settings.priceOffset)<0||db.settings.minWithdrawal<0||db.settings.withdrawalFeePercent<0||db.settings.withdrawalFeePercent>100)return send(res,400,{error:'Invalid settings. ROI must be 1-4%, referral percentage must be 0-100%, free Global Team must be 5-15, fallback price must be positive, and price offset must be non-negative.'}); numeric.forEach(k=>{if(db.settings[k]!==undefined)db.settings[k]=Number(db.settings[k])});if(input.fallbackPrice!==undefined||input.hb9Price!==undefined||input.priceOffset!==undefined||input.spreadPercent!==undefined||input.manualOverrideEnabled!==undefined||input.buyFeePercent!==undefined||input.sellFeePercent!==undefined){const result=setMarketSettings(db,{fallbackPrice:db.settings.fallbackPrice||db.settings.hb9Price,priceOffset:db.settings.priceOffset,spreadPercent:db.settings.spreadPercent,manualOverrideEnabled:db.settings.manualOverrideEnabled,buyFeePercent:db.settings.buyFeePercent,sellFeePercent:db.settings.sellFeePercent},u.id);if(result.error)return send(res,400,{error:result.error});}else db.settings.priceMode=marketSettings(db).manualOverrideEnabled?'manual_override':'icp_proxy';writeDB(db);return send(res,200,{message:'Settings saved',settings:{...db.settings,market:marketSettings(db)}});}
      if(p==='/api/admin/demo/reset'&&method==='POST'){return send(res,404,{error:'Route not found'});}
      if(p==='/api/admin/daily-income/run'&&method==='POST'){return send(res,410,{error:'Daily Global Team and ROI are handled by the UTC scheduler.'});}
      if(p==='/api/admin/salary/run'&&method==='POST'){const summary=await processSalaryPayouts(db,today());if(summary.processedUsers===0)return send(res,409,{error:'Salary cycle already processed or no qualified users',summary});db.salaryRuns=db.salaryRuns||[];db.salaryRuns.push({id:id('srun'),adminId:u.id,adminName:u.name,...summary,createdAt:new Date().toISOString()});writeDB(db);return send(res,200,{message:'Salary payout run completed',summary});}
      if(p==='/api/admin/direct-business'&&method==='POST'){const {userId,amount,note}=await body(req);const target=userById(db,userId),value=Number(amount);if(!target||target.role!=='user')return send(res,404,{error:'User not found'});if(!Number.isFinite(value)||value<=0)return send(res,400,{error:'Direct business amount must be greater than zero'});const oldBusiness=business(db,target.id),newBusiness=roundCurrency(oldBusiness+value),createdAt=new Date().toISOString();db.directBusiness.push({id:id('biz'),userId:target.id,sourceUserId:null,amount:value,reason:note||'Manual admin adjustment',createdAt,createdBy:u.id});db.directBusinessAudit=(db.directBusinessAudit||[]);db.directBusinessAudit.push({id:id('audit'),type:'DIRECT_BUSINESS_ADJUSTMENT',userId:target.id,oldBusiness,addedBusiness:value,newBusiness,adminId:u.id,adminName:u.name,note:note||'',createdAt,immutable:true});writeDB(db);return send(res,201,{message:'Direct business added',audit:db.directBusinessAudit.at(-1)});}
      if(p.startsWith('/api/admin/users/')&&p.endsWith('/status')&&method==='PUT'){const target=userById(db,p.split('/')[4]);const {status}=await body(req);if(!target||target.role==='admin')return send(res,404,{error:'User not found'});target.status=status==='blocked'?'blocked':'active';writeDB(db);return send(res,200,{message:'User status updated'});}
      return send(res,404,{error:'Route not found'});
    }
    const routePath=new URL(req.url,`http://${req.headers.host}`).pathname;
    let f=(routePath==='/'||routePath==='/exchange'||routePath==='/admin')?'/index.html':decodeURIComponent(routePath);f=path.join(PUBLIC,f);if(!f.startsWith(PUBLIC)||!fs.existsSync(f)) {res.writeHead(404);return res.end('Not found');} const ext=path.extname(f),types={'.html':'text/html','.css':'text/css','.js':'application/javascript','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream'});fs.createReadStream(f).pipe(res);
  } catch(e){ console.error(e);send(res,500,{error:'Server error'}); }
});
if(require.main===module)server.listen(PORT,()=>{const storage=runtimeStorageDiagnostics();console.log('RUNTIME_DATA_FILE',{dataFile:storage.dataFile,envDataFile:storage.envDataFile,cwd:storage.cwd,appDir:storage.appDir});console.log('NOWPAYMENTS_DEPOSIT_GATEWAY',depositServiceStatus());console.log('DAILY_SCHEDULER_UTC',{globalTeam:'17:30',roi:'18:00'});startDailySchedulers();console.log(`HB9 Staking running at ${APP_URL}`);});
module.exports={configuredDepositWatcherStartBlock,dataFile:DATA,readDB,resolveDataFile,runtimeStorageDiagnostics,writeDB,depositDerivationPath,depositPrivateSigner,depositSignerDiagnostics,derivedDepositAddress,ensureDepositAddress,hdBaseDerivationPath,hdFingerprint,hdWalletConsistencyStatus,isZeroValueBep20Transfer,parseBep20TransferWatcherLog,processDepositWatcherLogs,recordBep20Transfer,repairBep20RawUnitAmounts,repairBnbConversionPrecision,resolveDepositWatcherLiveScanRange,resolveDepositWatcherStart,validateBep20TransferEvent,createSweepCandidates,updateBroadcastedSweep,updateDepositConfirmations,retrySweep,sweepServiceStatus,migrateUnsafeDepositAddresses,createNowPaymentsDeposit,creditNowPaymentsDeposit,verifyNowPaymentsSignature,sortedJson,adminFundTransfer,walletBalances,bnbLedgerDiagnostic,accrueGlobalPoints,globalPointSummary,globalPointEligibilityDate,globalTeamUnits,dashboard,convertUsdtToAsset,createStake,bnbMarket,exchangeReserveReport,runGlobalTeamDaily,runRoiDaily,lastDueDate,nextDueTime,startDailySchedulers,server};
