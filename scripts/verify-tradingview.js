const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const chromePath = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const appUrl = process.env.APP_URL || 'http://127.0.0.1:3000';
const port = 9300 + (process.pid % 500);
const userDataDir = path.join(os.tmpdir(), `hb9-tv-chrome-${process.pid}`);
const outDir = path.join(__dirname, '..', 'artifacts');
const desktopShot = path.join(outDir, 'hb9-exchange-tradingview-desktop.png');
const mobileShot = path.join(outDir, 'hb9-exchange-tradingview-mobile.png');

fs.mkdirSync(outDir, { recursive: true });

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw Error(`${response.status} ${response.statusText} for ${url}`);
  return response.json();
}

async function waitForChrome() {
  for (let i = 0; i < 80; i++) {
    try {
      const page = await fetchJson(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
      if (page.webSocketDebuggerUrl) return page;
    } catch (_) {
      await wait(250);
    }
  }
  throw Error('Chrome DevTools did not become ready');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];

  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(Error(message.error.message));
      else resolve(message.result || {});
      return;
    }
    listeners.forEach(listener => listener(message));
  };

  return new Promise((resolve, reject) => {
    ws.onerror = () => reject(Error('WebSocket connection failed'));
    ws.onopen = () => resolve({
      on: listener => listeners.push(listener),
      send(method, params = {}) {
        const callId = ++id;
        ws.send(JSON.stringify({ id: callId, method, params }));
        return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
      },
      close: () => ws.close()
    });
  });
}

async function evaluate(cdp, expression, awaitPromise = true) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    const exception = result.exceptionDetails.exception;
    throw Error(exception?.description || exception?.value || result.exceptionDetails.text || 'Evaluation failed');
  }
  return result.result?.value;
}

async function waitForExpression(cdp, expression, timeout = 30000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await evaluate(cdp, expression);
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await wait(500);
  }
  throw Error(`Timed out waiting for expression: ${expression}; last=${JSON.stringify(last)}`);
}

async function capture(cdp, file) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
}

