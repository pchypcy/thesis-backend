// models/HealthProfile.js — InGreen Sprint 1
//
// ทำไมแยกออกจาก User model:
//   User.health_profile ที่มีอยู่เดิมเป็น embedded sub-document
//   เก็บแค่ boolean flag (has_diabetes, has_kidney_disease, allergies[])
//
//   HealthProfile ใหม่ (collection แยก) รองรับ:
//   1. ข้อมูลละเอียดกว่า (allergen list มาตรฐาน EU 14 ชนิด)
//   2. Versioning — เก็บประวัติการอัปเดต
//   3. เป็น source-of-truth สำหรับ Allergy Alert (Sprint 4)
//   4. ใช้ใน AI Insight ที่ reference ข้อมูลสุขภาพจริง (Sprint 3)
//
// Backward compat:
//   User.health_profile ยังคงอยู่ ใช้ใน Quiz flow เดิม
//   HealthProfile collection นี้จะ sync กันผ่าน API ตอน Sprint 4

const mongoose = require('mongoose');

// ── EU 14 Major Allergens (มาตรฐาน EU Food Information Regulation) ──────────
// ใช้เป็น enum เพื่อป้องกัน typo และ normalize ข้อมูล
const ALLERGEN_LIST = [
    'Gluten',       // กลูเตน (ข้าวสาลี, ข้าวบาร์เลย์, ข้าวไรย์)
    'Crustaceans',  // สัตว์น้ำมีเปลือก (กุ้ง, ปู, ล็อบสเตอร์)
    'Eggs',         // ไข่
    'Fish',         // ปลา
    'Peanuts',      // ถั่วลิสง
    'Soybeans',     // ถั่วเหลือง
    'Milk',         // นม (รวม lactose)
    'TreeNuts',     // ถั่วเปลือกแข็ง (อัลมอนด์, วอลนัท, ฯลฯ)
    'Celery',       // ขึ้นฉ่าย
    'Mustard',      // มัสตาร์ด
    'Sesame',       // งา
    'Sulphites',    // ซัลไฟต์ (> 10mg/kg)
    'Lupin',        // ถั่วลูพิน
    'Molluscs',     // หอย
];

// ★ Sprint 7: ระดับการแพ้ที่ user กำหนดได้ (Severity dimension — แยกจาก Category)
const SEVERITY_LEVELS = ['mild', 'medium', 'severe'];

