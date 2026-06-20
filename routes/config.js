// routes/config.js — InGreen Sprint 1
//
// Endpoints:
//   GET  /api/config              → ดึง config ทั้งหมด (Admin + Server)
//   GET  /api/config/:key         → ดึงค่าเดียว (ใช้ใน business logic)
//   GET  /api/config/seed         → seed ค่าเริ่มต้น (เรียกครั้งเดียวตอน setup)
//   PATCH /api/config/:key        → แก้ไขค่า (Admin only — ใส่ auth ในอนาคต)

const express    = require('express');
const router     = express.Router();
const AppConfig  = require('../models/AppConfig');

// ── Default Config Values ──────────────────────────────────────────────────
// นี่คือทุกค่าที่เคยฝังอยู่ในโค้ด ย้ายมาที่นี่ทั้งหมด
const DEFAULT_CONFIGS = [
    // ─ Health Limits (WHO Guidelines) ─
    {
        key:         'WHO_SUGAR_DAILY_G',
        value:       50,
        label:       'WHO Sugar Limit (Daily)',
        description: 'ปริมาณน้ำตาลสูงสุดต่อวันตามแนะนำของ WHO ใช้ใน Sugar Tracker และ AI Insight',
        unit:        'g/day',
        category:    'health',
        isEditable:  true,
    },
    {
        key:         'WHO_SODIUM_DAILY_MG',
        value:       2000,
        label:       'WHO Sodium Limit (Daily)',
        description: 'ปริมาณโซเดียมสูงสุดต่อวัน (WHO แนะนำ < 2g = 2000mg)',
        unit:        'mg/day',
        category:    'health',
        isEditable:  true,
    },
    {
        key:         'WHO_FAT_DAILY_G',
        value:       65,
        label:       'WHO Fat Limit (Daily)',
        description: 'ปริมาณไขมันสูงสุดต่อวัน อ้างอิงจาก 2000 kcal diet',
        unit:        'g/day',
        category:    'health',
        isEditable:  true,
    },
    {
        key:         'SUGAR_TRACKER_STARCH_G',
        value:       300,
        label:       'Starch Daily Limit',
        description: 'โควต้าแป้งรายวันสำหรับ Sugar Tracker (Sprint 3)',
        unit:        'g/day',
        category:    'health',
        isEditable:  true,
    },

    // ─ VIP / Subscription ─
    {
        key:         'VIP_PRICE_THB',
        value:       69,
        label:       'VIP Subscription Price',
        description: 'ราคา VIP subscription ต่อเดือน ใช้ใน Dashboard รายได้และ Upgrade Sheet',
        unit:        '฿/เดือน',
        category:    'vip',
        isEditable:  true,
    },
    {
        key:         'VIP_DURATION_DAYS',
        value:       30,
        label:       'VIP Duration',
        description: 'จำนวนวันที่ VIP มีผล หลังจากชำระเงิน',
        unit:        'วัน',
        category:    'vip',
        isEditable:  true,
    },
    {
        key:         'VIP_FREE_TRIAL_DAYS',
        value:       3,
        label:       'VIP Free Trial Period',
        description: 'จำนวนวันที่ให้ทดลองใช้ Sugar Tracker ฟรีก่อน lock (Progressive reveal - Sprint 4)',
        unit:        'วัน',
        category:    'vip',
        isEditable:  true,
    },
    {
        key:         'VIP_POINTS_MULTIPLIER',
        value:       1.5,
        label:       'VIP Points Multiplier',
        description: 'ตัวคูณแต้มสำหรับ VIP user ทุกครั้งที่สแกน (Sprint 3)',
        unit:        'x',
        category:    'vip',
        isEditable:  true,
    },

    // ─ Gamification ─
    {
        key:         'SCAN_LIMIT_PER_DAY',
        value:       5,
        label:       'Daily Scan Limit',
        description: 'จำนวนครั้งสแกนสูงสุดต่อวันที่ได้รับแต้ม (ปัจจุบัน hardcode ใน users.js)',
        unit:        'ครั้ง/วัน',
        category:    'gamification',
        isEditable:  true,
    },
    {
        key:         'SCAN_POINTS_DEFAULT',
        value:       50,
        label:       'Default Points per Scan',
        description: 'แต้มที่ได้รับต่อการสแกน 1 ครั้ง (สำหรับสินค้าทั่วไป)',
        unit:        'แต้ม',
        category:    'gamification',
        isEditable:  true,
    },
    {
        key:         'SCAN_POINTS_ECO',
        value:       30,
        label:       'Eco Product Points per Scan',
        description: 'แต้มสำหรับสินค้า eco-friendly (ปัจจุบัน hardcode 30 ใน products.js)',
        unit:        'แต้ม',
        category:    'gamification',
        isEditable:  true,
    },
    {
        key:         'CONTRIBUTION_POINTS',
        value:       50,
        label:       'Add Product Contribution Points',
        description: 'แต้มที่ได้รับเมื่อเพิ่มสินค้าใหม่ลงระบบ (ปัจจุบัน hardcode ใน AddProduct.jsx)',
        unit:        'แต้ม',
        category:    'gamification',
        isEditable:  true,
    },
    {
        key:         'DAILY_GOAL_SCANS',
        value:       3,
        label:       'Daily Goal (Scans)',
        description: 'เป้าหมายการสแกนต่อวันที่แสดงใน Home progress bar',
        unit:        'ครั้ง',
        category:    'gamification',
        isEditable:  true,
    },

    // ─ System ─
    {
        key:         'INGREEN_FEE_PERCENT',
        value:       5,
        label:       'InGreen GP Fee (%)',
        description: 'เปอร์เซ็นต์ค่า GP ที่หักจากร้านค้าทุกครั้งที่ใช้คูปอง (ปัจจุบัน hardcode 0.05 ใน merchant.js)',
        unit:        '%',
        category:    'system',
        isEditable:  false, // ห้ามแก้ผ่าน UI — ต้องแก้ผ่าน code review
    },
    {
        key:         'PRODUCT_CROWDSOURCE_THRESHOLD',
        value:       3,
        label:       'Crowdsource Vote Threshold',
        description: 'จำนวน vote ที่ต้องได้ก่อนสินค้า user-submitted จะ approved อัตโนมัติ (Sprint 5)',
        unit:        'votes',
        category:    'system',
        isEditable:  true,
    },

    // ─ AI Receipt Scan (★ SPRINT 5) ─
    {
        key:         'AI_SCAN_VIP_PER_DAY',
        value:       20,
        label:       'AI Scan Quota (VIP)',
        description: 'จำนวนสแกนใบเสร็จด้วย AI ต่อวันสำหรับ VIP — คุมต้นทุน OpenAI/OCR',
        unit:        'ครั้ง/วัน',
        category:    'vip',
        isEditable:  true,
    },
    {
        key:         'AI_SCAN_FREE_COOL_HOURS',
        value:       48,
        label:       'AI Scan Cooldown (Free)',
        description: 'ช่วงเวลาห้ามสแกนต่อ user Free ต่อครั้ง (1 ครั้ง/2 วัน)',
        unit:        'ชั่วโมง',
        category:    'system',
        isEditable:  true,
    },
    {
        key:         'AI_SCAN_COST_THB',
        value:       0.5,
        label:       'AI Scan Cost Estimate',
        description: 'ต้นทุน OCR ต่อใบเสร็จโดยประมาณ (ใช้คำนวณ break-even VIP)',
        unit:        '฿/scan',
        category:    'system',
        isEditable:  false,
    },

    // ─ Protein Tracking (★ SPRINT 5) ─
    {
        key:         'PROTEIN_GOAL_DAILY_G',
        value:       50,
        label:       'Daily Protein Goal',
        description: 'เป้าหมายโปรตีนต่อวันโดยทั่วไป (RDA ~0.8g/kg → 50g สำหรับ 60kg)',
        unit:        'g/day',
        category:    'health',
        isEditable:  true,
    },

    // ─ ★ SPRINT 7: VIP Auto-Expiry Job ─
    {
        key:         'VIP_EXPIRY_JOB_INTERVAL_MIN',
        value:       60,
        label:       'VIP Expiry Job Interval',
        description: 'ความถี่ที่ scheduled job ตรวจ/ตัดสิทธิ์ VIP trial และส่ง reminder (นาที)',
        unit:        'นาที',
        category:    'vip',
        isEditable:  true,
    },

    // ─ ★ SPRINT 7: Weighted Product Voting ─
    {
        key:         'PRODUCT_VOTE_QUORUM',
        value:       3,
        label:       'Vote Quorum (min voters)',
        description: 'จำนวนผู้โหวต (unique) ขั้นต่ำก่อนระบบตัดสินผลโหวตสินค้าได้ — ลด bias จากคนกลุ่มเล็ก',
        unit:        'คน',
        category:    'system',
        isEditable:  true,
    },
    {
        key:         'PRODUCT_VOTE_APPROVE_WEIGHT',
        value:       4,
        label:       'Vote Approve Weight',
        description: 'คะแนนถ่วงน้ำหนัก (weighted) ฝั่ง approve ที่ต้องถึง เพื่อผ่าน community vote',
        unit:        'weight',
        category:    'system',
        isEditable:  true,
    },
    {
        key:         'PRODUCT_VOTE_WINDOW_HOURS',
        value:       72,
        label:       'Vote Window (hours)',
        description: 'ระยะเวลาเปิดโหวตต่อสินค้า — หมดเวลาแล้วระบบสรุปผลตาม quorum + weighted score',
        unit:        'ชั่วโมง',
        category:    'system',
        isEditable:  true,
    },
    {
        key:         'PRODUCT_VOTE_MAX_WEIGHT_PER_USER',
        value:       3,
        label:       'Max Vote Weight / User',
        description: 'เพดานน้ำหนักโหวตต่อ 1 คน — กันผู้ใช้ trust สูงคนเดียวครอบงำผลโหวต',
        unit:        'weight',
        category:    'system',
        isEditable:  true,
    },
    {
        key:         'VOTE_FINALIZE_JOB_INTERVAL_MIN',
        value:       30,
        label:       'Vote Finalize Job Interval',
        description: 'ความถี่ที่ job สรุปผลโหวตสินค้าที่หมดเวลา (นาที)',
        unit:        'นาที',
        category:    'system',
        isEditable:  true,
    },
];

