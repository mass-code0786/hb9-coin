# HB9 Production MLM Platform Roadmap

Source audit: `AUDIT_REPORT.md`  
Goal: convert the local/demo HB9 staking app into a production-ready MLM, staking, wallet, and admin platform.

## Executive Direction

The current app is a useful demo. Production requires a rebuild of the financial core: transactional database, wallet ledger, MLM engine, blockchain deposit/withdrawal rails, admin operations, security controls, observability, and mobile clients. The safest path is not to keep adding patches to `server.js` and `public/app.js`; preserve business rules that are valid, then move them into tested services.

Production readiness target:
- 0-20%: foundation and architecture
- 20-45%: secure financial ledger and auth
- 45-65%: MLM engine and admin workflows
- 65-80%: blockchain/payment integrations
- 80-90%: mobile, AI, reports, compliance
- 90-100%: hardening, audits, launch operations

## Feature Roadmap Matrix

### 1. Missing Modules

| Module | Priority | Complexity | Dependencies | Tables Required | APIs Required |
|---|---|---:|---|---|---|
| Production auth/session service | Critical | Medium | PostgreSQL, Redis, email/SMS provider | `users`, `roles`, `permissions`, `user_sessions`, `password_resets`, `mfa_factors` | `POST /auth/login`, `POST /auth/logout`, `POST /auth/refresh`, `POST /auth/password/forgot`, `POST /auth/password/reset`, `POST /auth/mfa/*` |
| KYC/compliance module | Critical if real money | High | KYC vendor, document storage | `kyc_profiles`, `kyc_documents`, `kyc_checks`, `risk_flags` | `POST /kyc/start`, `GET /kyc/status`, `POST /admin/kyc/:id/approve`, `POST /admin/kyc/:id/reject` |
| Wallet ledger module | Critical | High | PostgreSQL transactions, decimal math | `wallet_accounts`, `wallet_transactions`, `ledger_entries`, `ledger_journal`, `balance_snapshots` | `GET /wallets`, `GET /wallets/:id/transactions`, internal ledger APIs |
| Deposit lifecycle | Critical | High | Blockchain watcher/payment gateway | `deposit_addresses`, `deposits`, `deposit_events`, `blockchain_transactions` | `POST /deposits/address`, `GET /deposits`, `POST /webhooks/deposits` |
| Withdrawal lifecycle | Critical | High | Ledger reservation, approval, blockchain signer | `withdrawals`, `withdrawal_approvals`, `withdrawal_batches`, `payout_transactions` | `POST /withdrawals`, `GET /withdrawals`, `POST /admin/withdrawals/:id/approve`, `POST /admin/withdrawals/:id/reject`, `POST /admin/withdrawals/:id/broadcast` |
| MLM genealogy tree | Critical | High | User/sponsor model | `sponsor_links`, `placement_nodes`, `genealogy_closure`, `leg_volumes` | `GET /network/tree`, `GET /network/downline`, `POST /admin/network/place` |
| MLM commission engine | Critical | Very High | Ledger, genealogy, package rules | `commission_plans`, `commission_rules`, `commission_runs`, `commission_items`, `rank_periods` | `POST /admin/commissions/run`, `GET /commissions`, `GET /admin/commissions/runs` |
| Package/staking plans | High | Medium | Wallet ledger | `packages`, `staking_positions`, `staking_events`, `staking_plan_versions` | `GET /packages`, `POST /stakes`, `GET /stakes`, `POST /admin/packages` |
| Rank/achievement system | High | High | MLM engine, genealogy | `ranks`, `rank_rules`, `rank_qualifications`, `rank_history`, `achievements` | `GET /ranks`, `GET /users/me/rank`, `GET /admin/ranks`, `POST /admin/ranks` |
| Notification system | High | Medium | Queue, email/SMS/push | `notifications`, `notification_templates`, `delivery_attempts`, `user_notification_settings` | `GET /notifications`, `PATCH /notifications/:id/read`, admin template APIs |
| Audit/logging module | Critical | Medium | Admin/auth | `audit_logs`, `security_events`, `admin_action_logs` | `GET /admin/audit-logs`, internal `audit()` |
| Reporting/export module | High | Medium | Ledger, commissions | `report_jobs`, `report_exports` | `POST /admin/reports`, `GET /admin/reports/:id/download` |
| Support/ticket module | Medium | Medium | User/admin | `support_tickets`, `ticket_messages`, `ticket_attachments` | `POST /support/tickets`, `GET /support/tickets`, admin ticket APIs |
| Native mobile apps | High | High | Stable APIs, auth, push | API-backed only; plus `device_tokens` | Mobile API parity, `POST /devices`, push notification APIs |
| AI assistant/analytics | Medium | High | Clean data, permissions, OpenAI integration | `ai_conversations`, `ai_messages`, `ai_tool_calls`, `ai_insights` | `POST /ai/chat`, `GET /ai/insights`, admin AI APIs |

