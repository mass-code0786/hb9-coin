# HB9 Staking Security Checklist

## Authentication

- [x] Passwords use Node `scrypt` with a unique random salt.
- [x] Login rejects blocked accounts and uses random bearer sessions.
- [ ] Replace in-memory sessions with secure, expiring, HttpOnly cookie sessions in production.
- [ ] Add password reset, MFA, session revocation, and audit logs.

## Authorization and admin permissions

- [x] Server-side role checks gate every `/api/admin/*` route.
- [x] Only administrators can approve deposits, alter settings, or block accounts.
- [ ] Use granular permissions and record every privileged action.

## Deposit logic

- [x] Local demo has mock deposits only; deposits are pending until admin approval.
- [x] Approval creates the stake and direct-business record exactly once.
- [ ] Before production, verify BEP20 transaction hash, token contract, chain ID, confirmations, recipient, amount and replay prevention.

## Withdrawal logic

- [x] Only credited B1 Income is considered for withdrawal; Flush and Global Unpaid are excluded.
- [x] Minimum and fee are server-side settings; requests are manual approval.
- [ ] Add address validation, withdrawal approval workflow, 2FA, velocity limits, reconciliation and on-chain transaction tracking.

## B1, 2X business, Global Team, and Flush calculation

- [x] B1 is calculated server-side, bounded by 1–4% admin ROI, and written to immutable ledger entries.
- [x] Required direct business is stake × configurable multiplier (default 2X).
- [x] Ineligible B1 becomes Flush; eligible users receive B1 and Global Team extra becomes Flush.
- [x] Global Team daily engagement records are made for every registered user, including non-investors, with paid/unpaid values persisted.
- [ ] Run income generation in a durable scheduled worker with database transaction locks and an idempotency key `(user_id, income_date, type)`.

## API security and rate limiting

- [ ] Add HTTPS, CORS allowlist, CSP, secure headers, CSRF protection for cookie auth, input schemas, request body limits, and structured logging.
- [ ] Rate-limit login, registration, deposits, withdrawal requests, and all admin APIs.

## Secrets and database permissions

- [x] `.env.example` documents configuration without secrets.
- [ ] Use a managed secret store and rotate session/database/provider keys.
- [ ] Replace JSON demo storage with PostgreSQL; use a least-privilege application role and a separate migration role.

## Ledger consistency and race conditions

- [x] Income ledger entries have an `immutable` marker and no delete/update API.
- [ ] Enforce append-only records in the database using permissions/triggers; use decimal currency columns, not JavaScript floating-point.
- [ ] Use database transactions and row locks for deposit approval, daily income creation, and withdrawal reservation to prevent concurrent double-credit/double-withdrawal.

## Required test cases before production

- [ ] Auth: invalid credentials, blocked account, expired/revoked session, role escalation attempts.
- [ ] Deposits: duplicate transaction, changed amount, insufficient confirmations, simultaneous approvals.
- [ ] Income: 1%, 4%, exact 2X boundary, below 2X, multiple stakes, final lock day, repeated daily run.
- [ ] Global Team: non-investor daily record, 5–7% extra validation, paid/unpaid transitions.
- [ ] Withdrawal: Flush/Unpaid exclusion, fee/minimum, simultaneous requests, approval/rejection and reconciliation.