// ── GET /api/config ────────────────────────────────────────────────────────
// ดึง config ทั้งหมด (จัดกลุ่มตาม category)
router.get('/', async (req, res) => {
    try {
        const configs = await AppConfig.find().sort({ category: 1, key: 1 });
        
        // จัดกลุ่มตาม category เพื่อให้ frontend ใช้งานง่าย
        const grouped = configs.reduce((acc, c) => {
            if (!acc[c.category]) acc[c.category] = [];
            acc[c.category].push(c);
            return acc;
        }, {});

        res.json({ success: true, data: configs, grouped });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── GET /api/config/seed ─────────────────────────────────────────────────
// ★ FIX: ต้อง register ก่อน /:key เพราะ Express match ตามลำดับ
// Seed ค่าเริ่มต้น (ใช้ upsert กัน error ถ้า key มีอยู่แล้ว)
router.get('/seed', async (req, res) => {
    try {
        const ops = DEFAULT_CONFIGS.map(cfg => ({
            updateOne: {
                filter: { key: cfg.key },
                update: { $setOnInsert: cfg }, // ถ้า key มีอยู่แล้วไม่ทับ
                upsert: true,
            }
        }));
        
        const result = await AppConfig.bulkWrite(ops);
        res.json({ 
            success: true, 
            message: `Seeded ${result.upsertedCount} configs (${result.matchedCount} already existed)`,
            total: DEFAULT_CONFIGS.length
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── GET /api/config/:key ───────────────────────────────────────────────────
// ดึงค่าเดียวตาม key (ใช้ใน business logic เช่น check sugar limit)
router.get('/:key', async (req, res) => {
    try {
        const config = await AppConfig.findOne({ key: req.params.key });
        if (!config) return res.status(404).json({ success: false, message: `ไม่พบ config key: ${req.params.key}` });

        res.json({ success: true, key: config.key, value: config.value, unit: config.unit });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── PATCH /api/config/:key ────────────────────────────────────────────────
// แก้ไขค่า config (Admin only — ต่อ auth middleware ในอนาคต)
router.patch('/:key', async (req, res) => {
    try {
        const config = await AppConfig.findOne({ key: req.params.key });
        if (!config) return res.status(404).json({ success: false, message: 'ไม่พบ config key นี้' });
        if (!config.isEditable) return res.status(403).json({ success: false, message: 'config นี้ไม่อนุญาตให้แก้ไขผ่าน API' });
        
        const { value } = req.body;
        if (value === undefined) return res.status(400).json({ success: false, message: 'กรุณาส่ง value มาด้วย' });
        
        config.value = value;
        await config.save();
        
        res.json({ success: true, message: `อัปเดต ${config.key} = ${value} สำเร็จ`, data: config });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── Helper: ดึงค่าเดียวแบบ Promise (ใช้ใน route อื่น) ────────────────────
// ตัวอย่าง: const limit = await getConfig('WHO_SUGAR_DAILY_G', 50);
async function getConfig(key, defaultValue = null) {
    try {
        const config = await AppConfig.findOne({ key });
        return config ? config.value : defaultValue;
    } catch {
        return defaultValue; // fail-safe: ถ้า DB ล้มเหลว ใช้ค่า default
    }
}

module.exports = router;
module.exports.getConfig = getConfig;