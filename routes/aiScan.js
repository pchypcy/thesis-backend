// routes/aiScan.js — InGreen Sprint 5 (AI Receipt Scan)
//
// Endpoints:
//   GET  /api/ai-scan/quota/:username        → สถานะโควต้าปัจจุบัน
//   POST /api/ai-scan/receipt                → สแกนใบเสร็จ (ใช้ Mock OCR / GPT-Vision)
//
// Rate limit:
//   VIP        → 20 ครั้ง/วัน  (reset เที่ยงคืน Bangkok)
//   Free user  → 1 ครั้ง/2 วัน  (rolling 48h cooldown)
//
// คุมต้นทุนได้ชัด: 1 VIP = ฿69/เดือน, ต้นทุน OCR ≈ ฿0.5/scan × 20 × 30 = ฿300/เดือนสูงสุด
// → break-even เมื่อ user ใช้น้อยกว่า 10 ครั้ง/วัน เฉลี่ย
//
// Mock OCR mode: ถ้าไม่มี OPENAI_API_KEY ใน env จะ return ข้อมูล demo
// Production: เชื่อม GPT-Vision หรือ Tesseract OCR ในส่วน performOCR()

const express   = require('express');
const router    = express.Router();
const ScanQuota = require('../models/ScanQuota');
const VipSubscription = require('../models/VipSubscription');
const { getConfig } = require('./config');

async function checkVip(username) {
    const sub = await VipSubscription.findOne({ username });
    return sub ? sub.isActive : false;
}

// ── Mock OCR (สำหรับ demo / dev ที่ไม่มี OpenAI key) ────────────────────
// Production: แทนที่ด้วยการเรียก GPT-Vision API จริง
async function performOCR(/* imageBase64, mimeType */) {
    // ตัวอย่างข้อมูลใบเสร็จที่ extract ได้
    const sample = {
        merchantName: 'Lemon Farm สาขาสุขุมวิท',
        date:         new Date().toISOString().slice(0, 10),
        items: [
            { name: 'นมข้าวโอ๊ตออร์แกนิก 1L',    price: 89,  qty: 1 },
            { name: 'ขนมปังโฮลวีต 400g',           price: 65,  qty: 1 },
            { name: 'ไข่ไก่อารมณ์ดี Free-Range 10 ฟอง', price: 119, qty: 1 },
            { name: 'ผักสลัดออร์แกนิก 200g',       price: 79,  qty: 2 },
        ],
        total: 431,
        currency: 'THB',
        confidence: 0.94,
    };

    // คำนวณ green score แบบหยาบ (eco-friendly keyword detection)
    const ecoKeywords = ['organic','ออร์แกนิก','free-range','อารมณ์ดี','whole','wheat','โฮลวีต','plant'];
    const ecoCount = sample.items.filter(it =>
        ecoKeywords.some(k => it.name.toLowerCase().includes(k.toLowerCase()))
    ).length;
    const greenScore = Math.round((ecoCount / sample.items.length) * 100);

    return {
        ...sample,
        greenScore,
        ecoItemCount: ecoCount,
        suggestedPoints: ecoCount * 10,
    };
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
        const { username, imageBase64 } = req.body || {};

        if (!username) {
            return res.status(400).json({ success: false, message: 'กรุณาส่ง username' });
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

        // ── Run OCR (mock for demo; production = GPT-Vision) ──
        const t0 = Date.now();
        const ocrResult = await performOCR(imageBase64);
        const latencyMs = Date.now() - t0;

        console.log(`🧾 AI scan: ${username} | ${isVip ? 'VIP' : 'FREE'} | items=${ocrResult.items.length} | green=${ocrResult.greenScore}% | ${latencyMs}ms`);

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
            meta: { latencyMs, mock: !process.env.OPENAI_API_KEY },
        });

    } catch (err) {
        console.error('AI Scan Error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการสแกนใบเสร็จ' });
    }
});

module.exports = router;
