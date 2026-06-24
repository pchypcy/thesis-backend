// routes/connections.js — Green Profile API (DPSE-03)  →  mounted at /api/connections
//
// ฝั่ง "ผู้ใช้ InGreen" คุมการเชื่อมต่อ (Consent Management ในสไลด์)
// ใช้ JWT เดิม (middleware/auth.js) — req.user.username
//
//   GET  /api/connections             → รายชื่อ partner + สถานะการอนุญาตของฉัน
//   POST /api/connections/grant       → อนุญาต partner + เลือก scope → ได้ consent_token
//   POST /api/connections/revoke      → เพิกถอนสิทธิ์ (partner เรียกไม่ได้ทันที)
//   GET  /api/connections/:slug/audit → ดูบันทึกการเข้าถึง + ตรวจ integrity (tamper-evident)

const express      = require('express');
const router       = express.Router();
const crypto       = require('crypto');
const verifyToken  = require('../middleware/auth');
const PartnerApp   = require('../models/PartnerApp');
const ConsentGrant = require('../models/ConsentGrant');
const { verifyChain } = require('../utils/auditChain');
const { SCOPES }   = require('../utils/greenProfileSchema');

// ── seed partner ตัวอย่าง (idempotent — ไม่ทับของเดิม) ──────────────────────
// ใช้ $setOnInsert → ถ้ามี slug นี้อยู่แล้วจะไม่แตะข้อมูล
const DEMO_PARTNERS = [
    {
        slug: 'mockfood', name: 'MockFood',
        api_key: 'pk_live_mockfood_demo_001',
        brand_color: '#00B14F', logo_icon: 'ti-motorbike',
        description: 'แอปสั่งอาหารจำลอง (ตัวแทน Grab / LINE MAN ในอนาคต)',
        allowed_scopes: ['allergy', 'health', 'sustainability'],
    },
    {
        slug: 'greeneats', name: 'GreenEats',
        api_key: 'pk_live_greeneats_demo_002',
        brand_color: '#2D8048', logo_icon: 'ti-leaf',
        description: 'แพลตฟอร์มอาหารรักษ์โลก',
        allowed_scopes: ['allergy', 'sustainability'],
    },
];

let seeded = false;
async function ensureDemoPartners() {
    if (seeded) return;
    for (const p of DEMO_PARTNERS) {
        await PartnerApp.updateOne({ slug: p.slug }, { $setOnInsert: p }, { upsert: true });
    }
    seeded = true;
}

function genToken() {
    return 'ct_' + crypto.randomBytes(12).toString('hex');
}

// ── GET /api/connections ────────────────────────────────────────────────────
router.get('/', verifyToken, async (req, res) => {
    try {
        await ensureDemoPartners();
        const username = req.user.username;

        const [partners, grants] = await Promise.all([
            PartnerApp.find({ status: 'active' }).lean(),
            ConsentGrant.find({ username }).lean(),
        ]);

        const bySlug = {};
        grants.forEach(g => { bySlug[g.partner_slug] = g; });

        const list = partners.map(p => {
            const g = bySlug[p.slug];
            return {
                slug: p.slug, name: p.name,
                brand_color: p.brand_color, logo_icon: p.logo_icon,
                description: p.description, allowed_scopes: p.allowed_scopes,
                status: g ? g.status : 'available',
                scopes: (g && g.scopes) || [],
                consent_token: (g && g.status === 'active') ? g.consent_token : null,
                last_access_at: (g && g.last_access_at) || null,
                access_count: (g && g.access_count) || 0,
            };
        });

        res.json({ scopes_available: SCOPES, partners: list });
    } catch (err) {
        console.error('connections list error:', err);
        res.status(500).json({ message: 'server_error' });
    }
});

// ── POST /api/connections/grant ─────────────────────────────────────────────
router.post('/grant', verifyToken, async (req, res) => {
    try {
        await ensureDemoPartners();
        const username = req.user.username;
        const { partner_slug, scopes } = req.body || {};

        const partner = await PartnerApp.findOne({ slug: partner_slug, status: 'active' });
        if (!partner) return res.status(404).json({ message: 'ไม่พบ partner รายนี้' });

        const wanted = (Array.isArray(scopes) ? scopes : [])
            .filter(s => partner.allowed_scopes.includes(s));
        if (wanted.length === 0) {
            return res.status(400).json({ message: 'ต้องเลือกข้อมูลที่จะแชร์อย่างน้อย 1 อย่าง' });
        }

        let grant = await ConsentGrant.findOne({ username, partner_slug });
        if (!grant) {
            grant = new ConsentGrant({
                username, partner_slug, scopes: wanted,
                consent_token: genToken(), status: 'active',
            });
        } else {
            grant.scopes = wanted;
            grant.status = 'active';
            if (!grant.consent_token) grant.consent_token = genToken();
        }
        await grant.save();

        res.json({ success: true, partner_slug, scopes: wanted, consent_token: grant.consent_token });
    } catch (err) {
        console.error('grant error:', err);
        res.status(500).json({ message: 'server_error' });
    }
});

// ── POST /api/connections/revoke ────────────────────────────────────────────
router.post('/revoke', verifyToken, async (req, res) => {
    try {
        const username = req.user.username;
        const { partner_slug } = req.body || {};

        const grant = await ConsentGrant.findOne({ username, partner_slug });
        if (!grant) return res.status(404).json({ message: 'ยังไม่ได้เชื่อมต่อ partner รายนี้' });

        grant.status = 'revoked';
        await grant.save();
        res.json({ success: true });
    } catch (err) {
        console.error('revoke error:', err);
        res.status(500).json({ message: 'server_error' });
    }
});

// ── GET /api/connections/:slug/audit ────────────────────────────────────────
router.get('/:slug/audit', verifyToken, async (req, res) => {
    try {
        const username = req.user.username;
        const grant = await ConsentGrant.findOne({ username, partner_slug: req.params.slug }).lean();
        if (!grant) return res.status(404).json({ message: 'ยังไม่ได้เชื่อมต่อ partner รายนี้' });

        const log = Array.isArray(grant.access_log) ? grant.access_log : [];
        res.json({
            partner_slug: req.params.slug,
            total: log.length,
            integrity: verifyChain(log),
            entries: log,
        });
    } catch (err) {
        console.error('audit error:', err);
        res.status(500).json({ message: 'server_error' });
    }
});

module.exports = router;
