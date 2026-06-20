// models/VipSubscription.js — InGreen Sprint 1
//
// จัดการ VIP subscription lifecycle:
//   สมัคร → active → หมดอายุ → (ต่ออายุ | ยกเลิก)
//
// Sprint 2 จะใช้: vip-status API, upgrade-vip API
// Sprint 3 จะใช้: check ก่อนแสดง Sugar Tracker, แต้ม ×1.5
// Sprint 4 จะใช้: progressive reveal (3 วันฟรี), VIP gate

const mongoose = require('mongoose');

const VipSubscriptionSchema = new mongoose.Schema({
    // ── Identity ─────────────────────────────────────────────────────────────
    username: { 
        type: String, 
        required: true, 
        unique: true,   // 1 user : 1 subscription record (upsert ทุกครั้ง)
        index: true 
    },

    // ── Subscription Status ──────────────────────────────────────────────────
    status: {
        type: String,
        enum: ['trial', 'active', 'expired', 'cancelled'],
        default: 'trial',
        //  trial     = ใช้ 3 วันฟรี (นับจาก registeredAt)
        //  active    = จ่ายเงินแล้ว ยังไม่หมดอายุ
        //  expired   = หมดอายุแล้ว ยังไม่ต่ออายุ
        //  cancelled = ยกเลิกแล้ว (ยังใช้ได้ถึง expiresAt)
    },

    // ── Timeline ──────────────────────────────────────────────────────────────
    trialStartedAt: { type: Date, default: Date.now },
    trialEndsAt:    { type: Date, default: null },   // คำนวณตอน create: +3 วัน

    startedAt:  { type: Date, default: null },   // วันที่เริ่ม subscription จริง
    expiresAt:  { type: Date, default: null },   // วันหมดอายุ (startedAt + 30 วัน)
    renewedAt:  { type: Date, default: null },   // วันที่ต่ออายุล่าสุด

    // ── ★ Sprint 7: Auto-expiry job tracking ─────────────────────────────────
    // กัน reminder ซ้ำ + เก็บ audit ว่า job ตัดสิทธิ์เมื่อไหร่
    trialReminderSentAt: { type: Date, default: null },  // ส่ง reminder "เหลือ 1 วัน" แล้วเมื่อไหร่
    expiredByJobAt:      { type: Date, default: null },  // job ตัดสิทธิ์ trial→expired เมื่อไหร่
    expiryReason:        { type: String, default: null },// 'trial_ended' | 'subscription_ended'

    // ── Billing History ──────────────────────────────────────────────────────
    // เก็บทุกครั้งที่มีการชำระเงิน (Sprint 2 จะ push เข้า array นี้)
    paymentHistory: [{
        amount:    { type: Number, required: true },  // ฿69
        method:    { type: String, default: 'in_app' }, // 'promptpay', 'card', etc
        paidAt:    { type: Date, default: Date.now },
        reference: { type: String, default: null },   // payment reference ID
    }],

    // ── Feature Flags ─────────────────────────────────────────────────────────
    // คำนวณจาก status + expiresAt — ไม่ได้เก็บตรงๆ
    // ใช้ virtual แทน เพื่อไม่ให้ data inconsistent
    
}, { timestamps: true });

// ── Virtual: เช็คว่า VIP ยังใช้งานได้อยู่ ──────────────────────────────────
// รวม trial period ด้วย
VipSubscriptionSchema.virtual('isActive').get(function() {
    const now = new Date();
    
    if (this.status === 'trial' && this.trialEndsAt) {
        return now < this.trialEndsAt;
    }
    if (['active', 'cancelled'].includes(this.status) && this.expiresAt) {
        return now < this.expiresAt;
    }
    return false;
});

// ── Virtual: วันที่เหลือ ──────────────────────────────────────────────────────
VipSubscriptionSchema.virtual('daysRemaining').get(function() {
    const now = new Date();
    const end = this.status === 'trial' ? this.trialEndsAt : this.expiresAt;
    if (!end) return 0;
    const diff = end - now;
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
});

// ── Static Method: เริ่ม trial ────────────────────────────────────────────
// เรียกตอน user สมัครสมาชิกใหม่
VipSubscriptionSchema.statics.startTrial = async function(username, trialDays = 3) {
    const trialEndsAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
    return this.findOneAndUpdate(
        { username },
        { $setOnInsert: { username, status: 'trial', trialStartedAt: new Date(), trialEndsAt } },
        { upsert: true, new: true }
    );
};

// ── Static Method: upgrade เป็น VIP จริง ─────────────────────────────────
// เรียกใน upgrade-vip API (Sprint 2)
VipSubscriptionSchema.statics.upgrade = async function(username, durationDays = 30, paymentInfo = {}) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
    
    return this.findOneAndUpdate(
        { username },
        { 
            $set: { status: 'active', startedAt: now, expiresAt, renewedAt: now },
            $push: { paymentHistory: { amount: paymentInfo.amount || 69, method: paymentInfo.method || 'in_app', paidAt: now, reference: paymentInfo.reference || null } }
        },
        { upsert: true, new: true }
    );
};

module.exports = mongoose.model('VipSubscription', VipSubscriptionSchema);