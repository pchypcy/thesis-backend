// models/Coupon.js — InGreen Sprint 2
// เพิ่มจาก Sprint 1:
//   [SPRINT 2] expiresAt → กำหนดเวลาหมดอายุการใช้สิทธิ์ (default 30 นาทีหลัง redeem)
//              ใช้คู่กับ status เพื่อ block การสแกนคูปองที่หมดเวลา

const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
    username:  { type: String, required: true },   // เจ้าของคูปอง
    shopName:  { type: String, required: true },   // ร้านที่แลก
    couponCode:{ type: String, required: true, unique: true }, // GRN-XXXXXXXX (ห้ามซ้ำ)
    status:    { type: String, default: 'active' }, // active | redeemed | expired

    // ★ SPRINT 1: HMAC fields
    hmacSignature: { type: String, default: null },
    issuedAt: { type: Date, default: null },

    // usedAt: timestamp ตอนที่ร้านสแกน
    usedAt: { type: Date, default: null },

    // ★ SPRINT 2: เวลาหมดอายุสิทธิ์ (30 นาทีหลัง issue)
    // ถ้า new Date() > expiresAt และ status ยังเป็น 'active' → ถือว่า expired
    // scan-coupon route จะ reject และ update status → 'expired' อัตโนมัติ
    expiresAt: { type: Date, default: null },

    // ★ SPRINT 5: Customer-confirm flow (กันร้านโกงยอด)
    //   1. ร้านสแกน QR → /merchant/check-coupon (เช็ค valid)
    //   2. ร้านกรอกยอด → /merchant/request-confirm  (สร้าง pendingConfirm)
    //   3. ลูกค้าเห็นใน /coupons/pending-confirm/:username → กดยืนยัน/ปฏิเสธ
    //   4. ลูกค้ายืนยัน → ร้านถึง /merchant/scan-coupon สรุปรายการได้
    pendingConfirm: {
        merchantId:       { type: String, default: null },
        // ★ Sprint 6: Order Summary breakdown
        originalAmount:   { type: Number, default: null },  // ราคาเต็มก่อนส่วนลด
        discountAmount:   { type: Number, default: null },  // ส่วนลดที่ใช้ (บาท)
        totalAmount:      { type: Number, default: null },  // ยอดสุทธิ = original - discount
        discountValue:    { type: String, default: null },  // text จาก reward เช่น "ส่วนลด 15%"
        requestedAt:      { type: Date,   default: null },
        confirmExpiresAt: { type: Date,   default: null }, // 3 นาทีหลัง request
        status:           { type: String, enum: ['none', 'pending', 'confirmed', 'rejected', 'timeout'], default: 'none' },
        confirmedAt:      { type: Date,   default: null },
        rejectedAt:       { type: Date,   default: null },
        rejectReason:     { type: String, default: null },
    },

    createdAt: { type: Date, default: Date.now },
});

// Index เพื่อ verify เร็วขึ้น: merchant scan-coupon จะ query { couponCode, status: 'active' }
couponSchema.index({ couponCode: 1, status: 1 });

// ★ SPRINT 2: Index สำหรับ cleanup job หรือ query คูปองที่หมดอายุ
couponSchema.index({ expiresAt: 1, status: 1 });

module.exports = mongoose.model('Coupon', couponSchema);