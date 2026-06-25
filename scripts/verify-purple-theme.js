const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const port = 3400 + (process.pid % 400);
const dataFile = path.join(os.tmpdir(), `hb9-purple-theme-${process.pid}.json`);
const outDir = path.join(__dirname, '..', 'artifacts');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function request(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: url,
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) }
    }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => res.statusCode >= 400 ? reject(Error(raw)) : resolve(raw ? JSON.parse(raw) : {}));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(Error(message.error.message)) : resolve(message.result || {});
  };
  return new Promise((resolve, reject) => {
    ws.onerror = () => reject(Error('WebSocket connection failed'));
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const callId = ++id;
        ws.send(JSON.stringify({ id: callId, method, params }));
        return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
      },
      close: () => ws.close()
    });
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function waitFor(cdp, expression, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (await evaluate(cdp, expression)) return true; } catch (_) {}
    await wait(250);
  }
  throw Error(`Timed out waiting for ${expression}`);
}

async function newPage(debugPort) {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
      const page = await response.json();
      if (page.webSocketDebuggerUrl) return page;
    } catch (_) {
      await wait(250);
    }
  }
  throw Error('Chrome DevTools unavailable');
}

async function captureSet({ width, height, mobile, suffix, views, auth }) {
  const chromePath = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const debugPort = 9600 + (process.pid % 300) + (mobile ? width % 10 : 20);
  const userDataDir = path.join(os.tmpdir(), `hb9-purple-theme-chrome-${process.pid}-${suffix}`);
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--remote-allow-origins=*',
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-extensions',
    `--window-size=${width},${height}`,
    'about:blank'
  ], { stdio: 'ignore' });
  const shots = {};
  try {
    const page = await newPage(debugPort);
    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}` });
    await waitFor(cdp, 'document.readyState === "complete" && !!document.querySelector("#app")');
    await evaluate(cdp, `
      (() => {
        localStorage.setItem('hb9token', ${JSON.stringify(auth.token)});
        localStorage.setItem('hb9user', ${JSON.stringify(JSON.stringify(auth.user))});
        localStorage.removeItem('hb9presentation');
        return true;
      })()
    `);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}` });
    await waitFor(cdp, 'document.readyState === "complete" && !!document.querySelector("#app")');
    for (const view of views) {
      await evaluate(cdp, `
        (() => {
          const button = [...document.querySelectorAll('[data-view]')].find(x => x.dataset.view === ${JSON.stringify(view)});
          if (button) button.click();
          else if (${JSON.stringify(view)} === 'Dashboard') view = 'Dashboard';
          return true;
        })()
      `);
      await waitFor(cdp, `document.querySelector('h1')?.textContent === ${JSON.stringify(view)} || document.body.innerText.includes(${JSON.stringify(view)})`, 12000);
      await wait(700);
      const overflow = await evaluate(cdp, `(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)()`);
      if (overflow > 2) throw Error(`${view} has horizontal overflow ${overflow}px at ${suffix}`);
      if (view === 'Dashboard') {
        const labels = await evaluate(cdp, `[...document.querySelectorAll('.income-pairs .income-pair label')].map(x => x.textContent.trim()).join('|')`);
        if (!labels.includes('Salary Income')) throw Error('Dashboard salary income card missing');
        const values = await evaluate(cdp, `document.body.innerText`);
        if (values.includes('$100.00') || values.includes('500 HB9') || /Demo Mode|alice@hb9\\.local|Bob Direct|Alice Demo/.test(values)) throw Error('Dashboard contains seeded/demo values');
        const bottomNav = await evaluate(cdp, `[...document.querySelectorAll('.defi-bottom-nav button')].map(x => x.querySelector('b')?.textContent.trim()).join('|')`);
        if (bottomNav !== 'Dashboard|Exchange|Team|Wallet|Profile') throw Error(`Unexpected bottom nav content: ${bottomNav}`);
      }
      const name = `purple-theme-${view.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${suffix}.png`;
      const file = path.join(outDir, name);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true });
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      shots[view] = file;
    }
    cdp.close();
    return shots;
  } finally {
    chrome.kill();
  }
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(dataFile, { force: true });
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, APP_URL: 'https://coin.hb9.live', MARKET_TEST_MODE: 'true' },
    stdio: 'ignore'
  });
  try {
    const userEmail = `production-clean-${process.pid}@hb9.live`;
    for (let i = 0; i < 40; i++) {
      try { await request('POST', '/api/auth/register', { name: 'Production Clean User', email: userEmail, password: 'ProdClean@123', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }); break; }
      catch (error) { if (i === 39) throw error; await wait(100); }
    }
    const auth = await request('POST', '/api/auth/login', { email: userEmail, password: 'ProdClean@123' });
    const dashboard = await request('GET', '/api/dashboard', null, auth.token);
    if (dashboard.wallets.usdt !== 0 || dashboard.wallets.hb9 !== 0 || dashboard.stats.totalDeposit !== 0 || dashboard.stats.totalStakeHb9 !== 0) throw Error('Fresh registered user does not start at zero');
    const views = ['Dashboard', 'HB9 Exchange', 'Stake', 'Withdraw'];
    const mobile387 = await captureSet({ width: 387, height: 1200, mobile: true, suffix: 'mobile-387', views, auth });
    const mobile390 = await captureSet({ width: 390, height: 1200, mobile: true, suffix: 'mobile-390', views, auth });
    const mobile412 = await captureSet({ width: 412, height: 1200, mobile: true, suffix: 'mobile-412', views, auth });
    const desktop = await captureSet({ width: 1440, height: 1100, mobile: false, suffix: 'desktop', views: ['Dashboard'], auth });
    console.log(JSON.stringify({ status: 'PASS', screenshots: { mobile387, mobile390, mobile412, desktop } }, null, 2));
  } finally {
    server.kill();
    fs.rmSync(dataFile, { force: true });
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', error: error.message }, null, 2));
  process.exitCode = 1;
});
