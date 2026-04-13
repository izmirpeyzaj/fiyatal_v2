const db = require('./db');
const emailService = require('./emailService');

/**
 * Creates a notification for a user and optionally sends an email.
 * @param {number} userId - The target user ID.
 * @param {string} title - Notification title.
 * @param {string} message - Notification content.
 * @param {string} link - Optional link to the relevant page.
 * @param {boolean} sendEmail - Whether to send an email notification as well.
 */
async function createNotification(userId, title, message, link = null, sendEmail = false) {
    try {
        // Insert into database for In-App notification
        db.prepare(`
            INSERT INTO notifications (user_id, title, message, link)
            VALUES (?, ?, ?, ?)
        `).run(userId, title, message, link);

        // Optionally send email
        if (sendEmail) {
            const user = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
            if (user && user.email) {
                await emailService.sendEmail(
                    user.email,
                    title,
                    `Merhaba,\n\n${message}\n\nDetaylar için: ${link ? 'http://localhost:4321' + link : 'FiyatAl Platformu'}`
                );
            }
        }
        
        return { success: true };
    } catch (err) {
        console.error("Notification Error:", err);
        return { success: false, error: err.message };
    }
}

module.exports = { createNotification };
