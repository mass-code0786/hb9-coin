# HB9 Staking Complete Project Audit

Audit date: 2026-06-23  
Repository root: `C:\Users\md464\OneDrive\Documents\Desktop\hb9`

## 1. Project Overview

### Purpose

This project is a local/demo HB9 staking platform. It demonstrates user registration, login, mock USDT BEP20 deposits, HB9 conversion, permanent HB9 staking, daily B1 income, direct-business eligibility, global team reporting, flush income, referral income, withdrawals, HB9 transfers, and admin demo controls.

Evidence:
- `README.md:1` names the project "HB9 Staking - local demo".
- `README.md:22` explicitly says deposits are mock deposits and the app does not generate wallet addresses or monitor BEP20 transactions.
- `server.js:10` enables demo mode unless `NODE_ENV=production` or `DEMO_MODE=false`.
- `SECURITY_CHECKLIST.md:16-21` documents deposit logic as local demo/mock only.

### Technology Stack

- Runtime: Node.js 18+, configured in `package.json:10`.
- Server: native Node `http` server, no Express or framework, implemented in `server.js:85-117`.
- Storage: JSON file database at `data/db.json`, read/write helpers in `server.js:18-19`.
- Auth crypto: Node `crypto.scryptSync` password hashing and random bearer tokens in memory, implemented in `server.js:11` and `server.js:16-17`.
- Frontend: static HTML/CSS/JavaScript served from `public`, with `public/index.html:1` loading many CSS files and `public/app.js`.
- External market data: Binance ICPUSDT is mirrored and exposed as HB9/USDT in `server.js:38`; TradingView script is loaded from `https://s3.tradingview.com/tv.js` in `public/app.js:142`.
- Tests: custom smoke script in `scripts/smoke.js`; npm script in `package.json:7`.

### Architecture Overview

The app is a monolith:
- Backend API and static file server are both in `server.js`.
- All data is loaded from and written to a single JSON document through `readDB()` and `writeDB()` in `server.js:18-19`.
- There are no database migrations, ORM models, controllers, services, or route modules.
- Frontend is a single-page app in `public/app.js` with pages stored in a `pages` object starting at `public/app.js:28`.
- CSS is layered across many files in `public/index.html:1`, with multiple override/restore files such as `mobile-*.css`, `theme-teal*.css`, `final-clean.css`, and `withdraw-redesign.css`.

## 2. Implemented Features

### Authentication and Authorization

Implemented:
- Login API: `POST /api/auth/login` in `server.js:89`.
- Registration API: `POST /api/auth/register` in `server.js:90`.
- Password hashing: scrypt with random salt in `server.js:16`.
- Password verification: timing-safe comparison in `server.js:17`.
- Bearer token sessions: in-memory `sessions` map in `server.js:11` and auth lookup in `server.js:73`.
- Blocked users cannot log in because login requires `u.status === 'active'` in `server.js:89`.
- Admin-only route gate: all admin APIs are after `if(u.role!=='admin') return 403` in `server.js:103`.

Not production-ready:
- Sessions are memory-only, never expire, are not revocable, and are stored in browser `localStorage` at `public/app.js:2` and `public/app.js:22`.
- `SESSION_SECRET` is documented in `.env.example:2` but unused in code.
- There is no logout API or server-side token invalidation.

### User Management

Implemented:
- Seed users: admin, Alice, Bob in `server.js:24-27`.
- User registration creates `role:'user'`, `status:'active'`, wallet address, optional sponsor in `server.js:90`.
- Admin can block/unblock users with `PUT /api/admin/users/:id/status` in `server.js:110`.
- User profile UI shows name, email, wallet, status, join date, referral link in `public/app.js:115`.
- Admin Users tab lists users, status, stake, business, B1, wallet, balances, and block/unblock controls via `public/app.js:55`, `public/app.js:84`, and `public/app.js:86`.

Gaps:
- No edit profile, password reset, MFA, email verification, KYC, identity verification, role management, or granular admin permissions.
- Sponsor lookup compares exact email only in `server.js:90`; it is not case-normalized.

### MLM / Network Structure

Implemented:
- Single-level sponsor relationship through `users.sponsorId`, seeded for Bob under Alice in `server.js:27`.
- Direct team is derived by filtering users with `sponsorId === currentUser.id` in `server.js:81`.
- Direct business is stored separately in `directBusiness`, seeded in `server.js:32`.

