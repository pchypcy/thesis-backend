// models/Settlement.js — InGreen v3
//
// Settlement = ใบจ่ายเงินงวด (ต่อร้าน ต่อรอบ)
// รวม invoices หลายใบในงวดนั้น คำนวณยอดสุทธิให้ร้าน
//
// Flow:
//   1. Admin กด "สร้างใบจ่ายงวดสัปดาห์นี้" → ระบบรวม invoices ที่ pending + ยังไม่มี settlementId
//      group by merchantId → สร้าง Settlement 1 ใบต่อร้าน
//   2. แต่ละ Settlement มี status: pending → admin กรอกเลขอ้างอิง + กดบันทึก → status: paid
//   3. ทุก Invoice ที่อยู่ใน batch จะถูก link ผ่าน settlementId + status เปลี่ยนเป็น paid

const mongoose = require('mongoose');

const SettlementSchema = new mongoose.Schema({
    // ── Batch identifier ────────────────────────────────────────────────────
    batchCode:  { type: String, required: true, index: true }, // SET-202611-W47 (year-month-week)
    period: {
        from:  { type: Date, required: true },
        to:    { type: Date, required: true },
        label: { type: String, default: null },                 // "สัปดาห์ที่ 47 / 2026" or "พ.ย. 2026"
    },

    // ── Merchant (1 settlement ต่อ 1 ร้าน) ──────────────────────────────────
    merchantId:   { type: String, required: true, index: true },
    merchantName: { type: String, required: true },

    // Bank snapshot ณ ตอนสร้าง (กันการเปลี่ยนภายหลัง)
    bankSnapshot: {
        bankName:    { type: String, default: null },
        bankCode:    { type: String, default: null },
        accountNo:   { type: String, default: null },
        accountName: { type: String, default: null },
    },

    // ── Amount breakdown ────────────────────────────────────────────────────
    invoiceIds:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' }],
    invoiceCount: { type: Number, default: 0 },
    grossAmount:  { type: Number, required: true },  // รวมยอดขายทั้งหมด
    feeAmount:    { type: Number, required: true },  // GP ที่ InGreen หัก (5%)
    netAmount:    { type: Number, required: true },  // ยอดที่ต้องจ่ายร้าน = gross - fee

    // ── Status workflow ─────────────────────────────────────────────────────
    status: {
        type: String,
        enum: ['pending', 'paid', 'cancelled'],
        default: 'pending',
        index: true,
    },

    // ── Payment record (เมื่อ admin จ่ายแล้ว) ───────────────────────────────
    paidAt:        { type: Date,   default: null },
    paidBy:        { type: String, default: null },   // admin username
    paymentRef:    { type: String, default: null },   // เลขอ้างอิงโอนเงิน
    paymentMethod: { type: String, default: 'bank_transfer' },
    paymentNote:   { type: String, default: null },

    // ── Created by ──────────────────────────────────────────────────────────
    createdBy: { type: String, default: 'admin' },
}, { timestamps: true });

// Compound index — ป้องกัน duplicate batch ต่อ merchant ต่อ period
SettlementSchema.index({ merchantId: 1, batchCode: 1 }, { unique: true });

module.exports = mongoose.model('Settlement', SettlementSchema);
