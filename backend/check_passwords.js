const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const db = new Database('fiyatal.db');

const users = db.prepare('SELECT email, password FROM users').all();
const testPasswords = ['Pass1234!', 'Test1234!', '123456', 'Admin1234!'];

users.forEach(user => {
    testPasswords.forEach(pass => {
        if (bcrypt.compareSync(pass, user.password)) {
            console.log(`Match found: User ${user.email} -> Password: ${pass}`);
        }
    });
});