Not implemented:
- No binary tree, left/right legs, placement tree, genealogy table, upline traversal, spillover, matching tree, rank tree, or multi-level network.
- No recursive downline queries or persisted parent-child network relationship beyond direct sponsor.

### Referral System

Implemented:
- Registration can include sponsor email in frontend at `public/app.js:121-122`.
- Profile generates referral link using `?ref=email` in `public/app.js:115`.
- Sponsor is stored on new users in `server.js:90`.
- Referral income is created when a sponsored user stakes HB9 in `server.js:99`.
- Referral total is calculated by `referralTotal()` in `server.js:43`.
- Dashboard includes today/total referral income in `server.js:83` and `public/app.js:113`.
- Admin Referral Income Report is rendered in `public/app.js:117`.

Gaps:
- Referral income is only direct/single-level.
- No fraud prevention, sponsor change workflow, referral code lookup on server, or referral link landing behavior beyond reading `ref` in the client.

### Package / Staking System

Implemented:
- HB9 staking is permanent according to current code: `POST /api/stakes` creates an active stake with no `endDate` in `server.js:99`.
- Staking consumes HB9 balance as computed by `walletBalances()` in `server.js:44-49`.
- Stake amount in USD is calculated as HB9 amount times `hb9Price` in `server.js:99`.
- Stake UI exists in `public/app.js:127`.
- My Staking UI shows active/permanent staking in `public/app.js:128`.

Inconsistencies:
- Earlier UI definitions still reference `lockDays` and `endDate` at `public/app.js:30-31`, `public/app.js:57`, and `public/app.js:89-90`, but current bottom overrides make staking permanent at `public/app.js:127-129`.
- `settings.lockDays` does not exist in seed settings at `server.js:34`.
- Admin Stakes report still has an `End` column at `public/app.js:57`, but permanent stakes have no `endDate`.

### Wallet System

Implemented wallets are computed, not stored as account balances:
- Approved USDT deposits minus conversions plus sale proceeds: `walletBalances()` in `server.js:45-49`.
- HB9 balance from conversions, transfers, and staking in `server.js:46-49`.
- Withdrawal wallet from credited B1 plus referral income in `server.js:83`.
- Frontend dashboard wallet/stake display is assembled in `public/app.js:103-108`.
- HB9 transfers are implemented in `server.js:100-101` and `public/app.js:143`.

Gaps:
- No normalized wallet accounts table.
- No reserved balances.
- No transaction-level double-entry ledger for all wallet movement.
- Uses JavaScript floating point numbers.

### Income System

Implemented:
- B1 income: `globalForDate()` calculates daily ROI using `dailyRoi` in `server.js:61`, creates ledger in `server.js:68`.
- Flush income: ineligible B1 or global extra is recorded in `flushRecords` in `server.js:69-70`.
- Global team records: generated for every user in `globalForDate()` and `processDaily()` at `server.js:52-72`.
- Referral income: created on stake in `server.js:99`.
- Dashboard returns income summary in `server.js:83`.
- Admin reports: B1, Referral, Global Team, Flush in `public/app.js:58-60` and `public/app.js:117`.

Not implemented:
- Matching income, binary income, rank income, level income, ROI caps, package-specific income slabs, payout cycles, or income locking.

### Commission Calculations

Implemented:
- Direct referral percent defaults to 10% in `server.js:34`, applied in `server.js:99`.
- B1 daily ROI defaults to 2%, configurable 1-4% in `server.js:34` and validated in `server.js:106`.
- Direct business eligibility uses active stake times `directMultiplier`, default 2X, in `server.js:61`.
- Global extra percent defaults to 6%, validated 5-7% in `server.js:106`.
- Non-investor global activity value uses deterministic pseudo-random activity based on `userId + date` in `server.js:59-60`.

### Rank / Achievement System

Not implemented. There are no rank tables, rank fields, achievement records, badge rules, rank income rules, or rank UI. Searches found no implemented rank module.

### Withdrawal System

Implemented:
- User withdrawal request API: `POST /api/withdrawals` in `server.js:102`.
- Minimum withdrawal and fee settings in `server.js:34`.
- Available balance excludes pending/non-rejected withdrawals in `server.js:102`.
- Frontend validates BEP20 address format before submit in `public/app.js:110`.
- Withdrawal history UI in `public/app.js:110`.
- Admin withdrawal report exists in `public/app.js:61`.

