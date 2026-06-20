// models/DailyIntake.js — InGreen Sprint 1
//
// เก็บปริมาณน้ำตาล + แป้งสะสมรายวันต่อ user
// Sprint 2: log-intake API จะ push ข้อมูลเข้ามาทุกครั้งที่ VIP สแกน
// Sprint 3: intake-summary API จะดึง aggregated data ไปวาดกราฟใน SugarTracker
//
// Design decision: แยก collection ออกจาก User เพราะ:
//   - User document จะโตเร็วมากถ้าเก็บ log ทุก scan
//   - ต้องทำ aggregation (sum by day, week) → แยก collection query เร็วกว่า
//   - compound index (username + date) ทำให้ lookup O(log n)

const mongoose = require('mongoose');

// ── Helper: ดึง date string ในรูป YYYY-MM-DD (Bangkok timezone) ─────────────
// ใช้สร้าง dateKey ที่ unique ต่อ user ต่อวัน
function getBangkokDateKey(date = new Date()) {
    return new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }))
        .toISOString()
        .slice(0, 10); // '2026-04-22'
}

// ── Schema ────────────────────────────────────────────────────────────────────
const DailyIntakeSchema = new mongoose.Schema({
    // ── Identity (compound unique) ────────────────────────────────────────────
    username: { type: String, required: true, index: true },
    dateKey:  { 
        type: String,     // 'YYYY-MM-DD' — Bangkok timezone
        required: true,
        index: true
    },
    date:     { type: Date, required: true }, // Date object สำหรับ range query

    // ── Nutrient Totals (สะสมตลอดวัน) ────────────────────────────────────────
    // Sprint 2 log-intake จะ $inc ค่าเหล่านี้ทุกครั้งที่สแกน
    total_sugar_g:   { type: Number, default: 0 },
    total_starch_g:  { type: Number, default: 0 },   // carbs_g จาก Product
    total_sodium_mg: { type: Number, default: 0 },
    total_fat_g:     { type: Number, default: 0 },
    total_kcal:      { type: Number, default: 0 },

    // ★ SPRINT 5: เพิ่ม protein (VIP feature) + custom nutrients
    // โครงสร้าง custom_nutrients = { zinc_mg: 3.2, magnesium_mg: 95, fiber_g: 12, ... }
    // user เลือกผ่าน HealthProfile.tracked_nutrients (รองรับการขยายในอนาคต)
    total_protein_g:  { type: Number, default: 0 },
    custom_nutrients: { type: mongoose.Schema.Types.Mixed, default: {} },

    // ── Scan Log (รายการสินค้าที่สแกนในวันนั้น) ─────────────────────────────
    // เก็บไว้สำหรับ breakdown ในหน้า Daily Detail
    scans: [{
        barcode:     String,
        productName: String,
        sugar_g:     { type: Number, default: 0 },
        starch_g:    { type: Number, default: 0 },
        sodium_mg:   { type: Number, default: 0 },
        fat_g:       { type: Number, default: 0 },
        kcal:        { type: Number, default: 0 },
        protein_g:   { type: Number, default: 0 },        // ★ SPRINT 5
        custom:      { type: mongoose.Schema.Types.Mixed, default: {} }, // ★ SPRINT 5 per-scan custom
        scannedAt:   { type: Date, default: Date.now },
    }],

    // ── WHO Limit Snapshot ────────────────────────────────────────────────────
    // เก็บ limit ณ วันนั้น (เผื่อ WHO เปลี่ยนค่าทีหลัง ข้อมูลเก่าไม่ผิดเพี้ยน)
    sugar_limit_g:   { type: Number, default: 50 },
    starch_limit_g:  { type: Number, default: 300 },
    protein_goal_g:  { type: Number, default: 50 },  // ★ SPRINT 5: ทั่วไป 50g/วัน

}, { timestamps: true });

// ── Compound Unique Index ─────────────────────────────────────────────────────
// ป้องกัน duplicate (1 user : 1 record ต่อวัน)
// Sprint 2 จะ upsert ด้วย { username, dateKey }
DailyIntakeSchema.index({ username: 1, dateKey: 1 }, { unique: true });

// ── Virtual: sugar % of daily limit ──────────────────────────────────────────
DailyIntakeSchema.virtual('sugar_percent').get(function() {
    if (!this.sugar_limit_g) return 0;
    return Math.round((this.total_sugar_g / this.sugar_limit_g) * 100);
});

// ── Virtual: starch % of daily limit ──────────────────────────────────────────
DailyIntakeSchema.virtual('starch_percent').get(function() {
    if (!this.starch_limit_g) return 0;
    return Math.round((this.total_starch_g / this.starch_limit_g) * 100);
});

// ── Static Method: log scan (atomic, upsert) ─────────────────────────────────
// Sprint 2 log-intake API จะเรียก method นี้
// atomic $inc ป้องกัน race condition ถ้าสแกนเร็วมาก
DailyIntakeSchema.statics.logScan = async function(username, product, limits = {}) {
    const now = new Date();
    const dateKey = getBangkokDateKey(now);

    // ★ SPRINT 5: รองรับ custom nutrients dynamic
    const customIn = product.custom_nutrients && typeof product.custom_nutrients === 'object'
        ? product.custom_nutrients : {};

    const scanEntry = {
        barcode:     product.barcode     || '',
        productName: product.name        || 'Unknown',
        sugar_g:     product.sugar_g     || 0,
        starch_g:    product.carbs_g     || 0,
        sodium_mg:   product.sodium_mg   || 0,
        fat_g:       product.fat_g       || 0,
        kcal:        product.energy_kcal || 0,
        protein_g:   product.protein_g   || 0,  // ★ SPRINT 5
        custom:      customIn,                  // ★ SPRINT 5
        scannedAt:   now,
    };

    // ★ SPRINT 5: ทำ $inc สำหรับ custom_nutrients แบบ dynamic
    const incFields = {
        total_sugar_g:   scanEntry.sugar_g,
        total_starch_g:  scanEntry.starch_g,
        total_sodium_mg: scanEntry.sodium_mg,
        total_fat_g:     scanEntry.fat_g,
        total_kcal:      scanEntry.kcal,
        total_protein_g: scanEntry.protein_g,
    };
    for (const [k, v] of Object.entries(customIn)) {
        if (typeof v === 'number' && !Number.isNaN(v)) {
            incFields[`custom_nutrients.${k}`] = v;
        }
    }

    return this.findOneAndUpdate(
        { username, dateKey },
        {
            $inc: incFields,
            $push:     { scans: scanEntry },
            $setOnInsert: {
                username,
                dateKey,
                date:           now,
                sugar_limit_g:  limits.sugar  || 50,
                starch_limit_g: limits.starch || 300,
                protein_goal_g: limits.protein || 50,
            }
        },
        { upsert: true, new: true }
    );
};

// ── Static Method: weekly summary ────────────────────────────────────────────
// Sprint 2 intake-summary API (period=week) จะเรียก method นี้
DailyIntakeSchema.statics.getWeeklySummary = async function(username) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return this.find({ username, date: { $gte: sevenDaysAgo } })
        .sort({ date: 1 })
        .select('dateKey total_sugar_g total_starch_g total_sodium_mg total_protein_g custom_nutrients sugar_limit_g starch_limit_g protein_goal_g');
};

module.exports = mongoose.model('DailyIntake', DailyIntakeSchema);
module.exports.getBangkokDateKey = getBangkokDateKey;