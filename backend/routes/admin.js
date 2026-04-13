const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../db');
const emailService = require('../emailService');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

router.get('/stats', requireAuth, requireRole('admin'), (req, res) => {
    const stats = {
        total_buyers: db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'buyer'").get().count,
        total_sellers: db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'seller'").get().count,
        active_requests: db.prepare("SELECT COUNT(*) as count FROM requests WHERE status = 'active'").get().count,
        total_offers: db.prepare("SELECT COUNT(*) as count FROM offers").get().count
    };
    res.json(stats);
});

router.get('/users', requireAuth, requireRole('admin'), (req, res) => {
    const role = req.query.role;
    if (!role || !['buyer', 'seller', 'admin'].includes(role)) {
        return res.status(400).json({ error: 'Gecerli bir rol belirtin.' });
    }
    const users = db.prepare(`
        SELECT id, name, email, phone, company_name, role, status, is_verified, created_at,
        (SELECT COUNT(*) FROM requests WHERE buyer_id = users.id) as request_count,
        (SELECT COUNT(*) FROM offers WHERE seller_id = users.id) as offer_count
        FROM users WHERE role = ?
    `).all(role);
    res.json(users);
});

router.post('/users/:id/status', requireAuth, requireRole('admin'), (req, res) => {
    const { status } = req.body;
    if (!status || !['active', 'blocked'].includes(status)) {
        return res.status(400).json({ error: 'Gecerli bir durum belirtin (active veya blocked).' });
    }
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.id);
    res.json({ success: true });
});

router.post('/users/:id/verify', requireAuth, requireRole('admin'), (req, res) => {
    const { is_verified } = req.body;
    db.prepare('UPDATE users SET is_verified = ? WHERE id = ?').run(is_verified ? 1 : 0, req.params.id);
    res.json({ success: true });
});

router.get('/requests', requireAuth, requireRole('admin'), (req, res) => {
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

router.get('/projects', requireAuth, requireRole('admin'), (req, res) => {
    const projects = db.prepare(`
        SELECT p.*, u.company_name as buyer_company,
        (SELECT COUNT(*) FROM requests WHERE project_id = p.id) as request_count
        FROM projects p
        JOIN users u ON p.buyer_id = u.id
        ORDER BY p.created_at DESC
    `).all();
    res.json(projects);
});

router.get('/export/excel', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
    const workbook = new ExcelJS.Workbook();

    const sheet = workbook.addWorksheet('Talepler ve Teklifler');
    sheet.columns = [
        { header: 'Talep ID', key: 'id', width: 10 },
        { header: 'Talep Basligi', key: 'title', width: 30 },
        { header: 'Alici Sirket', key: 'buyer_company', width: 25 },
        { header: 'Durum', key: 'status', width: 15 },
        { header: 'Teklif Sayisi', key: 'offer_count', width: 15 },
        { header: 'Olusturma Tarihi', key: 'created_at', width: 20 }
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

    if (status) { query += " AND r.status = ?"; params.push(status); }
    if (buyer_id) { query += " AND r.buyer_id = ?"; params.push(buyer_id); }
    if (date_from) { query += " AND r.created_at >= ?"; params.push(date_from); }
    if (date_to) { query += " AND r.created_at <= ?"; params.push(date_to); }

    const requests = db.prepare(query + " ORDER BY r.created_at DESC").all(...params);
    requests.forEach(r => sheet.addRow(r));

    const itemsSheet = workbook.addWorksheet('Urun Kalemleri');
    itemsSheet.columns = [
        { header: 'Talep ID', key: 'request_id', width: 10 },
        { header: 'Urun Ozellikleri', key: 'properties', width: 50 },
        { header: 'Ortalama Birim Fiyat (TL)', key: 'avg_price', width: 25 },
        { header: 'En Dusuk Fiyat (TL)', key: 'min_price', width: 20 }
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
}));

router.get('/export/all', requireAuth, requireRole('admin'), (req, res) => {
    const data = {
        users: db.prepare('SELECT id, name, company_name, email, phone, role, status, created_at FROM users').all(),
        requests: db.prepare('SELECT * FROM requests').all(),
        offers: db.prepare('SELECT * FROM offers').all()
    };
    res.json(data);
});

router.get('/smtp', requireAuth, requireRole('admin'), (req, res) => {
    const config = db.prepare('SELECT host, port, user, secure, from_name, from_email FROM smtp_config WHERE id = 1').get();
    res.json(config);
});

router.post('/smtp', requireAuth, requireRole('admin'), (req, res) => {
    const { host, port, user, pass, secure, from_name, from_email } = req.body;
    if (!host || !port || !user) {
        return res.status(400).json({ error: 'SMTP host, port ve kullanici gereklidir.' });
    }
    db.prepare(`
        UPDATE smtp_config SET host=?, port=?, user=?, pass=?, secure=?, from_name=?, from_email=?
        WHERE id = 1
    `).run(host, port, user, pass, secure ? 1 : 0, from_name, from_email);
    res.json({ success: true });
});

router.post('/debug/daily-summary', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
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
}));

module.exports = router;
