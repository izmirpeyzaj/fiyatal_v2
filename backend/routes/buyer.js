const express = require('express');
const ExcelJS = require('exceljs');
const crypto = require('crypto');
const db = require('../db');
const emailService = require('../emailService');
const notificationService = require('../notificationService');
const aiService = require('../aiService');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateOfferStatus } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

function normalizeStr(str) {
    if (!str) return '';
    return str.toLowerCase()
        .replace(/\u0131/g, 'i')
        .replace(/\u011f/g, 'g')
        .replace(/\u00fc/g, 'u')
        .replace(/\u015f/g, 's')
        .replace(/\u00f6/g, 'o')
        .replace(/\u00e7/g, 'c')
        .replace(/i\u0307/g, 'i')
        .trim();
}

router.post('/requests', requireAuth, requireRole('buyer'), asyncHandler(async (req, res) => {
    const { title, items, photo_required, location_required, shipping_note, delivery_address, delivery_lat, delivery_lng, expires_at, asset_ids } = req.body;

    if (!title || !items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Baslik ve en az bir urun gereklidir.' });
    }

    const transaction = db.transaction(() => {
        const projectResult = db.prepare('INSERT INTO projects (buyer_id, name) VALUES (?, ?)').run(req.session.userId, title);
        const projectId = projectResult.lastInsertRowid;

        const reqResult = db.prepare(`
            INSERT INTO requests (buyer_id, project_id, title, photo_required, location_required, shipping_note, delivery_address, delivery_lat, delivery_lng, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(req.session.userId, projectId, title, photo_required ? 1 : 0, location_required ? 1 : 0, shipping_note, delivery_address, delivery_lat, delivery_lng, expires_at || null);

        const requestId = reqResult.lastInsertRowid;

        const insertItem = db.prepare('INSERT INTO request_items (request_id, item_order, properties) VALUES (?, ?, ?)');
        items.forEach((item, index) => {
            insertItem.run(requestId, index + 1, JSON.stringify(item));
        });

        if (asset_ids && Array.isArray(asset_ids)) {
            const attachStmt = db.prepare('INSERT INTO request_attachments (request_id, asset_id) VALUES (?, ?)');
            asset_ids.forEach(assetId => {
                attachStmt.run(requestId, assetId);
            });
        }

        return requestId;
    });

    const requestId = transaction();

    const notifiedSellers = new Set();
    const fullRequestText = normalizeStr(title + ' ' + JSON.stringify(items));

    const sellersByInterests = db.prepare('SELECT DISTINCT u.id, u.email, u.name, si.keyword FROM seller_interests si JOIN users u ON si.seller_id = u.id WHERE u.status = ?').all('active');
    sellersByInterests.forEach(s => {
        if (notifiedSellers.has(s.id)) return;
        if (fullRequestText.includes(normalizeStr(s.keyword))) {
            emailService.notifySellerOfMatch(s.email, s.name, title);
            notifiedSellers.add(s.id);
        }
    });

    items.forEach(item => {
        let desc = '';
        const searchKeys = ['aciklama', 'tanim', 'is', 'urun', 'item'];
        for (const k in item) {
            if (searchKeys.some(sk => normalizeStr(k).includes(sk))) {
                desc = item[k];
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
            WHERE ri.properties LIKE ? AND u.role = 'seller' AND u.status = 'active'
        `).all(`%${normalizedDesc}%`);

        historicalSellers.forEach(s => {
            if (!notifiedSellers.has(s.id)) {
                emailService.notifySellerOfMatch(s.email, s.name, title);
                notifiedSellers.add(s.id);
            }
        });
    });

    res.json({ success: true, requestId });
}));

router.get('/requests', requireAuth, requireRole('buyer'), (req, res) => {
    const requests = db.prepare(`
        SELECT r.*,
        (SELECT COUNT(*) FROM request_items WHERE request_id = r.id) as item_count,
        (SELECT COUNT(*) FROM offers WHERE request_id = r.id) as offer_count
        FROM requests r WHERE buyer_id = ? ORDER BY created_at DESC
    `).all(req.session.userId);
    res.json(requests);
});

router.get('/requests/:id/offers', requireAuth, requireRole('buyer'), (req, res) => {
    const requestId = req.params.id;

    const request = db.prepare('SELECT buyer_id FROM requests WHERE id = ?').get(requestId);
    if (!request || request.buyer_id !== req.session.userId) {
        return res.status(403).json({ error: 'Bu talep size ait degil.' });
    }

    const offers = db.prepare(`
        SELECT o.*, u.name as seller_name, u.company_name as seller_company, u.phone as seller_phone,
        (SELECT SUM(unit_price) FROM offer_items WHERE offer_id = o.id) as total
        FROM offers o
        JOIN users u ON o.seller_id = u.id
        WHERE o.request_id = ?
        ORDER BY o.submitted_at DESC
    `).all(requestId);

    const result = offers.map(offer => {
        const attachments = db.prepare(`
            SELECT ua.* FROM offer_attachments oa
            JOIN user_assets ua ON oa.asset_id = ua.id
            WHERE oa.offer_id = ?
        `).all(offer.id);
        return { ...offer, attachments };
    });

    res.json(result);
});

