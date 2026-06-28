const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class FakeClassList {
  add() {}
  remove() {}
  toggle() {}
}

class FakeElement {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.classList = new FakeClassList();
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.max = '';
    this.placeholder = '';
    this.disabled = false;
    this.onclick = null;
    this.oninput = null;
    this.onsubmit = null;
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  addEventListener(event, handler) {
    if (event === 'click') this.onclick = handler;
  }
  querySelector(selector) {
    if (selector === 'iframe' && this.hasIframe) return {};
    return null;
  }
  focus() {}
}

function createPage() {
  const page = {
    html: '',
    elements: {},
    set innerHTML(value) {
      this.html = value;
      const chartId = /id="([^"]+)" data-tradingview-container/.exec(value)?.[1] || 'chart';
      this.elements.chart = new FakeElement();
      this.elements.chart.id = chartId;
      this.elements.status = new FakeElement();
      this.elements.exchangePrice = new FakeElement();
      this.elements.marketBase = new FakeElement();
      this.elements.marketPair = new FakeElement();
      this.elements.priceLabel = new FakeElement();
      this.elements.form = new FakeElement();
      this.elements.form.elements = {
        swapAmount: new FakeElement(),
        swapOutput: new FakeElement()
      };
      this.elements.assetButtons = [
        new FakeElement({ exchangeAsset: 'HB9' }),
        new FakeElement({ exchangeAsset: 'BNB' })
      ];
      this.elements.intervalButtons = [
        new FakeElement({ tvInterval: '15' }),
        new FakeElement({ tvInterval: '60' }),
        new FakeElement({ tvInterval: '240' }),
        new FakeElement({ tvInterval: 'D' })
      ];
      this.elements.swapToggle = new FakeElement();
      this.elements.maxButton = new FakeElement();
    },
    get innerHTML() {
      return this.html;
    },
    querySelector(selector) {
      if (selector === '[data-tradingview-container]') return this.elements.chart;
      if (selector === '#exchange-form') return this.elements.form;
      if (selector === '.market-status') return this.elements.status;
      if (selector === '.exchange-price') return this.elements.exchangePrice;
      if (selector === '[data-market-base]') return this.elements.marketBase;
      if (selector === '[data-market-pair]') return this.elements.marketPair;
      if (selector === '[data-price-label]') return this.elements.priceLabel;
      if (selector === '[data-swap-toggle]') return this.elements.swapToggle;
      if (selector === '[data-max-swap]') return this.elements.maxButton;
      if (selector.startsWith('[data-selected-asset=')) {
        const asset = /data-selected-asset="([^"]+)"/.exec(selector)?.[1];
        const pair = /data-selected-pair="([^"]+)"/.exec(selector)?.[1];
        return this.html.includes(`data-selected-asset="${asset}"`) && this.html.includes(`data-selected-pair="${pair}"`) ? this : null;
      }
      if (selector.startsWith('#')) return this.elements.chart?.id === selector.slice(1) ? this.elements.chart : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-exchange-asset]') return this.elements.assetButtons;
      if (selector === '[data-tv-interval]') return this.elements.intervalButtons;
      return [];
    }
  };
  return page;
}

