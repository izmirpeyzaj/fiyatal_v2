const express = require('express');
const db = require('../db');
const notificationService = require('../notificationService');
const aiService = require('../aiService');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { upload } = require('../middleware/upload');

const router = express.Router();

router.get('/users/profile', requireAuth, (req, res) => {
    const user = db.prepare('SELECT id, name, email, company_name, phone, role, status FROM users WHERE id = ?').get(req.session.userId);
    res.json(user);
});

router.get('/user-assets', requireAuth, (req, res) => {
    const assets = db.prepare('SELECT * FROM user_assets WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
    res.json(assets);
});

router.post('/user-assets/link', requireAuth, (req, res) => {
    const { name, url } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'Isim ve URL zorunludur.' });

    const result = db.prepare('INSERT INTO user_assets (user_id, type, name, url) VALUES (?, ?, ?, ?)').run(req.session.userId, 'link', name, url);
    res.json({ id: result.lastInsertRowid, success: true });
});

router.delete('/user-assets/:id', requireAuth, (req, res) => {
    const asset = db.prepare('SELECT id FROM user_assets WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
    if (!asset) return res.status(404).json({ error: 'Dosya bulunamadi veya yetkiniz yok.' });

    db.prepare('DELETE FROM user_assets WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

router.post('/upload', requireAuth, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Dosya secilemedi.' });

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

router.get('/notifications', requireAuth, (req, res) => {
    const notifications = db.prepare(`
        SELECT * FROM notifications
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 50
    `).all(req.session.userId);
    res.json(notifications);
});

router.patch('/notifications/:id/read', requireAuth, (req, res) => {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.session.userId);
    res.json({ success: true });
});

router.post('/notifications/read-all', requireAuth, (req, res) => {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.session.userId);
    res.json({ success: true });
});

router.get('/requests/:id/questions', requireAuth, (req, res) => {
    const questions = db.prepare(`
        SELECT q.*, u.company_name as seller_company,
               ri.item_order, ri.properties as item_properties
        FROM request_questions q
        LEFT JOIN users u ON q.seller_id = u.id
        LEFT JOIN request_items ri ON q.request_item_id = ri.id
        WHERE q.request_id = ?
        ORDER BY q.created_at DESC
    `).all(req.params.id);

    const formatted = questions.map(q => {
        if (q.item_properties) {
            try { q.item_properties = JSON.parse(q.item_properties); } catch(e) {}
        }
        return q;
    });

    res.json(formatted);
});

router.post('/requests/:id/questions', requireAuth, requireRole('seller'), (req, res) => {
    const { question, request_item_id } = req.body;
    if (!question || question.trim().length < 3) {
        return res.status(400).json({ error: 'Soru en az 3 karakter olmalidir.' });
    }

    db.prepare('INSERT INTO request_questions (request_id, seller_id, question, request_item_id) VALUES (?, ?, ?, ?)').run(req.params.id, req.session.userId, question.trim(), request_item_id || null);

    const request = db.prepare('SELECT buyer_id, title FROM requests WHERE id = ?').get(req.params.id);
    if (request) {
        notificationService.createNotification(
            request.buyer_id,
            'Yeni Teknik Soru!',
            `"${request.title}" talebinizdeki bir urun hakkinda teknik soru soruldu.`,
            `/buyer/requests/${req.params.id}/offers`,
            false
        );
    }

    res.json({ success: true });
});

router.patch('/questions/:id/answer', requireAuth, requireRole('buyer'), (req, res) => {
    const { answer } = req.body;
    if (!answer || answer.trim().length < 1) {
        return res.status(400).json({ error: 'Yanit gereklidir.' });
    }

    db.prepare('UPDATE request_questions SET answer = ?, answered_at = CURRENT_TIMESTAMP WHERE id = ?').run(answer.trim(), req.params.id);

    const question = db.prepare('SELECT q.seller_id, r.title, q.request_id FROM request_questions q JOIN requests r ON q.request_id = r.id WHERE q.id = ?').get(req.params.id);
    if (question) {
        notificationService.createNotification(
            question.seller_id,
            'Sorunuz Yanitlandi!',
            `"${question.title}" talebi icin sordugunuz teknik soru yanitlandi.`,
            `/seller/requests/${question.request_id}`,
            true
        );
    }

    res.json({ success: true });
});

router.post('/offers/:id/analyze', requireAuth, requireRole('buyer'), asyncHandler(async (req, res) => {
    const offerId = req.params.id;

    const existing = db.prepare('SELECT * FROM offer_analyses WHERE offer_id = ?').get(offerId);
    if (existing) return res.json(existing);

    const offer = db.prepare(`
        SELECT o.*, u.company_name,
        (SELECT AVG(rating) FROM seller_ratings WHERE seller_id = o.seller_id) as rating
        FROM offers o
        JOIN users u ON o.seller_id = u.id
        WHERE o.id = ?
    `).get(offerId);

    if (!offer) return res.status(404).json({ error: 'Teklif bulunamadi.' });

    const items = db.prepare('SELECT * FROM offer_items WHERE offer_id = ?').all(offerId);
    offer.total_price = items.reduce((sum, i) => sum + (i.unit_price || 0), 0);
    offer.items = items;

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
}));

router.get('/messages/:offerId', requireAuth, (req, res) => {
    const offer = db.prepare('SELECT o.seller_id, r.buyer_id FROM offers o JOIN requests r ON o.request_id = r.id WHERE o.id = ?').get(req.params.offerId);
    if (!offer) return res.status(404).json({ error: 'Teklif bulunamadi.' });
    if (req.session.userId !== offer.seller_id && req.session.userId !== offer.buyer_id) {
        return res.status(403).json({ error: 'Bu mesajlara erisim yetkiniz yok.' });
    }

    const messages = db.prepare(`
        SELECT m.*, u.name as sender_name, u.role as sender_role, u.company_name as sender_company
        FROM messages m
        JOIN users u ON m.sender_id = u.id
        WHERE m.offer_id = ?
        ORDER BY m.created_at ASC
    `).all(req.params.offerId);
    res.json(messages);
});

router.post('/messages/:offerId', requireAuth, (req, res) => {
    const { message } = req.body;
    if (!message || message.trim().length < 1) {
        return res.status(400).json({ error: 'Mesaj bos olamaz.' });
    }

    const offer = db.prepare('SELECT o.seller_id, r.buyer_id, r.title FROM offers o JOIN requests r ON o.request_id = r.id WHERE o.id = ?').get(req.params.offerId);
    if (!offer) return res.status(404).json({ error: 'Teklif bulunamadi.' });
    if (req.session.userId !== offer.seller_id && req.session.userId !== offer.buyer_id) {
        return res.status(403).json({ error: 'Bu teklif uzerinde mesaj gonderme yetkiniz yok.' });
    }

    const result = db.prepare('INSERT INTO messages (offer_id, sender_id, message) VALUES (?, ?, ?)').run(req.params.offerId, req.session.userId, message.trim());

    const recipientId = req.session.userId === offer.buyer_id ? offer.seller_id : offer.buyer_id;
    notificationService.createNotification(recipientId, 'Yeni Mesaj', `"${offer.title}" teklifi hakkinda yeni bir mesaj aldiniz.`, null, false);

    res.json({ success: true, id: result.lastInsertRowid });
});

router.get('/users/preferences', requireAuth, (req, res) => {
    let prefs = db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(req.session.userId);
    if (!prefs) {
        db.prepare('INSERT INTO notification_preferences (user_id) VALUES (?)').run(req.session.userId);
        prefs = db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(req.session.userId);
    }
    res.json(prefs);
});

router.put('/users/preferences', requireAuth, (req, res) => {
    const fields = ['email_new_offer', 'email_new_request', 'email_question', 'email_status_change', 'email_daily_summary', 'app_new_offer', 'app_new_request', 'app_question', 'app_status_change'];
    const existing = db.prepare('SELECT id FROM notification_preferences WHERE user_id = ?').get(req.session.userId);
    if (!existing) {
        db.prepare('INSERT INTO notification_preferences (user_id) VALUES (?)').run(req.session.userId);
    }
    fields.forEach(f => {
        if (req.body[f] !== undefined) {
            db.prepare(`UPDATE notification_preferences SET ${f} = ? WHERE user_id = ?`).run(req.body[f] ? 1 : 0, req.session.userId);
        }
    });
    res.json({ success: true });
});

router.put('/users/profile', requireAuth, (req, res) => {
    const { name, phone, company_name, locale, theme } = req.body;
    if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.session.userId);
    if (phone !== undefined) db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, req.session.userId);
    if (company_name) db.prepare('UPDATE users SET company_name = ? WHERE id = ?').run(company_name, req.session.userId);
    if (locale) db.prepare('UPDATE users SET locale = ? WHERE id = ?').run(locale, req.session.userId);
    if (theme) db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, req.session.userId);
    res.json({ success: true });
});

module.exports = router;
