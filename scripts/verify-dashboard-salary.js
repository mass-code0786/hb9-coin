const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3300 + (process.pid % 400);
const dataFile = path.join(os.tmpdir(), `hb9-dashboard-salary-${process.pid}.json`);
const outDir = path.join(__dirname, '..', 'artifacts');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = require('http').request({
      hostname: '127.0.0.1',
      port,
      path: url,
      method,
      headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) }
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

async function captureDashboard({ width, height, mobile, fileName }) {
  const chromePath = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const debugPort = 9500 + (process.pid % 400) + (mobile ? 1 : 0);
  const userDataDir = path.join(os.tmpdir(), `hb9-dashboard-salary-chrome-${process.pid}-${mobile ? 'mobile' : 'desktop'}`);
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
  try {
    const page = await newPage(debugPort);
    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}` });
    await waitFor(cdp, 'document.readyState === "complete" && !!document.querySelector(".income-pairs")');
    const labels = await evaluate(cdp, `[...document.querySelectorAll('.income-pairs .income-pair label')].map(x => x.textContent.trim())`);
    const expected = ['Referral Income', 'Level Income', 'B1 Income', 'Salary Income', 'Global Team', 'Flush Income'];
    if (JSON.stringify(labels) !== JSON.stringify(expected)) throw Error(`Income card order mismatch: ${JSON.stringify(labels)}`);
    const salary = await evaluate(cdp, `(() => {
      const card = document.querySelector('[data-income-card="Salary Income"]');
      return card ? card.innerText : '';
    })()`);
    if (!/Today \/ Total/.test(salary) || !/HB9/.test(salary)) throw Error(`Salary card missing amount values: ${salary}`);
    if (/Rank:|Cap:|qualified|left|used/i.test(salary)) throw Error(`Salary card has extra detail text: ${salary}`);
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, fileName);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    cdp.close();
    return file;
  } finally {
    chrome.kill();
  }
}

async function main() {
  fs.rmSync(dataFile, { force: true });
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, DEMO_MODE: 'true', MARKET_TEST_MODE: 'true' },
    stdio: 'ignore'
  });
  try {
    for (let i = 0; i < 40; i++) {
      try { await request('GET', '/api/dashboard'); break; }
      catch (error) { if (i === 39) throw error; await wait(100); }
    }
    const desktop = await captureDashboard({ width: 1440, height: 1100, mobile: false, fileName: 'dashboard-salary-desktop.png' });
    const mobile = await captureDashboard({ width: 390, height: 1200, mobile: true, fileName: 'dashboard-salary-mobile-390.png' });
    console.log(JSON.stringify({ status: 'PASS', screenshots: { desktop, mobile } }, null, 2));
  } finally {
    server.kill();
    fs.rmSync(dataFile, { force: true });
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', error: error.message }, null, 2));
  process.exitCode = 1;
});