## 2. Database Changes Required

### Required Database Platform

Use PostgreSQL for primary storage, Redis for sessions/queues/rate limits, and object storage for documents/reports. Use database migrations from day one.

Critical database design requirements:
- Decimal currency fields, never JavaScript floats.
- Foreign keys for all relationships.
- Unique constraints for email, wallet address where needed, blockchain tx hash, commission idempotency keys.
- Row-level locks for deposits, withdrawals, staking, transfers, and commission runs.
- Append-only ledger enforced by database permissions/triggers.
- Separate migration/admin DB role from application DB role.

### Core Tables

| Table | Priority | Complexity | Dependencies | APIs |
|---|---|---:|---|---|
| `users` | Critical | Medium | Auth | Auth, profile, admin users |
| `user_profiles` | High | Low | Users | Profile APIs |
| `roles`, `permissions`, `role_permissions`, `user_roles` | Critical | Medium | Users | Admin RBAC APIs |
| `user_sessions`, `refresh_tokens` | Critical | Medium | Redis optional | Auth APIs |
| `audit_logs` | Critical | Medium | All admin actions | Admin audit APIs |
| `settings`, `settings_history` | High | Medium | Admin | Admin settings APIs |
| `wallet_accounts` | Critical | High | Users, currencies | Wallet APIs |
| `wallet_transactions` | Critical | High | Wallet accounts | Wallet history APIs |
| `ledger_journal`, `ledger_entries` | Critical | Very High | Wallet engine | Internal ledger APIs |
| `currencies`, `exchange_rates` | High | Medium | Exchange providers | Market APIs |
| `deposit_addresses` | Critical | High | Blockchain | Deposit APIs |
| `deposits`, `deposit_events` | Critical | High | Blockchain watcher | Deposit/admin APIs |
| `withdrawals`, `withdrawal_approvals` | Critical | High | Wallet reservations | Withdrawal/admin APIs |
| `blockchain_transactions` | Critical | High | Chain indexer | Deposit/withdrawal tracking |
| `packages`, `package_versions` | High | Medium | Admin | Package APIs |
| `staking_positions`, `staking_events` | Critical | High | Wallet ledger | Stake APIs |
| `sponsor_links` | Critical | Medium | Users | Referral/network APIs |
| `placement_nodes`, `genealogy_closure` | Critical for binary | High | Network placement | Tree APIs |
| `leg_volumes` | High for binary | High | Commission engine | Binary reports |
| `commission_plans`, `commission_rules` | Critical | High | Admin config | Admin plan APIs |
| `commission_runs`, `commission_items` | Critical | Very High | MLM engine | Commission APIs |
| `income_ledger` | Critical | High | Commission engine | Income APIs |
| `rank_rules`, `rank_history` | High | High | MLM engine | Rank APIs |
| `notifications`, `delivery_attempts` | High | Medium | Queue/providers | Notification APIs |
| `report_jobs`, `report_exports` | Medium | Medium | Queue/storage | Report APIs |
| `kyc_profiles`, `risk_flags` | Critical if real money | High | KYC vendor | KYC/admin APIs |

## 3. MLM Engine Requirements

### Engine Principles

The MLM engine must be deterministic, idempotent, auditable, and replayable. Each calculation run must produce immutable commission items and ledger entries. Rules must be versioned so historical payouts can be explained even after plan changes.

### Required Commission Types

