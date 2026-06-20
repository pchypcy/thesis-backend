// models/CouponQuota.js — InGreen Sprint 1
//
// ทำไมต้องมี:
//   ระบบเดิมไม่มีการจำกัดจำนวนการใช้คูปอง → ร้านค้าแลกซ้ำได้ไม่จำกัด
//   Sprint 2 จะใช้ตารางนี้ใน check-quota API และ atomic deduction
//
// ความสัมพันธ์:
//   Reward (แคมเปญ) 1 ─── many ──→ CouponQuota (โควต้าต่อ rewardId)
//   CouponQuota 1 ────── many ──→ Coupon (คูปองที่แจกออกไปแล้ว)
//
// Atomic deduction (Sprint 2):
//   ใช้ findOneAndUpdate + $inc + condition เพื่อป้องกัน race condition
//   เมื่อคนหลายคน redeem พร้อมกัน

const mongoose = require('mongoose');

const CouponQuotaSchema = new mongoose.Schema({
    // ── ผูกกับแคมเปญ ───────────────────────────────────────────────────────
    rewardId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Reward', 
        required: true,
        index: true
    },
    shopId:   { type: String, required: true, index: true }, // เช่น 'shop_001'
    shopName: { type: String, required: true },

    // ── โควต้า ──────────────────────────────────────────────────────────────
    maxTotal:   { 
        type: Number, 
        default: null  // null = ไม่จำกัด
    },
    maxPerUser: { 
        type: Number, 
        default: 1     // default: 1 คน redeem ได้ครั้งเดียวต่อแคมเปญ
    },
    maxPerDay:  { 
        type: Number, 
        default: null  // null = ไม่จำกัดต่อวัน
    },

    // ── Counter (อัปเดต atomic ใน Sprint 2) ─────────────────────────────────
    usedTotal: { type: Number, default: 0 },

    // ── วันที่แคมเปญ ─────────────────────────────────────────────────────────
    validFrom:  { type: Date, default: Date.now },
    validUntil: { type: Date, default: null },  // null = ไม่มีวันหมดอายุ

    // ── สถานะ ────────────────────────────────────────────────────────────────
    isActive: { type: Boolean, default: true },

}, { timestamps: true });

// ── Index สำหรับ check-quota query ──────────────────────────────────────────
// Sprint 2 จะ query: { rewardId, isActive: true }
CouponQuotaSchema.index({ rewardId: 1, isActive: 1 });

// ── Virtual: เช็คว่าโควต้าเต็มหรือยัง ──────────────────────────────────────
CouponQuotaSchema.virtual('isFull').get(function() {
    if (this.maxTotal === null) return false; // ไม่จำกัด
    return this.usedTotal >= this.maxTotal;
});

// ── Virtual: เช็คว่าแคมเปญยังไม่หมดอายุ ────────────────────────────────────
CouponQuotaSchema.virtual('isExpired').get(function() {
    if (!this.validUntil) return false;
    return new Date() > this.validUntil;
});

// ── Static Method: สำหรับ atomic deduction ใน Sprint 2 ─────────────────────
// ใช้แทน quota.usedTotal++ เพื่อป้องกัน race condition
// ตัวอย่าง: await CouponQuota.atomicDeduct(rewardId)
CouponQuotaSchema.statics.atomicDeduct = async function(rewardId) {
    const result = await this.findOneAndUpdate(
        { 
            rewardId,
            isActive: true,
            // เงื่อนไข: usedTotal < maxTotal หรือ maxTotal เป็น null (ไม่จำกัด)
            $or: [
                { maxTotal: null },
                { $expr: { $lt: ['$usedTotal', '$maxTotal'] } }
            ]
        },
        { $inc: { usedTotal: 1 } },
        { new: true }
    );
    
    // ถ้า result เป็น null → โควต้าเต็มแล้ว หรือ quota ไม่มีอยู่
    return result !== null;
};

module.exports = mongoose.model('CouponQuota', CouponQuotaSchema);