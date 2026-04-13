const db = require('./db');
const emailService = require('./emailService');

function getFrontendUrl() {
    return process.env.FRONTEND_URL || 'http://localhost:4321';
}

async function createNotification(userId, title, message, link = null, sendEmailFlag = false) {
    try {
        db.prepare(`
            INSERT INTO notifications (user_id, title, message, link)
            VALUES (?, ?, ?, ?)
        `).run(userId, title, message, link);

        if (sendEmailFlag) {
            const user = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
            if (user && user.email) {
                const frontendUrl = getFrontendUrl();
                await emailService.sendEmail({
                    to: user.email,
                    subject: title,
                    html: `<p>Merhaba,</p><p>${message}</p><p>Detaylar icin: <a href="${link ? frontendUrl + link : frontendUrl}">FiyatAl Platformu</a></p>`
                });
            }
        }

        return { success: true };
    } catch (err) {
        console.error("Notification Error:", err.message);
        return { success: false, error: err.message };
    }
}

module.exports = { createNotification };