Gaps:
- No admin approve/reject withdrawal API despite UI displaying statuses.
- No on-chain payout tracking, tx hash, velocity limits, 2FA, reconciliation, or address allowlisting.
- Server only checks address presence in `server.js:102`; strict BEP20 validation is client-only.

### Deposit / Funding System

Implemented:
- User submits mock USDT deposit with minimum 10 USDT in `server.js:96`.
- Admin approves pending deposit in `server.js:111`.
- Approved deposits credit USDT wallet through `walletBalances()` in `server.js:45`.
- If deposit owner has sponsor, approval adds direct business to sponsor in `server.js:111`.
- Deposit page in `public/app.js:87`.
- Admin Deposits report and approve button in `public/app.js:56`.

Important mismatch:
- Admin button says "Approve & stake" in `public/app.js:56`, but server approval only approves and credits USDT wallet; staking happens later via conversion and `POST /api/stakes` in `server.js:97-99`.

Not implemented:
- No blockchain deposit address generation, tx hash capture, BEP20 listener, confirmations, replay prevention, token contract validation, or automatic funding.

### Admin Panel Features

Implemented:
- Admin panel loads aggregate data through `GET /api/admin/overview` in `server.js:105`.
- Tabs include Overview, Users, Deposits, Stakes, B1 Report, Referral Income Report, HB9 Transfer Report, Global Team Report, Flush Report, Withdrawals, Settings in `public/app.js:50`.
- Run Daily Income and Reset Demo Data controls in `public/app.js:54`, handlers in `public/app.js:67-68`, APIs in `server.js:107-108`.
- Add Direct Business control and audit in `public/app.js:52`, `public/app.js:69`, API in `server.js:109`.
- Settings form in `public/app.js:47`, transfer settings extension in `public/app.js:146`, APIs in `server.js:104` and `server.js:106`.
- Export report creates client-side JSON in `public/app.js:14` and button added in `public/app.js:84`.

Gaps:
- No withdrawal approval action, deposit rejection, user edit/delete, audit log for every admin action, granular roles, or server-side report export.

### Notifications

Implemented:
- Client toast messages in `public/app.js:8`.
- Confirmation modals in `public/app.js:10`.

Not implemented:
- No persisted notifications, email, SMS, push, in-app notification center, read/unread state, or notification table.

### Reports

Implemented:
- User reports: Income, Flush Report, Global Team, Team, My Staking, Withdrawal History in `public/app.js:33-36`, `public/app.js:110-115`, `public/app.js:128`, `public/app.js:131-132`.
- Admin reports: B1, Referral, Transfer, Global Team, Flush, Withdrawals in `public/app.js:58-61`, `public/app.js:117`, `public/app.js:146`.
- Export demo report in `public/app.js:14` includes users, stakes, B1 income, global team, flush, withdrawals, settings.

Gaps:
- No backend CSV/PDF export, date filters, pagination, reconciliation reports, tax reports, or immutable report snapshots.

### Mobile App Features

Implemented as responsive web UI only:
- Mobile drawer in `public/app.js:12`, extended for exchange in `public/app.js:124`.
- Mobile header injection in `public/app.js:79`.
- Mobile CSS files loaded in `public/index.html:1`.

Not implemented:
- No native iOS/Android app, React Native, Capacitor, PWA manifest, service worker, push notifications, app store build, or offline mode.

### AI Features

Not implemented. There are no AI routes, OpenAI dependencies, prompts, model calls, vector store, assistants, or AI UI modules.

### Other Implemented Modules

- HB9 exchange buy/sell: `server.js:97-98`, UI in `public/app.js:130`.
- Market ticker/klines endpoints: `server.js:92-94`.
- TradingView widget: `public/app.js:142`.
- HB9 transfer: `server.js:100-101`, UI in `public/app.js:143`, admin report in `public/app.js:146`.
- Demo smoke test: `scripts/smoke.js`.

## 3. Database Analysis

There is no real database schema and no migrations. The "tables" below are top-level arrays/objects in `data/db.json` and seeded in `server.js:23-34`.

### Tables / Collections

