try { require('dotenv').config(); } catch (_) { /* .env is optional in the dependency-free demo */ }
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HDNodeWallet, Interface, JsonRpcProvider, Wallet, Contract, getAddress, isAddress, formatUnits, parseUnits, parseEther } = require('ethers');

const PORT = Number(process.env.PORT || 3000);
const DATA = path.resolve(process.env.DATA_FILE || './data/db.json');
const PUBLIC = path.join(__dirname, 'public');
const APP_URL = process.env.APP_URL || (process.env.NODE_ENV === 'production' ? 'https://coin.hb9.live' : `http://localhost:${PORT}`);
const PRODUCTION_DOMAIN = /^https:\/\/coin\.hb9\.live\/?$/i.test(APP_URL);
const DEV_ONLY_DEMO = process.env.NODE_ENV !== 'production' && process.env.DEMO_MODE === 'true';
const DEMO_MODE = DEV_ONLY_DEMO;
const BSC_CHAIN = 'BSC';
const USDT_BEP20_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];
const usdtInterface = new Interface(USDT_BEP20_ABI);
const TRANSFER_TOPIC = usdtInterface.getEvent('Transfer').topicHash;
const WATCHER_POLL_MS = Math.max(5000, Number(process.env.DEPOSIT_WATCHER_POLL_MS || 15000));
let watcherTimer = null;
let watcherRunning = false;
let watcherResetApplied = false;
let sweepTimer = null;
let sweepRunning = false;
const HB9_TOTAL_SUPPLY = 1000000;
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
const hash = (password, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') });
const check = (password, user) => crypto.timingSafeEqual(Buffer.from(hash(password, user.salt).hash, 'hex'), Buffer.from(user.passwordHash, 'hex'));
function readDB() { if (!fs.existsSync(DATA)) initializeDB(); const db=JSON.parse(fs.readFileSync(DATA, 'utf8')); ensureSupply(db); return db; }
function writeDB(db) { fs.mkdirSync(path.dirname(DATA), {recursive:true}); fs.writeFileSync(DATA, JSON.stringify(db, null, 2)); }
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
  const ensure=(asset,walletType,balance=0)=>{let wallet=db.reserve_wallets.find(x=>x.asset===asset&&x.walletType===walletType);if(!wallet){wallet={id:id('res'),asset,walletType,balance,lockedBalance:0,createdAt:now,updatedAt:now};db.reserve_wallets.push(wallet);}wallet.balance=roundCurrency(Number(wallet.balance)||0);wallet.lockedBalance=roundCurrency(Number(wallet.lockedBalance)||0);return wallet;};
  ensure('HB9','exchange',0);ensure('HB9','income',0);ensure('USDT','treasury',0);
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
  const value=roundCurrency(Number(amount));
  if(!Number.isFinite(value)||value<0)throw Error('Invalid reserve amount');
  const wallet=reserveWallet(db,asset,walletType), sign=direction==='credit'?1:-1, next=roundCurrency(wallet.balance+(value*sign));
  if(next<0)throw Error(`${asset} ${walletType} reserve is insufficient`);
  wallet.balance=next;wallet.updatedAt=new Date().toISOString();
  const entry={id:id('rsv'),asset,walletType,direction,amount:value,balanceAfter:wallet.balance,reason,refId,userId,createdAt:wallet.updatedAt,immutable:true};
  db.reserve_ledger.push(entry);
  return entry;
}
function burnHb9(db,{amount,reason,refId,userId}){
  ensureSupply(db);
  const value=roundCurrency(Number(amount));
  if(!Number.isFinite(value)||value<=0)throw Error('Invalid burn amount');
  const burned=roundCurrency((db.burn_ledger||[]).reduce((n,x)=>n+(Number(x.amount)||0),0)+value);
  if(burned>HB9_TOTAL_SUPPLY)throw Error('HB9 burn exceeds total supply');
  const entry={id:id('brn'),asset:'HB9',amount:value,reason,refId,userId,createdAt:new Date().toISOString(),immutable:true};
  db.burn_ledger.push(entry);
  return entry;
}
function walletEntry(db,{userId,asset,direction,amount,reason,refId}){
  ensureSupply(db);
  const entry={id:id('wlt'),userId,asset,direction,amount:roundCurrency(Number(amount)),reason,refId,createdAt:new Date().toISOString(),immutable:true};
  db.wallet_ledger.push(entry);
  return entry;
}
function circulatingHb9(db){
  return roundCurrency((db.users||[]).filter(u=>u.role==='user').reduce((sum,u)=>sum+walletBalances(db,u.id).hb9+(db.stakes||[]).filter(s=>s.userId===u.id&&s.status==='active').reduce((n,s)=>n+(Number(s.coinAmount)||0),0),0));
}
function reserveTotal(db,asset){ensureSupply(db);return roundCurrency(db.reserve_wallets.filter(x=>x.asset===asset).reduce((n,x)=>n+(Number(x.balance)||0),0));}
function burnTotal(db){ensureSupply(db);return roundCurrency(db.burn_ledger.reduce((n,x)=>n+(Number(x.amount)||0),0));}
function solvencyReport(db){
  ensureSupply(db);
  const circulating=circulatingHb9(db), burned=burnTotal(db), hb9Reserve=reserveTotal(db,'HB9'), usdtReserve=reserveTotal(db,'USDT'), withdrawableUsdt=roundCurrency((db.users||[]).filter(u=>u.role==='user').reduce((n,u)=>n+walletBalances(db,u.id).withdrawableUsdt,0));
  const accounted=roundCurrency(circulating+burned+hb9Reserve);
  return {totalHb9Supply:HB9_TOTAL_SUPPLY,hb9Reserve,hb9ExchangeReserve:reserveWallet(db,'HB9','exchange').balance,hb9IncomeReserve:reserveWallet(db,'HB9','income').balance,circulatingHb9:circulating,totalBurnedHb9:burned,remainingHb9Supply:roundCurrency(HB9_TOTAL_SUPPLY-burned),accountedHb9:accounted,usdtReserve,withdrawableUsdtLiability:withdrawableUsdt,solvent:accounted<=HB9_TOTAL_SUPPLY&&usdtReserve>=withdrawableUsdt};
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
function walletBalances(db,userId) {
  const deposits=db.deposits.filter(x=>x.userId===userId&&(x.status==='approved'||x.status==='credited')).reduce((n,x)=>n+x.amount,0);
  const conversions=(db.conversions||[]).filter(x=>x.userId===userId), buys=conversions.filter(x=>!x.direction||x.direction==='buy'), sells=conversions.filter(x=>x.direction==='sell');
  const convertedUsdt=buys.reduce((n,x)=>n+x.usdtAmount,0), receivedHb9=buys.reduce((n,x)=>n+x.hb9Amount,0), soldHb9=sells.reduce((n,x)=>n+x.hb9Amount,0), receivedUsdt=sells.reduce((n,x)=>n+x.usdtAmount,0), transfers=db.transfers||[], sentHb9=transfers.filter(x=>x.senderId===userId).reduce((n,x)=>n+x.amount+x.fee,0), receivedTransferHb9=transfers.filter(x=>x.receiverId===userId).reduce((n,x)=>n+x.amount,0);
  const stakedHb9=db.stakes.filter(x=>x.userId===userId).reduce((n,x)=>n+x.coinAmount,0);
  const withdrawals=(db.withdrawals||[]).filter(x=>x.userId===userId&&x.status!=='rejected').reduce((n,x)=>n+x.amount,0);
  const b1Hb9=(db.incomeLedger||[]).filter(x=>x.userId===userId&&x.type==='B1_INCOME'&&x.status==='credited').reduce((n,x)=>n+(Number(x.hb9Amount) || Number(x.amount) || 0),0);
  const referralHb9=(db.referralLedger||[]).filter(x=>x.sponsorId===userId&&(!x.status||x.status==='credited')).reduce((n,x)=>n+(Number(x.referralHb9Amount) || Number(x.referralAmount) || 0),0);
  const levelHb9=levelIncomeTotal(db,userId);
  const salaryHb9=(db.salary_payouts||[]).filter(x=>x.userId===userId&&x.status==='credited').reduce((n,x)=>n+(Number(x.hb9Amount)||0),0);
  return {usdt:roundCurrency(deposits-convertedUsdt+receivedUsdt-withdrawals),withdrawableUsdt:roundCurrency(receivedUsdt-withdrawals),hb9:roundCurrency(receivedHb9+b1Hb9+referralHb9+levelHb9+salaryHb9-soldHb9-stakedHb9-sentHb9+receivedTransferHb9),totalDeposit:roundCurrency(deposits)};
}
function flushTotal(db,userId) { return db.flushRecords.filter(x=>x.userId===userId).reduce((n,x)=>n+x.flushedIncome,0); }
function deterministicInt(seed, min, max) {
  const low=Math.ceil(Number(min)), high=Math.floor(Number(max));
  const span=Math.max(1,high-low+1), seedNum=[...seed].reduce((n,c)=>n+c.charCodeAt(0),0);
  return low+(seedNum%span);
}
function audit(db,type,details){db.auditLogs=db.auditLogs||[];db.auditLogs.push({id:id('aud'),type,details,createdAt:new Date().toISOString()});}
function normalizeChain(chain){return String(chain||'BSC').trim().toUpperCase();}
function nextHdIndex(db,chain){return (db.deposit_addresses||[]).filter(x=>x.chain===chain).reduce((max,x)=>Math.max(max,Number(x.hdIndex)||0),-1)+1;}
function depositServiceStatus(){
  const missing=[];
  if(!depositAddressServiceStatus().configured)missing.push('HD_WALLET_XPUB');
  if(!process.env.BSC_RPC_URL)missing.push('BSC_RPC_URL');
  if(!isAddress(process.env.USDT_BEP20_CONTRACT||''))missing.push('USDT_BEP20_CONTRACT');
  if(!isAddress(process.env.TREASURY_WALLET_BSC||''))missing.push('TREASURY_WALLET_BSC');
  if(!Number.isInteger(Number(process.env.REQUIRED_DEPOSIT_CONFIRMATIONS||12))||Number(process.env.REQUIRED_DEPOSIT_CONFIRMATIONS||12)<1)missing.push('REQUIRED_DEPOSIT_CONFIRMATIONS');
  if(process.env.DEPOSIT_WATCHER_ENABLED!=='true')missing.push('DEPOSIT_WATCHER_ENABLED=true');
  return {configured:missing.length===0,watcherEnabled:process.env.DEPOSIT_WATCHER_ENABLED==='true',missing,message:missing.length?'Automatic deposit service is not configured yet.':'Automatic deposit monitoring is active.'};
}
function depositAddressServiceStatus(){
  if(!process.env.HD_WALLET_XPUB)return {configured:false,error:'Deposit address service is not configured'};
  try{HDNodeWallet.fromExtendedKey(process.env.HD_WALLET_XPUB).deriveChild(0);return {configured:true};}catch(_){return {configured:false,error:'Deposit address service is not configured'};}
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
function watcherLogContext(log){
  return {transactionHash:typeof log?.transactionHash==='string'?log.transactionHash:null,blockNumber:Number.isInteger(log?.blockNumber)?log.blockNumber:null,logIndex:Number.isInteger(log?.index)?log.index:null};
}
function parseBep20TransferWatcherLog(log){
  if(!log||typeof log!=='object')return {reason:'log is not an object'};
  if(!Array.isArray(log.topics)||log.topics.length<3)return {reason:'Transfer log must contain at least three topics'};
  if(String(log.topics[0]).toLowerCase()!==TRANSFER_TOPIC.toLowerCase())return {reason:'topic0 is not the ERC20 Transfer signature'};
  if(!/^0x[0-9a-fA-F]{64}$/.test(String(log.data||'')))return {reason:'data is not a 32-byte hexadecimal amount'};
  if(!/^0x[0-9a-fA-F]{64}$/.test(String(log.topics[1]))||!/^0x[0-9a-fA-F]{64}$/.test(String(log.topics[2])))return {reason:'from or to topic is not a 32-byte hexadecimal value'};
  if(!/^0x[0-9a-fA-F]{64}$/.test(String(log.transactionHash||'')))return {reason:'transaction hash is invalid'};
  if(!Number.isInteger(log.index)||log.index<0)return {reason:'log index is invalid'};
  if(!Number.isInteger(log.blockNumber)||log.blockNumber<0)return {reason:'block number is invalid'};
  try{
    return {event:{chain:BSC_CHAIN,txHash:log.transactionHash,logIndex:log.index,blockNumber:log.blockNumber,fromAddress:getAddress(`0x${String(log.topics[1]).slice(-40)}`),toAddress:getAddress(`0x${String(log.topics[2]).slice(-40)}`),amount:Number(formatUnits(BigInt(log.data),6)),contractAddress:log.address??null,topics:log.topics,data:log.data}};
  }catch(error){return {reason:`unable to decode Transfer log: ${error.message}`};}
}
function warnRejectedDepositWatcherLog(log,reason){console.warn('Deposit watcher rejected log:',{reason,...watcherLogContext(log)});}
function sweepServiceStatus(){
  const missing=[];
  if(process.env.SWEEP_ENABLED!=='true')missing.push('SWEEP_ENABLED=true');
  if(!process.env.BSC_RPC_URL)missing.push('BSC_RPC_URL');
  if(!isAddress(process.env.USDT_BEP20_CONTRACT||''))missing.push('USDT_BEP20_CONTRACT');
  if(!isAddress(process.env.TREASURY_WALLET_BSC||''))missing.push('TREASURY_WALLET_BSC');
  if(!process.env.HD_WALLET_MNEMONIC)missing.push('HD_WALLET_MNEMONIC');
  if(!process.env.SWEEP_SIGNER_PRIVATE_KEY)missing.push('SWEEP_SIGNER_PRIVATE_KEY');
  if(!process.env.GAS_WALLET_PRIVATE_KEY)missing.push('GAS_WALLET_PRIVATE_KEY');
  if(!positiveEnvNumber('MIN_SWEEP_USDT',1))missing.push('MIN_SWEEP_USDT');
  if(!positiveEnvNumber('SWEEP_POLL_MS',60000))missing.push('SWEEP_POLL_MS');
  if(!positiveEnvNumber('SWEEP_CONFIRMATIONS',12))missing.push('SWEEP_CONFIRMATIONS');
  if(!positiveEnvNumber('GAS_TOPUP_BNB_AMOUNT'))missing.push('GAS_TOPUP_BNB_AMOUNT');
  if(!positiveEnvNumber('MIN_DEPOSIT_ADDRESS_BNB'))missing.push('MIN_DEPOSIT_ADDRESS_BNB');
  try{if(process.env.SWEEP_SIGNER_PRIVATE_KEY)new Wallet(process.env.SWEEP_SIGNER_PRIVATE_KEY);if(process.env.GAS_WALLET_PRIVATE_KEY)new Wallet(process.env.GAS_WALLET_PRIVATE_KEY);}catch(_){missing.push('valid sweep signer private keys');}
  return {configured:missing.length===0,enabled:process.env.SWEEP_ENABLED==='true',missing,message:missing.length?'Treasury sweep service is not configured yet.':'Treasury sweep service is active.'};
}
function depositPrivateSigner(address,hdIndex,provider){
  const expected=getAddress(address);
  if(process.env.HD_WALLET_MNEMONIC){
    const path=process.env.HD_WALLET_DERIVATION_PATH||"m/44'/60'/0'/0";
    const signer=HDNodeWallet.fromPhrase(process.env.HD_WALLET_MNEMONIC,'',path).deriveChild(Number(hdIndex)).connect(provider);
    if(signer.address===expected)return signer;
  }
  if(process.env.SWEEP_SIGNER_PRIVATE_KEY){const signer=new Wallet(process.env.SWEEP_SIGNER_PRIVATE_KEY,provider);if(signer.address===expected)return signer;}
  throw Error('No server-side signer controls this deposit address');
}
function derivedDepositAddress(chain,index){
  if(normalizeChain(chain)!==BSC_CHAIN)throw Error('Unsupported deposit chain');
  const status=depositAddressServiceStatus();
  if(!status.configured)throw Error(status.error);
  return getAddress(HDNodeWallet.fromExtendedKey(process.env.HD_WALLET_XPUB).deriveChild(index).address);
}
function ensureDepositAddress(db,userId,chainInput='BSC'){
  const chain=normalizeChain(chainInput);
  db.deposit_addresses=db.deposit_addresses||[];
  const existing=db.deposit_addresses.find(x=>x.userId===userId&&x.chain===chain);
  if(existing)return existing;
  const hdIndex=nextHdIndex(db,chain), createdAt=new Date().toISOString();
  const record={id:id('addr'),userId,chain,address:derivedDepositAddress(chain,hdIndex),hdIndex,createdAt};
  if(db.deposit_addresses.some(x=>x.chain===chain&&x.address.toLowerCase()===record.address.toLowerCase()))throw Error('Derived deposit address collision');
  db.deposit_addresses.push(record);
  audit(db,'DEPOSIT_ADDRESS_CREATED',{userId,chain,address:record.address,hdIndex});
  return record;
}
function validateBep20TransferEvent({chain,txHash,logIndex,toAddress,fromAddress,amount,blockNumber}){
  const failures=[];
  if(chain!==BSC_CHAIN)failures.push(`unsupported chain: ${chain}`);
  if(!/^0x[a-f0-9]{64}$/.test(txHash))failures.push('transaction hash must be a 32-byte hex value');
  if(!Number.isInteger(logIndex)||logIndex<0)failures.push('log index must be a non-negative integer');
  if(!isAddress(toAddress))failures.push('recipient address is invalid');
  if(!isAddress(fromAddress))failures.push('sender address is invalid');
  if(!Number.isFinite(amount)||amount<=0)failures.push('amount must be a finite value greater than zero');
  if(!Number.isInteger(blockNumber)||blockNumber<0)failures.push('block number must be a non-negative integer');
  return failures;
}
function recordBep20Transfer(db,input){
  const chain=normalizeChain(input.chain), txHash=String(input.txHash||'').trim().toLowerCase(), logIndex=Number(input.logIndex), toAddress=String(input.toAddress||'').trim().toLowerCase(), fromAddress=String(input.fromAddress||input.from||'').trim().toLowerCase(), amount=Number(input.amount), blockNumber=Number(input.blockNumber), requiredConfirmations=Number(process.env.REQUIRED_DEPOSIT_CONFIRMATIONS||12);
  const failures=validateBep20TransferEvent({chain,txHash,logIndex,toAddress,fromAddress,amount,blockNumber});
  if(failures.length){
    console.warn('Invalid BEP20 transfer event:',{failures,topics:input.topics??null,data:input.data??null,from:fromAddress,to:toAddress,amount,contractAddress:input.contractAddress??null,transactionHash:txHash,logIndex,blockNumber});
    throw Error('Invalid BEP20 transfer event');
  }
  const address=(db.deposit_addresses||[]).find(x=>x.chain===chain&&x.address.toLowerCase()===toAddress);
  if(!address)return null;
  db.blockchain_transactions=db.blockchain_transactions||[];db.deposits=db.deposits||[];
  const eventKey=`${chain}:${txHash}:${logIndex}`,now=new Date().toISOString();
  let tx=db.blockchain_transactions.find(x=>x.eventKey===eventKey);
  if(!tx){
    tx={id:id('btx'),eventKey,chain,txHash,logIndex,fromAddress:getAddress(fromAddress),toAddress:address.address,userId:address.userId,depositAddressId:address.id,amount,confirmations:0,requiredConfirmations,blockNumber,status:'detected',createdAt:now,updatedAt:now};
    db.blockchain_transactions.push(tx);
    const deposit={id:id('dep'),userId:address.userId,amount,asset:'USDT',chain,network:'USDT BEP20',txHash,logIndex,fromAddress:tx.fromAddress,depositAddressId:address.id,status:'detected',confirmations:0,requiredConfirmations,blockNumber,createdAt:now};
    db.deposits.push(deposit);
    audit(db,'BEP20_DEPOSIT_DETECTED',{eventKey,txHash,logIndex,userId:address.userId,toAddress:address.address,amount,blockNumber});
  }
  return tx;
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
    if(!deposit.auditCreditedAt){audit(db,'BEP20_DEPOSIT_CREDITED',{eventKey:tx.eventKey,txHash:tx.txHash,logIndex:tx.logIndex,userId:tx.userId,amount:tx.amount,confirmations:tx.confirmations});deposit.auditCreditedAt=now;}
  }
}
async function pollDepositWatcher(){
  if(watcherRunning||!depositServiceStatus().configured)return;
  watcherRunning=true;
  try{
    const provider=new JsonRpcProvider(process.env.BSC_RPC_URL), latestBlock=await provider.getBlockNumber(), db=readDB();
    db.deposit_watcher=db.deposit_watcher||{};
    const start=resolveDepositWatcherStart({latestBlock,confirmations:process.env.REQUIRED_DEPOSIT_CONFIRMATIONS,state:db.deposit_watcher,resetCursor:process.env.DEPOSIT_WATCHER_RESET_CURSOR==='true'&&!watcherResetApplied});
    if(start.reset){
      Object.assign(db.deposit_watcher,{lastProcessedBlock:latestBlock,cursorMode:start.cursorMode,lastCursorResetAt:new Date().toISOString()});
      delete db.deposit_watcher.lastScannedBlock;
      delete db.deposit_watcher.configuredStartBlock;
      writeDB(db);
      watcherResetApplied=true;
      console.log(`Deposit watcher starting from block ${latestBlock} to ${latestBlock} (cursor reset)`);
      return;
    }
    const nextBlock=start.nextBlock;
    const range=Math.max(1,Math.min(2000,Number(process.env.DEPOSIT_WATCHER_BLOCK_RANGE||500))), toBlock=Math.min(latestBlock,nextBlock+range-1);
    if(nextBlock<=toBlock){
      console.log(`Deposit watcher starting from block ${nextBlock} to ${toBlock}`);
      const logs=await provider.getLogs({address:getAddress(process.env.USDT_BEP20_CONTRACT),topics:[TRANSFER_TOPIC],fromBlock:nextBlock,toBlock});
      for(const log of logs){
        const parsed=parseBep20TransferWatcherLog(log);
        if(!parsed.event){warnRejectedDepositWatcherLog(log,parsed.reason);continue;}
        try{recordBep20Transfer(db,parsed.event);}catch(error){warnRejectedDepositWatcherLog(log,`recording event failed: ${error.message}`);}
      }
      updateDepositConfirmations(db,latestBlock);
      // Do not advance the cursor until getLogs and event handling have both succeeded.
      Object.assign(db.deposit_watcher,{lastProcessedBlock:toBlock,cursorMode:start.cursorMode});
      if(start.configuredStartBlock===null)delete db.deposit_watcher.configuredStartBlock;
      else db.deposit_watcher.configuredStartBlock=start.configuredStartBlock;
      delete db.deposit_watcher.lastScannedBlock;
      writeDB(db);
      return;
    }
    updateDepositConfirmations(db,latestBlock);writeDB(db);
  }catch(error){console.error('Deposit watcher error:',error.message);}finally{watcherRunning=false;}
}
function startDepositWatcher(){if(process.env.DEPOSIT_WATCHER_ENABLED==='true'){pollDepositWatcher();watcherTimer=setInterval(pollDepositWatcher,WATCHER_POLL_MS);}}
function sweepRecordForDeposit(db,depositId){return (db.sweep_transactions||[]).find(item=>item.depositId===depositId);}
function createSweepCandidates(db){
  const minimum=positiveEnvNumber('MIN_SWEEP_USDT',1),now=new Date().toISOString();db.sweep_transactions=db.sweep_transactions||[];
  for(const deposit of db.deposits||[]){
    if(deposit.status!=='credited'||Number(deposit.creditedAmount??deposit.amount)<minimum||sweepRecordForDeposit(db,deposit.id))continue;
    const address=(db.deposit_addresses||[]).find(item=>item.id===deposit.depositAddressId);if(!address)continue;
    const sweep={id:id('swp'),depositId:deposit.id,userId:deposit.userId,chain:BSC_CHAIN,depositTxHash:deposit.txHash,depositLogIndex:deposit.logIndex,fromAddress:address.address,toAddress:getAddress(process.env.TREASURY_WALLET_BSC),amount:Number(deposit.creditedAmount??deposit.amount),status:'not_started',gasTopupStatus:'not_required',createdAt:now,updatedAt:now};
    db.sweep_transactions.push(sweep);Object.assign(deposit,{sweepStatus:'not_started',sweepId:sweep.id});audit(db,'TREASURY_SWEEP_CANDIDATE',{depositId:deposit.id,sweepId:sweep.id,amount:sweep.amount,fromAddress:sweep.fromAddress,toAddress:sweep.toAddress});
  }
}
function sweepConfirmations(receipt,latestBlock){return receipt?Math.max(0,Number(latestBlock)-Number(receipt.blockNumber)+1):0;}
function failSweep(db,sweep,reason,phase){
  const now=new Date().toISOString();sweep.status='failed_retryable';sweep.failureReason=String(reason||'Sweep transaction failed');sweep.failedPhase=phase;sweep.failedAt=now;sweep.updatedAt=now;
  const deposit=(db.deposits||[]).find(item=>item.id===sweep.depositId);if(deposit)deposit.sweepStatus='failed_retryable';audit(db,'TREASURY_SWEEP_FAILED',{sweepId:sweep.id,depositId:sweep.depositId,phase,reason:sweep.failureReason});
}
async function updateBroadcastedSweep(db,sweep,provider,latestBlock){
  const confirmationsRequired=Number(process.env.SWEEP_CONFIRMATIONS||12);
  if(sweep.gasTopupTxHash&&sweep.gasTopupStatus==='broadcasted'){
    const receipt=await provider.getTransactionReceipt(sweep.gasTopupTxHash);if(!receipt)return false;
    if(Number(receipt.status)!==1){failSweep(db,sweep,'Gas top-up reverted','gas_topup');return true;}
    sweep.gasTopupConfirmations=sweepConfirmations(receipt,latestBlock);if(sweep.gasTopupConfirmations<confirmationsRequired)return false;
    sweep.gasTopupStatus='confirmed';sweep.status='gas_funded';sweep.gasFundedAt=new Date().toISOString();sweep.updatedAt=sweep.gasFundedAt;audit(db,'TREASURY_SWEEP_GAS_FUNDED',{sweepId:sweep.id,gasTopupTxHash:sweep.gasTopupTxHash});
  }
  if(!sweep.sweepTxHash||sweep.status!=='broadcasted')return false;
  const receipt=await provider.getTransactionReceipt(sweep.sweepTxHash);if(!receipt)return false;
  if(Number(receipt.status)!==1){failSweep(db,sweep,'USDT sweep reverted','token_sweep');return true;}
  sweep.confirmations=sweepConfirmations(receipt,latestBlock);if(sweep.confirmations<confirmationsRequired)return false;
  const now=new Date().toISOString();sweep.status='confirmed';sweep.sweptAt=now;sweep.updatedAt=now;
  const deposit=(db.deposits||[]).find(item=>item.id===sweep.depositId);if(deposit)Object.assign(deposit,{sweepStatus:'confirmed',sweptAt:now,sweepTxHash:sweep.sweepTxHash});
  reserveMove(db,{asset:'USDT',walletType:'treasury',direction:'credit',amount:sweep.amount,reason:'BEP20 treasury sweep confirmed',refId:sweep.id,userId:sweep.userId});audit(db,'TREASURY_SWEEP_CONFIRMED',{sweepId:sweep.id,depositId:sweep.depositId,sweepTxHash:sweep.sweepTxHash,amount:sweep.amount,toAddress:sweep.toAddress});return true;
}
async function executeSweep(db,sweep,provider){
  if(sweep.sweepTxHash||sweep.status==='confirmed'||sweep.status==='failed_retryable')return;
  const deposit=(db.deposits||[]).find(item=>item.id===sweep.depositId),address=(db.deposit_addresses||[]).find(item=>item.id===deposit?.depositAddressId);if(!deposit||!address)return failSweep(db,sweep,'Deposit address is unavailable','configuration');
  try{
    const minimum=parseEther(String(positiveEnvNumber('MIN_DEPOSIT_ADDRESS_BNB'))),topup=parseEther(String(positiveEnvNumber('GAS_TOPUP_BNB_AMOUNT'))),bnbBalance=await provider.getBalance(address.address);
    if(bnbBalance<minimum){
      if(!sweep.gasTopupTxHash){const gasWallet=new Wallet(process.env.GAS_WALLET_PRIVATE_KEY,provider),tx=await gasWallet.sendTransaction({to:address.address,value:topup});if(!tx.hash)throw Error('Gas top-up broadcast did not return a transaction hash');Object.assign(sweep,{status:'gas_topup_broadcasted',gasTopupStatus:'broadcasted',gasTopupTxHash:tx.hash,gasTopupFrom:gasWallet.address,updatedAt:new Date().toISOString()});deposit.sweepStatus='gas_topup_broadcasted';audit(db,'TREASURY_SWEEP_GAS_TOPUP_BROADCAST',{sweepId:sweep.id,txHash:tx.hash,toAddress:address.address,amountBnb:String(topup)});}return;
    }
    sweep.gasTopupStatus=sweep.gasTopupStatus==='not_required'?'available':sweep.gasTopupStatus;
    const signer=depositPrivateSigner(address.address,address.hdIndex,provider),token=new Contract(getAddress(process.env.USDT_BEP20_CONTRACT),['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)'],signer),available=await token.balanceOf(address.address),requested=parseUnits(String(deposit.creditedAmount??deposit.amount),6),amount=available<requested?available:requested;
    if(amount<=0n)throw Error('Deposit address has no USDT available to sweep');
    if(amount<requested)throw Error('Deposit address USDT balance is below the credited deposit amount');
    const tx=await token.transfer(getAddress(process.env.TREASURY_WALLET_BSC),amount);if(!tx.hash)throw Error('USDT sweep broadcast did not return a transaction hash');
    Object.assign(sweep,{status:'broadcasted',sweepTxHash:tx.hash,amount:Number(formatUnits(amount,6)),tokenContract:getAddress(process.env.USDT_BEP20_CONTRACT),updatedAt:new Date().toISOString(),broadcastAt:new Date().toISOString()});Object.assign(deposit,{sweepStatus:'broadcasted',sweepTxHash:tx.hash});audit(db,'TREASURY_SWEEP_BROADCAST',{sweepId:sweep.id,depositId:deposit.id,txHash:tx.hash,fromAddress:address.address,toAddress:sweep.toAddress,amount:sweep.amount});
  }catch(error){failSweep(db,sweep,error.message,'broadcast');}
}
async function pollSweepWorker(){
  if(sweepRunning||!sweepServiceStatus().configured)return;sweepRunning=true;
  try{const provider=new JsonRpcProvider(process.env.BSC_RPC_URL),latestBlock=await provider.getBlockNumber(),db=readDB();createSweepCandidates(db);for(const sweep of db.sweep_transactions||[]){if(['broadcasted','gas_topup_broadcasted'].includes(sweep.status)||sweep.gasTopupStatus==='broadcasted')await updateBroadcastedSweep(db,sweep,provider,latestBlock);if(['not_started','gas_funded'].includes(sweep.status))await executeSweep(db,sweep,provider);}writeDB(db);}catch(error){console.error('Sweep worker error:',error.message);}finally{sweepRunning=false;}
}
function startSweepWorker(){if(process.env.SWEEP_ENABLED==='true'){pollSweepWorker();sweepTimer=setInterval(pollSweepWorker,Number(process.env.SWEEP_POLL_MS||60000));}}
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
function globalForDate(db,userId,date,hb9PriceOverride=null) {
  const existing = db.globalTeamRecords.find(x=>x.userId===userId&&x.date===date);
  // A user can receive a non-investor activity record before an admin approves a
  // same-day deposit. Reconcile that activity record into the investment record,
  // but never create a second financial ledger entry for the same date.
  if (existing && db.incomeLedger.some(x=>x.userId===userId&&x.date===date&&x.type==='B1_INCOME')) return;
  const context=incomeContext(db,userId,date,hb9PriceOverride), createdAt=new Date().toISOString();
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
  const globalRecord={activity:context.totalGlobalTeam,value:context.globalTeamValueUsd,paid,unpaid,globalTeamCount:context.totalGlobalTeam,...context};
  if (existing) Object.assign(existing,globalRecord,{reconciledAt:createdAt});
  else db.globalTeamRecords.push({id:id('gbl'),userId,date,...globalRecord,createdAt});
  const flushRecord={incomeType:'B1 / Global Team',eligibleIncome:context.b1EligibleUsd,paidIncome:paid,flushedIncome:context.flushUsd,burnStatus:'Burned Forever',withdrawable:false,recoverable:false,...context,createdAt};
  const existingFlush=db.flushRecords.find(x=>x.userId===userId&&x.date===date&&x.incomeType==='B1 / Global Team');
  if (existingFlush) Object.assign(existingFlush,flushRecord);
  else db.flushRecords.push({id:id('fls'),userId,date,...flushRecord});
  if (!context.activeStakeUsd) return;
  db.incomeLedger.push({id:id('led'),userId,date,type:'B1_INCOME',asset:'HB9',amount:creditedB1Hb9,hb9Amount:creditedB1Hb9,valueUsd:creditedB1Usd,status:incomeStatus,note:incomeQueuedReason||context.reason,immutable:true,...context,creditedB1Hb9,creditedB1Usd,createdAt});
}
async function processDaily(db) { const d=today(), market=await exchangeMarket(db,'1d',1), hb9Price=Number(market.hb9BasePrice||market.price||market.icpPrice||marketSettings(db).fallbackPrice); const before={ledger:db.incomeLedger.length,global:db.globalTeamRecords.length,flush:db.flushRecords.length}; let processed=0,skipped=0; db.users.filter(u=>u.role==='user').forEach(u=>{const already=db.globalTeamRecords.some(x=>x.userId===u.id&&x.date===d);if(already)skipped++;else{globalForDate(db,u.id,d,hb9Price);processed++}}); return {date:d,hb9Price,usersProcessed:processed,b1Credited:db.incomeLedger.slice(before.ledger).filter(x=>x.status==='credited').reduce((n,x)=>n+x.amount,0),globalGenerated:db.globalTeamRecords.length-before.global,flushGenerated:db.flushRecords.slice(before.flush).reduce((n,x)=>n+x.flushedIncome,0),skippedUsers:skipped}; }
function auth(req, db) {
  const token=(req.headers.authorization||'').replace('Bearer ','');
  const session=sessions.get(token);
  if(session)return userById(db,session.userId);
  return null;
}
function send(res,status,payload) { res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(payload)); }
function body(req) { return new Promise((resolve,reject)=>{let b='';req.on('data',x=>b+=x);req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch(e){reject(e)}})}); }
function safeUser(u){ const {passwordHash,salt,...safe}=u; return safe; }
function dashboard(db,u) {
  const stake=activeStakes(db,u.id).reduce((n,s)=>n+s.amount,0), completed=business(db,u.id), required=stake*setting(db,'directMultiplier');
  const globals=db.globalTeamRecords.filter(x=>x.userId===u.id), flushes=db.flushRecords.filter(x=>x.userId===u.id), b1=db.incomeLedger.filter(x=>x.userId===u.id&&x.type==='B1_INCOME'&&x.status==='credited');
  const referrals=(db.referralLedger||[]).filter(x=>x.sponsorId===u.id), levelIncome=(db.level_income_ledger||[]).filter(x=>x.receiverUserId===u.id);
  const creditedLevelIncome=levelIncome.filter(x=>x.status==='credited'), direct=db.users.filter(x=>x.sponsorId===u.id);
  const qualifiedDirects=qualifiedDirectReferralCount(db,u.id), levelUnlocked=unlockedLevel(db,u.id);
  const allStakes=db.stakes.filter(s=>s.userId===u.id), withdrawals=db.withdrawals.filter(x=>x.userId===u.id), deposits=db.deposits.filter(x=>x.userId===u.id), balances=walletBalances(db,u.id);
  const salary=salaryReport(db,u.id);
  return {user:safeUser(u),settings:{...db.settings,market:marketSettings(db)},depositService:depositServiceStatus(),sweepService:sweepServiceStatus(),wallets:{...balances,withdrawal:balances.withdrawableUsdt},supply:solvencyReport(db),stats:{totalStake:allStakes.reduce((n,s)=>n+s.amount,0),activeStake:stake,totalStakeHb9:allStakes.reduce((n,s)=>n+s.coinAmount,0),activeStakeHb9:activeStakeHb9(db,u.id),totalDeposit:balances.totalDeposit,totalWithdrawal:withdrawals.filter(x=>x.status!=='rejected').reduce((n,x)=>n+x.amount,0),directTeam:direct.length,qualifiedDirectReferralCount:qualifiedDirects,unlockedLevel:levelUnlocked,directBusiness:completed,requiredBusiness:required,remainingBusiness:Math.max(0,required-completed)},income:{todayReferral:referrals.filter(x=>x.date===today()&&(!x.status||x.status==='credited')).reduce((n,x)=>n+(Number(x.referralHb9Amount)||Number(x.referralAmount)||0),0),totalReferral:referrals.filter(x=>!x.status||x.status==='credited').reduce((n,x)=>n+(Number(x.referralHb9Amount)||Number(x.referralAmount)||0),0),todayLevelIncome:creditedLevelIncome.filter(x=>String(x.createdAt||'').slice(0,10)===today()).reduce((n,x)=>n+(Number(x.hb9Amount)||0),0),totalLevelIncome:creditedLevelIncome.reduce((n,x)=>n+(Number(x.hb9Amount)||0),0),todaySalary:(db.salary_payouts||[]).filter(x=>x.userId===u.id&&x.status==='credited'&&String(x.createdAt||'').slice(0,10)===today()).reduce((n,x)=>n+(Number(x.hb9Amount)||0),0),totalSalary:(db.salary_payouts||[]).filter(x=>x.userId===u.id&&x.status==='credited').reduce((n,x)=>n+(Number(x.hb9Amount)||0),0),todayB1:b1.filter(x=>x.date===today()).reduce((n,x)=>n+(Number(x.hb9Amount)||Number(x.amount)||0),0),totalB1:b1.reduce((n,x)=>n+(Number(x.hb9Amount)||Number(x.amount)||0),0),paidGlobal:globals.reduce((n,x)=>n+x.paid,0),unpaidGlobal:globals.reduce((n,x)=>n+x.unpaid,0),todayFlush:flushes.filter(x=>x.date===today()).reduce((n,x)=>n+(Number(x.flushedIncome)||0),0),totalFlush:flushes.reduce((n,x)=>n+(Number(x.flushedIncome)||0),0),eligible:stake>0&&completed>=required},salary,levelUnlock:{qualifiedDirectReferralCount:qualifiedDirects,unlockedLevel:levelUnlocked,requiredStakeUsd:LEVEL_DIRECT_MIN_STAKE_USD,maxLevel:LEVEL_INCOME_PERCENTS.length},b1Records:b1.map(x=>({date:x.date,fromUser:u.name,amount:Number(x.hb9Amount)||Number(x.amount)||0,valueUsd:x.valueUsd,status:x.status})),levelIncomeRecords:levelIncome,deposits,stakes:allStakes,team:direct.map(x=>({id:x.id,name:x.name,email:x.email,joinedAt:x.createdAt,activeStakeUsd:activeStakeUsd(db,x.id)})),referrals,globals,flushes,withdrawals};
}
const server=http.createServer(async(req,res)=>{
  try {
    if (req.url.startsWith('/api/')) {
      const db=readDB(), url=new URL(req.url,`http://${req.headers.host}`), p=url.pathname, method=req.method;
      if (p==='/api/auth/login'&&method==='POST') { const {email,password}=await body(req); if(typeof email!=='string'||typeof password!=='string')return send(res,400,{error:'Email and password are required'}); const u=db.users.find(x=>x.email.toLowerCase()===email.toLowerCase()); if(!u||!check(password,u)||u.status!=='active') return send(res,401,{error:'Invalid credentials or blocked account'}); const token=crypto.randomBytes(32).toString('hex'); sessions.set(token,{userId:u.id}); return send(res,200,{token,user:safeUser(u)}); }
      if (p==='/api/auth/register'&&method==='POST') { const {name,email,password,sponsorEmail,walletAddress}=await body(req); if(!name||!email||!password||password.length<8)return send(res,400,{error:'Name, email and 8+ character password are required'}); if(typeof walletAddress!=='string'||!/^0x[a-fA-F0-9]{40}$/.test(walletAddress))return send(res,400,{error:'Enter a valid 42-character BEP20 wallet address starting with 0x'}); if(db.users.some(x=>x.email.toLowerCase()===email.toLowerCase()))return send(res,409,{error:'Email already registered'});const addressService=depositAddressServiceStatus();if(!addressService.configured)return send(res,503,{error:addressService.error}); const h=hash(password), sponsor=db.users.find(x=>x.email===sponsorEmail); const u={id:id('usr'),name,email:email.toLowerCase(),role:'user',status:'active',passwordHash:h.hash,salt:h.salt,walletAddress,sponsorId:sponsor?.id||null,createdAt:new Date().toISOString()}; db.users.push(u);ensureDepositAddress(db,u.id,'BSC');writeDB(db);return send(res,201,{message:'Registration complete. Please log in.'}); }
      const u=auth(req,db); if(!u)return send(res,401,{error:'Authentication required'});
      if(p==='/api/market/hb9-ticker'&&method==='GET'){try{const market=await exchangeMarket(db,'1d',1);return send(res,200,{symbol:'HB9/USDT',pair:'HB9/USDT',source:market.source,price:market.price,icpPrice:market.icpPrice,hb9BasePrice:market.hb9BasePrice,priceOffset:market.priceOffset,hb9BuyPrice:market.hb9BuyPrice,hb9SellPrice:market.hb9SellPrice,buyPrice:market.buyPrice,sellPrice:market.sellPrice,spreadPercent:market.spreadPercent,manualOverrideEnabled:market.manualOverrideEnabled,high24h:market.high24h,low24h:market.low24h,volume24h:market.baseVolume,quoteVolume24h:market.quoteVolume,changePercent:market.changePercent});}catch(error){return send(res,503,{error:error.message});}}
      if(p==='/api/market/hb9-klines'&&method==='GET'){const interval={"15m":"15m","1h":"1h","4h":"4h","1d":"1d"}[url.searchParams.get('interval')]||'1d';try{const market=await exchangeMarket(db,interval,120);return send(res,200,{symbol:'HB9/USDT',pair:'HB9/USDT',source:market.source,candles:market.candles});}catch(error){return send(res,503,{error:error.message});}}
      if(p==='/api/market/hb9-usdt'&&method==='GET'){const market=await exchangeMarket(db);return send(res,200,{symbol:'HB9/USDT',...market});}
      if(p==='/api/dashboard'&&method==='GET')return send(res,200,dashboard(db,u));
      if(p==='/api/deposit-address'&&method==='GET'){const status=depositAddressServiceStatus();if(!status.configured)return send(res,503,{error:status.error});try{const record=ensureDepositAddress(db,u.id,url.searchParams.get('chain')||BSC_CHAIN);writeDB(db);return send(res,200,{depositAddress:record,service:depositServiceStatus()});}catch(error){return send(res,503,{error:'Deposit address service is not configured'});}}
      if(p==='/api/deposits'&&method==='POST')return send(res,410,{error:'Manual deposit submission is disabled. Send USDT BEP20 to your assigned deposit address.'});
      if(p==='/api/internal/deposit-events'&&method==='POST'&&process.env.DEPOSIT_WATCHER_TEST_MODE==='true'){const event=await body(req),tx=recordBep20Transfer(db,event);if(!tx)return send(res,202,{message:'Transfer does not target an assigned deposit address'});updateDepositConfirmations(db,Number(event.currentBlock));writeDB(db);const deposit=db.deposits.find(x=>x.chain===tx.chain&&x.txHash===tx.txHash&&Number(x.logIndex)===Number(tx.logIndex));return send(res,200,{transaction:tx,deposit});}
      if(p==='/api/convert'&&method==='POST'){if(!db.settings.exchangeEnabled)return send(res,403,{error:'Exchange is disabled'});const {amount}=await body(req), value=Number(amount), balances=walletBalances(db,u.id), market=await exchangeMarket(db), rate=market.buyPrice, fee=setting(db,'tradingFeePercent')+setting(db,'buyFeePercent');if(!Number.isFinite(value)||value<=0)return send(res,400,{error:'Conversion amount is invalid'});if(value>balances.usdt)return send(res,400,{error:'Not enough USDT balance'});const hb9Amount=roundCurrency(value/rate*(1-fee/100));if(reserveWallet(db,'HB9','exchange').balance<hb9Amount)return send(res,400,{error:'HB9 reserve is insufficient'});const orderId=id('xord'),createdAt=new Date().toISOString();reserveMove(db,{asset:'HB9',walletType:'exchange',direction:'debit',amount:hb9Amount,reason:'HB9 buy',userId:u.id,refId:orderId});reserveMove(db,{asset:'USDT',walletType:'treasury',direction:'credit',amount:value,reason:'HB9 buy',userId:u.id,refId:orderId});walletEntry(db,{userId:u.id,asset:'USDT',direction:'debit',amount:value,reason:'HB9 buy',refId:orderId});walletEntry(db,{userId:u.id,asset:'HB9',direction:'credit',amount:hb9Amount,reason:'HB9 buy',refId:orderId});db.conversions=(db.conversions||[]);db.exchange_orders=db.exchange_orders||[];const order={id:orderId,userId:u.id,direction:'buy',usdtAmount:value,hb9Amount,rate,buyPrice:rate,sellPrice:market.sellPrice,feePercent:fee,status:'completed',createdAt,immutable:true};db.conversions.push({id:id('cnv'),...order});db.exchange_orders.push(order);writeDB(db);return send(res,201,{message:'USDT converted to HB9',hb9Amount,buyPrice:rate});}
      if(p==='/api/exchange/sell'&&method==='POST'){if(!db.settings.exchangeEnabled)return send(res,403,{error:'Exchange is disabled'});const {amount}=await body(req), hb9Amount=Number(amount), balances=walletBalances(db,u.id), market=await exchangeMarket(db), rate=market.sellPrice, fee=setting(db,'tradingFeePercent')+setting(db,'sellFeePercent');if(!Number.isFinite(hb9Amount)||hb9Amount<=0)return send(res,400,{error:'HB9 amount is invalid'});if(hb9Amount>balances.hb9)return send(res,400,{error:'Not enough HB9 wallet balance'});const usdtAmount=roundCurrency(hb9Amount*rate*(1-fee/100));if(reserveWallet(db,'USDT','treasury').balance<usdtAmount)return send(res,400,{error:'USDT reserve is insufficient'});const orderId=id('xord'),createdAt=new Date().toISOString();reserveMove(db,{asset:'USDT',walletType:'treasury',direction:'debit',amount:usdtAmount,reason:'HB9 sell payout',userId:u.id,refId:orderId});burnHb9(db,{amount:hb9Amount,reason:'HB9 sell burn',userId:u.id,refId:orderId});walletEntry(db,{userId:u.id,asset:'HB9',direction:'debit',amount:hb9Amount,reason:'HB9 sell burn',refId:orderId});walletEntry(db,{userId:u.id,asset:'USDT',direction:'credit',amount:usdtAmount,reason:'HB9 sell payout',refId:orderId});db.conversions=(db.conversions||[]);db.exchange_orders=db.exchange_orders||[];const order={id:orderId,userId:u.id,direction:'sell',hb9Amount,usdtAmount,rate,sellPrice:rate,buyPrice:market.buyPrice,feePercent:fee,status:'completed',burnedHb9:hb9Amount,createdAt,immutable:true};db.conversions.push({id:id('cnv'),...order});db.exchange_orders.push(order);writeDB(db);return send(res,201,{message:'HB9 converted to USDT and burned',usdtAmount,sellPrice:rate,burnedHb9:hb9Amount,totalBurnedHb9:burnTotal(db),remainingHb9Supply:solvencyReport(db).remainingHb9Supply,circulatingHb9:solvencyReport(db).circulatingHb9});}
      if(p==='/api/stakes'&&method==='POST'){const {amount}=await body(req), coinAmount=Number(amount), balances=walletBalances(db,u.id), market=await exchangeMarket(db), price=market.buyPrice, payoutPrice=Number(market.hb9BasePrice||market.price||market.icpPrice||marketSettings(db).fallbackPrice);if(!Number.isFinite(coinAmount)||coinAmount<=0)return send(res,400,{error:'HB9 stake amount is invalid'});if(coinAmount>balances.hb9)return send(res,400,{error:'Not enough HB9 balance'});const isFirstStake=!db.stakes.some(s=>s.userId===u.id), usdAmount=roundCurrency(coinAmount*price), createdAt=new Date().toISOString(), stake={id:id('stk'),userId:u.id,amount:usdAmount,usdValueAtStake:usdAmount,coinAmount,hb9Amount:coinAmount,hb9PriceAtStake:price,status:'active',startDate:today(),dailyRate:db.settings.dailyRoi/100,createdAt};db.stakes.push(stake);walletEntry(db,{userId:u.id,asset:'HB9',direction:'lock',amount:coinAmount,reason:'HB9 stake',refId:stake.id});if(u.sponsorId){const referralPercent=setting(db,'referralPercent'),referralUsdAmount=roundCurrency(usdAmount*referralPercent/100),referralHb9Amount=payoutPrice>0?roundCurrency(referralUsdAmount/payoutPrice):0,refId=id('ref');let status='credited',creditedHb9=referralHb9Amount,note='Referral income credited';try{reserveMove(db,{asset:'HB9',walletType:'income',direction:'debit',amount:referralHb9Amount,reason:'Referral income emission',userId:u.sponsorId,refId});walletEntry(db,{userId:u.sponsorId,asset:'HB9',direction:'credit',amount:referralHb9Amount,reason:'Referral income credited',refId});}catch(error){status='queued';creditedHb9=0;note='HB9 income reserve insufficient';}db.referralLedger=(db.referralLedger||[]);db.income_emissions=db.income_emissions||[];db.referralLedger.push({id:refId,type:'REFERRAL_INCOME',asset:'HB9',sponsorId:u.sponsorId,referredUserId:u.id,stakeAmount:usdAmount,stakeCoinAmount:coinAmount,referralPercent,referralAmount:creditedHb9,referralHb9Amount:creditedHb9,queuedHb9Amount:status==='queued'?referralHb9Amount:0,referralUsdAmount,hb9PriceAtCredit:payoutPrice,hb9PriceAtPayout:payoutPrice,status,note,date:today(),createdAt,immutable:true});db.income_emissions.push({id:id('iem'),userId:u.sponsorId,type:'REFERRAL_INCOME',asset:'HB9',amount:referralHb9Amount,valueUsd:referralUsdAmount,status,reason:note,createdAt,immutable:true});}if(isFirstStake)payLevelIncome(db,u,stake,payoutPrice);writeDB(db);return send(res,201,{message:'HB9 permanent stake created',stake:{coinAmount,usdAmount,hb9PriceAtStake:price}});}
      if(p==='/api/transfers'&&method==='GET'){const records=(db.transferLedger||[]).filter(x=>x.userId===u.id).map(x=>({...x,counterparty:safeUser(userById(db,x.counterpartyId))}));return send(res,200,{transfers:records});}
      if(p==='/api/transfers'&&method==='POST'){const {receiver,amount,note}=await body(req), value=Number(amount), receiverUser=db.users.find(x=>x.id===receiver||x.email.toLowerCase()===String(receiver||'').toLowerCase());if(!receiverUser||receiverUser.role!=='user')return send(res,404,{error:'Receiver not found'});if(receiverUser.id===u.id)return send(res,400,{error:'You cannot transfer HB9 to yourself'});if(!Number.isFinite(value)||value<=0)return send(res,400,{error:'Transfer amount must be greater than zero'});if(value<setting(db,'minHb9Transfer'))return send(res,400,{error:`Minimum transfer is ${setting(db,'minHb9Transfer')} HB9`});const fee=roundCurrency(value*setting(db,'hb9TransferFeePercent')/100),available=walletBalances(db,u.id).hb9;if(value+fee>available)return send(res,400,{error:'Not enough available HB9 balance'});const createdAt=new Date().toISOString(),transfer={id:id('trf'),senderId:u.id,receiverId:receiverUser.id,amount:value,fee,status:'completed',note:String(note||''),createdAt};db.transfers=(db.transfers||[]);db.transferLedger=(db.transferLedger||[]);db.transfers.push(transfer);db.transferLedger.push({id:id('tlg'),transferId:transfer.id,userId:u.id,type:'HB9_TRANSFER_SENT',counterpartyId:receiverUser.id,amount:value,fee,createdAt,immutable:true},{id:id('tlg'),transferId:transfer.id,userId:receiverUser.id,type:'HB9_TRANSFER_RECEIVED',counterpartyId:u.id,amount:value,fee:0,createdAt,immutable:true});writeDB(db);return send(res,201,{message:'HB9 transfer completed',transfer});}
      if(p==='/api/withdrawals'&&method==='POST'){const {amount,address}=await body(req);const value=Number(amount),available=walletBalances(db,u.id).withdrawableUsdt;if(!Number.isFinite(value)||value<=0)return send(res,400,{error:'Withdrawal amount is invalid'});if(!/^0x[a-fA-F0-9]{40}$/.test(String(address||'')))return send(res,400,{error:'Valid USDT BEP20 address is required'});if(value<setting(db,'minWithdrawal'))return send(res,400,{error:`Minimum withdrawal is ${setting(db,'minWithdrawal')} USDT`});if(value>available)return send(res,400,{error:'Not enough USDT withdrawal balance. Convert HB9 to USDT before withdrawing.'});const withdrawal={id:id('wd'),userId:u.id,asset:'USDT',chain:'BSC',amount:value,address,status:'pending',fee:roundCurrency(value*setting(db,'withdrawalFeePercent')/100),createdAt:new Date().toISOString()};db.withdrawals.push(withdrawal);walletEntry(db,{userId:u.id,asset:'USDT',direction:'lock',amount:value,reason:'USDT withdrawal lock',refId:withdrawal.id});writeDB(db);return send(res,201,{message:'USDT BEP20 withdrawal request submitted for manual approval.'});}
      if(u.role!=='admin')return send(res,403,{error:'Admin only action'});
      if(p==='/api/admin/transfer-settings'&&method==='PUT'){const {minHb9Transfer,hb9TransferFeePercent}=await body(req),min=Number(minHb9Transfer),fee=Number(hb9TransferFeePercent);if(!Number.isFinite(min)||min<0||!Number.isFinite(fee)||fee<0||fee>100)return send(res,400,{error:'Invalid transfer settings'});db.settings.minHb9Transfer=min;db.settings.hb9TransferFeePercent=fee;writeDB(db);return send(res,200,{message:'Transfer settings saved',settings:db.settings});}
      if(p==='/api/admin/overview'&&method==='GET'){return send(res,200,{users:db.users.filter(x=>x.role==='user').map(x=>({...safeUser(x),summary:dashboard(db,x)})),settings:{...db.settings,market:marketSettings(db)},sweepService:sweepServiceStatus(),marketSettings:marketSettings(db),priceHistory:db.hb9_price_history||[],marketReport:hb9MarketReport(db),supply:db.hb9_supply,reserveWallets:db.reserve_wallets||[],reserveLedger:db.reserve_ledger||[],burnLedger:db.burn_ledger||[],walletLedger:db.wallet_ledger||[],exchangeOrders:db.exchange_orders||[],incomeEmissions:db.income_emissions||[],solvency:solvencyReport(db),deposits:db.deposits,depositAddresses:db.deposit_addresses||[],blockchainTransactions:db.blockchain_transactions||[],sweepTransactions:db.sweep_transactions||[],auditLogs:db.auditLogs||[],conversions:db.conversions||[],stakes:db.stakes,withdrawals:db.withdrawals,transfers:db.transfers||[],ledger:db.incomeLedger,referrals:db.referralLedger||[],levelIncomeLedger:db.level_income_ledger||[],salaryRanks:db.salary_ranks||[],salaryQualifications:db.salary_qualifications||[],salaryPayouts:db.salary_payouts||[],globals:db.globalTeamRecords,flushes:db.flushRecords,directBusinessAudit:db.directBusinessAudit||[],dailyRuns:db.dailyRuns||[],demoMode:DEMO_MODE});}
      if(p==='/api/admin/reserve-wallets'&&method==='PUT'){const input=await body(req),asset=String(input.asset||'').toUpperCase(),walletType=String(input.walletType||''),balance=Number(input.balance);if(!['HB9','USDT'].includes(asset)||!walletType)return send(res,400,{error:'Valid asset and walletType are required'});if(!Number.isFinite(balance)||balance<0)return send(res,400,{error:'Reserve balance must be non-negative'});const wallet=reserveWallet(db,asset,walletType),old=wallet.balance;if(asset==='HB9'){const projected=roundCurrency(solvencyReport(db).accountedHb9-old+balance);if(projected>HB9_TOTAL_SUPPLY)return send(res,400,{error:'HB9 reserve adjustment exceeds fixed total supply'});}wallet.balance=roundCurrency(balance);wallet.updatedAt=new Date().toISOString();db.reserve_ledger.push({id:id('rsv'),asset,walletType,direction:'admin_set',amount:wallet.balance,balanceAfter:wallet.balance,reason:'Admin reserve adjustment',userId:u.id,createdAt:wallet.updatedAt,immutable:true});writeDB(db);return send(res,200,{message:'Reserve wallet updated',wallet,solvency:solvencyReport(db)});}
      if(p.startsWith('/api/admin/withdrawals/')&&p.endsWith('/reject')&&method==='POST'){const wd=db.withdrawals.find(x=>x.id===p.split('/')[4]);if(!wd||wd.status!=='pending')return send(res,400,{error:'Pending withdrawal not found'});wd.status='rejected';wd.rejectedAt=new Date().toISOString();wd.rejectedBy=u.id;walletEntry(db,{userId:wd.userId,asset:'USDT',direction:'unlock',amount:wd.amount,reason:'USDT withdrawal rejected',refId:wd.id});writeDB(db);return send(res,200,{message:'Withdrawal rejected and USDT unlocked',withdrawal:wd});}
      if(p.startsWith('/api/admin/withdrawals/')&&p.endsWith('/payout')&&method==='POST'){const wd=db.withdrawals.find(x=>x.id===p.split('/')[4]);if(!wd||wd.status!=='pending')return send(res,400,{error:'Pending withdrawal not found'});wd.status='approved';wd.paidAt=new Date().toISOString();wd.paidBy=u.id;walletEntry(db,{userId:wd.userId,asset:'USDT',direction:'payout',amount:wd.amount,reason:'USDT withdrawal payout',refId:wd.id});writeDB(db);return send(res,200,{message:'Withdrawal payout recorded',withdrawal:wd});}
      if(p==='/api/admin/market-settings'&&method==='PUT'){const result=setMarketSettings(db,await body(req),u.id);if(result.error)return send(res,400,{error:result.error});writeDB(db);return send(res,200,{message:'HB9 market prices saved',marketSettings:result.settings,priceHistory:db.hb9_price_history||[]});}
      if(p==='/api/admin/deposits/search'&&method==='GET'){const q=String(url.searchParams.get('q')||'').toLowerCase(),userId=url.searchParams.get('userId');const records=(db.deposits||[]).filter(x=>(!userId||x.userId===userId)&&(!q||String(x.userId||'').toLowerCase().includes(q)||String(x.txHash||'').toLowerCase().includes(q)||String(x.sweepTxHash||'').toLowerCase().includes(q)||String(x.depositAddressId||'').toLowerCase().includes(q)||String((db.deposit_addresses||[]).find(a=>a.id===x.depositAddressId)?.address||'').toLowerCase().includes(q)));return send(res,200,{deposits:records});}
      if(p==='/api/admin/sweeps'&&method==='GET'){const q=String(url.searchParams.get('q')||'').toLowerCase();const records=(db.sweep_transactions||[]).filter(x=>!q||String(x.userId||'').toLowerCase().includes(q)||String(x.depositTxHash||'').toLowerCase().includes(q)||String(x.sweepTxHash||'').toLowerCase().includes(q)||String(x.toAddress||'').toLowerCase().includes(q));return send(res,200,{service:sweepServiceStatus(),sweeps:records});}
      if(p.startsWith('/api/admin/sweeps/')&&p.endsWith('/retry')&&method==='POST'){const sweep=(db.sweep_transactions||[]).find(item=>item.id===p.split('/')[4]);try{retrySweep(db,sweep);writeDB(db);return send(res,200,{message:'Sweep retry queued',sweep});}catch(error){return send(res,400,{error:error.message});}}
      if(p==='/api/admin/settings'&&method==='PUT'){const input=await body(req); const allowed=['dailyRoi','directMultiplier','referralPercent','globalActivityMin','globalActivityMax','hb9Price','fallbackPrice','priceOffset','spreadPercent','buyFeePercent','sellFeePercent','manualOverrideEnabled','minWithdrawal','withdrawalFeePercent','manualWithdrawalApproval','treasuryWalletBSC']; for(const k of allowed)if(input[k]!==undefined)db.settings[k]=input[k];db.settings.globalPointValue=0.02;delete db.settings.globalExtraPercent; const numeric=['dailyRoi','directMultiplier','referralPercent','globalActivityMin','globalActivityMax','hb9Price','fallbackPrice','priceOffset','spreadPercent','buyFeePercent','sellFeePercent','minWithdrawal','withdrawalFeePercent']; if(!/^0x[a-fA-F0-9]{40}$/.test(String(db.settings.treasuryWalletBSC||'')))return send(res,400,{error:'Treasury wallet must be a valid EVM address'});if(numeric.some(k=>db.settings[k]!==undefined&&!Number.isFinite(Number(db.settings[k])))||db.settings.dailyRoi<1||db.settings.dailyRoi>4||db.settings.directMultiplier<1||db.settings.referralPercent<0||db.settings.referralPercent>100||db.settings.globalActivityMin<5||db.settings.globalActivityMax>15||db.settings.globalActivityMax<db.settings.globalActivityMin||Number(db.settings.fallbackPrice||db.settings.hb9Price)<=0||Number(db.settings.priceOffset)<0||db.settings.minWithdrawal<0||db.settings.withdrawalFeePercent<0||db.settings.withdrawalFeePercent>100)return send(res,400,{error:'Invalid settings. ROI must be 1-4%, referral percentage must be 0-100%, free Global Team must be 5-15, fallback price must be positive, and price offset must be non-negative.'}); numeric.forEach(k=>{if(db.settings[k]!==undefined)db.settings[k]=Number(db.settings[k])});if(input.fallbackPrice!==undefined||input.hb9Price!==undefined||input.priceOffset!==undefined||input.spreadPercent!==undefined||input.manualOverrideEnabled!==undefined||input.buyFeePercent!==undefined||input.sellFeePercent!==undefined){const result=setMarketSettings(db,{fallbackPrice:db.settings.fallbackPrice||db.settings.hb9Price,priceOffset:db.settings.priceOffset,spreadPercent:db.settings.spreadPercent,manualOverrideEnabled:db.settings.manualOverrideEnabled,buyFeePercent:db.settings.buyFeePercent,sellFeePercent:db.settings.sellFeePercent},u.id);if(result.error)return send(res,400,{error:result.error});}else db.settings.priceMode=marketSettings(db).manualOverrideEnabled?'manual_override':'icp_proxy';writeDB(db);return send(res,200,{message:'Settings saved',settings:{...db.settings,market:marketSettings(db)}});}
      if(p==='/api/admin/demo/reset'&&method==='POST'){return send(res,404,{error:'Route not found'});}
      if(p==='/api/admin/daily-income/run'&&method==='POST'){const summary=await processDaily(db);if(summary.usersProcessed===0)return send(res,409,{error:'Already processed today',summary});db.dailyRuns=(db.dailyRuns||[]);db.dailyRuns.push({id:id('run'),date:summary.date,adminId:u.id,adminName:u.name,...summary,createdAt:new Date().toISOString()});writeDB(db);return send(res,200,{message:'Daily income run completed',summary});}
      if(p==='/api/admin/salary/run'&&method==='POST'){const summary=await processSalaryPayouts(db,today());if(summary.processedUsers===0)return send(res,409,{error:'Salary cycle already processed or no qualified users',summary});db.salaryRuns=db.salaryRuns||[];db.salaryRuns.push({id:id('srun'),adminId:u.id,adminName:u.name,...summary,createdAt:new Date().toISOString()});writeDB(db);return send(res,200,{message:'Salary payout run completed',summary});}
      if(p==='/api/admin/direct-business'&&method==='POST'){const {userId,amount,note}=await body(req);const target=userById(db,userId),value=Number(amount);if(!target||target.role!=='user')return send(res,404,{error:'User not found'});if(!Number.isFinite(value)||value<=0)return send(res,400,{error:'Direct business amount must be greater than zero'});const oldBusiness=business(db,target.id),newBusiness=roundCurrency(oldBusiness+value),createdAt=new Date().toISOString();db.directBusiness.push({id:id('biz'),userId:target.id,sourceUserId:null,amount:value,reason:note||'Manual admin adjustment',createdAt,createdBy:u.id});db.directBusinessAudit=(db.directBusinessAudit||[]);db.directBusinessAudit.push({id:id('audit'),type:'DIRECT_BUSINESS_ADJUSTMENT',userId:target.id,oldBusiness,addedBusiness:value,newBusiness,adminId:u.id,adminName:u.name,note:note||'',createdAt,immutable:true});writeDB(db);return send(res,201,{message:'Direct business added',audit:db.directBusinessAudit.at(-1)});}
      if(p.startsWith('/api/admin/users/')&&p.endsWith('/status')&&method==='PUT'){const target=userById(db,p.split('/')[4]);const {status}=await body(req);if(!target||target.role==='admin')return send(res,404,{error:'User not found'});target.status=status==='blocked'?'blocked':'active';writeDB(db);return send(res,200,{message:'User status updated'});}
      return send(res,404,{error:'Route not found'});
    }
    let f=(req.url==='/'||req.url==='/exchange')?'/index.html':decodeURIComponent(req.url);f=path.join(PUBLIC,f);if(!f.startsWith(PUBLIC)||!fs.existsSync(f)) {res.writeHead(404);return res.end('Not found');} const ext=path.extname(f);res.writeHead(200,{'Content-Type':ext==='.html'?'text/html':ext==='.css'?'text/css':'application/javascript'});fs.createReadStream(f).pipe(res);
  } catch(e){ console.error(e);send(res,500,{error:'Server error'}); }
});
if(require.main===module)server.listen(PORT,()=>{console.log(`HB9 Staking running at ${APP_URL}`);startDepositWatcher();startSweepWorker();});
module.exports={configuredDepositWatcherStartBlock,parseBep20TransferWatcherLog,resolveDepositWatcherStart,validateBep20TransferEvent,createSweepCandidates,updateBroadcastedSweep,retrySweep,sweepServiceStatus};
