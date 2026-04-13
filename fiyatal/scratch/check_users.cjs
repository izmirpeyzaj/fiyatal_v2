const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'backend', 'fiyatal.db');
const db = new Database(dbPath);

const users = db.prepare('SELECT name, email, role FROM users').all();
console.log(JSON.stringify(users, null, 2));
