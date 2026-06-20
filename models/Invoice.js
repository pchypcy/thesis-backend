// models/Invoice.js — InGreen v3
//
// เพิ่มจากเดิม:
//   campaignLabel → ชื่อโปรโมชั่น human-readable ณ เวลาสแกน เช่น "ส่วนลด 15%", "ฟรี 1 เมนู"
//   campaignId    → ref ไปยัง Reward._id ที่ใช้อยู่ตอนสแกน (สำหรับ trace ย้อนหลัง)

const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema({
  merchantId:  { type: String, required: true, index: true },
  username:    { type: String, required: true },
  couponCode:  { type: String, required: true },
  totalAmount: { type: Number, required: true },
  inGreenFee:  { type: Number, required: true },
  status:      { type: String, default: 'pending' }, // pending | paid

  // ── Discount tracking ──────────────────────────────────────────────────────
  fullPrice:      { type: Number, default: 0 },
  discountAmount: { type: Number, default: 0 },

  // ตัวเลข/code ที่ match กับ Reward.discountRate เช่น "15", "free_1", "buy1get1"
  discountRate:         { type: String, default: null },
  couponDiscount:       { type: String, default: null }, // legacy alias

  // ถ้าอัตราเปลี่ยน → เก็บอัตราเดิมไว้แสดงใน Timeline
  previousDiscountRate: { type: String, default: null },

  // ── Campaign snapshot ──────────────────────────────────────────────────────
  // เก็บ ณ เวลาที่สแกน เพื่อให้ Timeline แสดงชื่อโปรโมชั่นได้แม้ภายหลังจะเปลี่ยน
  campaignLabel: { type: String, default: null }, // "ส่วนลด 15%", "ฟรี 1 เมนู"
  campaignId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Reward', default: null },

  // ★ Settlement: เมื่อ invoice ถูกรวมเข้า settlement batch
  settlementId: { type: mongoose.Schema.Types.ObjectId, ref: 'Settlement', default: null, index: true },
  paidAt:       { type: Date,   default: null },
  paidRef:      { type: String, default: null },   // เลขอ้างอิงโอนเงิน

  redeemedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Invoice', invoiceSchema);