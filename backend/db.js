const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'fiyatal.db');
const db = new Database(dbPath);

// Create tables
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    password      TEXT NOT NULL,
    role          TEXT NOT NULL,
    phone         TEXT,
    company_name  TEXT,
    status        TEXT DEFAULT 'active',
    is_verified   INTEGER DEFAULT 0,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    buyer_id      INTEGER REFERENCES users(id),
    name          TEXT NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS requests (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    buyer_id            INTEGER REFERENCES users(id),
    project_id          INTEGER REFERENCES projects(id),
    title               TEXT NOT NULL,
    status              TEXT DEFAULT 'active',
    photo_required      INTEGER DEFAULT 0,
    location_required   INTEGER DEFAULT 0,
    shipping_note       TEXT,
    delivery_address    TEXT,
    delivery_lat        REAL,
    delivery_lng        REAL,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at          DATETIME
);

CREATE TABLE IF NOT EXISTS request_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id   INTEGER REFERENCES requests(id),
    item_order   INTEGER NOT NULL,
    properties   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS offers (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id        INTEGER REFERENCES requests(id),
    seller_id         INTEGER REFERENCES users(id),
    shipping_included INTEGER,
    seller_lat        REAL,
    seller_lng        REAL,
    seller_address    TEXT,
    notes             TEXT,
    status            TEXT DEFAULT 'pending',
    submitted_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS offer_items (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id          INTEGER REFERENCES offers(id),
    request_item_id   INTEGER REFERENCES request_items(id),
    unit_price        REAL,
    photo_url         TEXT
);

CREATE TABLE IF NOT EXISTS smtp_config (
    id            INTEGER PRIMARY KEY CHECK (id = 1), -- Single row config
    host          TEXT,
    port          INTEGER,
    user          TEXT,
    pass          TEXT,
    secure        INTEGER DEFAULT 0,
    from_name     TEXT,
    from_email    TEXT
);

CREATE TABLE IF NOT EXISTS seller_interests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id     INTEGER REFERENCES users(id),
    keyword       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invitations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id    INTEGER REFERENCES requests(id),
    email         TEXT NOT NULL,
    token         TEXT UNIQUE NOT NULL,
    status        TEXT DEFAULT 'pending',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS seller_ratings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    buyer_id      INTEGER REFERENCES users(id),
    seller_id     INTEGER REFERENCES users(id),
    offer_id      INTEGER REFERENCES offers(id),
    rating        INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
    comment       TEXT,
    is_private    INTEGER DEFAULT 0,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS request_questions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id    INTEGER REFERENCES requests(id),
    seller_id     INTEGER REFERENCES users(id),
    question      TEXT NOT NULL,
    answer        TEXT,
    request_item_id INTEGER REFERENCES request_items(id),
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    answered_at   DATETIME
);

CREATE TABLE IF NOT EXISTS notifications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER REFERENCES users(id),
    title         TEXT NOT NULL,
    message       TEXT NOT NULL,
    link          TEXT,
    is_read       INTEGER DEFAULT 0,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id      INTEGER REFERENCES offers(id),
    sender_id     INTEGER REFERENCES users(id),
    message       TEXT NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_assets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER REFERENCES users(id),
    type          TEXT NOT NULL, -- 'file' or 'link'
    name          TEXT NOT NULL,
    file_path     TEXT,
    url           TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS request_attachments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id    INTEGER REFERENCES requests(id),
    asset_id      INTEGER REFERENCES user_assets(id),
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS offer_attachments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id      INTEGER REFERENCES offers(id),
    asset_id      INTEGER REFERENCES user_assets(id),
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS offer_analyses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id      INTEGER REFERENCES offers(id),
    analysis_text TEXT NOT NULL,
    score         INTEGER,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

// Handle Migration: Add project_id to requests if it doesn't exist
try {
    const tableInfo = db.prepare("PRAGMA table_info(requests)").all();
    if (!tableInfo.find(c => c.name === 'project_id')) {
        db.exec("ALTER TABLE requests ADD COLUMN project_id INTEGER REFERENCES projects(id)");
    }
    if (!tableInfo.find(c => c.name === 'expires_at')) {
        db.exec("ALTER TABLE requests ADD COLUMN expires_at DATETIME");
    }
} catch (err) {
    console.error("Migration error (project_id):", err);
}

try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    if (!tableInfo.find(c => c.name === 'is_verified')) {
        db.exec("ALTER TABLE users ADD COLUMN is_verified INTEGER DEFAULT 0");
    }
} catch (err) {
    console.error("Migration error (is_verified):", err);
}

try {
    const tableInfo = db.prepare("PRAGMA table_info(request_questions)").all();
    if (!tableInfo.find(c => c.name === 'request_item_id')) {
        db.exec("ALTER TABLE request_questions ADD COLUMN request_item_id INTEGER REFERENCES request_items(id)");
    }
} catch (err) {
    console.error("Migration error (request_item_id):", err);
}

// Seed Admin User
const adminEmail = 'admin@fiyatal.com';
const existingAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);

if (!existingAdmin) {
    const hashedPassword = bcrypt.hashSync('Admin1234!', 10);
    db.prepare(`
        INSERT INTO users (name, email, password, role, company_name, status)
        VALUES ('Admin', ?, ?, 'admin', 'FiyatAl Sistem', 'active')
    `).run(adminEmail, hashedPassword);
    console.log('Admin user seeded successfully.');
}

// Seed Placeholder SMTP Config
const existingSmtp = db.prepare('SELECT id FROM smtp_config WHERE id = 1').get();
if (!existingSmtp) {
    db.prepare(`
        INSERT INTO smtp_config (id, host, port, user, pass, secure, from_name, from_email)
        VALUES (1, 'smtp.example.com', 587, 'user@example.com', 'password', 0, 'FiyatAl B2B', 'no-reply@fiyatal.com')
    `).run();
    console.log('Placeholder SMTP config seeded.');
}

module.exports = db;

