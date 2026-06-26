const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { HDNodeWallet } = require('ethers');

const port = 3500 + (process.pid % 300);
const debugPort = 9700 + (process.pid % 200);
const dataFile = path.join(os.tmpdir(), `hb9-deposit-submit-${process.pid}.json`);
const screenshotFile = path.join(__dirname, '..', 'artifacts', 'deposit-address-ready.png');
const TEST_XPUB = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk').neuter().extendedKey;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
        if (res.statusCode >= 400) return reject(Error(json.error || `HTTP ${res.statusCode}`));
        resolve(json);
      });
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

async function waitFor(expression, cdp, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(cdp, expression)) return;
    await wait(150);
  }
  throw Error(`Timed out waiting for ${expression}`);
}

async function newPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
      const page = await response.json();
      if (page.webSocketDebuggerUrl) return page;
    } catch (_) {
      await wait(150);
    }
  }
  throw Error('Chrome DevTools unavailable');
}

async function main() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, DEMO_MODE: 'true', MARKET_TEST_MODE: 'true', HD_WALLET_XPUB: TEST_XPUB, BSC_RPC_URL: 'http://127.0.0.1:1', USDT_BEP20_CONTRACT: '0x55d398326f99059ff775485246999027b3197955', TREASURY_WALLET_BSC: '0x9999999999999999999999999999999999999999', DEPOSIT_WATCHER_ENABLED: 'true' },
    stdio: 'ignore'
  });
  let chrome;
  try {
    const email = `deposit-ui-${process.pid}@hb9.local`;
    for (let i = 0; i < 40; i++) {
      try {
        await request('POST', '/api/auth/register', { name: 'Deposit UI Test', email, password: 'Deposit@123', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
        break;
      } catch (error) {
        if (i === 39) throw error;
        await wait(100);
      }
    }
    const auth = await request('POST', '/api/auth/login', { email, password: 'Deposit@123' });
    const chromePath = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    chrome = spawn(chromePath, [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${path.join(os.tmpdir(), `hb9-deposit-chrome-${process.pid}`)}`,
      '--remote-allow-origins=*',
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--window-size=1440,1100',
      'about:blank'
    ], { stdio: 'ignore' });
    const page = await newPage();
    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}` });
    await waitFor('document.readyState === "complete"', cdp);
    await evaluate(cdp, `localStorage.hb9token=${JSON.stringify(auth.token)};localStorage.hb9user=${JSON.stringify(JSON.stringify(auth.user))};location.reload()`);
    await waitFor('!!document.querySelector("[data-view=\\"Deposit\\"]")', cdp);
    await evaluate(cdp, `document.querySelector('[data-view="Deposit"]').click()`);
    await waitFor(`document.body.innerText.includes('Your permanent USDT BEP20 address')`, cdp);
    const state = await evaluate(cdp, `(() => {
      const address = document.querySelector('[data-copy-deposit-address]')?.dataset.copyDepositAddress;
      return { address, hasManualForm: !!document.querySelector('#deposit'), historyVisible: document.body.innerText.includes('Deposit History') };
    })()`);
    if (!/^0x[a-fA-F0-9]{40}$/.test(state.address || '') || state.hasManualForm || !state.historyVisible) throw Error(`Unexpected Deposit UI state: ${JSON.stringify(state)}`);
    const dashboard = await request('GET', '/api/dashboard', null, auth.token);
    if (!dashboard.depositService.configured || dashboard.wallets.usdt !== 0) throw Error('Dashboard did not expose a configured automatic deposit service');
    fs.mkdirSync(path.dirname(screenshotFile), { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true });
    fs.writeFileSync(screenshotFile, Buffer.from(shot.data, 'base64'));
    cdp.close();
    console.log(JSON.stringify({ status: 'PASS', screenshot: screenshotFile, state }, null, 2));
  } finally {
    chrome?.kill();
    server.kill();
    fs.rmSync(dataFile, { force: true });
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', error: error.message }, null, 2));
  process.exitCode = 1;
});
