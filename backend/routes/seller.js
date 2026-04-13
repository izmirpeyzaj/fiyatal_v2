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

router.get('/requests/search', requireAuth, requireRole('seller'), (req, res) => {
    const { q, location } = req.query;
    let query = `SELECT r.*, u.company_name as buyer_company, (SELECT COUNT(*) FROM request_items WHERE request_id = r.id) as item_count FROM requests r JOIN users u ON r.buyer_id = u.id WHERE r.status = 'active'`;
    const params = [];
    if (q) { query += " AND (r.title LIKE ? OR EXISTS (SELECT 1 FROM request_items ri WHERE ri.request_id = r.id AND ri.properties LIKE ?))"; params.push(`%${q}%`, `%${q}%`); }
    if (location) { query += " AND r.delivery_address LIKE ?"; params.push(`%${location}%`); }
    query += " ORDER BY r.created_at DESC";
    res.json(db.prepare(query).all(...params));
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

router.get('/stats', requireAuth, requireRole('seller'), (req, res) => {
    const userId = req.session.userId;
    const totalOffers = db.prepare('SELECT COUNT(*) as count FROM offers WHERE seller_id = ?').get(userId).count;
    const acceptedOffers = db.prepare("SELECT COUNT(*) as count FROM offers WHERE seller_id = ? AND status = 'accepted'").get(userId).count;
    const pendingOffers = db.prepare("SELECT COUNT(*) as count FROM offers WHERE seller_id = ? AND status = 'pending'").get(userId).count;
    const winRate = totalOffers > 0 ? ((acceptedOffers / totalOffers) * 100).toFixed(1) : 0;
    const avgRating = db.prepare('SELECT AVG(rating) as avg FROM seller_ratings WHERE seller_id = ?').get(userId).avg || 0;
    const monthlyData = db.prepare(`SELECT strftime('%Y-%m', o.submitted_at) as month, COUNT(*) as offers, SUM(CASE WHEN o.status = 'accepted' THEN 1 ELSE 0 END) as accepted FROM offers o WHERE o.seller_id = ? GROUP BY month ORDER BY month DESC LIMIT 6`).all(userId);
    res.json({ totalOffers, acceptedOffers, pendingOffers, winRate, avgRating: parseFloat(avgRating).toFixed(1), monthlyData: monthlyData.reverse() });
});

router.get('/price-alerts', requireAuth, requireRole('seller'), (req, res) => {
    res.json(db.prepare('SELECT * FROM price_alerts WHERE seller_id = ? ORDER BY created_at DESC').all(req.session.userId));
});

router.post('/price-alerts', requireAuth, requireRole('seller'), (req, res) => {
    const { category, min_price, max_price } = req.body;
    if (!category) return res.status(400).json({ error: 'Kategori gereklidir.' });
    db.prepare('INSERT INTO price_alerts (seller_id, category, min_price, max_price) VALUES (?, ?, ?, ?)').run(req.session.userId, category, min_price || null, max_price || null);
    res.json({ success: true });
});

router.delete('/price-alerts/:id', requireAuth, requireRole('seller'), (req, res) => {
    db.prepare('DELETE FROM price_alerts WHERE id = ? AND seller_id = ?').run(req.params.id, req.session.userId);
    res.json({ success: true });
});

router.get('/profile/showcase', requireAuth, requireRole('seller'), (req, res) => {
    let profile = db.prepare('SELECT * FROM seller_profiles WHERE seller_id = ?').get(req.session.userId);
    if (!profile) { db.prepare('INSERT INTO seller_profiles (seller_id) VALUES (?)').run(req.session.userId); profile = db.prepare('SELECT * FROM seller_profiles WHERE seller_id = ?').get(req.session.userId); }
    res.json(profile);
});

router.put('/profile/showcase', requireAuth, requireRole('seller'), (req, res) => {
    const { description, website, city, sector, established_year, employee_count, certificates, cover_image } = req.body;
    const existing = db.prepare('SELECT id FROM seller_profiles WHERE seller_id = ?').get(req.session.userId);
    if (!existing) db.prepare('INSERT INTO seller_profiles (seller_id) VALUES (?)').run(req.session.userId);
    db.prepare(`UPDATE seller_profiles SET description=?, website=?, city=?, sector=?, established_year=?, employee_count=?, certificates=?, cover_image=?, updated_at=CURRENT_TIMESTAMP WHERE seller_id = ?`).run(description || '', website || '', city || '', sector || '', established_year || null, employee_count || '', JSON.stringify(certificates || []), cover_image || '', req.session.userId);
    res.json({ success: true });
});

router.get('/showcase/:id', (req, res) => {
    const seller = db.prepare(`
        SELECT u.id, u.name, u.company_name, u.is_verified, u.created_at,
        sp.description, sp.website, sp.city, sp.sector, sp.established_year, sp.employee_count, sp.certificates, sp.cover_image,
        (SELECT AVG(rating) FROM seller_ratings WHERE seller_id = u.id) as avg_rating,
        (SELECT COUNT(*) FROM seller_ratings WHERE seller_id = u.id) as rating_count,
        (SELECT COUNT(*) FROM offers WHERE seller_id = u.id) as total_offers
        FROM users u LEFT JOIN seller_profiles sp ON u.id = sp.seller_id
        WHERE u.id = ? AND u.role = 'seller' AND u.status = 'active'
    `).get(req.params.id);
    if (!seller) return res.status(404).json({ error: 'Satici bulunamadi.' });

    const publicRatings = db.prepare(`SELECT sr.rating, sr.comment, sr.created_at, u.company_name as buyer_company FROM seller_ratings sr JOIN users u ON sr.buyer_id = u.id WHERE sr.seller_id = ? AND sr.is_private = 0 ORDER BY sr.created_at DESC LIMIT 10`).all(req.params.id);
    if (seller.certificates) { try { seller.certificates = JSON.parse(seller.certificates); } catch(e) { seller.certificates = []; } }
    res.json({ ...seller, ratings: publicRatings });
});

module.exports = router;
