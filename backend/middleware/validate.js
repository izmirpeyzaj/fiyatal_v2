function validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(String(email).toLowerCase());
}

function validatePassword(password) {
    return typeof password === 'string' && password.length >= 8;
}

function validateRegister(req, res, next) {
    const { name, email, password, role } = req.body;
    const errors = [];

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
        errors.push('Ad Soyad en az 2 karakter olmalidir.');
    }
    if (!email || !validateEmail(email)) {
        errors.push('Gecerli bir e-posta adresi girin.');
    }
    if (!password || !validatePassword(password)) {
        errors.push('Sifre en az 8 karakter olmalidir.');
    }
    if (!role || !['buyer', 'seller'].includes(role)) {
        errors.push('Gecerli bir rol secin (buyer veya seller).');
    }

    if (errors.length > 0) {
        return res.status(400).json({ error: errors[0] });
    }
    next();
}

function validateLogin(req, res, next) {
    const { email, password } = req.body;
    if (!email || !validateEmail(email)) {
        return res.status(400).json({ error: 'Gecerli bir e-posta adresi girin.' });
    }
    if (!password || password.length === 0) {
        return res.status(400).json({ error: 'Sifre gereklidir.' });
    }
    next();
}

function validateOfferStatus(req, res, next) {
    const { status } = req.body;
    if (!status || !['accepted', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'Gecerli bir durum secin (accepted veya rejected).' });
    }
    next();
}

module.exports = { validateRegister, validateLogin, validateOfferStatus, validateEmail };