| Collection | Purpose | Key fields | References |
|---|---|---|---|
| `users` | User/admin accounts | `id`, `name`, `email`, `role`, `status`, `passwordHash`, `salt`, `walletAddress`, `sponsorId`, `createdAt` | `sponsorId -> users.id` |
| `deposits` | Mock USDT deposit requests | `id`, `userId`, `amount`, `status`, `network`, `createdAt`, `approvedAt`, `approvedBy` | `userId -> users.id`, `approvedBy -> users.id` |
| `conversions` | USDT/HB9 exchange records | `id`, `userId`, `direction`, `usdtAmount`, `hb9Amount`, `rate`, `feePercent`, `createdAt` | `userId -> users.id` |
| `stakes` | Permanent HB9 stake positions | `id`, `userId`, `amount`, `coinAmount`, `status`, `startDate`, `dailyRate`, `createdAt` | `userId -> users.id` |
| `directBusiness` | Direct business volume credits | `id`, `userId`, `sourceUserId`, `amount`, `reason`, `createdAt`, `createdBy` | `userId -> users.id`, `sourceUserId -> users.id`, `createdBy -> users.id` |
| `incomeLedger` | B1 income ledger | `id`, `userId`, `date`, `type`, `amount`, `status`, `note`, `immutable`, `createdAt` | `userId -> users.id` |
| `referralLedger` | Direct referral income ledger | `id`, `type`, `sponsorId`, `referredUserId`, `stakeAmount`, `stakeCoinAmount`, `referralPercent`, `referralAmount`, `date`, `createdAt`, `immutable` | `sponsorId -> users.id`, `referredUserId -> users.id` |
| `globalTeamRecords` | Daily global team activity/value | `id`, `userId`, `date`, `activity`, `value`, `paid`, `unpaid`, `createdAt`, `reconciledAt` | `userId -> users.id` |
| `flushRecords` | Non-withdrawable/ineligible income records | `id`, `userId`, `date`, `incomeType`, `eligibleIncome`, `paidIncome`, `flushedIncome`, `reason`, `createdAt` | `userId -> users.id` |
| `withdrawals` | User withdrawal requests | `id`, `userId`, `amount`, `address`, `status`, `fee`, `createdAt` | `userId -> users.id` |
| `transfers` | HB9 peer transfers | `id`, `senderId`, `receiverId`, `amount`, `fee`, `status`, `note`, `createdAt` | `senderId/receiverId -> users.id` |
| `transferLedger` | Per-user transfer ledger rows | `id`, `transferId`, `userId`, `type`, `counterpartyId`, `amount`, `fee`, `createdAt`, `immutable` | `transferId -> transfers.id`, `userId/counterpartyId -> users.id` |
| `directBusinessAudit` | Admin direct-business audit entries | `id`, `type`, `userId`, `oldBusiness`, `addedBusiness`, `newBusiness`, `adminId`, `adminName`, `note`, `createdAt`, `immutable` | `userId/adminId -> users.id` |
| `dailyRuns` | Admin-triggered daily income run summaries | `id`, `date`, `adminId`, `adminName`, `usersProcessed`, `b1Credited`, `globalGenerated`, `flushGenerated`, `skippedUsers`, `createdAt` | `adminId -> users.id` |
| `settings` | Platform settings object | ROI, multiplier, fees, price, transfer settings, withdrawal settings | none |

### Relationships

- User sponsor: `users.sponsorId` points to another user; used by `server.js:81` and `server.js:90`.
- Deposit owner/admin: `deposits.userId` and `deposits.approvedBy`; approval logic in `server.js:111`.
- Stake owner: `stakes.userId`; dashboard aggregation in `server.js:82-83`.
- Referral ledger links sponsor and referred user in `server.js:99`.
- Direct business can link a source user or admin-created adjustment in `server.js:32`, `server.js:109`, `server.js:111`.
- Transfer ledger links transfer, user, and counterparty in `server.js:100-101`.

### Missing Relationships / Constraints

- No foreign key enforcement because JSON storage is used.
- No unique indexes on email, wallet address, deposit transaction hash, daily income key, or ledger id.
- No idempotency key for `(userId, date, type)` income ledger; duplicate prevention is partial and depends on `globalTeamRecords` in `server.js:72`.
- No withdrawal approval relationship fields such as `approvedBy`, `approvedAt`, `rejectedBy`, `txHash`.
- No package table, rank table, binary tree table, notifications table, audit log table, or wallet balance/account table.

