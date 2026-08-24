// Serverless function (Vercel). Keeps the Gemini API key secret on the server.
// Deploy this whole folder to Vercel and set the GEMINI_API_KEY environment variable
// in the Vercel project settings (Settings -> Environment Variables).

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB decoded
const MAX_TEXT_LENGTH = 1000;
const MAX_LOCATION_LENGTH = 100;
const MAGIC_BYTES = {
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]],
  "image/gif": [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  ],
};

function matchesSignature(buf, signature) {
  if (buf.length < signature.length) return false;
  return signature.every((byte, i) => buf[i] === byte);
}

function isGenuineImage(buf, declaredType) {
  const signatures = MAGIC_BYTES[declaredType];
  if (!signatures) return false;
  const matchesDeclared = signatures.some((sig) => matchesSignature(buf, sig));
  if (!matchesDeclared) return false;
  if (declaredType === "image/webp") {
    const webpMarker = buf.slice(8, 12).toString("ascii");
    if (webpMarker !== "WEBP") return false;
  }
  return true;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "ยังไม่ได้ตั้งค่า GEMINI_API_KEY บนเซิร์ฟเวอร์ กรุณาตั้งค่าใน Vercel > Settings > Environment Variables",
    });
    return;
  }

  try {
    const { imageBase64, imageMediaType, text, province, district } = req.body || {};

    const trimmedText = (text || "").trim().slice(0, MAX_TEXT_LENGTH);
    const trimmedProvince = (province || "").trim().slice(0, MAX_LOCATION_LENGTH);
    const trimmedDistrict = (district || "").trim().slice(0, MAX_LOCATION_LENGTH);

    if (!imageBase64 && !trimmedText) {
      res.status(400).json({ error: "กรุณาแนบรูปหรือพิมพ์อาการอย่างน้อยหนึ่งอย่าง" });
      return;
    }

    let imageBuffer = null;
    if (imageBase64) {
      try {
        imageBuffer = Buffer.from(imageBase64, "base64");
      } catch (e) {
        res.status(400).json({ error: "ไฟล์รูปไม่ถูกต้อง" });
        return;
      }
      if (imageBuffer.length === 0 || imageBuffer.length > MAX_IMAGE_BYTES) {
        res.status(400).json({ error: "ไฟล์รูปใหญ่เกินไปหรือไม่ถูกต้อง (ไม่เกิน 8MB)" });
        return;
      }
      if (!isGenuineImage(imageBuffer, imageMediaType)) {
        res.status(400).json({ error: "รองรับเฉพาะไฟล์รูปภาพ JPG, PNG, WEBP หรือ GIF เท่านั้น" });
        return;
      }
    }

    const parts = [];
    if (imageBase64) {
      parts.push({
        inlineData: {
          mimeType: imageMediaType,
          data: imageBase64,
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

    const model = "gemini-1.5-flash";
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            maxOutputTokens: 1200,
            temperature: 0.2,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const detail = await geminiRes.text();
      res.status(502).json({ error: "เชื่อมต่อระบบวิเคราะห์ไม่สำเร็จ กรุณาลองใหม่", detail });
      return;
    }

    const data = await geminiRes.json();
    const textOut = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textOut) {
      res.status(502).json({ error: "ไม่ได้รับคำตอบจากระบบวิเคราะห์ กรุณาลองใหม่" });
      return;
    }

    let cleaned = textOut.replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      cleaned = cleaned.slice(start, end + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      res.status(502).json({ error: "ผลวิเคราะห์ไม่สมบูรณ์ กรุณาลองใหม่อีกครั้ง" });
      return;
    }

    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: "เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่", detail: String(err) });
  }
};
