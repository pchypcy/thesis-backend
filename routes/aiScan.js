// routes/aiScan.js — InGreen Sprint 5 (AI Receipt Scan)
//
// Endpoints:
//   GET  /api/ai-scan/quota/:username        → สถานะโควต้าปัจจุบัน
//   POST /api/ai-scan/receipt                → สแกนใบเสร็จด้วย AI vision
//
// Rate limit:
//   VIP        → 20 ครั้ง/วัน  (reset เที่ยงคืน Bangkok)
//   Free user  → 1 ครั้ง/2 วัน  (rolling 48h cooldown)
//
// AI provider (เลือกอัตโนมัติตาม env key):
//   1) GEMINI_API_KEY    → Google Gemini vision  (ฟรี — แนะนำ)
//   2) ANTHROPIC_API_KEY → Claude vision         (เสียเงิน)
//   3) ไม่มี key เลย       → mock demo             (ระบบไม่พัง)
// ปรับ model ได้ผ่าน env: GEMINI_MODEL / AI_SCAN_MODEL

const express   = require('express');
const axios     = require('axios');
const router    = express.Router();
const ScanQuota = require('../models/ScanQuota');
const VipSubscription = require('../models/VipSubscription');
const { getConfig } = require('./config');

const ANTHROPIC_URL   = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VER   = '2023-06-01';
const DEFAULT_MODEL   = process.env.AI_SCAN_MODEL || 'claude-sonnet-5';

// Google Gemini (ฟรี — สร้าง key ที่ aistudio.google.com ไม่ต้องผูกบัตร)
const GEMINI_MODEL    = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const geminiUrl = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

// เลือก provider อัตโนมัติ: Gemini (ฟรี) มาก่อน → Claude → mock
const hasAIKey   = () => !!(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY);
const activeName = () => process.env.GEMINI_API_KEY ? 'gemini' : (process.env.ANTHROPIC_API_KEY ? 'claude' : 'mock');
const activeModel = () => process.env.GEMINI_API_KEY ? GEMINI_MODEL : (process.env.ANTHROPIC_API_KEY ? DEFAULT_MODEL : null);

async function checkVip(username) {
    const sub = await VipSubscription.findOne({ username });
    return sub ? sub.isActive : false;
}

// ── ดึง base64 ล้วน + media type จาก data-URL ("data:image/jpeg;base64,....") ──
function stripDataUrl(b64, fallbackMime) {
    if (!b64) return { data: '', media: fallbackMime || 'image/jpeg' };
    const m = /^data:([^;]+);base64,(.*)$/s.exec(b64);
    if (m) return { data: m[2], media: m[1] };
    return { data: b64, media: fallbackMime || 'image/jpeg' };
}

// ── แปลงผล extract ให้อยู่ในรูปแบบเดียวกัน + คำนวณ Green Score ──
function normalizeReceipt(raw) {
    if (!raw || !Array.isArray(raw.items) || raw.items.length === 0) {
        throw new Error('no_items_extracted');
    }
    const items = raw.items.map((it) => ({
        name:  String(it.name || '').trim() || 'รายการสินค้า',
        qty:   Math.max(1, Math.round(Number(it.qty) || 1)),
        price: Math.max(0, Math.round((Number(it.price) || 0) * 100) / 100),
        eco:   !!it.eco,
        reason: it.reason ? String(it.reason).slice(0, 120) : '',
    }));
    const ecoCount = items.filter((it) => it.eco).length;
    const greenScore = Math.round((ecoCount / items.length) * 100);
    let total = Number(raw.total);
    if (!isFinite(total) || total <= 0) {
        total = items.reduce((s, it) => s + it.price * it.qty, 0);
    }
    return {
        merchantName: String(raw.merchantName || 'ร้านค้า').slice(0, 80),
        date:         raw.date || new Date().toISOString().slice(0, 10),
        items,
        total:        Math.round(total * 100) / 100,
        currency:     raw.currency || 'THB',
        confidence:   typeof raw.confidence === 'number' ? raw.confidence : 0.8,
        greenScore,
        ecoItemCount: ecoCount,
        suggestedPoints: Math.min(100, ecoCount * 10),
    };
}

