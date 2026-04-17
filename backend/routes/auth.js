const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { validateRegister, validateLogin } = require('../middleware/validate');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

const authRateLimit = rateLimit({ windowMs: 60000, max: 20, message: 'Cok fazla giris denemesi. Lutfen biraz bekleyin.' });

router.post('/register', authRateLimit, validateRegister, (req, res) => {
    const { name, email, password, role, company_name, phone } = req.body;
    try {
        const hashedPassword = bcrypt.hashSync(password, 10);
        const result = db.prepare(`
            INSERT INTO users (name, email, password, role, company_name, phone)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(name.trim(), email.trim().toLowerCase(), hashedPassword, role, company_name || '', phone || '');
        res.json({ success: true, userId: result.lastInsertRowid });
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Bu e-posta adresi zaten kayitli.' });
        }
        res.status(400).json({ error: 'Kullanici kaydi basarisiz.' });
    }
});

router.post('/login', authRateLimit, validateLogin, (req, res) => {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());

    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'Email veya sifre hatali.' });
    }

    if (user.status === 'blocked') {
        return res.status(403).json({ error: 'Hesabiniz bloke edilmistir. Lutfen yonetici ile iletisime gecin.' });
    }

    req.session.userId = user.id;
    req.session.name = user.name;
    req.session.role = user.role;
    req.session.companyName = user.company_name;

    res.json({
        success: true,
        user: {
            id: user.id,
            name: user.name,
            role: user.role,
            companyName: user.company_name
        }
    });
});

router.get('/me', (req, res) => {
    if (req.session.userId) {
        res.json({
            authenticated: true,
            user: {
                id: req.session.userId,
                name: req.session.name,
                role: req.session.role,
                companyName: req.session.companyName
            }
        });
    } else {
        res.json({ authenticated: false });
    }
});

router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout session destroy error:', err);
            return res.status(500).json({ error: 'Oturum kapatılamadı.' });
        }
        res.clearCookie('connect.sid');
        res.json({ success: true });
    });
});

router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4321';
        res.clearCookie('connect.sid');
        res.redirect(`${frontendUrl}/login`);
    });
});

module.exports = router;
