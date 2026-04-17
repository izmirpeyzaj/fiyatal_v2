const express = require('express');
const cors = require('cors');
const session = require('express-session');
const path = require('path');
const cron = require('node-cron');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('./db');
const emailService = require('./emailService');
const notificationService = require('./notificationService');
const { errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth');
const buyerRoutes = require('./routes/buyer');
const sellerRoutes = require('./routes/seller');
const adminRoutes = require('./routes/admin');
const sharedRoutes = require('./routes/shared');

const PORT = process.env.BACKEND_PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:4321';
const NODE_ENV = process.env.NODE_ENV || 'development';

const app = express();

app.use(cors({
    origin: [FRONTEND_URL, 'http://localhost:3000', 'http://localhost:4321'],
    credentials: true
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback_dev_secret_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

app.use('/api/auth', authRoutes);
app.use('/api/buyer', buyerRoutes);
app.use('/api/seller', sellerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', sharedRoutes);

app.use((req, res, next) => {
    console.warn(`[404 NOT FOUND] ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: 'Rota bulunamadi: ' + req.originalUrl });
});

app.use(errorHandler);

cron.schedule('0 * * * *', () => {
    try {
        console.log('[CRON] Checking for expired requests...');
        const now = new Date().toISOString();
        const expired = db.prepare(`
            SELECT id, buyer_id FROM requests
            WHERE status = 'open' AND expires_at < ?
        `).all(now);

        for (const req of expired) {
            db.prepare("UPDATE requests SET status = 'closed' WHERE id = ?").run(req.id);
            notificationService.createNotification(
                req.buyer_id,
                'Talep Suresi Doldu',
                `#${req.id} numarali talebinizin suresi doldugu icin otomatik olarak kapatildi.`,
                `/buyer/requests/${req.id}/offers`,
                true
            );
        }
        if (expired.length > 0) {
            console.log(`[CRON] Closed ${expired.length} expired requests.`);
        }
    } catch (err) {
        console.error('[CRON] Error closing expired requests:', err.message);
    }
});

cron.schedule('0 0 * * *', async () => {
    try {
        console.log('[CRON] Generating daily summaries...');
        const users = db.prepare("SELECT id, name, email FROM users WHERE role IN ('buyer', 'seller') AND status = 'active'").all();
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        for (const user of users) {
            const dailyNotis = db.prepare(`
                SELECT title, message FROM notifications
                WHERE user_id = ? AND created_at > ?
            `).all(user.id, yesterday);

            if (dailyNotis.length > 0) {
                await emailService.sendDailySummary(user.email, user.name, dailyNotis);
            }
        }
    } catch (err) {
        console.error('[CRON] Error sending daily summaries:', err.message);
    }
});

app.listen(PORT, () => {
    console.log(`Backend server running at http://localhost:${PORT} [${NODE_ENV}]`);
});