// ── prompt + ตัวแยก JSON ที่ใช้ร่วมกันทุก provider ────────────────────────
const RECEIPT_PROMPT = [
    'คุณคือผู้ช่วยอ่านใบเสร็จของแอป InGreen อ่านรูปใบเสร็จนี้ (ไทย/อังกฤษ) แล้วส่งกลับเป็น JSON เท่านั้น',
    'ห้ามมีข้อความอื่นนอก JSON, ห้ามใส่ ```',
    'โครงสร้าง:',
    '{',
    '  "merchantName": "ชื่อร้าน",',
    '  "date": "YYYY-MM-DD หรือ null",',
    '  "currency": "THB",',
    '  "items": [{ "name": "ชื่อสินค้า", "qty": จำนวน, "price": ราคารวมของบรรทัดนั้นเป็นบาท, "eco": true/false, "reason": "เหตุผลสั้นๆ" }],',
    '  "total": ยอดรวมเป็นตัวเลข,',
    '  "confidence": 0.0-1.0',
    '}',
    'กำหนด eco=true เมื่อสินค้าเป็นมิตรต่อสิ่งแวดล้อม/สุขภาพ เช่น ออร์แกนิก, ปลอดสารพิษ, plant-based/มังสวิรัติ, free-range/ไข่อารมณ์ดี, โฮลเกรน/โฮลวีต, ผักผลไม้สด, สินค้ารีฟิล/ลดบรรจุภัณฑ์, ถุงผ้า',
    'eco=false เมื่อเป็นของแปรรูปสูง, น้ำอัดลม/ขนมหวาน, พลาสติกใช้ครั้งเดียว',
    'ถ้าอ่านราคาไม่ชัดให้ประมาณการและลด confidence ถ้ารูปไม่ใช่ใบเสร็จให้ items เป็น []',
].join('\n');

function parseReceiptJson(text, ctx = '') {
    const raw = (text || '').trim();
    if (!raw) throw new Error(`empty_response${ctx ? '(' + ctx + ')' : ''}`);
    let jsonStr = raw;
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(jsonStr);
    if (fence) jsonStr = fence[1].trim();
    else {
        const s = jsonStr.indexOf('{'), e = jsonStr.lastIndexOf('}');
        if (s !== -1 && e !== -1) jsonStr = jsonStr.slice(s, e + 1);
    }
    let parsed;
    try { parsed = JSON.parse(jsonStr); }
    catch (e) {
        const head = raw.slice(0, 160).replace(/\s+/g, ' ');
        throw new Error(`parse_failed${ctx ? '(' + ctx + ')' : ''} head="${head}"`);
    }
    return normalizeReceipt(parsed);
}

// ── Google Gemini vision OCR (ฟรี — ไม่ต้องผูกบัตร) ───────────────────────
async function geminiOCR(imageBase64, mimeType) {
    const { data: b64, media } = stripDataUrl(imageBase64, mimeType);
    if (!b64) throw new Error('empty_image');
    const mediaType = mimeType || media || 'image/jpeg';

    const resp = await axios.post(`${geminiUrl(GEMINI_MODEL)}?key=${process.env.GEMINI_API_KEY}`, {
        contents: [{
            parts: [
                { inline_data: { mime_type: mediaType, data: b64 } },
                { text: RECEIPT_PROMPT },
            ],
        }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192, responseMimeType: 'application/json' },
    }, {
        headers: { 'content-type': 'application/json' },
        timeout: 25000,   // ถ้าเกินนี้ handler จะ fallback เป็น mock (ผู้ใช้ยังเห็นผลลัพธ์)
    });

    const cand = resp.data?.candidates?.[0];
    const finish = cand?.finishReason || 'none';
    const text = (cand?.content?.parts || [])
        .map((p) => p.text).filter(Boolean).join('\n');
    return parseReceiptJson(text, `gemini finish=${finish},len=${text.length}`);
}

// ── Claude vision OCR (ทางเลือก — ต้องเติมเครดิต) ─────────────────────────
async function claudeOCR(imageBase64, mimeType) {
    const { data: b64, media } = stripDataUrl(imageBase64, mimeType);
    if (!b64) throw new Error('empty_image');
    const mediaType = mimeType || media || 'image/jpeg';

    const resp = await axios.post(ANTHROPIC_URL, {
        model: DEFAULT_MODEL,
        max_tokens: 1500,
        messages: [{
            role: 'user',
            content: [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
                { type: 'text', text: RECEIPT_PROMPT },
            ],
        }],
    }, {
        headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': ANTHROPIC_VER,
            'content-type': 'application/json',
        },
        timeout: 28000,
    });

    const text = (resp.data?.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    return parseReceiptJson(text);
}

// ── Mock OCR (fallback สำหรับ demo / dev ที่ไม่มี AI key) ─────────────────
function mockOCR() {
    return normalizeReceipt({
        merchantName: 'Lemon Farm สาขาสุขุมวิท',
        date:         new Date().toISOString().slice(0, 10),
        currency:     'THB',
        items: [
            { name: 'นมข้าวโอ๊ตออร์แกนิก 1L',            price: 89,  qty: 1, eco: true,  reason: 'ออร์แกนิก plant-based' },
            { name: 'ขนมปังโฮลวีต 400g',                  price: 65,  qty: 1, eco: true,  reason: 'โฮลวีต' },
            { name: 'ไข่ไก่อารมณ์ดี Free-Range 10 ฟอง',   price: 119, qty: 1, eco: true,  reason: 'free-range' },
            { name: 'น้ำอัดลม 1.5L',                       price: 32,  qty: 1, eco: false, reason: 'น้ำตาลสูง' },
        ],
        total: 305,
        confidence: 0.94,
    });
}

