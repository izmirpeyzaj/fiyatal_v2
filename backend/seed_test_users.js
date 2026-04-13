const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const db = new Database('fiyatal.db');

const testUsers = [
    { name: 'Test Alıcı', email: 'buyer@test.com', role: 'buyer', password: 'Buyer1234!', company: 'Test Alıcı A.Ş.' },
    { name: 'Test Satıcı', email: 'seller@test.com', role: 'seller', password: 'Seller1234!', company: 'Test Satıcı Ltd.' }
];

testUsers.forEach(user => {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(user.email);
    if (!existing) {
        const hash = bcrypt.hashSync(user.password, 10);
        db.prepare(`
            INSERT INTO users (name, email, password, role, company_name, status)
            VALUES (?, ?, ?, ?, ?, 'active')
        `).run(user.name, user.email, hash, user.role, user.company);
        console.log(`Created test user: ${user.email} (${user.role}) - Password: ${user.password}`);
    } else {
        console.log(`User ${user.email} already exists.`);
    }
});