const HealthProfileSchema = new mongoose.Schema({
    // ── ผูกกับ User ─────────────────────────────────────────────────────────
    username: { 
        type: String, 
        required: true, 
        unique: true,   // 1 user : 1 health profile
        index: true 
    },

    // ── โรคประจำตัว ──────────────────────────────────────────────────────────
    conditions: {
        has_diabetes:       { type: Boolean, default: false },
        has_kidney_disease: { type: Boolean, default: false },
        has_high_pressure:  { type: Boolean, default: false },
        has_heart_disease:  { type: Boolean, default: false },
        has_celiac:         { type: Boolean, default: false },  // แพ้กลูเตน (Celiac disease)
    },

    // ── สารที่แพ้ (EU 14 allergens) ─────────────────────────────────────────
    // เก็บเป็น Array of string จาก ALLERGEN_LIST
    // Allergy Alert (Sprint 4) จะ compare กับ Product.ingredients
    allergens: {
        type: [String],
        validate: {
            validator: (arr) => arr.every(a => ALLERGEN_LIST.includes(a)),
            message: 'allergen ไม่อยู่ในรายการ EU 14 major allergens'
        },
        default: []
    },

    // ── ★ Sprint 7: REDESIGN — Severity แยกจาก Category (canonical model) ─────
    // เดิม (Sprint 6): allergens=[String] (category) + allergen_severities=Map (severity)
    //   → 2 field แยกกัน เสี่ยง drift, ไม่มี timestamp รายชนิด
    // ใหม่ (Sprint 7): allergen_entries เป็น source-of-truth เดียว
    //   แต่ละ entry = 1 อาหารที่แพ้ + ระดับการแพ้ที่ user กำหนดอิสระ + เวลาที่แก้
    //   allergens / allergen_severities = mirror ที่ derive จาก entries (backward compat)
    //
    //   allergenId = "อาหารชนิดไหน" (Category — จาก ALLERGEN_LIST)
    //   severity   = "แพ้แค่ไหน"     (Severity — user เลือกอิสระ ไม่ผูกกับ category)
    allergen_entries: {
        type: [{
            allergenId: { type: String, required: true },
            severity:   { type: String, enum: SEVERITY_LEVELS, default: 'medium' },
            updatedAt:  { type: Date, default: Date.now },
        }],
        default: [],
        validate: {
            validator: (arr) => arr.every(e => ALLERGEN_LIST.includes(e.allergenId)),
            message: 'allergen_entries มี allergenId ที่ไม่อยู่ใน EU 14 list',
        },
    },

    // ── Mirror fields (derived จาก allergen_entries — backward compat) ────────
    // Layer 1 = base risk จาก ALLERGEN_DB (system-wide, ไม่ขึ้นกับ user)
    // Layer 2 = ระดับที่ user ตั้งเอง — 'mild' (เล็กน้อย) | 'medium' (ปานกลาง) | 'severe' (รุนแรง)
    // ★ อย่าเขียนตรงๆ — ใช้ composeAllergenFields() เพื่อให้ sync กับ entries เสมอ
    allergen_severities: {
        type: Map,
        of: { type: String, enum: SEVERITY_LEVELS },
        default: {},
    },

    // ── ข้อมูลเพิ่มเติม (optional) ───────────────────────────────────────────
    daily_calorie_goal:   { type: Number, default: 2000 },  // kcal
    daily_sugar_goal_g:   { type: Number, default: null },   // null = ใช้ WHO default
    daily_sodium_goal_mg: { type: Number, default: null },
    daily_protein_goal_g: { type: Number, default: null },   // ★ SPRINT 5

    // ★ SPRINT 5: Custom Nutrient Tracking (VIP feature)
    // user เลือก nutrient ที่อยาก track ได้เอง เช่น zinc, magnesium, fiber
    // [{ key: 'zinc_mg', label: 'Zinc', unit: 'mg', goal: 11 }]
    tracked_nutrients: {
        type: [{
            key:      { type: String, required: true },
            label:    { type: String, required: true },
            unit:     { type: String, default: 'mg' },
            goal:     { type: Number, default: 0 },
            iconHint: { type: String, default: 'mdi:pill' },
        }],
        default: [],
    },

    // ── Sync flag ────────────────────────────────────────────────────────────
    // true = sync มาจาก User.health_profile เดิม (backward compat)
    // false = user กรอกผ่าน Health Profile page ใหม่
    synced_from_quiz: { type: Boolean, default: false },

    // ── Version / Audit ──────────────────────────────────────────────────────
    last_updated_by: { type: String, default: 'user' }, // 'user' | 'admin' | 'quiz'

}, { timestamps: true });

