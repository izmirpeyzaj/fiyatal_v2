const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

async function analyzeOffer(offerData, requestDetails) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
        Sen bir B2B satin alma uzmanisin. Asagidaki ihale talebi ve gelen teklifi analiz edip aliciya rapor sun.
        Analizi profesyonel, yapici ve tamamen Turkce yap.

        TALEBIN DETAYLARI:
        Baslik: ${requestDetails.title}
        Nakliye Sarti: ${requestDetails.shipping_note === 'included' ? 'Dahil' : 'Haric'}

        TEKLIFIN DETAYLARI:
        Satici Sirket: ${offerData.company_name}
        Satici Puani: ${offerData.rating}/5
        Toplam Tutar: ${offerData.total_price} TL
        Nakliye Durumu: ${offerData.shipping_included ? 'Dahil' : 'Haric'}
        Satici Notu: ${offerData.notes || 'Not eklenmemis'}
        Fotograflar: ${offerData.items.filter(i => i.photo_url).length} adet urun fotografi eklenmis.

        ANALIZ KRITERLERI:
        1. Fiyatin rekabetciligi
        2. Saticinin guvenilirligi (Puani 4 altindaysa uyar)
        3. Nakliye ve lojistik uyumu
        4. Teknik dokumantasyon
        5. Genel Skor (1-100 arasi)

        CIKTI FORMATI (Markdown):
        ### AI Analiz Raporu

        **Genel Degerlendirme:** [1-2 cumlelik ozet]

        #### Guclu Yonler
        - ...

        #### Dikkat Edilmesi Gerekenler
        - ...

        #### Karar Onerisi
        [Aliciya bu teklifi neden kabul etmesi veya etmemesi gerektigini soyle]

        **Yapay Zeka Skoru:** [SKOR]/100
    `;

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        const scoreMatch = text.match(/Skoru:\s*(\d+)/i) || text.match(/\[(\d+)\]\/100/);
        const score = scoreMatch ? parseInt(scoreMatch[1]) : 70;

        return { text, score };
    } catch (err) {
        console.error("AI Analysis Error:", err);
        throw new Error("AI analizi sirasinda bir hata olustu.");
    }
}

async function generateAnalysis(prompt) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (err) {
        console.error("AI Generation Error:", err);
        throw new Error("AI analizi olusturulamadi.");
    }
}

module.exports = { analyzeOffer, generateAnalysis };