router.get('/offers/:id', requireAuth, requireRole('buyer'), (req, res) => {
    const offer = db.prepare(`
        SELECT o.*, u.name as seller_name, u.company_name as seller_company, u.phone as seller_phone, r.buyer_id
        FROM offers o
        JOIN users u ON o.seller_id = u.id
        JOIN requests r ON o.request_id = r.id
        WHERE o.id = ?
    `).get(req.params.id);

    if (!offer) return res.status(404).json({ error: 'Teklif bulunamadi.' });
    if (offer.buyer_id !== req.session.userId) return res.status(403).json({ error: 'Bu teklif size ait degil.' });

    const items = db.prepare(`
        SELECT oi.*, ri.properties
        FROM offer_items oi
        JOIN request_items ri ON oi.request_item_id = ri.id
        WHERE oi.offer_id = ?
    `).all(req.params.id);

    res.json({ ...offer, items: items.map(i => ({ ...i, properties: JSON.parse(i.properties) })) });
});

router.post('/offers/:id/status', requireAuth, requireRole('buyer'), validateOfferStatus, (req, res) => {
    const { status } = req.body;

    const offer = db.prepare(`
        SELECT o.seller_id, r.title, o.request_id, r.buyer_id
        FROM offers o
        JOIN requests r ON o.request_id = r.id
        WHERE o.id = ?
    `).get(req.params.id);

    if (!offer) return res.status(404).json({ error: 'Teklif bulunamadi.' });
    if (offer.buyer_id !== req.session.userId) return res.status(403).json({ error: 'Bu teklif size ait degil.' });

    db.prepare('UPDATE offers SET status = ? WHERE id = ?').run(status, req.params.id);

    if (offer) {
        notificationService.createNotification(
            offer.seller_id,
            status === 'accepted' ? 'Teklifiniz Kabul Edildi!' : 'Teklif Reddedildi',
            `"${offer.title}" icin verdiginiz teklif alici tarafindan ${status === 'accepted' ? 'kabul edildi' : 'reddedildi'}.`,
            `/seller/offers/${req.params.id}`,
            true
        );
    }

    res.json({ success: true });
});

