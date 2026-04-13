function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

function errorHandler(err, req, res, _next) {
    console.error(`[${new Date().toISOString()}] Error:`, err.message);
    if (process.env.NODE_ENV !== 'production') {
        console.error(err.stack);
    }

    const statusCode = err.statusCode || 500;
    const message = statusCode === 500 ? 'Sunucu hatasi olustu.' : err.message;

    res.status(statusCode).json({ error: message });
}

module.exports = { asyncHandler, errorHandler };
