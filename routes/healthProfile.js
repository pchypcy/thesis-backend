// routes/healthProfile.js — InGreen Sprint 4 (May 10-16)
//
// ฟีเจอร์: ระบบแพ้อาหาร (Free for everyone — ไม่ใช่ VIP)
//   "ฟีเจอร์นี้คือ key feature ที่จะดึงดูดกลุ่มผู้ใช้ที่ต้องระวังเรื่องอาหารจริงๆ
//    เช่น แพ้ถั่ว แพ้นม ซึ่งเป็นเรื่องคอขาดบาดตาย"
//
// Endpoints:
//   GET  /api/health-profile/allergen-list      → คืน EU 14 list (labels TH/EN + severity)
//   GET  /api/health-profile/:username           → ข้อมูลโปรไฟล์สุขภาพ + allergens
//   PATCH /api/health-profile/:username          → อัปเดต allergens / conditions
//   POST /api/health-profile/check               → ตรวจสินค้ากับ allergens ของ user
//
// Disclaimer (สำคัญมากเพื่อกันการฟ้องร้อง):
//   - ระบบไม่ได้แม่นยำ 100%
//   - อาจมีสารผสมแฝง (cross-contamination)
//   - ผู้ใช้ต้องอ่านฉลากเองทุกครั้ง

const express        = require('express');
const router         = express.Router();
const HealthProfile  = require('../models/HealthProfile');
const User           = require('../models/User');
const allergyDetector = require('../utils/allergyDetector');

const { ALLERGEN_DB, getAllergenMap, checkProductAgainstAllergens, DEFAULT_DISCLAIMER } = allergyDetector;