async function main() {
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--remote-allow-origins=*',
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,1100',
    'about:blank'
  ], { stdio: 'ignore' });

  let chromeExited = false;
  chrome.on('exit', code => {
    chromeExited = true;
    if (code && code !== 0) console.error(`Chrome exited with ${code}`);
  });

  const consoleMessages = [];
  const pageErrors = [];
  const network = [];
  const failed = [];

  try {
    const page = await Promise.race([
      waitForChrome(),
      (async () => {
        while (!chromeExited) await wait(100);
        throw Error('Chrome exited before DevTools became ready');
      })()
    ]);
    const cdp = await connect(page.webSocketDebuggerUrl);
    cdp.on(message => {
      if (message.method === 'Runtime.consoleAPICalled') {
        consoleMessages.push({
          type: message.params.type,
          text: message.params.args.map(arg => arg.value || arg.description || '').join(' ')
        });
      }
      if (message.method === 'Runtime.exceptionThrown') {
        pageErrors.push(message.params.exceptionDetails?.text || message.params.exceptionDetails?.exception?.description || 'Runtime exception');
      }
      if (message.method === 'Network.requestWillBeSent') {
        const url = message.params.request.url;
        if (/tradingview|tv\.js|s3\.tradingview|symbol|\/api\//i.test(url)) network.push({ type: 'request', url });
      }
      if (message.method === 'Network.responseReceived') {
        const url = message.params.response.url;
        if (/tradingview|tv\.js|s3\.tradingview|symbol|\/api\//i.test(url)) {
          network.push({ type: 'response', status: message.params.response.status, url });
        }
      }
      if (message.method === 'Network.loadingFailed') {
        failed.push({
          requestId: message.params.requestId,
          errorText: message.params.errorText,
          blockedReason: message.params.blockedReason || null
        });
      }
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('DOMStorage.enable');
    const loginResponse = await fetch(`${appUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@hb9.local', password: 'Demo@123' })
    });
    const loginJson = await loginResponse.json();
    if (!loginResponse.ok || !loginJson.token) throw Error(loginJson.error || 'Login failed');
    await cdp.send('Page.navigate', { url: `${appUrl}/__storage_seed__` });
    await waitForExpression(cdp, `location.origin === ${JSON.stringify(new URL(appUrl).origin)}`, 10000);
    const storageId = { securityOrigin: new URL(appUrl).origin, isLocalStorage: true };
    await cdp.send('DOMStorage.setDOMStorageItem', { storageId, key: 'hb9token', value: loginJson.token });
    await cdp.send('DOMStorage.setDOMStorageItem', { storageId, key: 'hb9user', value: JSON.stringify(loginJson.user) });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${appUrl}/exchange` });
    await waitForExpression(cdp, `location.origin === ${JSON.stringify(new URL(appUrl).origin)} && !!document.querySelector("#app")`, 15000);
    await waitForExpression(cdp, 'document.readyState === "complete"', 15000);
    await waitForExpression(cdp, '!!(document.querySelector("#hb9-tradingview-chart") || document.querySelector("#email"))', 15000);
    if (await evaluate(cdp, '!!document.querySelector("#email")')) {
      await evaluate(cdp, `
        (async () => {
          const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'alice@hb9.local', password: 'Demo@123' })
          });
          const loginResponse = await response.json();
          if (!response.ok || !loginResponse.token) throw new Error(loginResponse.error || 'Login failed');
          localStorage.hb9token = loginResponse.token;
          localStorage.hb9user = JSON.stringify(loginResponse.user);
          location.href = '/exchange';
          return true;
        })()
      `);
    }
    try {
      await waitForExpression(cdp, '!!document.querySelector("#hb9-tradingview-chart")', 15000);
    } catch (error) {
      const state = await evaluate(cdp, `(() => ({
        href: location.href,
        title: document.title,
        hasApp: !!document.querySelector('#app'),
        h1: document.querySelector('h1')?.textContent || '',
        body: document.body.innerText.slice(0, 1200),
        token: !!localStorage.hb9token,
        errors: [...document.querySelectorAll('.error')].map(x => x.textContent)
      }))()`);
      throw Error(`${error.message}; pageState=${JSON.stringify(state)}; network=${JSON.stringify(network)}; console=${JSON.stringify(consoleMessages)}; pageErrors=${JSON.stringify(pageErrors)}`);
    }
    try {
      await waitForExpression(cdp, '!!document.querySelector("#hb9-tradingview-chart iframe")', 30000);
    } catch (error) {
      const state = await evaluate(cdp, `(() => {
        const chart = document.querySelector('#hb9-tradingview-chart');
        return {
          chartHtml: chart?.innerHTML || '',
          chartText: chart?.innerText || '',
          scriptLoaded: !!window.TradingView?.widget,
          scripts: [...document.scripts].map(script => script.src).filter(Boolean),
          status: document.querySelector('.market-status')?.textContent || ''
        };
      })()`);
      throw Error(`${error.message}; iframeState=${JSON.stringify(state)}; network=${JSON.stringify(network)}; failed=${JSON.stringify(failed)}; console=${JSON.stringify(consoleMessages)}; pageErrors=${JSON.stringify(pageErrors)}`);
    }
    await wait(8000);

    const desktop = await evaluate(cdp, `(() => {
      const chart = document.querySelector('#hb9-tradingview-chart');
      const iframe = chart?.querySelector('iframe');
      const rect = chart?.getBoundingClientRect();
      const scripts = [...document.scripts].map(script => script.src).filter(Boolean);
      const text = document.body.innerText;
      return {
        chartExists: !!chart,
        iframeExists: !!iframe,
        iframeSrc: iframe?.src || '',
        chartWidth: Math.round(rect?.width || 0),
        chartHeight: Math.round(rect?.height || 0),
        scriptLoaded: !!window.TradingView?.widget,
        tradingViewScripts: scripts.filter(src => /tradingview|tv\\.js/i.test(src)),
        visibleSymbolText: /BINANCE:ICPUSDT/.test(text),
        visiblePairText: /ICPUSDT/.test(text),
        status: document.querySelector('.market-status')?.textContent || '',
        bodyTextSnippet: text.slice(0, 1000)
      };
    })()`);

    await capture(cdp, desktopShot);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await wait(1000);
    const mobile = await evaluate(cdp, `(() => {
      const chart = document.querySelector('#hb9-tradingview-chart');
      const rect = chart?.getBoundingClientRect();
      return {
        chartWidth: Math.round(rect?.width || 0),
        chartHeight: Math.round(rect?.height || 0),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
        iframeExists: !!chart?.querySelector('iframe')
      };
    })()`);
    await capture(cdp, mobileShot);

    cdp.close();

    console.log(JSON.stringify({
      desktop,
      mobile,
      consoleMessages,
      pageErrors,
      tradingViewNetwork: network,
      failedNetwork: failed,
      screenshots: { desktop: desktopShot, mobile: mobileShot }
    }, null, 2));
  } finally {
    chrome.kill();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
