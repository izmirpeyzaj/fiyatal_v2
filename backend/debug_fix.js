const Database = require('better-sqlite3');
const db = new Database('fiyatal.db');

const requestId = 1;
try {
    const items = db.prepare('SELECT * FROM request_items WHERE request_id = ? ORDER BY item_order').all(requestId);
    console.log("Items count:", items.length);
    
    const offers = db.prepare(`
        SELECT o.id as offer_id, o.seller_id, u.company_name, u.is_verified, o.total_price 
        FROM offers o
        JOIN users u ON o.seller_id = u.id
        WHERE o.request_id = ?
    `).all(requestId);
    console.log("Offers count:", offers.length);

    const offerItems = db.prepare(`
        SELECT oi.*, o.seller_id 
        FROM offer_items oi
        JOIN offers o ON oi.offer_id = o.id
        WHERE o.request_id = ?
    `).all(requestId);
    console.log("OfferItems count:", offerItems.length);

    const sellers = offers.map(s => {
        const ratingResult = db.prepare('SELECT AVG(rating) as average FROM seller_ratings WHERE seller_id = ?').get(s.seller_id);
        console.log(`Rating for ${s.seller_id}:`, ratingResult);
        return s;
    });

    console.log("Success!");
} catch (err) {
    console.error("DEBUG ERROR:", err);
}
db.close();