## 4. API Analysis

All APIs are in `server.js:89-111`.

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | Public | Login with email/password, returns bearer token. `server.js:89` |
| POST | `/api/auth/register` | Public | Create user with name/email/password/wallet/sponsor. `server.js:90` |
| GET | `/api/market/hb9-ticker` | User/Admin | HB9 ticker mapped from market source. `server.js:92` |
| GET | `/api/market/hb9-klines` | User/Admin | HB9 candles for interval. `server.js:93` |
| GET | `/api/market/hb9-usdt` | User/Admin | Full market payload. `server.js:94` |
| GET | `/api/dashboard` | User/Admin | Current user dashboard, wallet, income, team, reports. `server.js:95` |
| POST | `/api/deposits` | User/Admin | Submit mock USDT deposit. `server.js:96` |
| POST | `/api/convert` | User/Admin | Convert approved USDT to HB9. `server.js:97` |
| POST | `/api/exchange/sell` | User/Admin | Sell HB9 back to USDT. `server.js:98` |
| POST | `/api/stakes` | User/Admin | Create permanent HB9 stake. `server.js:99` |
| GET | `/api/transfers` | User/Admin | List current user's transfer ledger. `server.js:100` |
| POST | `/api/transfers` | User/Admin | Send HB9 to another user. `server.js:101` |
| POST | `/api/withdrawals` | User/Admin | Request withdrawal. `server.js:102` |
| PUT | `/api/admin/transfer-settings` | Admin | Save HB9 transfer min/fee. `server.js:104` |
| GET | `/api/admin/overview` | Admin | Return users and all report data. `server.js:105` |
| PUT | `/api/admin/settings` | Admin | Save platform settings. `server.js:106` |
| POST | `/api/admin/demo/reset` | Admin + demo mode | Reset seed data. `server.js:107` |
| POST | `/api/admin/daily-income/run` | Admin | Run daily B1/global/flush. `server.js:108` |
| POST | `/api/admin/direct-business` | Admin | Add direct business adjustment and audit. `server.js:109` |
| PUT | `/api/admin/users/:id/status` | Admin | Block/unblock user. `server.js:110` |
| POST | `/api/admin/deposits/:id/approve` | Admin | Approve pending deposit and add direct business to sponsor. `server.js:111` |

API gaps:
- No withdrawal approve/reject API.
- No deposit reject API.
- No list endpoints for deposits/stakes/withdrawals per user beyond dashboard bundle.
- No pagination, filters, schemas, rate limits, request body size limits, or structured error codes.

## 5. Dashboard Analysis

### User Dashboard

Implemented:
- Main dashboard page in `public/app.js:29`, then heavily overridden in `public/app.js:74-79`, `public/app.js:91-109`, and `public/app.js:112-113`.
- Displays HB9 balance, active stake, total deposit, total withdrawal, total/active stake, direct team, direct business, referral income, B1 income, global team, flush income.
- Quick actions for Deposit, Withdraw, Transfer in `public/app.js:75` and final routing at `public/app.js:148`.

Issues:
- Dashboard code is layered by repeated overwrites, which is fragile and difficult to maintain.
- Transfer click has conflicting handlers: one opens Transfer in capture phase at `public/app.js:144`, while another later shows "Transfer feature coming soon" at `public/app.js:148`; because the earlier handler calls `stopImmediatePropagation()`, the later message may not run.

### Admin Dashboard

Implemented:
- Admin page loads `/api/admin/overview` in `public/app.js:41`.
- Admin tabs in `public/app.js:50`.
- Overview stats and demo controls in `public/app.js:54`.
- Users, deposits, stakes, reports, withdrawals, settings in `public/app.js:55-62`.
- Admin controls bound in `public/app.js:66-72`.

### Partner Dashboard

Not present. There is no `partner` role, route, UI, or data model. Only `admin` and `user` roles exist in `server.js:25-27` and `server.js:90`.

### School / Parent / Teacher Dashboards

Not present. There are no school, parent, or teacher roles, pages, APIs, tables, or domain entities. Searches found no implemented modules beyond generic text matches.

## 6. Income and MLM Logic

### Direct Income / Referral Income