// performOCR: เลือก provider อัตโนมัติ — Gemini (ฟรี) → Claude → mock
//   (visionOCR อาจ throw เมื่ออ่านไม่ได้ → handler จะคืนโควตาให้)
async function performOCR(imageBase64, mimeType) {
    if (process.env.GEMINI_API_KEY)    return await geminiOCR(imageBase64, mimeType);
    if (process.env.ANTHROPIC_API_KEY) return await claudeOCR(imageBase64, mimeType);
    return mockOCR();
}

// ── GET /api/ai-scan/quota/:username ─────────────────────────────────────
router.get('/quota/:username', async (req, res) => {
    try {
        const { username } = req.params;
        if (!username) return res.status(400).json({ success: false, message: 'กรุณาระบุ username' });

        const [isVip, vipPerDay, freeCoolHours] = await Promise.all([
            checkVip(username),
            getConfig('AI_SCAN_VIP_PER_DAY', 20),
            getConfig('AI_SCAN_FREE_COOL_HOURS', 48),
        ]);

        const status = await ScanQuota.getStatus(username, isVip, { vipPerDay, freeCoolHours });
        return res.json({ success: true, ...status });
    } catch (err) {
        console.error('AI Quota Error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
    }
});

// ── POST /api/ai-scan/receipt ────────────────────────────────────────────
// Body: { username, imageBase64?, mimeType? }
router.post('/receipt', async (req, res) => {
    try {
        const { username, imageBase64, mimeType } = req.body || {};

        if (!username) {
            return res.status(400).json({ success: false, message: 'กรุณาส่ง username' });
        }
        if (hasAIKey() && !imageBase64) {
            return res.status(400).json({ success: false, message: 'กรุณาส่งรูปใบเสร็จ' });
        }

        const [isVip, vipPerDay, freeCoolHours] = await Promise.all([
            checkVip(username),
            getConfig('AI_SCAN_VIP_PER_DAY', 20),
            getConfig('AI_SCAN_FREE_COOL_HOURS', 48),
        ]);

        // ── Atomic quota consume ก่อนเรียก OCR (ป้องกัน race) ──
        const quota = await ScanQuota.tryConsume(username, isVip, { vipPerDay, freeCoolHours });

        if (!quota.ok) {
            return res.status(429).json({
                success:   false,
                quotaExceeded: true,
                reason:    quota.reason,
                limit:     quota.limit,
                used:      quota.used,
                remaining: quota.remaining,
                retryAfter: quota.retryAfter,
                nextAvailableAt: quota.nextAvailableAt || null,
                hint:      quota.hint || null,
                message:   quota.reason === 'VIP_DAILY_LIMIT'
                    ? `วันนี้ใช้ AI สแกนใบเสร็จครบ ${quota.limit} ครั้งแล้ว — รีเซ็ตเที่ยงคืน`
                    : 'Free user ใช้ AI สแกนได้ 1 ครั้ง/2 วัน — อัปเกรด VIP เพื่อใช้ได้ 20 ครั้ง/วัน',
            });
        }

        // ── Run OCR — ต้องมีผลลัพธ์เสมอ ห้ามโยน error ให้ผู้ใช้ ──
        const t0 = Date.now();
        let ocrResult, usedFallback = false;
        try {
            ocrResult = await performOCR(imageBase64, mimeType);
        } catch (ocrErr) {
            // AI ช้า/ล้มเหลว → คืนโควตา + ใช้ผลตัวอย่างแทน (ผู้ใช้ยังเห็นผลลัพธ์ ไม่เจอ error)
            const apiMsg = ocrErr.response?.data?.error?.message;
            console.error(`🧾 AI scan fell back to mock: ${username} | ${ocrErr.message || 'ocr_error'}${apiMsg ? ' | ' + apiMsg : ''}`);
            try { await ScanQuota.refund(username, isVip); } catch {}
            ocrResult = mockOCR();
            usedFallback = true;
        }
        const latencyMs = Date.now() - t0;
        const usingAI = hasAIKey();

        console.log(`🧾 AI scan: ${username} | ${isVip ? 'VIP' : 'FREE'} | ${usedFallback ? 'mock-fallback' : activeName()} | items=${ocrResult.items.length} | green=${ocrResult.greenScore}% | ${latencyMs}ms`);

        return res.json({
            success: true,
            quota: {
                limit:     quota.limit,
                used:      quota.used,
                remaining: quota.remaining,
                isVip:     quota.isVip,
                nextAvailableAt: quota.nextAvailableAt || null,
            },
            receipt: ocrResult,
            meta: { latencyMs, mock: !usingAI || usedFallback, fallback: usedFallback, provider: activeName(), model: activeModel() },
        });

    } catch (err) {
        console.error('AI Scan Error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการสแกนใบเสร็จ' });
    }
});

module.exports = router;
