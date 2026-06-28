const { readDB, writeDB, repairBnbConversionPrecision, resolveDataFile } = require('../server');

const db = readDB();
const result = repairBnbConversionPrecision(db);
if (result.corrected > 0) writeDB(db);

console.log(JSON.stringify({
  dataFile: resolveDataFile(),
  corrected: result.corrected,
  repaired: result.repaired
}, null, 2));
