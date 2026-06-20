// models/AllergenGroup.js — InGreen Sprint 6
//
// "กลุ่มอาหารแพ้" — แต่เดิม hardcode ใน utils/allergyDetector.js (ALLERGEN_DB)
// Sprint 6: ย้ายมา DB เพื่อให้ Admin แก้ได้โดยไม่ deploy
//
// Backward compat:
//   - ID format ตรงกับ ALLERGEN_DB เดิม (เช่น 'Milk', 'Peanuts')
//   - HealthProfile.allergens (= array of IDs) ยังใช้ค่าเดิมได้
//   - utils/allergyDetector ยัง fallback ไป ALLERGEN_DB เดิมถ้า DB ว่าง
//
// Soft delete: ใช้ isActive=false แทน delete จริง — กัน user เลือกแล้วพังเงียบๆ

const mongoose = require('mongoose');

const AllergenGroupSchema = new mongoose.Schema({
    // ── Identifier (PascalCase) — ใช้เป็น primary key ใน HealthProfile.allergens ──
    // เช่น 'Milk', 'Peanuts', 'CustomGroup1'
    id: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        match: /^[A-Za-z][A-Za-z0-9_]{1,31}$/,  // PascalCase / camelCase, 2–32 ตัว
        index: true,
    },

    labelTH: { type: String, required: true, trim: true, maxlength: 120 },
    labelEN: { type: String, required: true, trim: true, maxlength: 120 },

    // iconify icon name เช่น 'ph:cow'
    icon: { type: String, default: 'mdi:alert-circle', trim: true, maxlength: 80 },

    // ระดับความรุนแรงเริ่มต้นจากระบบ (Layer 1 base risk)
    severity_default: {
        type: String,
        enum: ['critical', 'high', 'medium', 'low'],
        default: 'medium',
        required: true,
    },

    // keywords ที่ใช้ matching ส่วนผสม (ภาษาไทย/อังกฤษคละกัน)
    keywords: {
        type: [String],
        default: [],
        validate: {
            validator: (arr) => arr.length <= 200,
            message: 'keywords เกิน 200 รายการ',
        },
    },

    // ★ เตือน cross-contamination (อาจมีสารผสมแฝง) — สำหรับ allergen ร้ายแรง
    crossContaminationWarning: { type: Boolean, default: false },

    // ── Lifecycle flags ──
    isActive:  { type: Boolean, default: true },   // soft delete
    isBuiltin: { type: Boolean, default: false },  // true = มาจาก seed (EU 14) — ลบไม่ได้

    // audit
    last_updated_by: { type: String, default: 'admin' },

}, { timestamps: true });

module.exports = mongoose.model('AllergenGroup', AllergenGroupSchema);
