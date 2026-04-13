const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function analyzeOffer(offerData, requestDetails) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
        Sen bir B2B satın alma uzmanısın. Aşağıdaki ihale talebi ve gelen teklifi analiz edip alıcıya "En Mantıklı Seçim" raporu sunmanı istiyorum.
        Analizi profesyonel, yapıcı ve tamamen Türkçe yap.
        
        TALEBİN DETAYLARI:
        Başlık: ${requestDetails.title}
        Nakliye Şartı: ${requestDetails.shipping_note === 'included' ? 'Dahil' : 'Hariç'}
        Gereksinimler: ${requestDetails.photo_required ? 'Fotoğraf Zorunlu' : ''}, ${requestDetails.location_required ? 'Konum Zorunlu' : ''}
        
        TEKLİFİN DETAYLARI:
        Satıcı Şirket: ${offerData.company_name}
        Satıcı Puanı: ${offerData.rating}/5
        Toplam Tutar: ${offerData.total_price} ₺
        Nakliye Durumu: ${offerData.shipping_included ? 'Dahil' : 'Hariç'}
        Satıcı Notu: ${offerData.notes || 'Not eklenmemiş'}
        Fotoğraflar: ${offerData.items.filter(i => i.photo_url).length} adet ürün fotoğrafı eklenmiş.
        
        ANALİZ KRİTERLERİ:
        1. Fiyatın rekabetçiliği (Talebe göre değerlendir).
        2. Satıcının güvenilirliği (Puanı 4 altındaysa uyar).
        3. Nakliye ve lojistik uyumu.
        4. Teknik dökümantasyon (Fotoğrafların varlığı).
        5. Genel Skor (1-100 arası).
        
        ÇIKTI FORMATI (Markdown):
        ### 🤖 AI Analiz Raporu
        
        **Genel Değerlendirme:** [1-2 cümlelik özet]
        
        #### ✅ Güçlü Yönler
        - [X] ...
        
        #### ⚠️ Dikkat Edilmesi Gerekenler
        - [!] ...
        
        #### 📈 Karar Önerisi
        [Alıcıya bu teklifi neden kabul etmesi veya etmemesi gerektiğini söyle]
        
        **Yapay Zeka Skoru:** [SKOR]/100
    `;

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        // Extract score from text using regex
        const scoreMatch = text.match(/Skoru:\s*(\d+)/i) || text.match(/\[(\d+)\]\/100/);
        const score = scoreMatch ? parseInt(scoreMatch[1]) : 70;

        return { text, score };
    } catch (err) {
        console.error("AI Analysis Error:", err);
        throw new Error("AI analizi sırasında bir hata oluştu.");
    }
}

module.exports = { analyzeOffer };