// ── GET /api/health-profile/allergen-list ────────────────────────────────────
// คืนรายการสารก่อภูมิแพ้ พร้อม label TH/EN + severity_default
// ★ Sprint 6: ดึงจาก DB (AllergenGroup) — fallback hardcoded ถ้า DB ว่าง
//             admin แก้ผ่าน /api/admin/allergen-groups ได้ทันที
router.get('/allergen-list', async (req, res) => {
    try {
        const map = await getAllergenMap();
        const list = Object.entries(map).map(([id, def]) => ({
            id,
            labelTH:           def.labelTH,
            labelEN:           def.labelEN,
            icon:              def.icon,
            severity_default:  def.severity_default,
            crossContamination: def.crossContaminationWarning,
        }));

        // ★ เรียงตาม severity: critical → high → medium
        const order = { critical: 0, high: 1, medium: 2, low: 3 };
        list.sort((a, b) => order[a.severity_default] - order[b.severity_default]);

        return res.json({
            success:    true,
            total:      list.length,
            allergens:  list,
            disclaimer: DEFAULT_DISCLAIMER,
        });
    } catch (err) {
        console.error('allergen-list error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ── GET /api/health-profile/:username ────────────────────────────────────────
// ดึงโปรไฟล์สุขภาพ — ถ้ายังไม่มี ให้ sync จาก User.health_profile เดิม
router.get('/:username', async (req, res) => {
    try {
        const { username } = req.params;

        let profile = await HealthProfile.findOne({ username });

        // ถ้ายังไม่มี → สร้างจาก User.health_profile เดิม
        if (!profile) {
            const user = await User.findOne({ username });
            if (!user) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้' });

            profile = await HealthProfile.syncFromUser(username, user.health_profile || {});
        }

        // ★ Sprint 7: lazy migration — profile เก่าที่ยังไม่มี allergen_entries → backfill
        if (HealthProfile.backfillEntries(profile)) {
            await profile.save();
        }

        // ★ Sprint 6: serialize Map → plain object เพื่อให้ frontend อ่านง่าย
        const allergenSeverities = profile.allergen_severities
            ? Object.fromEntries(profile.allergen_severities)
            : {};

        return res.json({
            success: true,
            profile: {
                username:             profile.username,
                conditions:           profile.conditions,
                allergens:            profile.allergens,
                allergen_severities:  allergenSeverities,   // ★ Sprint 6 (mirror)
                allergen_entries:     profile.allergenProfile, // ★ Sprint 7 (canonical)
                daily_calorie_goal:   profile.daily_calorie_goal,
                daily_sugar_goal_g:   profile.daily_sugar_goal_g,
                daily_sodium_goal_mg: profile.daily_sodium_goal_mg,
                daily_protein_goal_g: profile.daily_protein_goal_g,
                tracked_nutrients:    profile.tracked_nutrients || [],
                synced_from_quiz:     profile.synced_from_quiz,
                updatedAt:            profile.updatedAt,
            },
            disclaimer: DEFAULT_DISCLAIMER,
        });

    } catch (err) {
        console.error('Health Profile GET error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
    }
});

// ── PATCH /api/health-profile/:username ──────────────────────────────────────
// อัปเดต conditions / allergens / daily goals
// Body: { conditions?: {}, allergens?: [], daily_sugar_goal_g?: number, ... }
router.patch('/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const {
            conditions, allergens,
            allergen_severities,             // ★ Sprint 6 (legacy): { Milk: 'mild', ... }
            allergen_entries,                // ★ Sprint 7 (canonical): [{ allergenId, severity }]
            daily_sugar_goal_g, daily_sodium_goal_mg, daily_calorie_goal,
            daily_protein_goal_g,           // ★ SPRINT 5
            tracked_nutrients,               // ★ SPRINT 5: array of {key,label,unit,goal,iconHint}
        } = req.body;

        // ★ Sprint 6: ใช้ DB-backed list — admin เพิ่มกลุ่มใหม่แล้ว user เลือกได้ทันที
        const allergenMap = await getAllergenMap();
        const validIds = Object.keys(allergenMap);
        const allowedSev = ['mild', 'medium', 'severe'];

        // ── ตรวจ allergens ว่าอยู่ใน list ──
        if (Array.isArray(allergens)) {
            const invalid  = allergens.filter(a => !validIds.includes(a));
            if (invalid.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: `allergen ไม่ถูกต้อง: ${invalid.join(', ')}`,
                });
            }
        }

        // ★ Sprint 7: validate allergen_entries (canonical)
        if (Array.isArray(allergen_entries)) {
            for (const e of allergen_entries) {
                if (!e || !validIds.includes(e.allergenId)) {
                    return res.status(400).json({ success: false, message: `allergen ไม่ถูกต้อง: ${e?.allergenId}` });
                }
                if (e.severity !== undefined && !allowedSev.includes(e.severity)) {
                    return res.status(400).json({ success: false, message: `severity ไม่ถูกต้องสำหรับ ${e.allergenId}: ${e.severity}` });
                }
            }
        }

        // ★ Sprint 6: validate allergen_severities (legacy)
        if (allergen_severities && typeof allergen_severities === 'object') {
            for (const [aid, sev] of Object.entries(allergen_severities)) {
                if (!validIds.includes(aid)) {
                    return res.status(400).json({ success: false, message: `allergen ไม่ถูกต้อง: ${aid}` });
                }
                if (!allowedSev.includes(sev)) {
                    return res.status(400).json({ success: false, message: `severity ไม่ถูกต้องสำหรับ ${aid}: ${sev}` });
                }
            }
        }

        // ── upsert profile ──
        const update = { last_updated_by: 'user', synced_from_quiz: false };
        if (conditions !== undefined) {
            // merge keys ที่ส่งมาเท่านั้น (ไม่ทับฟิลด์อื่น)
            for (const key of Object.keys(conditions)) {
                update[`conditions.${key}`] = !!conditions[key];
            }
        }

        // ★ Sprint 7: ถ้ามี allergen_entries หรือ allergens → compose ทั้ง 3 field ให้ sync กัน
        //   priority: allergen_entries (canonical) > allergens + allergen_severities (legacy)
        if (allergen_entries !== undefined || allergens !== undefined) {
            const composed = HealthProfile.composeAllergenFields(
                allergen_entries !== undefined
                    ? { entries: allergen_entries }
                    : { allergens, severities: allergen_severities }
            );
            update.allergen_entries    = composed.allergen_entries;
            update.allergens           = composed.allergens;
            update.allergen_severities = composed.allergen_severities;
        } else if (allergen_severities !== undefined) {
            // แก้เฉพาะ severity (ไม่เปลี่ยน category) — ต้อง merge กับ entries เดิม
            // โหลด profile ปัจจุบันมา compose ใหม่
            const current = await HealthProfile.findOne({ username });
            const baseAllergens = current?.allergens || [];
            const composed = HealthProfile.composeAllergenFields({ allergens: baseAllergens, severities: allergen_severities });
            update.allergen_entries    = composed.allergen_entries;
            update.allergens           = composed.allergens;
            update.allergen_severities = composed.allergen_severities;
        }
        if (daily_sugar_goal_g !== undefined)     update.daily_sugar_goal_g   = daily_sugar_goal_g;
        if (daily_sodium_goal_mg !== undefined)   update.daily_sodium_goal_mg = daily_sodium_goal_mg;
        if (daily_calorie_goal !== undefined)     update.daily_calorie_goal   = daily_calorie_goal;
        if (daily_protein_goal_g !== undefined)   update.daily_protein_goal_g = daily_protein_goal_g;

        // ★ SPRINT 5: validate & sanitize tracked_nutrients
        if (Array.isArray(tracked_nutrients)) {
            const cleaned = tracked_nutrients
                .filter(n => n && typeof n === 'object' && n.key && n.label)
                .slice(0, 12) // จำกัด 12 รายการต่อ user
                .map(n => ({
                    key:      String(n.key).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32),
                    label:    String(n.label).trim().slice(0, 32),
                    unit:     ['g', 'mg', 'mcg', 'kcal', 'IU'].includes(n.unit) ? n.unit : 'mg',
                    goal:     Math.max(0, Number(n.goal) || 0),
                    iconHint: String(n.iconHint || 'mdi:pill').slice(0, 64),
                }));
            update.tracked_nutrients = cleaned;
        }

        const profile = await HealthProfile.findOneAndUpdate(
            { username },
            { $set: update, $setOnInsert: { username } },
            { upsert: true, new: true }
        );

        // ── sync กลับ User.health_profile เก่า (backward compat) ──
        // เพื่อให้ Result.jsx เดิมยังใช้ได้
        const userAllergiesMap = { Peanuts: 'Peanuts', TreeNuts: 'TreeNuts', Gluten: 'Gluten', Milk: 'Milk', Eggs: 'Eggs', Soybeans: 'Soybeans' };
        const legacyAllergies  = (profile.allergens || [])
            .filter(a => userAllergiesMap[a])
            .map(a => userAllergiesMap[a]);

        await User.updateOne(
            { username },
            {
                $set: {
                    'health_profile.has_diabetes':       profile.conditions.has_diabetes,
                    'health_profile.has_kidney_disease': profile.conditions.has_kidney_disease,
                    'health_profile.has_high_pressure':  profile.conditions.has_high_pressure,
                    'health_profile.allergies':          legacyAllergies,
                },
            }
        );

        console.log(`🩺 Health profile updated: ${username} | allergens: ${profile.allergens.join(', ') || '—'}`);

        // ★ Sprint 6: serialize Map → plain object
        const allergenSeveritiesOut = profile.allergen_severities
            ? Object.fromEntries(profile.allergen_severities)
            : {};

        return res.json({
            success: true,
            message: 'บันทึกข้อมูลสุขภาพสำเร็จ',
            profile: {
                conditions:           profile.conditions,
                allergens:            profile.allergens,
                allergen_severities:  allergenSeveritiesOut,   // ★ Sprint 6 (mirror)
                allergen_entries:     profile.allergenProfile, // ★ Sprint 7 (canonical)
                daily_sugar_goal_g:   profile.daily_sugar_goal_g,
                daily_sodium_goal_mg: profile.daily_sodium_goal_mg,
                daily_calorie_goal:   profile.daily_calorie_goal,
                daily_protein_goal_g: profile.daily_protein_goal_g,
                tracked_nutrients:    profile.tracked_nutrients || [],
            },
            disclaimer: DEFAULT_DISCLAIMER,
        });

    } catch (err) {
        console.error('Health Profile PATCH error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์', detail: err.message });
    }
});