router.get('/requests/:id/comparison', requireAuth, requireRole('buyer'), (req, res) => {
    try {
        const requestId = req.params.id;
        const ownReq = db.prepare('SELECT buyer_id FROM requests WHERE id = ?').get(requestId);
        if (!ownReq) return res.status(404).json({ error: 'Talep bulunamadi.' });
        if (ownReq.buyer_id !== req.session.userId) return res.status(403).json({ error: 'Bu talep size ait degil.' });

        const items = db.prepare('SELECT * FROM request_items WHERE request_id = ? ORDER BY item_order').all(requestId);

        const offers = db.prepare(`
            SELECT o.id as offer_id, o.seller_id, u.company_name, u.is_verified,
            (SELECT SUM(unit_price) FROM offer_items WHERE offer_id = o.id) as total_price
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

        const sellerIds = offers.map(o => o.seller_id);
        let ratingMap = {};
        if (sellerIds.length > 0) {
            const placeholders = sellerIds.map(() => '?').join(',');
            const ratings = db.prepare(`
                SELECT seller_id, AVG(rating) as average
                FROM seller_ratings
                WHERE seller_id IN (${placeholders})
                GROUP BY seller_id
            `).all(...sellerIds);
            ratings.forEach(r => { ratingMap[r.seller_id] = r.average; });
        }

        const structuredItems = items.map(it => {
            let properties = {};
            try { properties = JSON.parse(it.properties); } catch(e) {}

            const itemOffers = {};
            offers.forEach(s => {
                const oi = offerItems.find(oi => oi.request_item_id === it.id && oi.seller_id === s.seller_id);
                itemOffers[s.seller_id] = oi ? { price: oi.unit_price } : null;
            });

            return { id: it.id, properties, offers: itemOffers };
        });

        const sellers = offers.map(s => ({
            id: s.seller_id,
            company_name: s.company_name,
            is_verified: s.is_verified,
            rating: ratingMap[s.seller_id] || 0,
            total_price: s.total_price || 0,
            offer_id: s.offer_id
        }));

        res.json({ items: structuredItems, sellers });
    } catch (err) {
        console.error("Comparison Error:", err);
        res.status(500).json({ error: 'Karsilastirma verisi hazirlanamiadi.' });
    }
});

router.get('/requests/:id/excel', requireAuth, requireRole('buyer'), asyncHandler(async (req, res) => {
    const requestId = req.params.id;
    const request = db.prepare('SELECT title, buyer_id FROM requests WHERE id = ?').get(requestId);
    if (!request) return res.status(404).json({ error: 'Talep bulunamadi.' });
    if (request.buyer_id !== req.session.userId) return res.status(403).json({ error: 'Bu talep size ait degil.' });

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
    const sheet = workbook.addWorksheet('Teklif Karsilastirma');

    const headerRow = ['Kalem No', 'Isin Tanimi', 'Birim', 'Miktar'];
    offers.forEach(o => { headerRow.push(`${o.company_name} (TL)`); });
    sheet.addRow(headerRow);

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };

    items.forEach(it => {
        const props = JSON.parse(it.properties);
        const rowData = [
            props['poz'] || props['kalem'] || props['no'] || it.item_order,
            props['aciklama'] || props['tanim'] || props['urun'] || props['item'] || '-',
            props['birim'] || props['unit'] || '-',
            props['miktar'] || props['adet'] || props['qty'] || 0
        ];

        offers.forEach(s => {
            const oi = offerItems.find(oi => oi.request_item_id === it.id && oi.seller_id === s.seller_id);
            rowData.push(oi && oi.unit_price > 0 ? oi.unit_price : 'YOK');
        });

        sheet.addRow(rowData);
    });

    const summaryRow = ['---', 'TOPLAM TEKLIF BEDELI', '---', '---'];
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
}));

const compareAllCache = new Map();
const COMPARE_CACHE_TTL_MS = 10 * 60 * 1000;

router.post('/requests/:id/compare-all', requireAuth, requireRole('buyer'), asyncHandler(async (req, res) => {
    const requestId = req.params.id;

    const ownReq = db.prepare('SELECT buyer_id FROM requests WHERE id = ?').get(requestId);
    if (!ownReq) return res.status(404).json({ error: 'Talep bulunamadi.' });
    if (ownReq.buyer_id !== req.session.userId) return res.status(403).json({ error: 'Bu talep size ait degil.' });

    const offers = db.prepare(`
        SELECT o.*, u.company_name, u.is_verified,
        (SELECT SUM(unit_price) FROM offer_items WHERE offer_id = o.id) as total_price,
        (SELECT AVG(rating) FROM seller_ratings WHERE seller_id = u.id) as rating
        FROM offers o
        JOIN users u ON o.seller_id = u.id
        WHERE o.request_id = ?
    `).all(requestId);

    if (offers.length === 0) return res.status(400).json({ error: 'Henuz teklif yok.' });

    // Cache key: request + offer count + sum of total prices (invalidates on any offer change)
    const cacheKey = `${requestId}:${offers.length}:${offers.reduce((s, o) => s + (o.total_price || 0), 0)}`;
    const cached = compareAllCache.get(cacheKey);
    if (cached && (Date.now() - cached.at) < COMPARE_CACHE_TTL_MS) {
        return res.json({ success: true, report: cached.report, cached: true });
    }

    const request = db.prepare('SELECT title FROM requests WHERE id = ?').get(requestId);

    const analysisPrompt = `
        Asagidaki B2B talebi icin gelen teklifleri analiz et ve "En Mantikli 3 Secenek" raporu sun.
        Talep Basligi: ${request.title}

        Teklifler:
        ${offers.map(o => `- ${o.company_name}: ${o.total_price} TL, Puan: ${o.rating || 'Yok'}, Onayli: ${o.is_verified ? 'Evet' : 'Hayir'}`).join('\n')}

        Lutfen su formatta bir yanit ver:
        1. **Genel Ozet**: Piyasa durumu ve fiyat dagilimi.
        2. **One Cikan Secenekler**: En dusuk fiyat, en yuksek guvenilirlik ve en dengeli teklif.
        3. **Tavsiye**: Aliciya hangi saticiyla ilerlemesini onerirsin ve neden?

        Yaniti profesyonel bir B2B diliyle ve Turkce ver.
    `;

    const report = await aiService.generateAnalysis(analysisPrompt);
    compareAllCache.set(cacheKey, { at: Date.now(), report });
    // Simple LRU-ish eviction
    if (compareAllCache.size > 200) {
        const firstKey = compareAllCache.keys().next().value;
        compareAllCache.delete(firstKey);
    }
    res.json({ success: true, report });
}));

router.post('/requests/:id/invite', requireAuth, requireRole('buyer'), asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'E-posta adresi gereklidir.' });

    const request = db.prepare('SELECT title, buyer_id FROM requests WHERE id = ?').get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Talep bulunamadi.' });
    if (request.buyer_id !== req.session.userId) return res.status(403).json({ error: 'Bu talep size ait degil.' });

    const token = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO invitations (request_id, email, token) VALUES (?, ?, ?)').run(req.params.id, email, token);
    const buyer = db.prepare('SELECT company_name FROM users WHERE id = ?').get(req.session.userId);

    await emailService.sendInvitation(email, buyer.company_name, request.title, token);
    res.json({ success: true });
}));

router.get('/projects', requireAuth, requireRole('buyer'), (req, res) => {
    const projects = db.prepare(`
        SELECT p.*,
        (SELECT COUNT(*) FROM requests WHERE project_id = p.id) as request_count
        FROM projects p
        WHERE p.buyer_id = ?
        ORDER BY p.created_at DESC
    `).all(req.session.userId);
    res.json(projects);
});

router.get('/favorites', requireAuth, requireRole('buyer'), (req, res) => {
    const favorites = db.prepare(`
        SELECT fs.*, u.name, u.company_name, u.email, u.phone, u.is_verified,
        (SELECT AVG(rating) FROM seller_ratings WHERE seller_id = fs.seller_id) as avg_rating,
        (SELECT COUNT(*) FROM seller_ratings WHERE seller_id = fs.seller_id) as rating_count,
        (SELECT COUNT(*) FROM offers WHERE seller_id = fs.seller_id) as total_offers
        FROM favorite_sellers fs
        JOIN users u ON fs.seller_id = u.id
        WHERE fs.buyer_id = ?
        ORDER BY fs.created_at DESC
    `).all(req.session.userId);
    res.json(favorites);
});

router.post('/favorites', requireAuth, requireRole('buyer'), (req, res) => {
    const { seller_id, note } = req.body;
    if (!seller_id) return res.status(400).json({ error: 'Satici ID gereklidir.' });
    try {
        db.prepare('INSERT OR IGNORE INTO favorite_sellers (buyer_id, seller_id, note) VALUES (?, ?, ?)').run(req.session.userId, seller_id, note || '');
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: 'Bu satici zaten favorilerinizde.' });
    }
});

router.delete('/favorites/:sellerId', requireAuth, requireRole('buyer'), (req, res) => {
    db.prepare('DELETE FROM favorite_sellers WHERE buyer_id = ? AND seller_id = ?').run(req.session.userId, req.params.sellerId);
    res.json({ success: true });
});

router.post('/requests/:id/extend', requireAuth, requireRole('buyer'), (req, res) => {
    const { new_expires_at } = req.body;
    if (!new_expires_at) return res.status(400).json({ error: 'Yeni bitis tarihi gereklidir.' });

    const request = db.prepare('SELECT * FROM requests WHERE id = ? AND buyer_id = ?').get(req.params.id, req.session.userId);
    if (!request) return res.status(404).json({ error: 'Talep bulunamadi.' });

    db.prepare('UPDATE requests SET expires_at = ?, status = ? WHERE id = ?').run(new_expires_at, 'active', req.params.id);

    const sellers = db.prepare('SELECT DISTINCT seller_id FROM offers WHERE request_id = ?').all(req.params.id);
    sellers.forEach(s => {
        notificationService.createNotification(s.seller_id, 'Talep Suresi Uzatildi', `"${request.title}" talebinin suresi uzatildi.`, `/seller/requests/${req.params.id}`, true);
    });

    res.json({ success: true });
});

router.get('/stats', requireAuth, requireRole('buyer'), (req, res) => {
    const userId = req.session.userId;
    const totalRequests = db.prepare('SELECT COUNT(*) as count FROM requests WHERE buyer_id = ?').get(userId).count;
    const activeRequests = db.prepare("SELECT COUNT(*) as count FROM requests WHERE buyer_id = ? AND status = 'active'").get(userId).count;
    const totalOffers = db.prepare('SELECT COUNT(*) as count FROM offers o JOIN requests r ON o.request_id = r.id WHERE r.buyer_id = ?').get(userId).count;
    const avgOffersPerRequest = totalRequests > 0 ? (totalOffers / totalRequests).toFixed(1) : 0;
    const acceptedOffers = db.prepare("SELECT COUNT(*) as count FROM offers o JOIN requests r ON o.request_id = r.id WHERE r.buyer_id = ? AND o.status = 'accepted'").get(userId).count;

    const monthlyData = db.prepare(`
        SELECT strftime('%Y-%m', r.created_at) as month,
        COUNT(DISTINCT r.id) as requests,
        COUNT(DISTINCT o.id) as offers
        FROM requests r
        LEFT JOIN offers o ON r.id = o.request_id
        WHERE r.buyer_id = ?
        GROUP BY month ORDER BY month DESC LIMIT 6
    `).all(userId);

    res.json({ totalRequests, activeRequests, totalOffers, avgOffersPerRequest, acceptedOffers, monthlyData: monthlyData.reverse() });
});

module.exports = router;
