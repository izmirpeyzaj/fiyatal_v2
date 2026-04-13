const Database = require('better-sqlite3');
const db = new Database('fiyatal.db');
const users = db.prepare('SELECT name, email, role FROM users').all();
console.log(JSON.stringify(users, null, 2));
