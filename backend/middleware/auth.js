const requireAuth = (req, res, next) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Yetkisiz erisim.' });
    }
    next();
};

const requireRole = (role) => (req, res, next) => {
    if (req.session.role !== role) {
        return res.status(403).json({ error: 'Bu islem icin yetkiniz yok.' });
    }
    next();
};

module.exports = { requireAuth, requireRole };