function createContext(options = {}) {
  const page = createPage();
  const storage = {};
  const widgets = [];
  const pendingApi = [];
  const apiCalls = [];
  let loadCount = 0;
  const context = {
    pages: {},
    data: {
      wallets: { usdt: 1000, hb9: 50, bnb: 0.00083333 },
      settings: { hb9Price: 0.2, market: { fallbackPrice: 0.2, priceOffset: 0, spreadPercent: 0 }, lockDays: 15 },
      conversions: [
        { id: 'cnv_bnb_ui', fromAsset: 'USDT', toAsset: 'BNB', fromAmount: 0.5, toAmount: 0.0008971184, price: 557.33, status: 'completed', createdAt: '2026-06-28T10:00:00.000Z' },
        { id: 'cnv_hb9_sell_ui', fromAsset: 'HB9', toAsset: 'USDT', fromAmount: 100, reinvestAmountHb9: 20, convertedAmountHb9: 80, toAmount: 16, price: 0.2, status: 'completed', createdAt: '2026-06-28T10:02:00.000Z' },
        { id: 'cnv_hb9_ui', fromAsset: 'USDT', toAsset: 'HB9', fromAmount: 1, toAmount: 0.444444, price: 2.25, status: 'completed', createdAt: '2026-06-28T10:01:00.000Z' }
      ],
      stakes: []
    },
    page,
    window: {},
    document: {
      body: { contains: element => Boolean(element) },
      head: { append() {} },
      querySelector: () => null
    },
    localStorage: {
      getItem: key => storage[key] || null,
      setItem: (key, value) => { storage[key] = String(value); }
    },
    api: (endpoint, requestOptions = {}) => {
      apiCalls.push({ endpoint, options: requestOptions });
      if (endpoint === '/api/convert') {
        const payload = JSON.parse(requestOptions.body || '{}');
        const isHb9Sell = payload.fromAsset === 'HB9' && payload.toAsset === 'USDT';
        return Promise.resolve({
          message: `${payload.fromAsset} converted to ${payload.toAsset}`,
          balance: payload.toAsset === 'BNB' ? { usdt: 900, bnb: 1, hb9: 50 } : isHb9Sell ? { usdt: 1001, hb9: 49, bnb: 2 } : { usdt: 900, hb9: 500, bnb: 2 },
          conversion: { id: `cnv_${payload.fromAsset}_${payload.toAsset}`, orderId: `ord_${payload.fromAsset}_${payload.toAsset}`, fromAsset: payload.fromAsset, toAsset: payload.toAsset, fromAmount: payload.amount, toAmount: isHb9Sell ? 1 : 1, price: 1, createdAt: new Date().toISOString() }
        });
      }
      if (options.delayedApi) {
        return new Promise(resolve => pendingApi.push({ endpoint, resolve }));
      }
      return Promise.resolve(endpoint.includes('bnb')
        ? { source: 'binance', price: 600 }
        : { source: 'icp_proxy', hb9BasePrice: 0.2, hb9BuyPrice: 0.2 });
    },
    money: value => `$${Number(value || 0).toFixed(2)}`,
    points: value => String(Number(value || 0)),
    esc: value => String(value ?? ''),
    table: (headers, rows) => rows ? `<div class="tablewrap"><table class="table"><thead><tr>${headers.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No records</div>',
    USDTLogo: () => 'USDT',
    HB9CoinLogo: className => `<svg class="${className || 'hb9-coin-logo'}" aria-label="HB9 coin logo"></svg>`,
    badge: value => String(value),
    toast() {},
    loading: () => () => {},
    load: async () => { loadCount++; },
    render() {},
    loadTradingViewScript: () => Promise.resolve(),
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: fn => { fn(); return 1; },
    clearTimeout() {},
    console
  };
  context.window.TradingView = {
    widget: function(config) {
      widgets.push(config);
      page.elements.chart.hasIframe = true;
    }
  };
  context.TradingView = context.window.TradingView;
  context.__widgets = widgets;
  context.__pendingApi = pendingApi;
  context.__apiCalls = apiCalls;
  context.__loadCount = () => loadCount;
  return context;
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

(async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'bnb-exchange.js'), 'utf8');
  const context = createContext();
  vm.createContext(context);
  vm.runInContext(source, context);

  context.pages['HB9 Exchange']();
  await tick();
  let historyHtml = context.page.innerHTML.match(/<section class="card exchange-history-card"[\s\S]*?<\/section><\/section>$/)?.[0] || '';
  assert(context.page.innerHTML.includes('BNB Exchange'), 'BNB selected title renders');
  assert(context.page.innerHTML.includes('data-selected-pair="BNBUSDT"'), 'BNB selected pair state renders');
  assert(context.page.innerHTML.includes('BNB Price'), 'BNB selected price card renders');
  assert(context.page.innerHTML.includes('binance-swap-card'), 'swap card layout renders');
  assert(context.page.innerHTML.includes('<span>From</span>'), 'swap card renders From section');
  assert(context.page.innerHTML.includes('<span>To</span>'), 'swap card renders To section');
  assert(context.page.innerHTML.includes('USDT Wallet: $1000.00'), 'swap card shows source wallet balance');
  assert(context.page.innerHTML.includes('data-max-swap'), 'swap card renders Max button');
  assert(context.page.innerHTML.includes('BNB conversion is USDT only'), 'BNB reverse direction is disabled with message');
  assert(context.page.innerHTML.includes('conversion-history-list'), 'conversion history renders compact mobile list');
  assert(context.page.innerHTML.includes('conversion-history-card'), 'conversion history renders compact mobile cards');
  assert(context.page.innerHTML.includes('conversion-history-table'), 'desktop conversion history table still renders');
  assert(context.page.innerHTML.includes('<th>Status</th>'), 'conversion history exposes status column');
  assert(historyHtml.includes('0.50 USDT'), 'BNB history formats USDT with 2 decimals');
  assert(historyHtml.includes('0.00089711 BNB'), 'BNB history formats received amount compactly without rounding to zero');
  assert(context.page.innerHTML.includes('0.00083333 BNB'), 'BNB wallet card shows decimal BNB balance');
  assert(historyHtml.includes('Completed'), 'BNB history normalizes completed status');
  assert(!/bnb-token-badge|hb9-coin-logo|<img|<svg/.test(historyHtml), 'conversion history rows do not render token logos');
  assert(context.page.innerHTML.includes('/assets/bnb-logo.svg'), 'BNB logo image renders from local asset');
  assert(context.page.innerHTML.includes('bnb-token-fallback'), 'BNB logo keeps fallback if image fails');
  assert(context.page.innerHTML.includes('onerror='), 'BNB logo image has no broken-image state');
  assert(!context.page.innerHTML.includes('HB9 Wallet'), 'BNB mode does not render HB9 wallet card');
  assert.strictEqual(context.__widgets.at(-1).symbol, 'BINANCE:BNBUSDT', 'BNB chart widget uses BNBUSDT');
  assert(context.page.elements.chart.hasIframe, 'BNB chart is not blank');
  context.page.elements.maxButton.onclick();
  assert.strictEqual(context.page.elements.form.elements.swapAmount.value, '1000.00', 'Max fills source USDT wallet balance');
  assert.strictEqual(context.page.elements.form.elements.swapOutput.value, '1.66666666 BNB', 'Max recalculates small-precision BNB receive amount');
  context.page.elements.form.elements.swapAmount.value = '25';
  await context.page.elements.form.onsubmit({ preventDefault() {}, submitter: new FakeElement() });
  const bnbPayload = JSON.parse(context.__apiCalls.filter(call => call.endpoint === '/api/convert').at(-1).options.body);
  assert.strictEqual(bnbPayload.fromAsset, 'USDT', 'BNB frontend payload includes USDT fromAsset');
  assert.strictEqual(bnbPayload.toAsset, 'BNB', 'BNB frontend payload includes BNB toAsset');
  assert.strictEqual(bnbPayload.amount, 25, 'BNB frontend payload includes amount');
  assert(/^convert-usdt-bnb-/.test(bnbPayload.clientRequestId), 'BNB frontend payload includes pair clientRequestId');
  assert.strictEqual(context.__loadCount(), 1, 'BNB convert refreshes dashboard data');

  context.page.elements.assetButtons[0].onclick();
  await tick();
  historyHtml = context.page.innerHTML.match(/<section class="card exchange-history-card"[\s\S]*?<\/section><\/section>$/)?.[0] || '';
  assert(context.page.innerHTML.includes('HB9 Exchange'), 'HB9 selected title renders after switch');
  assert(context.page.innerHTML.includes('data-selected-pair="HB9USDT"'), 'HB9 selected pair state renders');
  assert(context.page.innerHTML.includes('data-swap-direction="USDT_HB9"'), 'HB9 default swap direction is USDT to HB9');
  assert(context.page.innerHTML.includes('HB9 Price'), 'HB9 selected price card renders');
  assert(context.page.innerHTML.includes('USDT Wallet: $900.00'), 'HB9 default source wallet is USDT');
  assert(context.page.innerHTML.includes('aria-label="USDT amount"'), 'HB9 default amount input is USDT');
  assert(context.page.innerHTML.includes('aria-label="HB9 estimated receive"'), 'HB9 default receive field is HB9');
  assert(context.page.innerHTML.includes('<span>USDT</span><strong aria-hidden="true">⇅</strong><span>HB9</span>'), 'HB9 default swap toggle shows direction');
  assert(context.page.innerHTML.includes('<button class="primary swap-submit">Convert</button>'), 'HB9 default submit button renders');
  assert(context.page.innerHTML.includes('hb9-coin-logo'), 'HB9 logo still renders');
  assert(historyHtml.includes('1.00 USDT'), 'HB9 history formats USDT with 2 decimals');
  assert(historyHtml.includes('0.4444 HB9'), 'HB9 history formats received amount compactly');
  assert(historyHtml.includes('Auto Reinvest'), 'HB9 sell history shows auto reinvest split');
  assert(historyHtml.includes('20 HB9'), 'HB9 sell history formats auto reinvest amount');
  assert(historyHtml.includes('16.00 USDT'), 'HB9 sell history formats 80 percent USDT received amount');
  assert(!/bnb-token-badge|hb9-coin-logo|<img|<svg/.test(historyHtml), 'HB9 conversion history rows do not render token logos');
  assert(!context.page.innerHTML.includes('BNB Wallet'), 'HB9 mode does not render BNB wallet card');
  assert.strictEqual(context.__widgets.at(-1).symbol, 'BINANCE:ICPUSDT', 'HB9 chart widget uses existing ICP proxy');
  assert(context.page.elements.chart.hasIframe, 'HB9 chart is not blank after switch');
  context.page.elements.form.elements.swapAmount.value = '10';
  await context.page.elements.form.onsubmit({ preventDefault() {}, submitter: new FakeElement() });
  const hb9Payload = JSON.parse(context.__apiCalls.filter(call => call.endpoint === '/api/convert').at(-1).options.body);
  assert.strictEqual(hb9Payload.fromAsset, 'USDT', 'HB9 frontend payload includes USDT fromAsset');
  assert.strictEqual(hb9Payload.toAsset, 'HB9', 'HB9 frontend payload includes HB9 toAsset');
  assert.strictEqual(hb9Payload.amount, 10, 'HB9 frontend payload includes amount');
  assert(/^convert-usdt-hb9-/.test(hb9Payload.clientRequestId), 'HB9 frontend payload includes pair clientRequestId');
  assert.strictEqual(context.__loadCount(), 2, 'HB9 convert refreshes dashboard data');

  context.page.elements.swapToggle.onclick();
  await tick();
  assert(context.page.innerHTML.includes('data-swap-direction="HB9_USDT"'), 'HB9 swap toggle reverses direction');
  assert(context.page.innerHTML.includes('HB9 Wallet: 500 HB9'), 'reversed swap shows HB9 wallet as source');
  assert(context.page.innerHTML.includes('aria-label="HB9 amount"'), 'reversed swap from input is HB9');
  assert(context.page.innerHTML.includes('aria-label="USDT estimated receive"'), 'reversed swap receive field is USDT');
  assert(context.page.innerHTML.includes('<span>HB9</span><strong aria-hidden="true">⇅</strong><span>USDT</span>'), 'reversed swap toggle shows direction');
  assert(context.page.innerHTML.includes('<button class="primary swap-submit">Convert</button>'), 'reversed swap submit button renders');
  context.page.elements.form.elements.swapAmount.value = '5';
  context.page.elements.form.elements.swapAmount.oninput();
  assert.strictEqual(context.page.elements.form.elements.swapOutput.value, '0.80 USDT', 'reversed swap receive amount previews 80 percent conversion');
  assert(context.page.innerHTML.includes('data-swap-preview'), 'reversed swap renders split preview container');
  assert(context.page.elements.form.elements.swapOutput.value !== '1.00 USDT', 'reversed swap no longer previews 100 percent conversion');
  await context.page.elements.form.onsubmit({ preventDefault() {}, submitter: new FakeElement() });
  const hb9SellPayload = JSON.parse(context.__apiCalls.filter(call => call.endpoint === '/api/convert').at(-1).options.body);
  assert.strictEqual(hb9SellPayload.fromAsset, 'HB9', 'reversed swap payload includes HB9 fromAsset');
  assert.strictEqual(hb9SellPayload.toAsset, 'USDT', 'reversed swap payload includes USDT toAsset');
  assert.strictEqual(hb9SellPayload.amount, 5, 'reversed swap payload includes amount');
  assert(/^convert-hb9-usdt-/.test(hb9SellPayload.clientRequestId), 'reversed swap frontend payload includes pair clientRequestId');
  assert.strictEqual(context.__loadCount(), 3, 'HB9 to USDT convert refreshes dashboard data');

  context.page.elements.swapToggle.onclick();
  await tick();
  assert(context.page.innerHTML.includes('data-swap-direction="USDT_HB9"'), 'HB9 swap toggle switches back to USDT to HB9');
  assert(context.page.innerHTML.includes('aria-label="USDT amount"'), 'switching back restores USDT amount input');
  assert(context.page.innerHTML.includes('aria-label="HB9 estimated receive"'), 'switching back restores HB9 receive field');

  context.page.elements.assetButtons[1].onclick();
  await tick();
  assert(context.page.innerHTML.includes('data-selected-pair="BNBUSDT"'), 'switching back updates pair to BNBUSDT');
  assert(!context.page.innerHTML.includes('<span>HB9</span><strong aria-hidden="true">⇅</strong><span>USDT</span>'), 'BNB mode does not expose HB9 reverse direction');
  assert.strictEqual(context.__widgets.at(-1).symbol, 'BINANCE:BNBUSDT', 'switching back refreshes BNB chart');

  const delayedHb9 = createContext({ delayedApi: true });
  vm.createContext(delayedHb9);
  vm.runInContext(source, delayedHb9);
  delayedHb9.localStorage.setItem('hb9ExchangeAsset', 'HB9');
  delayedHb9.pages['HB9 Exchange']();
  assert.strictEqual(delayedHb9.__pendingApi.at(-1).endpoint, '/api/market/hb9-ticker');
  delayedHb9.page.elements.assetButtons[1].onclick();
  assert(delayedHb9.page.innerHTML.includes('data-selected-pair="BNBUSDT"'), 'BNB selected while old HB9 request is pending');
  const oldHb9 = delayedHb9.__pendingApi.find(item => item.endpoint === '/api/market/hb9-ticker');
  oldHb9.resolve({ source: 'icp_proxy', hb9BasePrice: 0.2, hb9BuyPrice: 0.2 });
  await tick();
  assert.notStrictEqual(delayedHb9.page.elements.marketPair.textContent, 'HB9USDT', 'old delayed HB9 response cannot overwrite BNB pair');
  assert(delayedHb9.page.innerHTML.includes('data-selected-pair="BNBUSDT"'), 'BNB pair remains selected after old HB9 response');

  const delayedBnb = createContext({ delayedApi: true });
  vm.createContext(delayedBnb);
  vm.runInContext(source, delayedBnb);
  delayedBnb.localStorage.setItem('hb9ExchangeAsset', 'BNB');
  delayedBnb.pages['HB9 Exchange']();
  assert.strictEqual(delayedBnb.__pendingApi.at(-1).endpoint, '/api/market/bnb-ticker');
  delayedBnb.page.elements.assetButtons[0].onclick();
  assert(delayedBnb.page.innerHTML.includes('data-selected-pair="HB9USDT"'), 'HB9 selected while old BNB request is pending');
  const oldBnb = delayedBnb.__pendingApi.find(item => item.endpoint === '/api/market/bnb-ticker');
  oldBnb.resolve({ source: 'binance', price: 600 });
  await tick();
  assert.notStrictEqual(delayedBnb.page.elements.marketPair.textContent, 'BNBUSDT', 'old delayed BNB response cannot overwrite HB9 pair');
  assert(delayedBnb.page.innerHTML.includes('data-selected-pair="HB9USDT"'), 'HB9 pair remains selected after old BNB response');

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'exchange-fixes.css'), 'utf8');
  assert(/\.exchange-history-scroll[\s\S]*overflow-x:\s*auto/.test(css), 'desktop conversion history table remains readable with overflow support');
  assert(/@media\s*\(max-width:\s*768px\)[\s\S]*\.conversion-history-tablewrap[\s\S]*display:\s*none\s*!important/.test(css), 'mobile hides wide conversion history table');
  assert(/@media\s*\(max-width:\s*768px\)[\s\S]*\.conversion-history-scroll[\s\S]*overflow-x:\s*visible\s*!important/.test(css), 'mobile conversion history does not require horizontal scroll');
  assert(/@media\s*\(max-width:\s*768px\)[\s\S]*\.conversion-history-list[\s\S]*display:\s*grid/.test(css), 'mobile conversion history uses compact cards');
  assert(/\.conversion-history-card b[\s\S]*overflow-wrap:\s*anywhere/.test(css), 'mobile conversion history text cannot overflow');
  assert(fs.existsSync(path.join(__dirname, '..', 'public', 'assets', 'bnb-logo.svg')), 'local BNB logo asset exists');

  console.log('exchange-ui-smoke ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
