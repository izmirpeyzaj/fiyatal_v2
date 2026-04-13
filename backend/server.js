const express = require('express');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./db');
const emailService = require('./emailService');
const ExcelJS = require('exceljs');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const aiService = require('./aiService');
const notificationService = require('./notificationService');
const cron = require('node-cron');
require('dotenv').config();

const PORT = 3001;
const app = express();

// Multer Storage Configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './public/uploads/attachments';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

app.use(cors({
    origin: ['http://localhost:3000', 'http://localhost:4321'], // Astro dev server ports
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: 'fiyatal_secret_key_2026',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true if using HTTPS
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Auth Middleware
const requireAuth = (req, res, next) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Yetkisiz erişim.' });
    }
    next();
};

const requireRole = (role) => (req, res, next) => {
    if (req.session.role !== role) {
        return res.status(403).json({ error: 'Bu işlem için yetkiniz yok.' });
    }
    next();
};

app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// --- AUTO-CLOSURE JOB ---
// Runs every hour to close expired requests
cron.schedule('0 * * * *', () => {
    console.log('Checking for expired requests...');
    const now = new Date().toISOString();
    const expired = db.prepare(`
        SELECT id, buyer_id FROM requests 
        WHERE status = 'open' AND expires_at < ?
    `).all(now);

    for (const req of expired) {
        db.prepare("UPDATE requests SET status = 'closed' WHERE id = ?").run(req.id);
        notificationService.createNotification(
            req.buyer_id,
            'Talep Süresi Doldu',
            `#${req.id} numaralı talebinizin süresi dolduğu için otomatik olarak kapatıldı.`,
            `/buyer/requests/${req.id}/offers`,
            true
        );
    }
});

// --- DAILY SUMMARY JOB ---
// Runs at midnight (00:00) to send daily summaries to all users
cron.schedule('0 0 * * *', async () => {
    console.log('Generating daily summaries...');
    const users = db.prepare("SELECT id, name, email FROM users WHERE role IN ('buyer', 'seller')").all();
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
});

// Testing endpoint for daily summary
app.post('/api/admin/debug/daily-summary', requireAuth, requireRole('admin'), async (req, res) => {
    const users = db.prepare("SELECT id, name, email FROM users WHERE role IN ('buyer', 'seller')").all();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let sentCount = 0;

    for (const user of users) {
        const dailyNotis = db.prepare(`
            SELECT title, message FROM notifications 
            WHERE user_id = ? AND created_at > ?
        `).all(user.id, yesterday);

        if (dailyNotis.length > 0) {
            await emailService.sendDailySummary(user.email, user.name, dailyNotis);
            sentCount++;
        }
    }
    res.json({ success: true, sentCount });
});

app.post('/api/upload', requireAuth, upload.single('photo'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Dosya yüklenemedi.' });
    }
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ success: true, url: fileUrl });
});

// --- AUTH ROUTES ---

