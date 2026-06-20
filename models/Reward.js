// models/Reward.js — InGreen v3
//
// การเปลี่ยนแปลงจากเดิม:
//   + shopId       → link ตรงกับ merchantId (เช่น 'shop_001') เพื่อ filter ต่อร้าน
//   + active       → เปิด/ปิดแคมเปญ
//   + discountRate → ตัวเลข % ที่ตรงกับ Invoice.discountRate (ใช้สำหรับ Era matching)
//                    เช่น discountValue = "ส่วนลด 15%" → discountRate = "15"
//   + history[]    → บันทึกทุกครั้งที่ discountValue/discountRate เปลี่ยน
//                    ทำให้ CouponRateTimeline รู้ว่า Era เดิมคืออะไร
//   + createdAt    → timestamps เพื่อ sort Era ตามเวลาจริง

const mongoose = require('mongoose');

// ── snapshot ของแคมเปญ ณ จุดที่มีการเปลี่ยนแปลง ──────────────────────────
const RewardHistorySchema = new mongoose.Schema({
  discountValue: String,   // ค่าเดิมก่อนเปลี่ยน เช่น "ส่วนลด 15%"
  discountRate:  String,   // ตัวเลขเดิม เช่น "15"
  description:   String,
  cost:          Number,
  active:        Boolean,
  changedAt:     { type: Date, default: Date.now },
  changedBy:     { type: String, default: 'admin' }, // admin หรือ merchantId
}, { _id: false });

// ── แคมเปญหลัก ────────────────────────────────────────────────────────────────
const RewardSchema = new mongoose.Schema({
  // ─ Identifiers ─
  shopId:    { type: String, index: true }, // 'shop_001', 'shop_002', ...
  shopName:  String,

  // ─ Content ─
  description:   String,
  cost:          Number,   // แต้มที่ต้องใช้แลก

  // ─ Discount (สองรูปแบบคือ human-readable กับ machine-readable) ─
  discountValue: String,  // "ส่วนลด 15%", "ฟรี 1 เมนู", "ซื้อ 1 แถม 1"
  discountRate:  String,  // ตัวเลข % สำหรับ match กับ Invoice.discountRate
                          // ถ้าเป็นแบบ non-% (เช่น ฟรี 1 เมนู) ให้ใส่ identifier เช่น "free_1"
                          // MerchantScan จะ POST discountRate นี้เข้า Invoice ตอนสแกน

  // ─ State ─
  active: { type: Boolean, default: true },
  image:  String,
  tag:    String,
  category: String,

  // ─ History ─
  // ทุกครั้งที่ admin/merchant แก้ไข discountValue/discountRate
  // ให้ push snapshot ปัจจุบันเข้า history ก่อน แล้วค่อยอัปเดต
  history: { type: [RewardHistorySchema], default: [] },

}, { timestamps: true }); // createdAt, updatedAt อัตโนมัติ

module.exports = mongoose.model('Reward', RewardSchema);