Direct referral income is implemented as a flat percentage of referred user's stake:
- Default `referralPercent:10` in `server.js:34`.
- Ledger creation in `server.js:99`.
- Sponsor totals in `server.js:43` and dashboard in `server.js:83`.

### Level Income

Not implemented. No multi-level traversal or level commission table exists.

### Matching Income

Not implemented. No matching rules, pairing records, or match ledger exists.

### Binary Income

Not implemented. No left/right leg, BV/PV, carry-forward, weak-leg logic, capping, or binary tree exists.

### Rank Income

Not implemented. No rank qualification, rank history, or rank income ledger exists.

### B1 Income

Implemented:
- Active stake sum is calculated in `server.js:58`.
- Eligibility requires direct business >= active stake * multiplier in `server.js:61`.
- B1 amount is active stake * daily ROI in `server.js:61`.
- Credited or flushed ledger entry is written in `server.js:68`.
- Daily run processes all users once per date based on global record existence in `server.js:72`.

### Global Team / Flush

Implemented:
- Every user can get a global activity record in `server.js:65-66`.
- Investor global value is B1 eligible amount plus configured extra percent in `server.js:62`.
- Eligible users get paid global value; ineligible users get unpaid global value in `server.js:63`.
- Flush is either ineligible B1 or eligible global extra in `server.js:69`.

Important limitation:
- Flush/global values are report values only. The withdrawal API only uses credited B1 plus referral income in `server.js:102`.

## 7. Security Review

### Positive Controls

- Passwords are not stored in plaintext; scrypt hashing is in `server.js:16`.
- Login rejects blocked accounts in `server.js:89`.
- Admin API gate exists in `server.js:103`.
- Server-side wallet checks prevent over-conversion, over-staking, over-transfer, and over-withdrawal in `server.js:97-102`.
- Settings validation constrains ROI, referral percent, global extra percent, withdrawal fee, etc. in `server.js:106`.
- Smoke test covers core safety paths in `scripts/smoke.js`.

### High-Risk Issues

1. JSON file storage is not safe for production money movement. `readDB()`/`writeDB()` in `server.js:18-19` have no transactions or locks, so concurrent requests can double-spend or lose writes.
2. Sessions are in memory and never expire. `sessions` is a process-local `Map` in `server.js:11`; auth uses bearer tokens in `server.js:73`; frontend stores tokens in `localStorage` at `public/app.js:2`.
3. No rate limiting on login, registration, deposits, withdrawals, or admin APIs. This is also called out in `SECURITY_CHECKLIST.md:39`.
4. Withdrawal address validation is only client-side in `public/app.js:110`; server checks only truthiness in `server.js:102`.
5. Market data is mislabeled: backend calls Binance `ICPUSDT` in `server.js:38` but exposes it as HB9/USDT in `server.js:92-94`; frontend TradingView uses `BINANCE:ICPUSDT` in `public/app.js:142`.
6. No CSRF protection, CSP, secure headers, CORS allowlist, HTTPS enforcement, request body limit, or structured logging. These are listed as missing in `SECURITY_CHECKLIST.md:37-39`.
7. Ledger immutability is only convention. Records include `immutable:true`, but there is no database permission, trigger, or append-only enforcement.
8. `check()` in `server.js:17` can throw if stored hash shape is invalid; not exploitable from normal UI but fragile for corrupted JSON.
9. Static file path check in `server.js:114` uses `startsWith(PUBLIC)` without normalizing case or path separator boundaries. It is probably acceptable in this local demo, but not a hardened static server.

### Medium / Low Issues

- Admin overview returns all user report data in one unpaginated payload at `server.js:105`.
- Admin action audits are incomplete. Direct business has audit in `server.js:109`, but status changes, deposit approvals, setting changes, daily runs, and reset do not have full audit logs.
- Demo credentials are visible in `README.md:12-14` and auth UI in `public/app.js:21`.
- `dotenv` is optionally required in `server.js:1` but `dotenv` is not declared in `package.json`; the app ignores the error.

## 8. Missing Features / Incomplete Modules / Dead Code

Missing:
- Real database and migrations.
- ORM models or schema definitions.
- Blockchain BEP20 deposit monitoring.
- Withdrawal approval/rejection workflow.
- Native mobile app.
- AI features.
- Partner/school/parent/teacher dashboards.
- Rank, achievement, binary, matching, and level income.
- Notifications beyond transient toasts.
- Production observability: logs, metrics, tracing, alerting.
- Deployment config, Dockerfile, CI pipeline.

