// Serverless function (Vercel)
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // ขยายรองรับสูงสุด 10MB
const MAX_TEXT_LENGTH = 1000;
const MAX_LOCATION_LENGTH = 100;

module.exports = async (req, res) => {
  // รองรับ CORS ให้เรียกจากมือถือได้ทุก OS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY บนเซิร์ฟเวอร์ กรุณาตั้งค่าใน Vercel Settings'
    });
    return;
  }

  try {
    const { imageBase64, imageMediaType, text, province, district } = req.body || {};

    const trimmedText = (text || '').trim().slice(0, MAX_TEXT_LENGTH);
    const trimmedProvince = (province || '').trim().slice(0, MAX_LOCATION_LENGTH);
    const trimmedDistrict = (district || '').trim().slice(0, MAX_LOCATION_LENGTH);

    if (!imageBase64 && !trimmedText) {
      res.status(400).json({ error: 'กรุณาแนบรูปหรือพิมพ์อาการอย่างน้อยหนึ่งอย่าง' });
      return;
    }

    const parts = [];

    if (imageBase64) {
      // 1. ตัด Prefix data:image/...;base64, ออก ทั้งของ iOS และ Android
      let cleanBase64 = imageBase64;
      if (cleanBase64.includes(',')) {
        cleanBase64 = cleanBase64.split(',')[1];
      }
      cleanBase64 = cleanBase64.trim();

      // 2. ปรับ MIME Type ให้มาตรฐาน (หาก Android/iOS ส่ง MIME แปลกๆ มา)
      let mimeType = imageMediaType || 'image/jpeg';
      if (mimeType.includes('heic') || mimeType.includes('heif')) {
        mimeType = 'image/jpeg'; // Fallback สำหรับรูปฟอร์แมต iPhone HEIC
      }

      parts.push({
        inlineData: {
          mimeType: mimeType,
          data: cleanBase64,
        },
      });
    }

    const prompt = `คุณคือนักวิชาการโรคพืชและกีฏวิทยาการเกษตรผู้เชี่ยวชาญของไทย ทำหน้าที่วินิจฉัยโรคและแมลงศัตรูพืชให้เกษตรกรจากภาพถ่ายและ/หรือคำอธิบายอาการ

ข้อมูลเพิ่มเติมจากเกษตรกร:
- อาการ/คำอธิบาย: ${trimmedText ? trimmedText : "(ไม่มีคำอธิบาย มีเฉพาะภาพ)"}
- พื้นที่: ${trimmedProvince && trimmedDistrict ? `${trimmedDistrict} จังหวัด${trimmedProvince}` : trimmedProvince ? `จังหวัด${trimmedProvince}` : "(ไม่ระบุพื้นที่)"}

ตอบกลับเป็น JSON เท่านั้น ห้ามใส่ markdown fence ใช้ schema นี้:
{
  "problem_name_th": "ชื่อโรค/แมลงภาษาไทย",
  "problem_name_sci": "ชื่อวิทยาศาสตร์หรือชื่อสามัญ",
  "category": "disease | pest | nutrient | unclear",
  "confidence": "high | medium | low",
  "symptoms": "อธิบายอาการที่พบ 1 ประโยคสั้นกระชับ",
  "cause": "สาเหตุของปัญหา 1 ประโยค",
  "organic_control": ["วิธีป้องกันกำจัดแบบอินทรีย์/เขตกรรม 1-2 ข้อ"],
  "chemical_control": ["ชื่อสารเคมีที่แนะนำ 1", "ชื่อสารเคมีที่แนะนำ 2"],
  "prevention": ["วิธีป้องกันไม่ให้เกิดซ้ำ"],
  "need_more_info": "ระบุข้อมูลที่ต้องการเพิ่ม (ถ้าข้อมูลพอแล้วให้เว้นว่าง)"
}

สำหรับ chemical_control: ระบุเฉพาะชื่อสารออกฤทธิ์หรือชื่อกลุ่มสารแบบสั้นๆ 2-3 รายการ
ถ้าภาพ/ข้อความไม่เกี่ยวกับเกษตร ตั้ง category เป็น "unclear"`;

    parts.push({ text: prompt });

    // ใช้โมเดล gemini-2.5-flash
    const model = 'gemini-2.5-flash';
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            maxOutputTokens: 1200,
            temperature: 0.2,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const detail = await geminiRes.text();
      console.error('Gemini API Error:', detail);
      res.status(502).json({ error: 'เชื่อมต่อระบบวิเคราะห์ไม่สำเร็จ กรุณาลองใหม่', detail });
      return;
    }

    const data = await geminiRes.json();
    const textOut = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textOut) {
      res.status(502).json({ error: 'ไม่ได้รับคำตอบจากระบบวิเคราะห์ กรุณาลองใหม่' });
      return;
    }

    let cleaned = textOut.replace(/```json|```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      cleaned = cleaned.slice(start, end + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      res.status(502).json({ error: 'ผลวิเคราะห์ไม่สมบูรณ์ กรุณาลองใหม่อีกครั้ง' });
      return;
    }

    res.status(200).json(parsed);
  } catch (err) {
    console.error('System Error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่', detail: String(err) });
  }
};
