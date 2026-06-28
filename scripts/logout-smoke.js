process.env.MARKET_TEST_MODE = 'true';
process.env.BOOTSTRAP_ADMIN_EMAIL = 'logout-admin@example.com';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'AdminLogout123!';
process.env.DATA_FILE = require('path').join(require('os').tmpdir(), `hb9-logout-${process.pid}.json`);

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { server, readDB } = require('../server');

async function request(base, route, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || payload.message || 'Request failed'), { status: response.status, payload });
  return payload;
}

(async () => {
  readDB();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  await request(base, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Logout User', email: 'logout-user@example.com', password: 'password123' }
  });

  const userLogin = await request(base, '/api/auth/login', {
    method: 'POST',
    body: { email: 'logout-user@example.com', password: 'password123' }
  });
  const userDashboard = await request(base, '/api/dashboard', { token: userLogin.token });
  assert.strictEqual(userDashboard.user.email, 'logout-user@example.com');

  await request(base, '/api/auth/logout', { method: 'POST', token: userLogin.token });
  await assert.rejects(
    () => request(base, '/api/dashboard', { token: userLogin.token }),
    error => error.status === 401
  );

  const adminLogin = await request(base, '/api/auth/login', {
    method: 'POST',
    body: { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD }
  });
  const adminOverview = await request(base, '/api/admin/overview', { token: adminLogin.token });
  assert(Array.isArray(adminOverview.users));

  await request(base, '/api/auth/logout', { method: 'POST', token: adminLogin.token });
  await assert.rejects(
    () => request(base, '/api/admin/overview', { token: adminLogin.token }),
    error => error.status === 401
  );

  const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'latin1');
  assert(appSource.includes('data-logout'), 'logout controls should be present');
  assert(appSource.includes('/api/auth/logout'), 'frontend should call logout API');
  assert(appSource.includes('clearAuthState'), 'frontend should clear cached auth state');
  assert(appSource.includes("adminLogout?'/admin':'/'"), 'admin logout should redirect to /admin');
  assert(appSource.includes('history.replaceState'), 'logout should replace history entry');
  assert(appSource.includes("window.addEventListener('pageshow'"), 'back-forward cache restore should require auth');

  console.log('logout-smoke ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  server.close();
  try { fs.unlinkSync(process.env.DATA_FILE); } catch (_) {}
});