| Feature | Priority | Complexity | Dependencies | Tables Required | APIs Required |
|---|---|---:|---|---|---|
| Direct referral income | Critical | Medium | Sponsor links, staking | `commission_rules`, `commission_items`, `income_ledger` | `GET /income/referral`, admin rule APIs |
| Level income | High | High | Genealogy closure | `level_commission_rules`, `commission_items` | `GET /income/levels`, admin rule APIs |
| Binary income | High if business model needs it | Very High | Placement tree, leg volume | `placement_nodes`, `leg_volumes`, `binary_cycles`, `commission_items` | `GET /binary/status`, `POST /admin/binary/run` |
| Matching income | Medium/High | High | Binary/direct payout source | `matching_rules`, `commission_items` | `GET /income/matching` |
| Rank income | High | High | Rank engine | `rank_rules`, `rank_history`, `rank_bonus_items` | `GET /income/rank`, admin rank APIs |
| B1 ROI/staking income | Critical | High | Staking positions, caps | `staking_positions`, `roi_accruals`, `commission_items` | `GET /income/b1`, `POST /admin/roi/run` |
| Flush/carry-forward logic | Critical | High | Commission engine | `flush_records`, `carry_forward_balances` | `GET /income/flush`, admin reports |
| Caps and compliance limits | Critical | High | Package/rank/wallet | `earning_caps`, `cap_events` | Internal engine APIs |

### Engine Jobs

- `commission:daily-roi`
- `commission:direct-referral`
- `commission:binary-cycle`
- `commission:rank-qualification`
- `commission:flush-expiry`
- `ledger:settlement`
- `reports:commission-summary`

Each job needs:
- `job_runs` table
- idempotency key
- retry policy
- locked execution window
- run summary
- admin-visible status

## 4. Security Requirements

| Requirement | Priority | Complexity | Dependencies | Tables Required | APIs Required |
|---|---|---:|---|---|---|
| HttpOnly secure cookie sessions or hardened OAuth/JWT flow | Critical | Medium | Auth service | `user_sessions`, `refresh_tokens` | Auth APIs |
| MFA for users and mandatory MFA for admins | Critical | Medium | SMS/TOTP/email provider | `mfa_factors`, `mfa_challenges` | `/auth/mfa/*` |
| RBAC/permission system | Critical | Medium | Admin model | `roles`, `permissions`, `user_roles` | Admin RBAC APIs |
| Rate limiting | Critical | Medium | Redis/API gateway | `rate_limit_events` optional | Middleware |
| Request validation schemas | Critical | Medium | API framework | none | All APIs |
| CSRF, CORS, CSP, secure headers | Critical | Medium | Web framework/proxy | none | Middleware |
| Audit logs | Critical | Medium | Admin/auth | `audit_logs`, `security_events` | `GET /admin/audit-logs` |
| Secrets management | Critical | Medium | Cloud secret manager | none | deployment |
| Encryption at rest for sensitive fields | High | Medium | KMS | maybe `encrypted_fields_metadata` | internal |
| Vulnerability scanning and dependency policy | High | Medium | CI/CD | none | CI |
| Penetration test and third-party audit | Critical before launch | High | Stable release | findings tracker | none |

## 5. Payment Gateway Integration

If fiat/card/bank payments are required, integrate a regulated payment provider. Do not mix gateway balances directly with internal wallet balances; settle through ledger transactions.

| Feature | Priority | Complexity | Dependencies | Tables Required | APIs Required |
|---|---|---:|---|---|---|
| Payment provider abstraction | High | Medium | Provider choice | `payment_providers`, `payment_methods` | `GET /payment-methods` |
| Fiat deposit intent | High | High | Provider SDK | `payment_intents`, `payment_events` | `POST /payments/deposit-intent` |
| Payment webhooks | Critical | High | Public webhook endpoint | `payment_events`, `deposits` | `POST /webhooks/payments/:provider` |
| Refund/chargeback handling | Critical | High | Provider support | `refunds`, `chargebacks`, `risk_flags` | Admin payment APIs |
| Reconciliation | Critical | High | Reports, ledger | `reconciliation_runs`, `reconciliation_items` | `POST /admin/reconciliation/run` |

