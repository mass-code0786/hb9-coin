try { require('dotenv').config(); } catch (_) { /* .env is optional */ }
const fs = require('fs');
const path = require('path');
const { migrateUnsafeDepositAddresses } = require('../server');

const dataFile = path.resolve(process.env.DATA_FILE || './data/db.json');
if (!fs.existsSync(dataFile)) throw Error(`Database file not found: ${dataFile}`);

const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const backup = `${dataFile}.before-deposit-address-safety-${Date.now()}.bak`;
fs.copyFileSync(dataFile, backup);

const summary = migrateUnsafeDepositAddresses(db);
fs.writeFileSync(dataFile, JSON.stringify(db, null, 2));

console.log('DEPOSIT_ADDRESS_SAFETY_MIGRATION_COMPLETE', JSON.stringify({ ...summary, backup }));