app.post('/api/auth/register', (req, res) => {
    const { name, email, password, role, company_name, phone } = req.body;
    try {
        const hashedPassword = bcrypt.hashSync(password, 10);
        const result = db.prepare(`
            INSERT INTO users (name, email, password, role, company_name, phone)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(name, email, hashedPassword, role, company_name, phone);
        res.json({ success: true, userId: result.lastInsertRowid });
    } catch (err) {
        res.status(400).json({ error: 'Kullanıcı kaydı başarısız. Email kullanımda olabilir.' });
    }
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'Email veya şifre hatalı.' });
    }

    if (user.status === 'blocked') {
        return res.status(403).json({ error: 'Hesabınız bloke edilmiştir. Lütfen yönetici ile iletişime geçin.' });
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

app.get('/api/auth/me', (req, res) => {
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

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('http://localhost:4321/login');
});

// --- BUYER ROUTES ---

app.post('/api/buyer/requests', requireAuth, requireRole('buyer'), async (req, res) => {
    const { title, items, photo_required, location_required, shipping_note, delivery_address, delivery_lat, delivery_lng, expires_at, asset_ids } = req.body;
    
    const transaction = db.transaction(() => {
        // 1. Create a Project for this upload
        const projectResult = db.prepare('INSERT INTO projects (buyer_id, name) VALUES (?, ?)').run(req.session.userId, title);
        const projectId = projectResult.lastInsertRowid;

        // 2. Create the Request
        const reqResult = db.prepare(`
            INSERT INTO requests (buyer_id, project_id, title, photo_required, location_required, shipping_note, delivery_address, delivery_lat, delivery_lng, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(req.session.userId, projectId, title, photo_required ? 1 : 0, location_required ? 1 : 0, shipping_note, delivery_address, delivery_lat, delivery_lng, expires_at || null);

        const requestId = reqResult.lastInsertRowid;
        
        // 3. Insert Items
        const insertItem = db.prepare('INSERT INTO request_items (request_id, item_order, properties) VALUES (?, ?, ?)');
        items.forEach((item, index) => {
            insertItem.run(requestId, index + 1, JSON.stringify(item));
        });

        // 4. Add Attachments from Asset Library
        if (asset_ids && Array.isArray(asset_ids)) {
            const attachStmt = db.prepare('INSERT INTO request_attachments (request_id, asset_id) VALUES (?, ?)');
            asset_ids.forEach(assetId => {
                attachStmt.run(requestId, assetId);
            });
        }

        return requestId;
    });

    try {
        const requestId = transaction();

        // --- NOTIFICATIONS (Post-Transaction) ---
        const notifiedSellers = new Set();
        
        const normalizeStr = (str) => {
            if (!str) return '';
            return str.toLowerCase()
                .replace(/ı/g, 'i')
                .replace(/ğ/g, 'g')
                .replace(/ü/g, 'u')
                .replace(/ş/g, 's')
                .replace(/ö/g, 'o')
                .replace(/ç/g, 'c')
                .replace(/i̇/g, 'i')
                .trim();
        };

        const fullRequestText = normalizeStr(title + ' ' + JSON.stringify(items));

        // 1. Notify Sellers by Keywords
        const sellersByInterests = db.prepare('SELECT DISTINCT u.id, u.email, u.name, si.keyword FROM seller_interests si JOIN users u ON si.seller_id = u.id').all();
        sellersByInterests.forEach(s => {
            if (notifiedSellers.has(s.id)) return;
            if (fullRequestText.includes(normalizeStr(s.keyword))) {
                emailService.notifySellerOfMatch(s.email, s.name, title);
                notifiedSellers.add(s.id);
            }
        });

        // 2. Notify Sellers who quoted on similar items in the past
        items.forEach(item => {
            let desc = '';
            const p = item; 
            const searchKeys = ['açıklama', 'tanım', 'is', 'urun', 'item'];
            
            for (const k in p) {
                if (searchKeys.some(sk => normalizeStr(k).includes(sk))) {
                    desc = p[k];
                    break;
                }
            }

            const normalizedDesc = normalizeStr(desc);
            if (!normalizedDesc || normalizedDesc.length < 3) return;

            const historicalSellers = db.prepare(`
                SELECT DISTINCT u.id, u.email, u.name
                FROM users u
                JOIN offers o ON u.id = o.seller_id
                JOIN offer_items oi ON o.id = oi.offer_id
                JOIN request_items ri ON oi.request_item_id = ri.id
                WHERE ri.properties LIKE ? AND u.role = 'seller'
            `).all(`%${normalizedDesc}%`);

            historicalSellers.forEach(s => {
                if (!notifiedSellers.has(s.id)) {
                    emailService.notifySellerOfMatch(s.email, s.name, title);
                    notifiedSellers.add(s.id);
                }
            });
        });

        res.json({ success: true, requestId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Talep oluşturulamadı.' });
    }
});

app.get('/api/buyer/requests', requireAuth, requireRole('buyer'), (req, res) => {
    const requests = db.prepare(`
        SELECT r.*, 
        (SELECT COUNT(*) FROM request_items WHERE request_id = r.id) as item_count,
        (SELECT COUNT(*) FROM offers WHERE request_id = r.id) as offer_count
        FROM requests r WHERE buyer_id = ? ORDER BY created_at DESC
    `).all(req.session.userId);
    res.json(requests);
});

app.get('/api/seller/requests', requireAuth, requireRole('seller'), (req, res) => {
    const requests = db.prepare(`
        SELECT r.*, u.company_name as buyer_company
        FROM requests r
        JOIN users u ON r.buyer_id = u.id
        WHERE r.status = 'active'
        ORDER BY r.created_at DESC
    `).all();
    res.json(requests);
});

// Fetching request detail for seller
app.get('/api/seller/requests/:id', requireAuth, requireRole('seller'), (req, res) => {
    const request = db.prepare(`
        SELECT r.*, u.company_name as buyer_company
        FROM requests r
        JOIN users u ON r.buyer_id = u.id
        WHERE r.id = ?
    `).get(req.params.id);

    if (!request) return res.status(404).json({ error: 'Talep bulunamadı.' });

    const items = db.prepare('SELECT * FROM request_items WHERE request_id = ? ORDER BY item_order').all(req.params.id);
    
    // Fetch questions for this request to calculate counts per item
    const questions = db.prepare('SELECT q.request_item_id, q.answer FROM request_questions q WHERE q.request_id = ?').all(req.params.id);

    // Check for existing offer
    const existingOffer = db.prepare('SELECT * FROM offers WHERE request_id = ? AND seller_id = ?').get(req.params.id, req.session.userId);
    let offerItems = [];
    if (existingOffer) {
        offerItems = db.prepare('SELECT * FROM offer_items WHERE offer_id = ?').all(existingOffer.id);
    }

    // Fetch attachments
    const attachments = db.prepare(`
        SELECT ua.* FROM request_attachments ra
        JOIN user_assets ua ON ra.asset_id = ua.id
        WHERE ra.request_id = ?
    `).all(req.params.id);

    res.json({ 
        ...request, 
        items: items.map(i => {
            const itemQuestions = questions.filter(q => q.request_item_id === i.id);
            return { 
                ...i, 
                properties: JSON.parse(i.properties),
                question_count: itemQuestions.length,
                answer_count: itemQuestions.filter(q => q.answer).length
            };
        }),
        attachments,
        existingOffer,
        offerItems,
        is_expired: request.expires_at ? new Date(request.expires_at) < new Date() : false
    });
});

// Submitting an offer
// GET seller's own offers
app.get('/api/seller/offers', requireAuth, requireRole('seller'), (req, res) => {
    try {
        const offers = db.prepare(`
            SELECT o.*, r.title as request_title 
            FROM offers o
            JOIN requests r ON o.request_id = r.id
            WHERE o.seller_id = ?
            ORDER BY o.submitted_at DESC
        `).all(req.session.userId);
        res.json(offers);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET seller's existing offer for a specific request
app.get('/api/seller/requests/:id/my-offer', requireAuth, requireRole('seller'), (req, res) => {
    try {
        const offer = db.prepare('SELECT * FROM offers WHERE request_id = ? AND seller_id = ?').get(req.params.id, req.session.userId);
        if (!offer) return res.json(null);
        
        const items = db.prepare('SELECT * FROM offer_items WHERE offer_id = ?').all(offer.id);
        res.json({ ...offer, items });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/seller/offers', requireAuth, requireRole('seller'), async (req, res) => {
    const { request_id, items, shipping_included, seller_lat, seller_lng, seller_address, notes, asset_ids } = req.body;

    const transaction = db.transaction(() => {
        // Check if offer exists
        const existing = db.prepare('SELECT id FROM offers WHERE request_id = ? AND seller_id = ?').get(request_id, req.session.userId);
        
        let offerId;
        if (existing) {
            db.prepare(`
                UPDATE offers SET shipping_included = ?, seller_lat = ?, seller_lng = ?, seller_address = ?, notes = ?, submitted_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(shipping_included ? 1 : 0, seller_lat, seller_lng, seller_address, notes, existing.id);
            offerId = existing.id;
            // Clear old items for refresh
            db.prepare('DELETE FROM offer_items WHERE offer_id = ?').run(offerId);
            // Clear old attachments for refresh
            db.prepare('DELETE FROM offer_attachments WHERE offer_id = ?').run(offerId);
        } else {
            const offerResult = db.prepare(`
                INSERT INTO offers (request_id, seller_id, shipping_included, seller_lat, seller_lng, seller_address, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(request_id, req.session.userId, shipping_included ? 1 : 0, seller_lat, seller_lng, seller_address, notes);
            offerId = offerResult.lastInsertRowid;
        }

        const insertOfferItem = db.prepare('INSERT INTO offer_items (offer_id, request_item_id, unit_price, photo_url) VALUES (?, ?, ?, ?)');
        items.forEach(item => {
            insertOfferItem.run(offerId, item.request_item_id, item.unit_price, item.photo_url || null);
        });

        // Add Attachments from Asset Library
        if (asset_ids && Array.isArray(asset_ids)) {
            const attachStmt = db.prepare('INSERT INTO offer_attachments (offer_id, asset_id) VALUES (?, ?)');
            asset_ids.forEach(assetId => {
                attachStmt.run(offerId, assetId);
            });
        }

        return offerId;
    });

    try {
        const offerId = transaction();
        
        // Notify Buyer
        const buyerInfo = db.prepare(`
            SELECT u.id as buyer_id, u.email, u.name, r.title, s.company_name as seller_company
            FROM requests r
            JOIN users u ON r.buyer_id = u.id
            CROSS JOIN (SELECT company_name FROM users WHERE id = ?) s
            WHERE r.id = ?
        `).get(req.session.userId, request_id);

        if (buyerInfo) {
            emailService.notifyBuyerOfOffer(buyerInfo.email, buyerInfo.name, buyerInfo.title, buyerInfo.seller_company);
            notificationService.createNotification(
                buyerInfo.buyer_id,
                'Yeni Teklif Geldi!',
                `${buyerInfo.seller_company} şirketi "${buyerInfo.title}" talebinize teklif verdi.`,
                `/buyer/requests/${request_id}/offers`,
                false
            );
        }

        res.json({ success: true, offerId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Teklif gönderilemedi.' });
    }
});

// --- ADMIN ROUTES ---

app.get('/api/admin/stats', requireAuth, requireRole('admin'), (req, res) => {
    try {
        const stats = {
            total_buyers: db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'buyer'").get().count,
            total_sellers: db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'seller'").get().count,
            active_requests: db.prepare("SELECT COUNT(*) as count FROM requests WHERE status = 'active'").get().count,
            total_offers: db.prepare("SELECT COUNT(*) as count FROM offers").get().count
        };
        res.json(stats);
    } catch (err) {
        console.error("Stats Error:", err);
        res.status(500).json({ error: 'İstatistikler alınamadı.' });
    }
});

app.get('/api/buyer/requests/:id/offers', requireAuth, requireRole('buyer'), (req, res) => {
    const offers = db.prepare(`
        SELECT o.*, u.name as seller_name, u.company_name as seller_company, u.phone as seller_phone
        FROM offers o
        JOIN users u ON o.seller_id = u.id
        WHERE o.request_id = ?
        ORDER BY o.submitted_at DESC
    `).all(req.params.id);

    // Calc totals and fetch attachments
    const result = offers.map(offer => {
        const total = db.prepare('SELECT SUM(unit_price) as total FROM offer_items WHERE offer_id = ?').get(offer.id).total;
        const attachments = db.prepare(`
            SELECT ua.* FROM offer_attachments oa
            JOIN user_assets ua ON oa.asset_id = ua.id
            WHERE oa.offer_id = ?
        `).all(offer.id);
        return { ...offer, total, attachments };
    });

    res.json(result);
});

app.get('/api/buyer/offers/:id', requireAuth, requireRole('buyer'), (req, res) => {
    const offer = db.prepare(`
        SELECT o.*, u.name as seller_name, u.company_name as seller_company, u.phone as seller_phone
        FROM offers o
        JOIN users u ON o.seller_id = u.id
        WHERE o.id = ?
    `).get(req.params.id);

    if (!offer) return res.status(404).json({ error: 'Teklif bulunamadı.' });

    const items = db.prepare(`
        SELECT oi.*, ri.properties 
        FROM offer_items oi
        JOIN request_items ri ON oi.request_item_id = ri.id
        WHERE oi.offer_id = ?
    `).all(req.params.id);

    res.json({ ...offer, items: items.map(i => ({ ...i, properties: JSON.parse(i.properties) })) });
});

app.post('/api/buyer/offers/:id/status', requireAuth, requireRole('buyer'), (req, res) => {
    const { status } = req.body; // 'accepted' or 'rejected'
    db.prepare('UPDATE offers SET status = ? WHERE id = ?').run(status, req.params.id);
    
    // Get offer details for notification
    const offer = db.prepare(`
        SELECT o.seller_id, r.title, o.request_id 
        FROM offers o 
        JOIN requests r ON o.request_id = r.id 
        WHERE o.id = ?
    `).get(req.params.id);

    if (offer) {
        notificationService.createNotification(
            offer.seller_id,
            status === 'accepted' ? 'Teklifiniz Kabul Edildi!' : 'Teklif Reddedildi',
            `"${offer.title}" için verdiğiniz teklif alıcı tarafından ${status === 'accepted' ? 'kabul edildi' : 'reddedildi'}.`,
            `/seller/offers/${req.params.id}`,
            true
        );
    }

    res.json({ success: true });
});

app.get('/api/users/profile', requireAuth, (req, res) => {
    const user = db.prepare('SELECT id, name, email, company_name, phone, role, status FROM users WHERE id = ?').get(req.session.userId);
    res.json(user);
});

// --- ASSET MANAGEMENT ROUTES ---

app.get('/api/user-assets', requireAuth, (req, res) => {
    const assets = db.prepare('SELECT * FROM user_assets WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
    res.json(assets);
});

app.post('/api/user-assets/link', requireAuth, (req, res) => {
    const { name, url } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'İsim ve URL zorunludur.' });
    
    const result = db.prepare('INSERT INTO user_assets (user_id, type, name, url) VALUES (?, ?, ?, ?)').run(req.session.userId, 'link', name, url);
    res.json({ id: result.lastInsertRowid, success: true });
});

app.delete('/api/user-assets/:id', requireAuth, (req, res) => {
    // Ensure ownership
    const asset = db.prepare('SELECT id FROM user_assets WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
    if (!asset) return res.status(404).json({ error: 'Dosya bulunamadı veya yetkiniz yok.' });
    
    db.prepare('DELETE FROM user_assets WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Dosya seçilmedi.' });
    
    const result = db.prepare('INSERT INTO user_assets (user_id, type, name, file_path) VALUES (?, ?, ?, ?)').run(
        req.session.userId, 
        'file', 
        req.file.originalname, 
        `/uploads/attachments/${req.file.filename}`
    );
    
    res.json({ 
        id: result.lastInsertRowid, 
        name: req.file.originalname, 
        path: `/uploads/attachments/${req.file.filename}`,
        success: true 
    });
});

// --- ADMIN MANAGEMENT ROUTES ---

app.get('/api/admin/users', requireAuth, requireRole('admin'), (req, res) => {
    const role = req.query.role;
    const users = db.prepare(`
        SELECT id, name, email, phone, company_name, role, status, created_at,
        (SELECT COUNT(*) FROM requests WHERE buyer_id = users.id) as request_count,
        (SELECT COUNT(*) FROM offers WHERE seller_id = users.id) as offer_count
        FROM users WHERE role = ?
    `).all(role);
    res.json(users);
});

app.post('/api/admin/users/:id/status', requireAuth, requireRole('admin'), (req, res) => {
    const { status } = req.body;
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.id);
    res.json({ success: true });
});

app.get('/api/admin/requests', requireAuth, requireRole('admin'), (req, res) => {
    const { status, buyer_id, projectId } = req.query;
    let query = `
        SELECT r.*, u.name as buyer_name, u.company_name as buyer_company,
        (SELECT COUNT(*) FROM request_items WHERE request_id = r.id) as item_count,
        (SELECT COUNT(*) FROM offers WHERE request_id = r.id) as offer_count
        FROM requests r
        JOIN users u ON r.buyer_id = u.id
        WHERE 1=1
    `;
    const params = [];

    if (status) {
        query += " AND r.status = ?";
        params.push(status);
    }
    if (buyer_id) {
        query += " AND r.buyer_id = ?";
        params.push(buyer_id);
    }
    if (projectId) {
        query += " AND r.project_id = ?";
        params.push(projectId);
    }

    const requests = db.prepare(query + " ORDER BY r.created_at DESC").all(...params);
    res.json(requests);
});

// Data export endpoints (returns raw data for Excel generation on frontend)
// Data export endpoints (returns Excel file)
app.get('/api/admin/export/excel', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook();
        
        // 1. Sheet: Talepler ve Teklifler
        const sheet = workbook.addWorksheet('Talepler ve Teklifler');
        sheet.columns = [
            { header: 'Talep ID', key: 'id', width: 10 },
            { header: 'Talep Başlığı', key: 'title', width: 30 },
            { header: 'Alıcı Şirket', key: 'buyer_company', width: 25 },
            { header: 'Durum', key: 'status', width: 15 },
            { header: 'Teklif Sayısı', key: 'offer_count', width: 15 },
            { header: 'Oluşturma Tarihi', key: 'created_at', width: 20 }
        ];

        const { status, buyer_id, date_from, date_to } = req.query;
        let query = `
            SELECT r.*, u.company_name as buyer_company,
            (SELECT COUNT(*) FROM offers WHERE request_id = r.id) as offer_count
            FROM requests r
            JOIN users u ON r.buyer_id = u.id
            WHERE 1=1
        `;
        const params = [];

        if (status) {
            query += " AND r.status = ?";
            params.push(status);
        }
        if (buyer_id) {
            query += " AND r.buyer_id = ?";
            params.push(buyer_id);
        }
        if (date_from) {
            query += " AND r.created_at >= ?";
            params.push(date_from);
        }
        if (date_to) {
            query += " AND r.created_at <= ?";
            params.push(date_to);
        }

        const requests = db.prepare(query + " ORDER BY r.created_at DESC").all(...params);
        
        requests.forEach(r => sheet.addRow(r));

        // 2. Sheet: Tüm Ürün Kalemleri (Fiyatlı/Fiyatsız)
        const itemsSheet = workbook.addWorksheet('Ürün Kalemleri');
        itemsSheet.columns = [
            { header: 'Talep ID', key: 'request_id', width: 10 },
            { header: 'Ürün Özellikleri', key: 'properties', width: 50 },
            { header: 'Ortalama Birim Fiyat (₺)', key: 'avg_price', width: 25 },
            { header: 'En Düşük Fiyat (₺)', key: 'min_price', width: 20 }
        ];

        const items = db.prepare(`
            SELECT ri.request_id, ri.properties, 
            AVG(oi.unit_price) as avg_price, 
            MIN(oi.unit_price) as min_price
            FROM request_items ri
            LEFT JOIN offer_items oi ON ri.id = oi.request_item_id
            GROUP BY ri.id
        `).all();

        items.forEach(i => {
            const props = JSON.parse(i.properties);
            const propStr = Object.entries(props).map(([k,v]) => `${k}: ${v}`).join(' | ');
            itemsSheet.addRow({ ...i, properties: propStr });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=fiyatal_rapor.xlsx');

        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Excel oluşturulurken hata oluştu.' });
    }
});

// Seller Ratings & Verification
app.get('/api/seller/:id/rating', (req, res) => {
    const stats = db.prepare(`
        SELECT AVG(rating) as average, COUNT(*) as count 
        FROM seller_ratings WHERE seller_id = ?
    `).get(req.params.id);
    res.json(stats);
});

app.post('/api/seller/ratings', requireAuth, requireRole('buyer'), (req, res) => {
    const { seller_id, offer_id, rating, comment, is_private } = req.body;
    try {
        db.prepare(`
            INSERT INTO seller_ratings (buyer_id, seller_id, offer_id, rating, comment, is_private)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(req.session.userId, seller_id, offer_id, rating, comment, is_private ? 1 : 0);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Değerlendirme gönderilemedi.' });
    }
});

app.post('/api/admin/users/:id/verify', requireAuth, requireRole('admin'), (req, res) => {
    const { is_verified } = req.body;
    db.prepare('UPDATE users SET is_verified = ? WHERE id = ?').run(is_verified ? 1 : 0, req.params.id);
    res.json({ success: true });
});

app.post('/api/offers/:id/analyze', requireAuth, requireRole('buyer'), async (req, res) => {
    try {
        const offerId = req.params.id;
        
        // Check if analysis already exists
        const existing = db.prepare('SELECT * FROM offer_analyses WHERE offer_id = ?').get(offerId);
        if (existing) return res.json(existing);

        // Fetch offer data
        const offer = db.prepare(`
            SELECT o.*, u.company_name, 
            (SELECT AVG(rating) FROM seller_ratings WHERE seller_id = o.seller_id) as rating
            FROM offers o
            JOIN users u ON o.seller_id = u.id
            WHERE o.id = ?
        `).get(offerId);

        if (!offer) return res.status(404).json({ error: 'Teklif bulunamadı.' });

        // Calculate total price accurately
        const items = db.prepare('SELECT * FROM offer_items WHERE offer_id = ?').all(offerId);
        offer.total_price = items.reduce((sum, i) => sum + (i.unit_price || 0), 0);
        offer.items = items;

        // Fetch request details
        const requestDetails = db.prepare('SELECT * FROM requests WHERE id = ?').get(offer.request_id);

        const analysis = await aiService.analyzeOffer(offer, requestDetails);

        const result = db.prepare(`
            INSERT INTO offer_analyses (offer_id, analysis_text, score)
            VALUES (?, ?, ?)
        `).run(offerId, analysis.text, analysis.score);

        res.json({
            id: result.lastInsertRowid,
            offer_id: offerId,
            analysis_text: analysis.text,
            score: analysis.score
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'AI analizi tamamlanamadı.' });
    }
});

// --- NOTIFICATION ROUTES ---
app.get('/api/notifications', requireAuth, (req, res) => {
    const notifications = db.prepare(`
        SELECT * FROM notifications 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT 50
    `).all(req.session.userId);
    res.json(notifications);
});

app.patch('/api/notifications/:id/read', requireAuth, (req, res) => {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.session.userId);
    res.json({ success: true });
});

app.post('/api/notifications/read-all', requireAuth, (req, res) => {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.session.userId);
    res.json({ success: true });
});

// Comparison Matrix Data
app.get('/api/buyer/requests/:id/comparison', requireAuth, requireRole('buyer'), (req, res) => {
    try {
        const requestId = req.params.id;
        const items = db.prepare('SELECT * FROM request_items WHERE request_id = ? ORDER BY item_order').all(requestId);
        const offers = db.prepare(`
            SELECT o.id as offer_id, o.seller_id, u.company_name, u.is_verified,
            (SELECT SUM(unit_price) FROM offer_items WHERE offer_id = o.id) as total_price
            FROM offers o
            JOIN users u ON o.seller_id = u.id
            WHERE o.request_id = ?
        `).all(requestId);

        // Get all offer items for these offers
        const offerItems = db.prepare(`
            SELECT oi.*, o.seller_id 
            FROM offer_items oi
            JOIN offers o ON oi.offer_id = o.id
            WHERE o.request_id = ?
        `).all(requestId);

        // Map offer items to items
        const structuredItems = items.map(it => {
            let properties = {};
            try { properties = JSON.parse(it.properties); } catch(e) {}
            
            const itemOffers = {};
            offers.forEach(s => {
                const oi = offerItems.find(oi => oi.request_item_id === it.id && oi.seller_id === s.seller_id);
                itemOffers[s.seller_id] = oi ? { price: oi.unit_price } : null;
            });

            return {
                id: it.id,
                properties,
                offers: itemOffers
            };
        });

        // Sellers list formatted for frontend
        const sellers = offers.map(s => {
            const ratingResult = db.prepare('SELECT AVG(rating) as average FROM seller_ratings WHERE seller_id = ?').get(s.seller_id);
            return {
                id: s.seller_id,
                company_name: s.company_name,
                is_verified: s.is_verified,
                rating: (ratingResult && ratingResult.average) ? ratingResult.average : 0,
                total_price: s.total_price || 0,
                offer_id: s.offer_id
            };
        });

        res.json({ items: structuredItems, sellers });
    } catch (err) {
        console.error("Comparison Error:", err);
        res.status(500).json({ error: 'Karşılaştırma verisi hazırlanamadı.' });
    }
});

// --- Q&A ROUTES ---
app.get('/api/requests/:id/questions', requireAuth, (req, res) => {
    const questions = db.prepare(`
        SELECT q.*, u.company_name as seller_company,
               ri.item_order, ri.properties as item_properties
        FROM request_questions q
        LEFT JOIN users u ON q.seller_id = u.id
        LEFT JOIN request_items ri ON q.request_item_id = ri.id
        WHERE q.request_id = ?
        ORDER BY q.created_at DESC
    `).all(req.params.id);
    
    // Parse properties for convenience
    const formatted = questions.map(q => {
        if (q.item_properties) {
            try { q.item_properties = JSON.parse(q.item_properties); } catch(e) {}
        }
        return q;
    });

    res.json(formatted);
});

app.post('/api/requests/:id/questions', requireAuth, requireRole('seller'), (req, res) => {
    const { question, request_item_id } = req.body;
    db.prepare('INSERT INTO request_questions (request_id, seller_id, question, request_item_id) VALUES (?, ?, ?, ?)').run(req.params.id, req.session.userId, question, request_item_id || null);
    
    // Notify Buyer
    const request = db.prepare('SELECT buyer_id, title FROM requests WHERE id = ?').get(req.params.id);
    if (request) {
        notificationService.createNotification(
            request.buyer_id,
            'Yeni Teknik Soru!',
            `"${request.title}" talebinizdeki bir ürün hakkında teknik soru soruldu.`,
            `/buyer/requests/${req.params.id}/offers`,
            false
        );
    }
    
    res.json({ success: true });
});

app.patch('/api/questions/:id/answer', requireAuth, requireRole('buyer'), (req, res) => {
    const { answer } = req.body;
    db.prepare('UPDATE request_questions SET answer = ?, answered_at = CURRENT_TIMESTAMP WHERE id = ?').run(answer, req.params.id);
    
    // Notify Seller
    const question = db.prepare('SELECT q.seller_id, r.title, q.request_id FROM request_questions q JOIN requests r ON q.request_id = r.id WHERE q.id = ?').get(req.params.id);
    if (question) {
        notificationService.createNotification(
            question.seller_id,
            'Sorunuz Yanıtlandı!',
            `"${question.title}" talebi için sorduğunuz teknik soru yanıtlandı.`,
            `/seller/requests/${question.request_id}`,
            true
        );
    }

    res.json({ success: true });
});

// --- COMPARISON EXCEL EXPORT ---
app.get('/api/buyer/requests/:id/excel', requireAuth, requireRole('buyer'), async (req, res) => {
    try {
        const requestId = req.params.id;
        const request = db.prepare('SELECT title FROM requests WHERE id = ?').get(requestId);
        if (!request) return res.status(404).send('Talep bulunamadı');

        const items = db.prepare('SELECT * FROM request_items WHERE request_id = ? ORDER BY item_order').all(requestId);
        const offers = db.prepare(`
            SELECT o.id as offer_id, o.seller_id, u.company_name, u.phone
            FROM offers o
            JOIN users u ON o.seller_id = u.id
            WHERE o.request_id = ?
        `).all(requestId);

        const offerItems = db.prepare(`
            SELECT oi.*, o.seller_id 
            FROM offer_items oi
            JOIN offers o ON oi.offer_id = o.id
            WHERE o.request_id = ?
        `).all(requestId);

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Teklif Karşılaştırma');

        // Headers
        const headerRow = ['Kalem No', 'İşin Tanımı', 'Birim', 'Miktar'];
        offers.forEach(o => {
            headerRow.push(`${o.company_name} (₺)`);
        });
        sheet.addRow(headerRow);

        // Styling for header
        sheet.getRow(1).font = { bold: true };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };

        // Data Rows
        items.forEach(it => {
            const props = JSON.parse(it.properties);
            const rowData = [
                props['poz'] || props['kalem'] || props['no'] || it.item_order,
                props['açıklama'] || props['tanım'] || props['ürün'] || props['item'] || '-',
                props['birim'] || props['unit'] || '-',
                props['miktar'] || props['adet'] || props['qty'] || 0
            ];

            offers.forEach(s => {
                const oi = offerItems.find(oi => oi.request_item_id === it.id && oi.seller_id === s.seller_id);
                rowData.push(oi && oi.unit_price > 0 ? oi.unit_price : 'YOK');
            });

            sheet.addRow(rowData);
        });

        // Summary Row at bottom
        const summaryRow = ['---', 'TOPLAM TEKLİF BEDELİ', '---', '---'];
        offers.forEach(s => {
            const total = offerItems
                .filter(oi => oi.seller_id === s.seller_id)
                .reduce((sum, curr) => sum + (curr.unit_price || 0), 0);
            summaryRow.push(total > 0 ? total : 'N/A');
        });
        const summaryIdx = sheet.addRow(summaryRow).number;
        sheet.getRow(summaryIdx).font = { bold: true };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=karsilastirma_${requestId}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error(err);
        res.status(500).send('Excel oluşturulamadı');
    }
});

// --- ADDITIONAL SPECIAL ROUTES ---

// SMTP Admin Config
app.get('/api/admin/smtp', requireAuth, requireRole('admin'), (req, res) => {
    const config = db.prepare('SELECT * FROM smtp_config WHERE id = 1').get();
    res.json(config);
});

app.post('/api/admin/smtp', requireAuth, requireRole('admin'), (req, res) => {
    const { host, port, user, pass, secure, from_name, from_email } = req.body;
    db.prepare(`
        UPDATE smtp_config SET host=?, port=?, user=?, pass=?, secure=?, from_name=?, from_email=?
        WHERE id = 1
    `).run(host, port, user, pass, secure ? 1 : 0, from_name, from_email);
    res.json({ success: true });
});

// Seller Interests
app.get('/api/seller/interests', requireAuth, requireRole('seller'), (req, res) => {
    const interests = db.prepare('SELECT * FROM seller_interests WHERE seller_id = ?').all(req.session.userId);
    res.json(interests);
});

app.post('/api/seller/interests', requireAuth, requireRole('seller'), (req, res) => {
    const { keyword } = req.body;
    db.prepare('INSERT INTO seller_interests (seller_id, keyword) VALUES (?, ?)').run(req.session.userId, keyword);
    res.json({ success: true });
});

app.delete('/api/seller/interests/:id', requireAuth, requireRole('seller'), (req, res) => {
    db.prepare('DELETE FROM seller_interests WHERE id = ? AND seller_id = ?').run(req.params.id, req.session.userId);
    res.json({ success: true });
});

// Invitations
app.post('/api/buyer/requests/:id/invite', requireAuth, requireRole('buyer'), async (req, res) => {
    const { email } = req.body;
    const token = crypto.randomBytes(16).toString('hex');
    
    try {
        db.prepare('INSERT INTO invitations (request_id, email, token) VALUES (?, ?, ?)').run(req.params.id, email, token);
        
        const request = db.prepare('SELECT title FROM requests WHERE id = ?').get(req.params.id);
        const buyer = db.prepare('SELECT company_name FROM users WHERE id = ?').get(req.session.userId);
        
        await emailService.sendInvitation(email, buyer.company_name, request.title, token);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Davetiye gönderilemedi.' });
    }
});

app.get('/api/admin/export/all', requireAuth, requireRole('admin'), (req, res) => {
    const data = {
        users: db.prepare('SELECT id, name, company_name, email, phone, role, status, created_at FROM users').all(),
        requests: db.prepare('SELECT * FROM requests').all(),
        offers: db.prepare('SELECT * FROM offers').all()
    };
    res.json(data);
});

// Seller Document Library - Retrieve previously uploaded files/links
app.get('/api/seller/library', requireAuth, requireRole('seller'), (req, res) => {
    try {
        const assets = db.prepare(`
            SELECT DISTINCT a.* 
            FROM assets a
            JOIN request_attachments ra ON a.id = ra.asset_id
            JOIN offers o ON ra.offer_id = o.id
            WHERE o.seller_id = ?
            ORDER BY a.created_at DESC
        `).all(req.session.userId);
        res.json(assets);
    } catch (err) {
        res.status(500).json({ error: 'Kütüphane yüklenemedi.' });
    }
});

// Comparative AI Analysis for all offers of a request
app.post('/api/buyer/requests/:id/compare-all', requireAuth, requireRole('buyer'), async (req, res) => {
    try {
        const requestId = req.params.id;
        
        // Fetch all offers and companies
        const offers = db.prepare(`
            SELECT o.*, u.company_name, u.is_verified,
            (SELECT SUM(unit_price) FROM offer_items WHERE offer_id = o.id) as total_price,
            (SELECT AVG(rating) FROM seller_ratings WHERE seller_id = u.id) as rating
            FROM offers o
            JOIN users u ON o.seller_id = u.id
            WHERE o.request_id = ?
        `).all(requestId);

        if (offers.length === 0) return res.status(400).json({ error: 'Henüz teklif yok.' });

        const request = db.prepare('SELECT title FROM requests WHERE id = ?').get(requestId);
        
        // Generate prompt for Gemini
        const analysisPrompt = `
            Aşağıdaki B2B talebi için gelen teklifleri analiz et ve "En Mantıklı 3 Seçenek" raporu sun.
            Talep Başlığı: ${request.title}
            
            Teklifler:
            ${offers.map(o => `- ${o.company_name}: ${o.total_price} TL, Puan: ${o.rating || 'Yok'}, Onaylı: ${o.is_verified ? 'Evet' : 'Hayır'}`).join('\n')}
            
            Lütfen şu formatta bir yanıt ver:
            1. **Genel Özet**: Piyasa durumu ve fiyat dağılımı.
            2. **Öne Çıkan Seçenekler**: En düşük fiyat, en yüksek güvenilirlik ve en dengeli teklif.
            3. **Tavsiye**: Alıcıya hangi satıcıyla ilerlemesini önerirsin ve neden?
            
            Yanıtı profesyonel bir B2B diliyle ve Türkçe ver.
        `;

        const report = await aiService.generateAnalysis(analysisPrompt);
        
        // Save or return report
        res.json({ success: true, report });
    } catch (err) {
        console.error("AI Comparison Error:", err);
        res.status(500).json({ error: 'AI karşılaştırması yapılamadı.' });
    }
});

// --- PROJECT ROUTES ---

app.get('/api/admin/projects', requireAuth, requireRole('admin'), (req, res) => {
    const projects = db.prepare(`
        SELECT p.*, u.company_name as buyer_company,
        (SELECT COUNT(*) FROM requests WHERE project_id = p.id) as request_count
        FROM projects p
        JOIN users u ON p.buyer_id = u.id
        ORDER BY p.created_at DESC
    `).all();
    res.json(projects);
});

app.get('/api/buyer/projects', requireAuth, requireRole('buyer'), (req, res) => {
    const projects = db.prepare(`
        SELECT p.*,
        (SELECT COUNT(*) FROM requests WHERE project_id = p.id) as request_count
        FROM projects p
        WHERE p.buyer_id = ?
        ORDER BY p.created_at DESC
    `).all(req.session.userId);
    res.json(projects);
});

app.get('/api/seller/projects', requireAuth, requireRole('seller'), (req, res) => {
    // Sellers see projects where they have given offers or matching keywords
    const projects = db.prepare(`
        SELECT DISTINCT p.*, u.company_name as buyer_company
        FROM projects p
        JOIN requests r ON p.id = r.project_id
        JOIN users u ON p.buyer_id = u.id
        LEFT JOIN offers o ON r.id = o.request_id AND o.seller_id = ?
        WHERE o.id IS NOT NULL 
           OR EXISTS (SELECT 1 FROM seller_interests si WHERE si.seller_id = ? AND (r.title LIKE '%' || si.keyword || '%' OR p.name LIKE '%' || si.keyword || '%'))
        ORDER BY p.created_at DESC
    `).all(req.session.userId, req.session.userId);
    res.json(projects);
});

app.listen(PORT, () => {
    console.log(`Backend server running at http://localhost:${PORT}`);
});