Recommended providers depend on operating country and compliance posture. Common options: Stripe, Checkout.com, Razorpay, Cashfree, PayPal, or bank transfer providers.

## 6. Blockchain Integration

The demo says BEP20 but does not actually monitor chain activity. Production must treat blockchain as an external settlement rail.

| Feature | Priority | Complexity | Dependencies | Tables Required | APIs Required |
|---|---|---:|---|---|---|
| Chain/provider configuration | Critical | Medium | RPC provider | `chains`, `token_contracts`, `rpc_providers` | Admin chain APIs |
| Deposit address generation | Critical | High | Custody model | `deposit_addresses` | `POST /deposits/address` |
| Blockchain indexer/watcher | Critical | Very High | RPC/WebSocket/indexer | `blockchain_transactions`, `deposit_events` | Internal worker |
| Confirmation policy | Critical | Medium | Watcher | `chain_confirmations` | Admin config |
| Tx hash replay prevention | Critical | Medium | Unique indexes | `blockchain_transactions` | Deposit processing |
| Hot/cold wallet management | Critical | Very High | Custody/KMS/HSM | `custody_wallets`, `signing_requests` | Admin custody APIs |
| Withdrawal signing/broadcast | Critical | Very High | HSM/MPC/provider | `payout_transactions`, `signing_requests` | `POST /admin/withdrawals/:id/broadcast` |
| Gas management | High | High | Chain treasury | `gas_wallets`, `gas_topups` | Admin gas APIs |
| Chain reconciliation | Critical | High | Indexer, ledger | `chain_reconciliation_runs` | Admin reconciliation APIs |

Preferred custody options:
- Fastest: use a regulated custodial provider.
- More control: MPC wallet provider.
- Highest responsibility: self-custody with HSM/KMS and strict operational controls.

## 7. Admin Features

| Feature | Priority | Complexity | Dependencies | Tables Required | APIs Required |
|---|---|---:|---|---|---|
| Admin RBAC | Critical | Medium | Security | RBAC tables | `GET/POST /admin/roles`, `/admin/users/:id/roles` |
| User management | Critical | Medium | Users/KYC | `users`, `audit_logs` | `GET /admin/users`, `PATCH /admin/users/:id` |
| Deposit approval/rejection | Critical | High | Deposit lifecycle | `deposits`, `audit_logs` | `POST /admin/deposits/:id/approve`, `POST /admin/deposits/:id/reject` |
| Withdrawal approval/rejection | Critical | High | Withdrawal lifecycle | `withdrawals`, `withdrawal_approvals` | withdrawal admin APIs |
| Commission run dashboard | Critical | High | MLM engine | `commission_runs`, `commission_items` | commission admin APIs |
| Plan/package management | High | Medium | Package module | `packages`, `package_versions` | package admin APIs |
| Rank/rule management | High | High | MLM engine | `rank_rules`, `commission_rules` | rank/rule admin APIs |
| Network tree viewer | High | High | Genealogy | `genealogy_closure`, `placement_nodes` | `GET /admin/network/tree` |
| Ledger explorer | Critical | High | Ledger | ledger tables | `GET /admin/ledger` |
| Reports and exports | High | Medium | Queue/storage | `report_jobs`, `report_exports` | report APIs |
| Audit/security center | Critical | Medium | Audit | `audit_logs`, `security_events` | audit APIs |
| Support desk | Medium | Medium | Support module | support tables | support APIs |
| System health dashboard | High | Medium | Observability | optional `system_events` | health APIs |

## 8. Mobile App Requirements

Recommended approach: build React Native or Flutter after backend API stabilization. A PWA can ship earlier, but do not call it a mobile app.

