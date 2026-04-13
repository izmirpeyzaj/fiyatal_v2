const rateLimitStore = new Map();

function rateLimit({ windowMs = 60000, max = 20, message = 'Cok fazla istek gonderdiniz. Lutfen bekleyin.' } = {}) {
    return (req, res, next) => {
        const key = req.ip || req.connection.remoteAddress;
        const now = Date.now();
        const windowStart = now - windowMs;

        if (!rateLimitStore.has(key)) {
            rateLimitStore.set(key, []);
        }

        const requests = rateLimitStore.get(key).filter(ts => ts > windowStart);
        requests.push(now);
        rateLimitStore.set(key, requests);

        if (requests.length > max) {
            return res.status(429).json({ error: message });
        }

        next();
    };
}

setInterval(() => {
    const cutoff = Date.now() - 120000;
    for (const [key, timestamps] of rateLimitStore) {
        const filtered = timestamps.filter(ts => ts > cutoff);
        if (filtered.length === 0) {
            rateLimitStore.delete(key);
        } else {
            rateLimitStore.set(key, filtered);
        }
    }
}, 60000);

module.exports = { rateLimit };
