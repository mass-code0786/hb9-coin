const fs=require('fs'); const path=require('path'); const source=path.join(__dirname,'..','server.js');
// Running the server once automatically initializes the local demo database.
console.log('Start the app with npm run dev; it initializes data/db.json if needed.');