| Feature | Priority | Complexity | Dependencies | Tables Required | APIs Required |
|---|---|---:|---|---|---|
| Mobile auth with biometric unlock | High | Medium | Stable auth | `device_tokens`, sessions | Auth/device APIs |
| User dashboard | High | Medium | Dashboard API | none beyond core | `GET /mobile/dashboard` or shared API |
| Deposit/withdrawal flows | High | High | Ledger/blockchain | core finance tables | deposit/withdrawal APIs |
| Staking and package purchase | High | Medium | Package/staking | package/staking tables | package/stake APIs |
| Network tree and referral sharing | High | Medium | MLM network | genealogy tables | network APIs |
| Income reports | High | Medium | MLM engine | income tables | income APIs |
| Push notifications | High | Medium | FCM/APNs | `device_tokens`, notifications | `POST /devices`, notification APIs |
| Support tickets | Medium | Medium | Support | support tables | support APIs |
| Admin mobile app | Medium | High | RBAC/MFA | admin/security tables | restricted admin APIs |

## 9. AI Feature Requirements

AI should be added after permissioned data access and audit logging exist.

| Feature | Priority | Complexity | Dependencies | Tables Required | APIs Required |
|---|---|---:|---|---|---|
| User support assistant | Medium | Medium | Knowledge base, support policies | `ai_conversations`, `ai_messages` | `POST /ai/support-chat` |
| Admin analytics assistant | Medium | High | Reporting layer, RBAC | `ai_conversations`, `ai_tool_calls` | `POST /admin/ai/query` |
| Fraud/risk summaries | High later | High | Ledger, KYC, audit | `risk_flags`, `ai_insights` | `GET /admin/risk/insights` |
| Commission explanation assistant | Medium | High | MLM engine explainability | `commission_explanations` | `GET /income/:id/explanation` |
| Document/report generation | Medium | Medium | Report module | `report_jobs`, `ai_generated_reports` | report AI APIs |

AI safety requirements:
- Never allow AI to execute financial actions directly.
- All AI tool calls must be permission checked and logged.
- No sensitive data should be sent to model providers unless policy and contracts allow it.
- AI outputs must be labeled as advisory.

## 10. Development Phases

### Phase 0: Product and Compliance Definition

Target readiness: 0% to 5%  
Priority: Critical  
Complexity: Medium

Deliverables:
- Final MLM compensation plan document.
- Legal/compliance review for MLM, staking, token, wallet, and payout model.
- Jurisdiction list and restricted regions.
- Custody decision: custodial provider, MPC, or self-custody.
- Production architecture document.

Exit criteria:
- Approved compensation plan.
- Approved legal/compliance constraints.
- Technical architecture signed off.

### Phase 1: Platform Foundation

Target readiness: 5% to 20%  
Priority: Critical  
Complexity: High

Deliverables:
- PostgreSQL schema and migration system.
- API framework with route modules, validation, error handling.
- Auth/session service.
- RBAC.
- Audit logs.
- CI/CD, tests, environments.

Exit criteria:
- Users can register/login securely.
- Admin roles and permissions work.
- All admin actions write audit logs.
- Demo JSON storage is fully removed from production path.

### Phase 2: Ledger, Wallets, and Financial Core

Target readiness: 20% to 40%  
Priority: Critical  
Complexity: Very High

Deliverables:
- Wallet account model.
- Double-entry ledger.
- Decimal math.
- Balance reservations.
- Transaction locks and idempotency.
- Internal settlement service.
- Unit and property tests for ledger invariants.

Exit criteria:
- No negative balances.
- Concurrent transfer/withdrawal tests pass.
- Every balance is reproducible from ledger entries.

### Phase 3: Package, Staking, and MLM Engine

Target readiness: 40% to 60%  
Priority: Critical  
Complexity: Very High

Deliverables:
- Package/version system.
- Staking positions and events.
- Sponsor/genealogy model.
- Direct, B1, flush, global, referral rules.
- Optional binary/level/matching/rank engines if approved.
- Commission run dashboard and explainability.

Exit criteria:
- Commission runs are deterministic and idempotent.
- Every payout maps to a rule version and source activity.
- Admin can replay/explain a user's commission.

### Phase 4: Deposit, Withdrawal, and Blockchain Rails

Target readiness: 60% to 75%  
Priority: Critical  
Complexity: Very High

Deliverables:
- BEP20 deposit address generation.
- Chain watcher/indexer.
- Confirmation/replay prevention.
- Withdrawal approval and signing.
- Reconciliation.
- Custody operations.

Exit criteria:
- Deposits are credited only after valid confirmations.
- Withdrawals require approval and produce on-chain tx records.
- Chain balances reconcile with internal ledger.

