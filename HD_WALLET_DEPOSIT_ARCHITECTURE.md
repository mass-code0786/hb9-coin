# HB9 HD Wallet Deposit Architecture

## Recommended Chain Architecture

- Use one master HD wallet per environment and per chain family.
- For USDT BEP20, use BSC/EVM address derivation and monitor `Transfer` events for the USDT contract.
- The web app should not hold the seed phrase. Use an isolated wallet service or HSM/KMS-backed signer that exposes address derivation by index from an xpub or controlled derivation service.
- The app stores only assigned deposit addresses, HD indexes, observed transactions, and credited deposit records.
- The blockchain watcher is a separate worker process. It scans assigned addresses, records incoming transfers, waits for confirmations, and calls the idempotent credit path.

## Tables Required

### users

Existing user table. Keep user identity, status, sponsor, and withdrawal wallet address separate from deposit addresses.

### deposit_addresses

```sql
id              uuid primary key
user_id         uuid not null references users(id)
chain           text not null
address         text not null
hd_index        bigint not null
created_at      timestamptz not null

unique(user_id, chain)
unique(chain, address)
unique(chain, hd_index)
```

### deposits

```sql
id                       uuid primary key
user_id                  uuid not null references users(id)
deposit_address_id        uuid references deposit_addresses(id)
chain                    text not null
network                  text not null
tx_hash                  text
amount                   numeric(30, 8) not null
status                   text not null check (status in ('pending', 'confirmed', 'credited'))
confirmations            integer not null default 0
required_confirmations   integer not null
created_at               timestamptz not null
credited_at              timestamptz

unique(chain, tx_hash)
```

### blockchain_transactions

```sql
id                       uuid primary key
chain                    text not null
tx_hash                  text not null
to_address               text not null
user_id                  uuid not null references users(id)
deposit_address_id        uuid not null references deposit_addresses(id)
amount                   numeric(30, 8) not null
block_number             bigint
confirmations            integer not null default 0
required_confirmations   integer not null
status                   text not null check (status in ('pending', 'confirmed', 'credited'))
created_at               timestamptz not null
updated_at               timestamptz not null
credited_at              timestamptz

unique(chain, tx_hash)
```

### sweep_transactions

```sql
id                       uuid primary key
deposit_id               uuid not null references deposits(id)
user_id                  uuid not null references users(id)
chain                    text not null
deposit_tx_hash           text not null
sweep_tx_hash             text not null
credited_amount           numeric(30, 8) not null
treasury_destination      text not null
status                   text not null check (status in ('queued', 'broadcasted', 'confirmed', 'failed'))
gas_asset                 text not null
fee_paid_by               text not null
created_at               timestamptz not null
broadcast_at             timestamptz
confirmed_at             timestamptz

unique(chain, deposit_tx_hash)
unique(chain, sweep_tx_hash)
```

### audit_logs

```sql
id           uuid primary key
type         text not null
actor_id     uuid
details      jsonb not null
created_at   timestamptz not null
```

## APIs Required

- `GET /api/deposit-address?chain=BSC`
  - Returns the user's permanent deposit address.
  - If no address exists, creates exactly one address for `(userId, chain)`.

- `GET /api/admin/deposits/search?q=...&userId=...`
  - Searches deposits by user, assigned address, and transaction hash.

- `POST /api/admin/blockchain/transactions`
  - Internal watcher ingestion endpoint in the demo scaffold.
  - Production should protect this with service authentication, mTLS, or private network access.
  - Body includes `chain`, `txHash`, `toAddress`, `amount`, `confirmations`, and `blockNumber`.

- `POST /api/admin/sweeps/run`
  - Internal sweep job trigger in the demo scaffold.
  - Production should run this as a worker, not as a public admin action.

- `GET /api/admin/sweeps?q=...`
  - Searches treasury transfers by deposit tx, sweep tx, user, or treasury destination.

Production watcher internals:

- `watcher.scanAssignedAddresses(chain)`
- `watcher.recordIncomingTransfer(event)`
- `watcher.updateConfirmations(txHash)`
- `depositCreditService.creditConfirmedDeposit(txHash)`

## HD Derivation Strategy

For EVM chains such as BSC:

```text
m / 44' / 60' / 0' / 0 / hdIndex
```

Rules:

- Allocate `hdIndex` monotonically per chain.
- Store `hdIndex` once in `deposit_addresses`.
- Never rotate a user's deposit address unless a separate migration process is built.
- Never reuse an index for a different user.
- Keep the seed phrase offline from the web app. The web app may store an xpub only if derivation can be done without private-key exposure.

The application derives permanent EVM deposit addresses from `HD_WALLET_XPUB` using BIP-32 non-hardened child indexes. Configure the xpub at `m/44'/60'/0'/0` so child index `n` maps to the expected BSC address. A missing or invalid xpub disables address allocation; there is no development-address fallback.

## Security Considerations

- Enforce `unique(chain, tx_hash)` for replay protection.
- Enforce `unique(user_id, chain)` so each user has one active deposit address per chain.
- Enforce `unique(chain, address)` and `unique(chain, hd_index)`.
- Make crediting idempotent: a confirmed transaction can transition to credited once.
- Store all watcher detections and credit actions in audit logs.
- Do not credit until required confirmations are met.
- Use token contract event logs for USDT BEP20, not native BNB transfer balance deltas.
- Validate token contract address, decimals, chain ID, destination address, and finality depth.
- Handle reorgs by using enough confirmations and by reconciling credited records against canonical blocks.
- Keep private keys out of the app database and application logs.
- Run sweeps from deposit addresses to treasury/cold wallets in a separate controlled signing service.
- Configure `TREASURY_WALLET_BSC` or `settings.treasuryWalletBSC` and validate it before any sweep.
- Deposit addresses need native gas, such as BNB on BSC, to sweep BEP20 tokens. Production should fund gas just-in-time or use a controlled gas station wallet.
- Sweeps must be idempotent per deposit: one credited deposit can create one sweep transaction.

## Example Deposit Flow

1. User registers.
2. System creates or returns the permanent BSC deposit address for that user.
3. User sends USDT BEP20 to the assigned address.
4. Watcher detects the USDT `Transfer` event to that address.
5. Watcher inserts `blockchain_transactions` and `deposits` with `pending`.
6. Watcher updates confirmations as new blocks arrive.
7. Once confirmations reach the required threshold, deposit status becomes `credited`.
8. The credited deposit amount appears in the user's USDT wallet balance.
9. The sweep worker broadcasts a token transfer from the user deposit address to the treasury wallet.
10. The sweep record stores `deposit_tx_hash`, `sweep_tx_hash`, `credited_amount`, and `treasury_destination`.
11. If the watcher sees the same `txHash` again, the unique key/idempotent logic prevents a second credit and a second sweep.

## Sweep Flow

1. Select credited deposits without an existing sweep transaction.
2. Validate treasury wallet configuration for the deposit chain.
3. Ensure the deposit address has enough native gas for the token transfer.
4. Broadcast USDT transfer from the deposit address to treasury.
5. Store `sweep_transactions` with `broadcasted` status and the sweep tx hash.
6. Update the deposit with `sweepTxHash`, `treasuryDestination`, and `sweepStatus`.
7. Confirm the sweep later from chain events and mark it `confirmed`.
