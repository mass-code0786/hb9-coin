const fs = require('fs');
const path = require('path');
const { repairBep20RawUnitAmounts } = require('../server');

const dataFile = path.resolve(process.env.DATA_FILE || './data/db.json');
if (!fs.existsSync(dataFile)) throw Error(`Database file not found: ${dataFile}`);
const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const result = repairBep20RawUnitAmounts(db);
if (!result.corrected) {
  console.log('No legacy BEP20 raw-unit amounts found.');
  process.exit(0);
}
const backup = `${dataFile}.before-bep20-unit-repair-${Date.now()}.bak`;
fs.copyFileSync(dataFile, backup);
fs.writeFileSync(dataFile, JSON.stringify(db, null, 2));
console.log(`Repaired BEP20 amounts. Backup: ${backup}`);