### Phase 5: Admin, Reports, and Operations

Target readiness: 75% to 85%  
Priority: High  
Complexity: High

Deliverables:
- Full admin console.
- User/KYC/risk management.
- Deposit/withdrawal operations.
- Network tree viewer.
- Ledger explorer.
- Reports/export jobs.
- Support desk.
- Observability dashboards.

Exit criteria:
- Operations team can run the platform without database access.
- All financial/admin actions are auditable.
- Reports match ledger totals.

### Phase 6: Mobile and AI

Target readiness: 85% to 92%  
Priority: High/Medium  
Complexity: High

Deliverables:
- Mobile app MVP.
- Push notifications.
- User support assistant.
- Admin analytics assistant with read-only tools.

Exit criteria:
- Mobile app passes store/security review.
- AI cannot perform financial writes.
- AI access is logged and permission-scoped.

### Phase 7: Hardening and Launch

Target readiness: 92% to 100%  
Priority: Critical  
Complexity: High

Deliverables:
- Load testing.
- Security audit and penetration test.
- Disaster recovery drill.
- Backup/restore validation.
- Incident response runbooks.
- Production monitoring and alerts.
- Launch checklist sign-off.

Exit criteria:
- Critical/high security findings resolved.
- Recovery time/recovery point objectives tested.
- Production readiness review passed.

## Complete Implementation Checklist

### Product and Legal

- [ ] Finalize compensation plan.
- [ ] Define whether staking is investment, rewards, utility, or internal points.
- [ ] Define supported countries and restricted countries.
- [ ] Complete legal review for MLM and token rewards.
- [ ] Complete privacy policy, terms, risk disclosures.
- [ ] Decide KYC/AML thresholds.
- [ ] Choose custody and payment providers.

### Backend Foundation

- [ ] Select backend framework.
- [ ] Add migration system.
- [ ] Add PostgreSQL.
- [ ] Add Redis.
- [ ] Split routes/services/repositories.
- [ ] Add validation schemas.
- [ ] Add structured error handling.
- [ ] Add logging and request IDs.
- [ ] Add test framework and coverage gates.
- [ ] Add CI/CD.

### Auth and Security

- [ ] Replace localStorage bearer auth.
- [ ] Add secure sessions/refresh tokens.
- [ ] Add MFA.
- [ ] Add password reset.
- [ ] Add session revocation.
- [ ] Add RBAC.
- [ ] Add rate limiting.
- [ ] Add CSRF/CORS/CSP/security headers.
- [ ] Add audit logs.
- [ ] Add secrets manager.
- [ ] Add vulnerability scanning.

### Database and Ledger

- [ ] Create users/profile/RBAC tables.
- [ ] Create wallet accounts.
- [ ] Create double-entry ledger.
- [ ] Create balance snapshots.
- [ ] Create idempotency keys.
- [ ] Create deposits/withdrawals tables.
- [ ] Create staking/package tables.
- [ ] Create MLM genealogy tables.
- [ ] Create commission tables.
- [ ] Create rank tables.
- [ ] Create notification/report tables.
- [ ] Add all foreign keys and indexes.
- [ ] Add append-only protections.

### MLM Engine

- [ ] Implement sponsor links.
- [ ] Implement placement tree if binary is required.
- [ ] Implement direct referral commission.
- [ ] Implement B1 ROI.
- [ ] Implement direct business qualification.
- [ ] Implement global team records.
- [ ] Implement flush/carry-forward.
- [ ] Implement level income if required.
- [ ] Implement binary income if required.
- [ ] Implement matching income if required.
- [ ] Implement rank engine.
- [ ] Implement commission run idempotency.
- [ ] Implement commission explainability.
- [ ] Add engine tests for all boundary cases.

### Payments and Blockchain

- [ ] Choose BEP20 RPC/indexing provider.
- [ ] Create token/chain configuration.
- [ ] Generate deposit addresses.
- [ ] Build deposit watcher.
- [ ] Validate token contract, chain ID, recipient, amount, tx hash, confirmations.
- [ ] Add replay prevention.
- [ ] Implement withdrawal reservations.
- [ ] Implement admin approval/rejection.
- [ ] Implement signing/broadcast.
- [ ] Implement gas wallet management.
- [ ] Implement chain reconciliation.
- [ ] Add payment gateway if fiat is required.
- [ ] Add payment webhooks and reconciliation.

