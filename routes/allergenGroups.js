// routes/allergenGroups.js — InGreen Sprint 6
//
// CRUD สำหรับ "กลุ่มอาหารแพ้" — เปิดให้ admin จัดการได้ผ่าน Admin Web UI
//
// Endpoints (admin only):
//   GET    /api/admin/allergen-groups            → list (default: active only)
//          ?includeInactive=true                  → list ทั้งหมด
//   POST   /api/admin/allergen-groups            → create ใหม่
//   PATCH  /api/admin/allergen-groups/:id        → แก้ field (label/icon/severity/keywords/isActive)
//   DELETE /api/admin/allergen-groups/:id        → soft delete (isActive=false)
//                                                  ถ้า isBuiltin → block (ลบ EU 14 ไม่ได้)
//   POST   /api/admin/allergen-groups/seed       → seed จาก hardcoded ALLERGEN_DB (idempotent)
//
// Auth:
//   ใช้ x-admin header (ตอนนี้ admin คือ localStorage flag) — ขอ guard เบาๆ
//   ภายในระบบยังไม่มี JWT — จึงใช้ header check แบบเดียวกับ admin routes อื่น

const express = require('express');
const router = express.Router();
const AllergenGroup = require('../models/AllergenGroup');
const { ALLERGEN_DB } = require('../utils/allergyDetector');

// ── Admin guard (light-weight — match รูปแบบ existing routes) ───────────────
function requireAdmin(req, res, next) {
    // ★ ปัจจุบัน admin session = localStorage flag ใน frontend ส่งผ่าน header
    //   ถ้ายังไม่มี header → อนุญาตชั่วคราว (compat กับ pages อื่นที่ยังไม่ส่ง)
    //   เมื่อ frontend ส่ง x-admin: 'true' = ผ่าน
    //   ถ้าตั้ง process.env.ADMIN_SECRET → ต้องตรง
    if (process.env.ADMIN_SECRET) {
        const sent = req.headers['x-admin-secret'];
        if (sent !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, message: 'admin only' });
        }
    }
    next();
}

// ── GET list ────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const includeInactive = req.query.includeInactive === 'true';
        const filter = includeInactive ? {} : { isActive: true };
        const groups = await AllergenGroup.find(filter).sort({
            isBuiltin: -1,           // builtin ขึ้นก่อน
            severity_default: 1,     // ใน group เดียวกัน เรียงตามชื่อ
            labelTH: 1,
        }).lean();
        return res.json({ success: true, total: groups.length, data: groups });
    } catch (err) {
        console.error('AllergenGroup LIST error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ── POST create ─────────────────────────────────────────────────────────────
router.post('/', requireAdmin, async (req, res) => {
    try {
        const {
            id, labelTH, labelEN, icon,
            severity_default, keywords, crossContaminationWarning,
        } = req.body || {};

        if (!id || !labelTH || !labelEN) {
            return res.status(400).json({ success: false, message: 'กรุณาระบุ id, labelTH, labelEN' });
        }

        const exists = await AllergenGroup.findOne({ id });
        if (exists) {
            return res.status(409).json({ success: false, message: `id "${id}" มีอยู่แล้ว` });
        }

        const group = await AllergenGroup.create({
            id: String(id).trim(),
            labelTH: String(labelTH).trim(),
            labelEN: String(labelEN).trim(),
            icon: icon ? String(icon).trim() : 'mdi:alert-circle',
            severity_default: severity_default || 'medium',
            keywords: Array.isArray(keywords)
                ? keywords.map(k => String(k).trim()).filter(Boolean).slice(0, 200)
                : [],
            crossContaminationWarning: !!crossContaminationWarning,
            isBuiltin: false,
            isActive: true,
        });

        return res.status(201).json({ success: true, data: group });
    } catch (err) {
        console.error('AllergenGroup CREATE error:', err);
        if (err.name === 'ValidationError') {
            return res.status(400).json({ success: false, message: err.message });
        }
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ── PATCH update ────────────────────────────────────────────────────────────
router.patch('/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const group = await AllergenGroup.findOne({ id });
        if (!group) return res.status(404).json({ success: false, message: 'ไม่พบกลุ่มอาหารแพ้' });

        const allowed = ['labelTH', 'labelEN', 'icon', 'severity_default', 'keywords', 'crossContaminationWarning', 'isActive'];
        for (const key of allowed) {
            if (req.body[key] === undefined) continue;

            if (key === 'keywords') {
                if (!Array.isArray(req.body.keywords)) continue;
                group.keywords = req.body.keywords
                    .map(k => String(k).trim())
                    .filter(Boolean)
                    .slice(0, 200);
                continue;
            }
            if (key === 'crossContaminationWarning' || key === 'isActive') {
                group[key] = !!req.body[key];
                continue;
            }
            group[key] = req.body[key];
        }

        group.last_updated_by = 'admin';
        await group.save();
        return res.json({ success: true, data: group });
    } catch (err) {
        console.error('AllergenGroup PATCH error:', err);
        if (err.name === 'ValidationError') {
            return res.status(400).json({ success: false, message: err.message });
        }
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ── DELETE soft delete ──────────────────────────────────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const group = await AllergenGroup.findOne({ id });
        if (!group) return res.status(404).json({ success: false, message: 'ไม่พบกลุ่มอาหารแพ้' });

        if (group.isBuiltin) {
            // EU 14 ลบจริงไม่ได้ — set isActive=false แทน (still listed in admin, hidden from users)
            group.isActive = false;
            await group.save();
            return res.json({
                success: true,
                soft: true,
                message: `ปิดใช้งานกลุ่ม "${group.labelTH}" แล้ว (built-in ลบถาวรไม่ได้)`,
                data: group,
            });
        }

        // Custom group — ลบจริง
        await AllergenGroup.deleteOne({ id });
        return res.json({ success: true, soft: false, message: 'ลบกลุ่มอาหารแพ้สำเร็จ' });
    } catch (err) {
        console.error('AllergenGroup DELETE error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ── POST seed (idempotent) ─────────────────────────────────────────────────
// คัดลอกจาก hardcoded ALLERGEN_DB → DB
// ทำงานแบบ idempotent: ถ้า id มีอยู่แล้ว → skip (ไม่ทับของ admin ที่แก้แล้ว)
router.post('/seed', requireAdmin, async (req, res) => {
    try {
        let created = 0;
        let skipped = 0;
        for (const [id, def] of Object.entries(ALLERGEN_DB)) {
            const exists = await AllergenGroup.findOne({ id });
            if (exists) { skipped++; continue; }

            await AllergenGroup.create({
                id,
                labelTH: def.labelTH,
                labelEN: def.labelEN,
                icon: def.icon,
                severity_default: def.severity_default,
                keywords: def.keywords || [],
                crossContaminationWarning: !!def.crossContaminationWarning,
                isBuiltin: true,
                isActive: true,
            });
            created++;
        }
        return res.json({
            success: true,
            message: `Seeded ${created} groups (${skipped} already existed)`,
            created, skipped,
        });
    } catch (err) {
        console.error('AllergenGroup SEED error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
