(function(){
  if (typeof pages === 'undefined' || typeof api === 'undefined') return;

  const EXCHANGE_ASSET_KEY = 'hb9ExchangeAsset';
  const selectedExchangeAsset = () => localStorage.getItem(EXCHANGE_ASSET_KEY) || 'BNB';
  const setExchangeAsset = asset => localStorage.setItem(EXCHANGE_ASSET_KEY, asset);
  const assetLogo = asset => asset === 'HB9'
    ? HB9CoinLogo('hb9-coin-logo hb9-coin-logo--swap')
    : `<span class="swap-token-badge" style="font-weight:800">BNB</span>`;
  const walletLine = (label, value, suffix = '') => `<div><small>${label}</small><b class="wallet-balance-line">${value}${suffix}</b></div>`;

  function renderMarketTradingView(symbol, interval = 'D') {
    const container = page.querySelector('#hb9-tradingview-chart');
    if (!container) return;
    container.innerHTML = '';
    const draw = () => {
      if (!window.TradingView || !document.body.contains(container)) return;
      new TradingView.widget({
        autosize: true,
        symbol,
        interval,
        timezone: 'Etc/UTC',
        theme: 'dark',
        style: '1',
        locale: 'en',
        toolbar_bg: '#0d1424',
        enable_publishing: false,
        hide_top_toolbar: false,
        hide_legend: false,
        save_image: false,
        container_id: 'hb9-tradingview-chart'
      });
    };
    if (typeof loadTradingViewScript === 'function') loadTradingViewScript(draw);
    else draw();
  }

  pages['HB9 Exchange'] = function(){
    const b = data.wallets || {};
    let asset = selectedExchangeAsset();
    if (!['HB9', 'BNB'].includes(asset)) asset = 'BNB';
    const market = data.settings.market || { fallbackPrice: data.settings.hb9Price, priceOffset: .09, spreadPercent: 0 };
    let price = asset === 'HB9' ? Number(market.fallbackPrice || data.settings.hb9Price) : null;
    let buyPrice = asset === 'HB9' ? Number(market.fallbackPrice || data.settings.hb9Price) + Number(market.priceOffset || .09) : null;
    const pair = asset === 'HB9' ? 'HB9USDT' : 'BNBUSDT';
    const title = asset === 'HB9' ? 'HB9 Exchange' : 'BNB Exchange';
    const subtitle = asset === 'HB9' ? 'HB9USDT market chart' : 'Live BNBUSDT market chart';
    const sourceLabel = asset === 'HB9' ? 'Loading HB9...' : 'Loading BNB...';
    const walletAsset = asset === 'HB9' ? Number(b.hb9 || 0) : Number(b.bnb || 0);
    const historyRows = (data.conversions || [])
      .filter(x => (x.toAsset || (x.hb9Amount ? 'HB9' : '')).toUpperCase() === asset)
      .slice().reverse().slice(0, 12)
      .map(x => {
        const fromAsset = x.fromAsset || 'USDT';
        const toAsset = x.toAsset || (x.hb9Amount ? 'HB9' : 'BNB');
        const fromAmount = Number(x.fromAmount ?? x.usdtAmount ?? 0);
        const toAmount = Number(x.toAmount ?? x.hb9Amount ?? x.bnbAmount ?? 0);
        return `<tr><td>${String(x.createdAt || '').slice(0, 10)}</td><td>${esc(fromAsset)}</td><td>${esc(toAsset)}</td><td>${money(fromAmount)}</td><td>${points(toAmount)} ${esc(toAsset)}</td><td>${money(x.price ?? x.buyPrice ?? x.rate ?? 0)}</td></tr>`;
      }).join('');

    page.innerHTML = `<section class="exchange-page"><section class="card exchange-chart hb9-tv-card"><div class="income-header"><div><h2>${title}</h2><p class="muted">${subtitle}</p></div><div class="statusrow"><div class="tabs"><button class="${asset === 'HB9' ? 'active' : ''}" data-exchange-asset="HB9">HB9</button><button class="${asset === 'BNB' ? 'active' : ''}" data-exchange-asset="BNB">BNB</button></div><b class="exchange-price">Loading...</b></div></div><div class="chart-controls hb9-tv-controls"><button data-tv-interval="15">15m</button><button data-tv-interval="60">1H</button><button data-tv-interval="240">4H</button><button class="active" data-tv-interval="D">1D</button><small class="market-status">${sourceLabel}</small></div><div id="hb9-tradingview-chart" class="tradingview-chart" aria-label="${pair} TradingView candlestick chart"></div><div class="exchange-market exchange-market-clean"><div><small>${asset} Price</small><b data-market-base>Loading...</b></div><div><small>Pair</small><b data-market-pair>${pair}</b></div></div></section><section class="card exchange-wallets">${walletLine('USDT Wallet', money(b.usdt || 0))}${walletLine('HB9 Wallet', `${points(b.hb9 || 0)} HB9`)}${walletLine('BNB Wallet', `${points(b.bnb || 0)} BNB`)}</section><section class="card exchange-convert hb9-swap-card"><div class="swap-balance"><small>USDT Wallet</small><b>${money(b.usdt || 0)}</b></div><form id="exchange-form" class="swap-box"><div class="swap-field"><label>USDT Amount</label><div class="swap-input-row"><span class="swap-token-badge" role="img" aria-label="USDT" title="USDT">${USDTLogo('usdt-coin-logo usdt-coin-logo--swap')}</span><input name="swapAmount" type="number" min="0.01" max="${Number(b.usdt || 0)}" step="0.01" autocomplete="off"></div></div><button class="swap-reverse" type="button" disabled title="Backend-priced conversion">USDT</button><div class="swap-field"><label>${asset} You Receive</label><div class="swap-input-row output"><span data-receive-logo class="swap-token-badge" role="img" aria-label="${asset}" title="${asset}">${assetLogo(asset)}</span><input name="swapOutput" readonly value="0 ${asset}"></div></div><button class="primary swap-submit">Convert to ${asset}</button></form></section><section class="card"><h2>Conversion History</h2>${table(['Date','From','To','From Amount','To Amount','Price'], historyRows, 'No conversions yet', 'USDT conversions will appear here.')}</section></section>`;

    const form = page.querySelector('#exchange-form');
    const amount = form.elements.swapAmount;
    const output = form.elements.swapOutput;
    const status = page.querySelector('.market-status');
    const syncOutput = () => {
      const value = Number(amount.value || 0);
      output.value = value && buyPrice ? `${points(value / buyPrice)} ${asset}` : `0 ${asset}`;
    };
    const updateTicker = async () => {
      try {
        const ticker = await api(asset === 'HB9' ? '/api/market/hb9-ticker' : '/api/market/bnb-ticker');
        if (asset === 'HB9') {
          price = Number(ticker.hb9BasePrice ?? ticker.icpPrice ?? ticker.price);
          buyPrice = Number(ticker.hb9BuyPrice);
          status.textContent = ticker.source === 'manual_override' ? 'Manual override' : 'Live ICPUSDT';
        } else {
          price = Number(ticker.price);
          buyPrice = price;
          status.textContent = ticker.source === 'fallback' ? 'BNB fallback price' : 'Live BNBUSDT';
        }
        page.querySelector('.exchange-price').textContent = money(price);
        page.querySelector('[data-market-base]').textContent = money(price);
        page.querySelector('[data-market-pair]').textContent = pair;
        status.classList.remove('error');
        syncOutput();
      } catch (error) {
        status.textContent = 'Market data unavailable';
        status.classList.add('error');
      }
    };

    page.querySelectorAll('[data-exchange-asset]').forEach(button => {
      button.onclick = () => {
        setExchangeAsset(button.dataset.exchangeAsset);
        pages['HB9 Exchange']();
      };
    });
    page.querySelectorAll('[data-tv-interval]').forEach(button => {
      button.onclick = () => {
        page.querySelectorAll('[data-tv-interval]').forEach(item => item.classList.toggle('active', item === button));
        renderMarketTradingView(asset === 'HB9' ? 'BINANCE:ICPUSDT' : 'BINANCE:BNBUSDT', button.dataset.tvInterval);
      };
    });
    amount.oninput = syncOutput;
    form.onsubmit = async event => {
      event.preventDefault();
      const value = Number(amount.value);
      if (!Number.isFinite(value) || value <= 0) {
        toast('USDT amount is invalid', 'error');
        amount.focus();
        return;
      }
      const done = loading(event.submitter, 'Converting...');
      try {
        toast((await api('/api/convert', { method: 'POST', body: JSON.stringify({ amount: amount.value, toAsset: asset }) })).message);
        load();
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        done();
      }
    };
    renderMarketTradingView(asset === 'HB9' ? 'BINANCE:ICPUSDT' : 'BINANCE:BNBUSDT', 'D');
    updateTicker();
    const timer = setInterval(() => {
      if (!document.body.contains(page.querySelector('#hb9-tradingview-chart'))) {
        clearInterval(timer);
        return;
      }
      updateTicker();
    }, 10000);
  };

  pages.Stake = function(){
    const b = data.wallets || {};
    const hb9Price = Number(data.settings.hb9Price || data.settings.market?.fallbackPrice || 0);
    page.innerHTML = `<section class="card"><div class="income-header"><div><h2>Stake</h2></div>${badge(`${data.settings.lockDays}-day lock`, 'unpaid')}</div><div class="lock-card"><div><small>Available HB9</small><b>${points(b.hb9 || 0)} HB9</b></div><div><small>Available BNB</small><b>${points(b.bnb || 0)} BNB</b></div><div><small>HB9 price</small><b>${money(hb9Price)}</b></div></div><form id="stake-asset" class="formrow"><div class="field"><label>Asset</label><select name="stakeAsset"><option value="HB9">HB9</option><option value="BNB">BNB</option></select></div><div class="field"><label>Stake Amount</label><input name="amount" type="number" min="0.01" step="0.01" placeholder="0.00"></div><div class="field"><label>Income Basis</label><input name="basis" value="Backend calculates HB9 equivalent" readonly></div><button class="primary">Stake</button></form></section><section class="card"><h2>Active Stakes</h2>${table(['Asset','Stake Amount','USD Value','HB9 Equivalent','Start','Status'], (data.stakes || []).slice().reverse().map(x => `<tr><td>${esc(x.stakeAsset || 'HB9')}</td><td>${points(x.stakeAmount ?? x.coinAmount ?? x.hb9Amount ?? 0)} ${esc(x.stakeAsset || 'HB9')}</td><td>${money(x.stakeUsdValue ?? x.amount ?? 0)}</td><td>${points(x.hb9EquivalentAmount ?? x.coinAmount ?? 0)} HB9</td><td>${esc(x.startDate || '')}</td><td>${badge(x.status, x.status === 'active' ? 'yes' : 'no')}</td></tr>`).join(''), 'No stakes yet', 'HB9 and BNB stakes will appear here.')}</section>`;
    const form = page.querySelector('#stake-asset');
    const asset = form.elements.stakeAsset;
    const amount = form.elements.amount;
    const syncMax = () => {
      const max = asset.value === 'BNB' ? Number(b.bnb || 0) : Number(b.hb9 || 0);
      amount.max = max;
      amount.placeholder = String(max);
    };
    asset.onchange = syncMax;
    syncMax();
    form.onsubmit = async event => {
      event.preventDefault();
      const done = loading(event.submitter, 'Staking...');
      try {
        toast((await api('/api/stakes', { method: 'POST', body: JSON.stringify({ stakeAsset: asset.value, amount: amount.value }) })).message);
        load();
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        done();
      }
    };
  };

  if (typeof renderAdmin === 'function') {
    const previousRenderAdmin = renderAdmin;
    renderAdmin = function(adminData){
      previousRenderAdmin(adminData);
      const tabs = document.querySelector('.tabs');
      if (tabs && !tabs.querySelector('[data-tab="Conversions"]')) {
        tabs.insertAdjacentHTML('beforeend', `<button class="${adminTab === 'Conversions' ? 'active' : ''}" data-tab="Conversions">Conversions</button>`);
        tabs.querySelector('[data-tab="Conversions"]').onclick = () => { adminTab = 'Conversions'; renderAdmin(adminData); };
      }
      if (adminTab === 'Users') {
        const tableEl = document.querySelector('.report-stack .table');
        if (tableEl && !tableEl.querySelector('[data-bnb-head]')) {
          tableEl.querySelector('thead tr')?.insertAdjacentHTML('beforeend', '<th data-bnb-head>BNB Balance</th>');
          [...tableEl.querySelectorAll('tbody tr')].forEach((row, index) => row.insertAdjacentHTML('beforeend', `<td>${points(adminData.users[index]?.summary?.wallets?.bnb || 0)} BNB</td>`));
        }
      }
      if (adminTab === 'Stakes') {
        const rows = (adminData.stakes || []).slice().reverse().map(x => `<tr><td>${esc((adminData.users || []).find(user => user.id === x.userId)?.name || x.userId)}</td><td>${esc(x.stakeAsset || 'HB9')}</td><td>${points(x.stakeAmount ?? x.coinAmount ?? 0)} ${esc(x.stakeAsset || 'HB9')}</td><td>${money(x.stakeUsdValue ?? x.amount ?? 0)}</td><td>${points(x.hb9EquivalentAmount ?? x.coinAmount ?? 0)} HB9</td><td>${esc(x.startDate || '')}</td><td>${badge(x.status, x.status === 'active' ? 'yes' : 'no')}</td></tr>`).join('');
        document.querySelector('.report-stack').innerHTML = `<section class="card">${table(['User','Asset','Stake Amount','USD Value','HB9 Equivalent','Start','Status'], rows, 'No stakes', 'HB9 and BNB stakes will appear here.')}</section>`;
      }
      if (adminTab === 'Conversions') {
        const rows = (adminData.conversions || []).slice().reverse().map(x => {
          const fromAsset = x.fromAsset || 'USDT';
          const toAsset = x.toAsset || (x.hb9Amount ? 'HB9' : 'BNB');
          return `<tr><td>${String(x.createdAt || '').slice(0, 19).replace('T', ' ')}</td><td>${esc((adminData.users || []).find(user => user.id === x.userId)?.name || x.userId)}</td><td>${esc(fromAsset)}</td><td>${esc(toAsset)}</td><td>${money(x.fromAmount ?? x.usdtAmount ?? 0)}</td><td>${points(x.toAmount ?? x.hb9Amount ?? x.bnbAmount ?? 0)} ${esc(toAsset)}</td><td>${money(x.price ?? x.buyPrice ?? x.rate ?? 0)}</td></tr>`;
        }).join('');
        document.querySelector('.report-stack').innerHTML = `<section class="card">${table(['Date','User','From','To','From Amount','To Amount','Price'], rows, 'No conversions', 'HB9 and BNB conversions will appear here.')}</section>`;
      }
    };
  }

  if (typeof view !== 'undefined' && view === 'HB9 Exchange' && typeof data !== 'undefined' && data && typeof render === 'function') render();
})();