Partially completed or inconsistent:
- "Approve & stake" UI text in `public/app.js:56` conflicts with server behavior in `server.js:111`.
- Permanent staking overrides conflict with older 100-day/lock UI code in `public/app.js:30-31`, `public/app.js:89-90`, and admin stake end-date column in `public/app.js:57`.
- `settings.lockDays` is referenced in frontend but absent from `server.js:34`.
- Withdrawal statuses include approved/rejected in UI at `public/app.js:61` and `public/app.js:110`, but no API changes statuses.
- Exchange is implemented, but market source is ICPUSDT while labeled HB9/USDT in `server.js:38`, `server.js:92-94`, and `public/app.js:142`.
- Frontend has many repeated function overrides, for example `renderAdmin` at `public/app.js:45`, `49`, `84`, `86`, `117`, `138`, `146`; `pages.Dashboard` at `public/app.js:74`, `77`, `91`, `100`, `112`; `pages['HB9 Exchange']` at `public/app.js:130`, `136`, `140`, `142`.

Dead or questionable code:
- `scripts/seed.js` imports `fs`, `path`, and `server.js` path but only prints instructions; it does not seed data directly.
- `flushTotal()` in `server.js:51` appears unused.
- Early versions of page renderers are overwritten later and may be unreachable.
- Many CSS files are override/restoration patches rather than cohesive modules, increasing cascade risk.

## 9. Production Readiness Score

Score: 32 / 100

Ready for demo:
- Local login/register.
- Mock deposits and admin approval.
- USDT/HB9 conversion.
- Permanent HB9 staking.
- B1, referral, global team, flush calculations.
- HB9 transfers.
- Admin overview, reports, settings, daily run, demo reset.
- Smoke test passes. Verified with `npm.cmd run smoke`.

Not ready for production:
- Storage must move from JSON to a transactional database.
- Money movement needs database transactions, row locks, idempotency keys, decimal numeric types, and append-only ledger enforcement.
- Real BEP20 deposit and withdrawal rails are absent.
- Sessions, rate limits, secure headers, CSRF/CORS policy, and body limits are missing.
- Admin permissions and audits are too coarse.
- Withdrawal workflow is incomplete.
- Market data is not real HB9 market data.
- Frontend architecture is fragile because of repeated overrides and many CSS patch files.

## 10. Final Summary and Recommended Priorities

### Currently Implemented

The app is a functioning HB9 staking demo with a native Node server, JSON data store, static SPA frontend, auth, user registration, direct sponsor referrals, mock deposits, HB9 conversion, permanent staking, B1 income, global team records, flush reporting, referral income, withdrawal requests, HB9 transfers, admin reports, admin settings, daily income generation, reset demo data, responsive/mobile web layout, and smoke coverage.

### Not Yet Implemented

Production database, migrations, formal models, real blockchain deposit monitoring, withdrawal approval/payouts, native mobile app, AI features, partner/school/parent/teacher dashboards, rank system, binary/matching/level income, durable background workers, notifications, full audit logs, granular permissions, deployment infrastructure, and production security controls are not implemented.

### Recommended Next Development Priorities

1. Replace `data/db.json` with PostgreSQL and migrations. Model users, deposits, conversions, stakes, ledgers, withdrawals, transfers, settings, and audits with foreign keys and unique constraints.
2. Build a true ledger service with decimal types, transactions, idempotency keys, row locks, and append-only enforcement.
3. Implement withdrawal approve/reject/payout workflow with admin audit, address validation, 2FA, tx hash, and reconciliation.
4. Split `server.js` into route, service, validation, auth, and repository layers.
5. Replace frontend override stacking in `public/app.js` with explicit page modules/components.
6. Add server-side validation schemas, request size limits, rate limits, secure headers, CORS allowlist, and expiring HttpOnly cookie sessions.
7. Decide whether HB9 market data is manual, internal, or sourced from a real exchange. Remove ICPUSDT relabeling if this is meant to represent real HB9.
8. Clean staking terminology: either permanent staking everywhere or a configured lock period everywhere.
9. Add admin deposit rejection, withdrawal processing, full audit logs, and report filters.
10. Only after the above, add rank/binary/matching/level income if those are actual product requirements.

