// routes/partnerApi.js — Green Profile API (DPSE-03)  →  mounted at /api/partner
//
// นี่คือ "API ที่ส่งออกให้ชาวบ้าน" — endpoint ที่แอปภายนอก (เช่น MockFood / Grab / LINE MAN)
// เรียกใช้ ทุก endpoint ต้องผ่าน partnerAuth (API key + consent token)
//
//   GET  /api/partner/v1/ping         → เช็คว่า service ทำงาน (ไม่ต้อง auth)
//   GET  /api/partner/v1/profile      → อ่าน Green Profile ตาม scope ที่อนุญาต
//   POST /api/partner/v1/green-check  → ส่งเมนูมาตรวจ คืนผลแบบไม่เปิดข้อมูลดิบ
//
// ทุกการเข้าถึงถูกบันทึกลง grant.access_log แบบ hash chain (utils/auditChain.js)

const express        = require('express');
const router         = express.Router();
const User           = require('../models/User');
const HealthProfile  = require('../models/HealthProfile');
const partnerAuth    = require('../middleware/partnerAuth');
const { buildGreenProfile, greenCheck } = require('../utils/greenProfileSchema');
const { appendEntry } = require('../utils/auditChain');

async function loadUserAndHp(username) {
    const [user, hp] = await Promise.all([
        User.findOne({ username }),
        HealthProfile.findOne({ username }),
    ]);
    return { user, hp };
}

async function logAccess(grant, action, payload) {
    const chain = Array.isArray(grant.access_log) ? grant.access_log : [];
    const entry = appendEntry(chain, { action, actor: grant.partner_slug, payload });
    chain.push(entry);
    grant.access_log = chain;
    grant.markModified('access_log');
    grant.last_access_at = new Date();
    grant.access_count = (grant.access_count || 0) + 1;
    await grant.save();
}

// ── health check (ไม่ต้อง auth) ─────────────────────────────────────────────
router.get('/v1/ping', (req, res) => {
    res.json({ ok: true, service: 'InGreen Green Profile API', version: 'v1' });
});

// ── GET /api/partner/v1/profile ─────────────────────────────────────────────
router.get('/v1/profile', partnerAuth, async (req, res) => {
    try {
        const { user, hp } = await loadUserAndHp(req.grant.username);
        if (!user) return res.status(404).json({ error: 'user_not_found' });

        const profile = buildGreenProfile(user, hp, req.grant.scopes);
        await logAccess(req.grant, 'read_profile', { scopes: req.grant.scopes });
        res.json(profile);
    } catch (err) {
        console.error('partner profile error:', err);
        res.status(500).json({ error: 'server_error' });
    }
});

// ── POST /api/partner/v1/green-check ────────────────────────────────────────
router.post('/v1/green-check', partnerAuth, async (req, res) => {
    try {
        const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
        if (items.length === 0) {
            return res.status(400).json({ error: 'no_items', message: 'ต้องส่ง items[] อย่างน้อย 1 รายการ' });
        }

        const { user, hp } = await loadUserAndHp(req.grant.username);
        if (!user) return res.status(404).json({ error: 'user_not_found' });

        const out = greenCheck(items, user, hp);
        await logAccess(req.grant, 'green_check', { count: items.length });
        res.json(out);
    } catch (err) {
        console.error('green-check error:', err);
        res.status(500).json({ error: 'server_error' });
    }
});

module.exports = router;