// ── ★ Sprint 7: compose helper — สร้างทั้ง 3 field ให้ sync กันจาก input ────
// รับได้ทั้งแบบใหม่ (entries) และแบบเก่า (allergens + severities map)
// คืน { allergen_entries, allergens, allergen_severities } ที่ derive จากกันเรียบร้อย
//
//   composeAllergenFields({ entries: [{allergenId, severity}] })
//   composeAllergenFields({ allergens: ['Milk'], severities: { Milk: 'mild' } })
HealthProfileSchema.statics.composeAllergenFields = function({ entries, allergens, severities } = {}) {
    let normalized = [];

    if (Array.isArray(entries)) {
        // แบบใหม่ — entries เป็น canonical
        normalized = entries
            .filter(e => e && ALLERGEN_LIST.includes(e.allergenId))
            .map(e => ({
                allergenId: e.allergenId,
                severity:   SEVERITY_LEVELS.includes(e.severity) ? e.severity : 'medium',
                updatedAt:  e.updatedAt ? new Date(e.updatedAt) : new Date(),
            }));
    } else if (Array.isArray(allergens)) {
        // แบบเก่า — รวม category list + severity map → entries
        const sevMap = severities && typeof severities === 'object'
            ? (severities instanceof Map ? Object.fromEntries(severities) : severities)
            : {};
        normalized = allergens
            .filter(a => ALLERGEN_LIST.includes(a))
            .map(a => ({
                allergenId: a,
                severity:   SEVERITY_LEVELS.includes(sevMap[a]) ? sevMap[a] : 'medium',
                updatedAt:  new Date(),
            }));
    }

    // dedupe โดย allergenId (เก็บอันแรก)
    const seen = new Set();
    normalized = normalized.filter(e => {
        if (seen.has(e.allergenId)) return false;
        seen.add(e.allergenId);
        return true;
    });

    const mirrorAllergens   = normalized.map(e => e.allergenId);
    const mirrorSeverities  = {};
    for (const e of normalized) mirrorSeverities[e.allergenId] = e.severity;

    return {
        allergen_entries:    normalized,
        allergens:           mirrorAllergens,
        allergen_severities: mirrorSeverities,
    };
};

// ── ★ Sprint 7: virtual — มุมมองรวม (ใช้ตอบ frontend) ──────────────────────
HealthProfileSchema.virtual('allergenProfile').get(function() {
    return (this.allergen_entries || []).map(e => ({
        allergenId: e.allergenId,
        severity:   e.severity,
        updatedAt:  e.updatedAt,
    }));
});

// ── ★ Sprint 7: backfill entries จาก mirror เก่า (migration) ────────────────
// สำหรับ profile เดิมที่มี allergens/allergen_severities แต่ยังไม่มี allergen_entries
// คืน true ถ้ามีการแก้ไข (เพื่อให้ caller รู้ว่าต้อง save)
HealthProfileSchema.statics.backfillEntries = function(profile) {
    if (!profile) return false;
    const hasEntries = Array.isArray(profile.allergen_entries) && profile.allergen_entries.length > 0;
    const hasLegacy  = Array.isArray(profile.allergens) && profile.allergens.length > 0;
    if (hasEntries || !hasLegacy) return false;

    const composed = this.composeAllergenFields({
        allergens:  profile.allergens,
        severities: profile.allergen_severities,
    });
    profile.allergen_entries    = composed.allergen_entries;
    profile.allergen_severities = composed.allergen_severities;
    return true;
};

// ── Static Method: sync จาก User.health_profile เดิม ─────────────────────
// เรียกตอน user login หรือ Quiz ทำแล้ว
HealthProfileSchema.statics.syncFromUser = async function(username, userHealthProfile) {
    const mappedAllergens = (userHealthProfile.allergies || [])
        .filter(a => ALLERGEN_LIST.includes(a)); // กรองเฉพาะที่ valid

    // ★ Sprint 7: ไม่ทับ entries เดิมถ้ามีอยู่แล้ว (user อาจตั้ง severity ไว้)
    //   ใช้ $setOnInsert สำหรับ allergen fields → sync เฉพาะตอนสร้างใหม่
    const composed = this.composeAllergenFields({ allergens: mappedAllergens });

    return this.findOneAndUpdate(
        { username },
        {
            $set: {
                'conditions.has_diabetes':       userHealthProfile.has_diabetes || false,
                'conditions.has_kidney_disease': userHealthProfile.has_kidney_disease || false,
                synced_from_quiz:                 true,
                last_updated_by:                  'quiz',
            },
            $setOnInsert: {
                allergen_entries:    composed.allergen_entries,
                allergens:           composed.allergens,
                allergen_severities: composed.allergen_severities,
            },
        },
        { upsert: true, new: true }
    );
};

// virtual ออกมาใน toJSON/toObject ด้วย
HealthProfileSchema.set('toJSON',   { virtuals: true });
HealthProfileSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('HealthProfile', HealthProfileSchema);
module.exports.ALLERGEN_LIST   = ALLERGEN_LIST;
module.exports.SEVERITY_LEVELS = SEVERITY_LEVELS;