// ── POST /api/health-profile/check ───────────────────────────────────────────
// ตรวจสินค้ากับ allergen profile ของ user
//
// Body:
//   {
//     username: 'somchai',
//     product: {
//       name, brand, ingredients, ingredients_text, allergens, marketing_text
//     }
//   }
//
// Response:
//   {
//     success, hasMatch, highestSeverity ('critical'|'high'|'medium'|null),
//     matches: [{ allergenId, labelTH, labelEN, severity, matchedKeywords }],
//     crossContamination: 'may contain peanut' | null,
//     disclaimer: { th, en },
//     userAllergens: ['Peanuts',...]
//   }
router.post('/check', async (req, res) => {
    try {
        const { username, product } = req.body;

        if (!username || !product) {
            return res.status(400).json({ success: false, message: 'กรุณาส่ง username และ product' });
        }

        // ── ดึง allergen list ของ user ──
        let profile = await HealthProfile.findOne({ username });
        if (!profile) {
            // fallback: sync จาก User.health_profile (backward compat)
            const user = await User.findOne({ username });
            if (user) {
                profile = await HealthProfile.syncFromUser(username, user.health_profile || {});
            }
        }

        const userAllergens = profile?.allergens || [];
        // ★ Sprint 6: Map → plain object สำหรับส่งเข้า detector
        const userSeverityMap = profile?.allergen_severities
            ? Object.fromEntries(profile.allergen_severities)
            : {};

        // ★ Sprint 6: pass DB-backed map → admin แก้กลุ่ม/keyword แล้วใช้ทันที
        const allergenMap = await getAllergenMap();
        // ── ตรวจ ──
        const result = checkProductAgainstAllergens(product, userAllergens, userSeverityMap, allergenMap);

        return res.json({
            success:             true,
            hasMatch:            result.hasMatch,
            highestSeverity:     result.highestSeverity,      // backward compat (= highestBaseSeverity)
            highestBaseSeverity: result.highestBaseSeverity,  // ★ Sprint 6
            highestUserSeverity: result.highestUserSeverity,  // ★ Sprint 6
            matches:             result.matches,               // มี baseSeverity + userSeverity ในแต่ละ item
            crossContamination:  result.crossContamination,
            userAllergens,
            userSeverities:      userSeverityMap,             // ★ Sprint 6
            disclaimer:          result.disclaimer,
        });

    } catch (err) {
        console.error('Health Profile CHECK error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์', detail: err.message });
    }
});

// ── ★ SPRINT 7: Migration — backfill allergen_entries ให้ profile เก่าทุกคน ──
// แปลง allergens[] + allergen_severities (map) → allergen_entries (canonical)
// idempotent: profile ที่มี entries แล้ว → skip
// (lazy backfill ทำงานตอน GET อยู่แล้ว — endpoint นี้ run ทีเดียวทั้งระบบ)
router.post('/migrate-severities', async (req, res) => {
    try {
        const profiles = await HealthProfile.find({
            $expr: { $gt: [{ $size: { $ifNull: ['$allergens', []] } }, 0] },
        });
        let migrated = 0, skipped = 0;
        for (const p of profiles) {
            if (HealthProfile.backfillEntries(p)) {
                await p.save();
                migrated++;
            } else {
                skipped++;
            }
        }
        return res.json({ success: true, message: `Migrated ${migrated} profiles (${skipped} already had entries)`, migrated, skipped });
    } catch (err) {
        console.error('migrate-severities error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
