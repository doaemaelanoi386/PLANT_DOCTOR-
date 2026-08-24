// Serverless function (Vercel). Keeps the Gemini API key secret on the server.
// Deploy this whole folder to Vercel and set the GEMINI_API_KEY environment variable
// in the Vercel project settings (Settings -> Environment Variables).

// Allowed image types and their real file "magic bytes" — checked against the
// actual decoded bytes, not the filename or the client-declared MIME type,
// since either of those can be spoofed to smuggle a non-image file through.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB decoded
const MAX_TEXT_LENGTH = 1000;
const MAX_LOCATION_LENGTH = 100;
const MAGIC_BYTES = {
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]], // "RIFF"; WEBP marker follows at byte 8
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
  if (!signatures) return false; // unsupported / unrecognized declared type
  const matchesDeclared = signatures.some((sig) => matchesSignature(buf, sig));
  if (!matchesDeclared) return false;
  if (declaredType === "image/webp") {
    // RIFF containers are shared by other formats too — confirm the WEBP marker at offset 8
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
        inline_data: {
          mime_type: imageMediaType,
          data: imageBase64,
        },
      });
    }

    const prompt = `คุณคือนักวิชาการโรคพืชและกีฏวิทยาการเกษตรผู้เชี่ยวชาญของไทย ทำหน้าที่วินิจฉัยโรคและแมลงศัตรูพืชให้เกษตรกรจากภาพถ่ายและ/หรือคำอธิบายอาการ

ข้อมูลเพิ่มเติมจากเกษตรกร:
- อาการ/คำอธิบาย: ${trimmedText ? trimmedText : "(ไม่มีคำอธิบาย มีเฉพาะภาพ)"}
- พื้นที่: ${trimmedProvince && trimmedDistrict ? `${trimmedDistrict} จังหวัด${trimmedProvince}` : trimmedProvince ? `จังหวัด${trimmedProvince}` : "(ไม่ระบุพื้นที่)"}

ใช้ข้อมูลพื้นที่เพื่อพิจารณาโรค/แมลงที่มักพบในภูมิศาสตร์นั้น ช่วยวินิจฉัยแม่นยำขึ้น

ตอบกลับเป็น JSON เท่านั้น ห้ามมีข้อความอื่นนอกเหนือจาก JSON ห้ามใส่ markdown fence ใช้ schema นี้เท่านั้น:
{
  "problem_name_th": "ชื่อโรค/แมลงภาษาไทย",
  "problem_name_sci": "ชื่อวิทยาศาสตร์หรือชื่อสามัญ ถ้าไม่ทราบให้เว้นว่าง",
  "category": "disease | pest | nutrient | unclear",
  "confidence": "high | medium | low",
  "symptoms": "อธิบายอาการที่พบ 1-2 ประโยค เชื่อมโยงกับสิ่งที่เห็นในภาพ/คำอธิบาย",
  "cause": "สาเหตุของปัญหา 1-2 ประโยค",
  "organic_control": ["วิธีป้องกันกำจัดแบบอินทรีย์/เขตกรรม ข้อละสั้นกระชับ ทำได้จริง"],
  "chemical_control": ["สารป้องกันกำจัดตามหลักวิชาการ ระบุกลุ่มสารหรือชื่อสามัญ พร้อมข้อควรระวังสั้นๆ"],
  "prevention": ["วิธีป้องกันไม่ให้เกิดซ้ำในรอบถัดไป"],
  "need_more_info": "ถ้าข้อมูลไม่พอให้วินิจฉัยแม่นยำ ให้ระบุว่าควรถ่ายภาพเพิ่มมุมไหนหรือให้ข้อมูลอะไรเพิ่ม ถ้าเพียงพอแล้วให้เว้นว่าง"
}

ถ้าภาพหรือข้อความไม่เกี่ยวข้องกับพืช/การเกษตรเลย ให้ตั้ง category เป็น "unclear" และอธิบายใน need_more_info 
ตอบให้กระชับ เน้นใช้ได้จริงในภาคสนาม เกษตรกรอ่านแล้วลงมือทำได้ทันที`;

    parts.push({ text: prompt });

    const model = "gemini-2.5-flash";
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            maxOutputTokens: 2000,
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
