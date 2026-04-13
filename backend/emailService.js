const nodemailer = require('nodemailer');
const db = require('./db');

/**
 * Creates a transporter based on the current SMTP config in the database.
 */
async function createTransporter() {
    const config = db.prepare('SELECT * FROM smtp_config WHERE id = 1').get();
    
    if (!config || config.host === 'smtp.example.com') {
        console.warn('SMTP is not configured or using placeholder. Emails will not be sent.');
        return null;
    }

    return nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure === 1,
        auth: {
            user: config.user,
            pass: config.pass
        }
    });
}

/**
 * Generic send function
 */
async function sendEmail({ to, subject, html }) {
    try {
        const transporter = await createTransporter();
        if (!transporter) return;

        const config = db.prepare('SELECT from_name, from_email FROM smtp_config WHERE id = 1').get();

        const info = await transporter.sendMail({
            from: `"${config.from_name}" <${config.from_email}>`,
            to,
            subject,
            html
        });

        console.log('Email sent: %s', info.messageId);
    } catch (err) {
        console.error('Email sending failed:', err);
    }
}

/**
 * Notify Buyer when an offer is received
 */
async function notifyBuyerOfOffer(buyerEmail, buyerName, requestTitle, sellerCompany) {
    const html = `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <h2 style="color: #2563eb;">Yeni Teklif Alındı!</h2>
            <p>Merhaba <strong>${buyerName}</strong>,</p>
            <p><strong>"${requestTitle}"</strong> başlıklı talebiniz için <strong>${sellerCompany}</strong> tarafından yeni bir fiyat teklifi verildi.</p>
            <p>Teklifi incelemek için hemen sisteme giriş yapabilirsiniz.</p>
            <a href="http://localhost:4321/login" style="display: inline-block; padding: 10px 20px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 5px; margin-top: 10px;">Teklifleri Gör</a>
            <p style="color: #64748b; font-size: 12px; margin-top: 20px;">FiyatAl B2B Platformu</p>
        </div>
    `;
    await sendEmail({
        to: buyerEmail,
        subject: `Yeni Teklif: ${requestTitle}`,
        html
    });
}

/**
 * Notify Seller when a request matches their keywords
 */
async function notifySellerOfMatch(sellerEmail, sellerName, requestTitle) {
    const html = `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <h2 style="color: #2563eb;">Yeni Fiyat Talebi!</h2>
            <p>Merhaba <strong>${sellerName}</strong>,</p>
            <p>İlgi alanınıza giren yeni bir talep yayınlandı: <strong>"${requestTitle}"</strong></p>
            <p>Hemen teklif vererek avantaj sağlayabilirsiniz.</p>
            <a href="http://localhost:4321/login" style="display: inline-block; padding: 10px 20px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 5px; margin-top: 10px;">Talebi İncele</a>
            <p style="color: #64748b; font-size: 12px; margin-top: 20px;">FiyatAl B2B Platformu</p>
        </div>
    `;
    await sendEmail({
        to: sellerEmail,
        subject: `İlginizi Çekebilir: ${requestTitle}`,
        html
    });
}

/**
 * Send invitation to acquaintance
 */
async function sendInvitation(toEmail, buyerCompany, requestTitle, token) {
    const inviteUrl = `http://localhost:4321/register?invite=${token}`;
    const html = `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <h2 style="color: #2563eb;">Fiyat Teklifi Daveti</h2>
            <p>Merhaba,</p>
            <p><strong>${buyerCompany}</strong>, <strong>"${requestTitle}"</strong> projesi için sizden fiyat teklifi bekliyor.</p>
            <p>Sisteme üye olarak bu talebe ve diğer tüm b2b fırsatlarına kutulabilirsiniz.</p>
            <a href="${inviteUrl}" style="display: inline-block; padding: 10px 20px; background-color: #21c55d; color: white; text-decoration: none; border-radius: 5px; margin-top: 10px;">Üye Ol & Teklif Ver</a>
            <p style="color: #64748b; font-size: 12px; margin-top: 20px;">FiyatAl B2B Platformu</p>
        </div>
    `;
    await sendEmail({
        to: toEmail,
        subject: `${buyerCompany} Sizi Fiyat Vermeye Davet Ediyor`,
        html
    });
}

/**
 * Send daily summary of notifications
 */
async function sendDailySummary(toEmail, userName, notifications) {
    if (!notifications || notifications.length === 0) return;

    const itemsHtml = notifications.map(n => `
        <div style="padding: 10px; border-bottom: 1px solid #f1f5f9;">
            <p style="margin: 0; font-weight: bold; color: #0f172a; font-size: 14px;">${n.title}</p>
            <p style="margin: 4px 0 0; color: #64748b; font-size: 12px;">${n.message}</p>
        </div>
    `).join('');

    const html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
            <div style="background-color: #2563eb; padding: 24px; text-align: center;">
                <h1 style="color: white; margin: 0; font-size: 20px;">Günlük Özet Raporu</h1>
                <p style="color: rgba(255,255,255,0.8); margin: 8px 0 0; font-size: 14px;">Son 24 saatteki önemli gelişmeler</p>
            </div>
            <div style="padding: 24px;">
                <p style="margin: 0 0 20px; font-size: 14px; color: #475569;">Merhaba <strong>${userName}</strong>, işte dünün özeti:</p>
                <div style="border: 1px solid #f1f5f9; border-radius: 12px; overflow: hidden;">
                    ${itemsHtml}
                </div>
                <div style="text-align: center; margin-top: 24px;">
                    <a href="http://localhost:4321/login" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 14px;">Paneli Görüntüle</a>
                </div>
            </div>
            <div style="background-color: #f8fafc; padding: 16px; text-align: center; border-top: 1px solid #e2e8f0;">
                <p style="color: #94a3b8; font-size: 11px; margin: 0;">FiyatAl B2B Platformu • Bu e-posta otomatik olarak oluşturulmuştur.</p>
            </div>
        </div>
    `;

    await sendEmail({
        to: toEmail,
        subject: `Günlük Özet: ${notifications.length} Yeni Bildiriminiz Var`,
        html
    });
}

module.exports = {
    notifyBuyerOfOffer,
    notifySellerOfMatch,
    sendInvitation,
    sendDailySummary
};