### Admin

- [ ] Build role-based admin console.
- [ ] User management.
- [ ] KYC/risk management.
- [ ] Deposit operations.
- [ ] Withdrawal operations.
- [ ] Package/rule management.
- [ ] Commission run management.
- [ ] Network tree viewer.
- [ ] Ledger explorer.
- [ ] Reports/export center.
- [ ] Audit/security center.
- [ ] Support desk.
- [ ] System health dashboard.

### Frontend Web

- [ ] Replace single-file `public/app.js`.
- [ ] Choose frontend framework or clean modular vanilla architecture.
- [ ] Build component library.
- [ ] Remove conflicting CSS overrides.
- [ ] Implement user dashboard.
- [ ] Implement wallet/deposit/withdrawal views.
- [ ] Implement staking/package views.
- [ ] Implement network/referral views.
- [ ] Implement income reports.
- [ ] Implement admin console.
- [ ] Add accessibility and responsive tests.

### Mobile

- [ ] Choose React Native or Flutter.
- [ ] Implement mobile auth.
- [ ] Add biometric unlock.
- [ ] Add push notifications.
- [ ] Implement dashboard.
- [ ] Implement deposits/withdrawals.
- [ ] Implement staking.
- [ ] Implement referral sharing.
- [ ] Implement income reports.
- [ ] Store submission/review.

### AI

- [ ] Define allowed AI use cases.
- [ ] Build knowledge base.
- [ ] Add permission-scoped AI tools.
- [ ] Add AI conversation storage.
- [ ] Add admin analytics assistant.
- [ ] Add support assistant.
- [ ] Add audit logs for AI tool calls.
- [ ] Add redaction and safety checks.

### Production Operations

- [ ] Docker/container setup.
- [ ] Environment-specific config.
- [ ] Database backups.
- [ ] Restore drills.
- [ ] Monitoring and alerting.
- [ ] Queue monitoring.
- [ ] Incident response runbook.
- [ ] Load testing.
- [ ] Penetration test.
- [ ] Security audit.
- [ ] Compliance review.
- [ ] Launch rollback plan.

## Production Readiness Plan: 0% to 100%

| Readiness | Milestone | Required Evidence |
|---:|---|---|
| 0% | Demo only | Current app runs locally with JSON storage |
| 5% | Product/legal defined | Approved MLM plan and compliance boundaries |
| 10% | Architecture approved | System design, ERD, API standards |
| 20% | Platform foundation | PostgreSQL, migrations, auth, RBAC, audit, CI |
| 30% | Ledger foundation | Double-entry ledger, wallet accounts, invariant tests |
| 40% | Financial core stable | Deposits/withdrawals modeled, reservations, idempotency |
| 50% | MLM core stable | Sponsor tree, direct/B1/referral/flush calculations |
| 60% | Advanced MLM ready | Binary/level/matching/rank if required, explainable runs |
| 70% | Blockchain integrated | BEP20 watcher, confirmations, replay prevention |
| 75% | Withdrawals operational | Approval, signing, broadcast, reconciliation |
| 80% | Admin operations ready | Full admin console, reports, audit, support workflows |
| 85% | Web UX production ready | Modular frontend, tested responsive UI |
| 90% | Mobile/AI ready | Mobile MVP, push, permissioned AI assistants |
| 95% | Security hardened | Pentest, dependency scan, rate limits, MFA, monitoring |
| 98% | Operational readiness | Backups, restore drill, incident runbooks, load test |
| 100% | Launch ready | Final compliance, security, finance, and CTO sign-off |

## CTO Recommendation

Treat the existing app as a prototype and test fixture, not as the production codebase foundation. Reuse the validated business cases and smoke scenarios, but rebuild the production platform around a ledger-first architecture. The highest-risk areas are financial correctness, MLM explainability, blockchain custody, and admin security; those must be solved before UI expansion, mobile apps, or AI features.

