const express = require('express');
const db = require('../db');
const emailService = require('../emailService');
const notificationService = require('../notificationService');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

router.get('/requests', requireAuth, requireRole('seller'), (req, res) => {
    const requests = db.prepare(`
        SELECT r.*, u.company_name as buyer_company
        FROM requests r
        JOIN users u ON r.buyer_id = u.id
        WHERE r.status = 'active'
        ORDER BY r.created_at DESC
    `).all();
    res.json(requests);
});

router.get('/requests/:id', requireAuth, requireRole('seller'), (req, res) => {
    const request = db.prepare(`
        SELECT r.*, u.company_name as buyer_company
        FROM requests r
        JOIN users u ON r.buyer_id = u.id
        WHERE r.id = ?
    `).get(req.params.id);

    if (!request) return res.status(404).json({ error: 'Talep bulunamadi.' });

    const items = db.prepare('SELECT * FROM request_items WHERE request_id = ? ORDER BY item_order').all(req.params.id);
    const questions = db.prepare('SELECT q.request_item_id, q.answer FROM request_questions q WHERE q.request_id = ?').all(req.params.id);

    const existingOffer = db.prepare('SELECT * FROM offers WHERE request_id = ? AND seller_id = ?').get(req.params.id, req.session.userId);
    let offerItems = [];
    if (existingOffer) {
        offerItems = db.prepare('SELECT * FROM offer_items WHERE offer_id = ?').all(existingOffer.id);
    }

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

router.get('/offers', requireAuth, requireRole('seller'), (req, res) => {
    const offers = db.prepare(`
        SELECT o.*, r.title as request_title
        FROM offers o
        JOIN requests r ON o.request_id = r.id
        WHERE o.seller_id = ?
        ORDER BY o.submitted_at DESC
    `).all(req.session.userId);
    res.json(offers);
});

router.get('/requests/:id/my-offer', requireAuth, requireRole('seller'), (req, res) => {
    const offer = db.prepare('SELECT * FROM offers WHERE request_id = ? AND seller_id = ?').get(req.params.id, req.session.userId);
    if (!offer) return res.json(null);

    const items = db.prepare('SELECT * FROM offer_items WHERE offer_id = ?').all(offer.id);
    res.json({ ...offer, items });
});

router.post('/offers', requireAuth, requireRole('seller'), asyncHandler(async (req, res) => {
    const { request_id, items, shipping_included, seller_lat, seller_lng, seller_address, notes, asset_ids } = req.body;

    if (!request_id || !items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Talep ID ve urun fiyatlari gereklidir.' });
    }

    const transaction = db.transaction(() => {
        const existing = db.prepare('SELECT id FROM offers WHERE request_id = ? AND seller_id = ?').get(request_id, req.session.userId);

        let offerId;
        if (existing) {
            db.prepare(`
                UPDATE offers SET shipping_included = ?, seller_lat = ?, seller_lng = ?, seller_address = ?, notes = ?, submitted_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(shipping_included ? 1 : 0, seller_lat, seller_lng, seller_address, notes, existing.id);
            offerId = existing.id;
            db.prepare('DELETE FROM offer_items WHERE offer_id = ?').run(offerId);
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

        if (asset_ids && Array.isArray(asset_ids)) {
            const attachStmt = db.prepare('INSERT INTO offer_attachments (offer_id, asset_id) VALUES (?, ?)');
            asset_ids.forEach(assetId => {
                attachStmt.run(offerId, assetId);
            });
        }

        return offerId;
    });

    const offerId = transaction();

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
            `${buyerInfo.seller_company} sirketi "${buyerInfo.title}" talebinize teklif verdi.`,
            `/buyer/requests/${request_id}/offers`,
            false
        );
    }

    res.json({ success: true, offerId });
}));

router.get('/:id/rating', (req, res) => {
    const stats = db.prepare(`
        SELECT AVG(rating) as average, COUNT(*) as count
        FROM seller_ratings WHERE seller_id = ?
    `).get(req.params.id);
    res.json(stats);
});

router.post('/ratings', requireAuth, requireRole('buyer'), (req, res) => {
    const { seller_id, offer_id, rating, comment, is_private } = req.body;
    if (!seller_id || !offer_id || !rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Gecerli bir degerlendirme girin (1-5).' });
    }
    try {
        db.prepare(`
            INSERT INTO seller_ratings (buyer_id, seller_id, offer_id, rating, comment, is_private)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(req.session.userId, seller_id, offer_id, rating, comment || '', is_private ? 1 : 0);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Degerlendirme gonderilemedi.' });
    }
});

router.get('/interests', requireAuth, requireRole('seller'), (req, res) => {
    const interests = db.prepare('SELECT * FROM seller_interests WHERE seller_id = ?').all(req.session.userId);
    res.json(interests);
});

router.post('/interests', requireAuth, requireRole('seller'), (req, res) => {
    const { keyword } = req.body;
    if (!keyword || keyword.trim().length < 2) {
        return res.status(400).json({ error: 'Anahtar kelime en az 2 karakter olmalidir.' });
    }
    db.prepare('INSERT INTO seller_interests (seller_id, keyword) VALUES (?, ?)').run(req.session.userId, keyword.trim());
    res.json({ success: true });
});

router.delete('/interests/:id', requireAuth, requireRole('seller'), (req, res) => {
    db.prepare('DELETE FROM seller_interests WHERE id = ? AND seller_id = ?').run(req.params.id, req.session.userId);
    res.json({ success: true });
});

router.get('/library', requireAuth, requireRole('seller'), (req, res) => {
    const assets = db.prepare('SELECT * FROM user_assets WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
    res.json(assets);
});

router.get('/projects', requireAuth, requireRole('seller'), (req, res) => {
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

module.exports = router;
