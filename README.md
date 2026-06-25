# HB9 Staking — local demo

Run with Node.js 18+:

```powershell
Copy-Item .env.example .env
npm run dev
```

Open `http://localhost:3000`.

Demo accounts: `admin@hb9.local` / `Admin@123`, `alice@hb9.local` / `Demo@123`, and `bob@hb9.local` / `Demo@123`.

Run the isolated end-to-end smoke test:

```powershell
npm.cmd run smoke
```

For daily demo activity, use **Admin Panel → Overview → Run Daily Income**. Use **Reset Demo Data** only in local/demo mode to restore the original seed state.

This demo intentionally uses mock deposits and admin approval. It does not generate wallet addresses or monitor BEP20 transactions.

## Client demo presentation

Open the landing page first and use **Presentation Mode** to hide local-demo and technical helper text. The landing page introduces HB9 Coin, the USDT BEP20 flow, permanent HB9 staking, HB9 B1 Income, HB9 Global Team Paid/Unpaid, and Flush Income reporting.

### Demo credentials

- Admin: `admin@hb9.local` / `Admin@123`
- User: `alice@hb9.local` / `Demo@123`

### Business rules to show

- A USDT BEP20 mock deposit can be converted to HB9 Coin and staked permanently; there is no unstake option.
- Daily HB9 B1 Income uses the admin-configured 1–4% rate.
- Required direct business is 2X active stake by default.
- Global Team values are tracked as Paid or Unpaid; Flush Income is transparent and not withdrawable.

### Case testing

- **Case A:** Create a $100 stake with no direct business, run Daily Income, and show $0 B1 with Flush Income and Global Team Unpaid.
- **Case B:** Create a $100 stake, add $200 direct business in Admin → Users, then run Daily Income to show credited B1, Paid Global Team, and the extra Flush value.
- **Case C:** Use a user without a deposit, run Daily Income, and show activity-only Global Team with no B1 or Flush.

### Admin controls

Admin → Overview provides **Run Daily Income** and local-only **Reset Demo Data**. Admin → Users provides the audited manual direct-business control.

### Smoke test

```powershell
npm.cmd run smoke
```
