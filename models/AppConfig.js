// models/AppConfig.js — InGreen Sprint 1
//
// ก่อนหน้า: ค่าสำคัญอย่าง WHO sugar limit ฝังตายอยู่ในโค้ด
//   เช่น if (sugar_g > 50) → ถ้าจะแก้ต้อง deploy ใหม่
//
// หลังจาก: ค่าทั้งหมดดึงจาก DB → แก้ได้ทันทีผ่าน Admin Panel
//   ไม่ต้อง deploy ใหม่, มี history การเปลี่ยนแปลง, config ต่อ environment ได้
//
// Schema ออกแบบให้ generic (key-value) เพื่อใส่ config ใหม่ได้ตลอด
// โดยไม่ต้องสร้าง field ใหม่

const mongoose = require('mongoose');

const AppConfigSchema = new mongoose.Schema({
    // ── Key ────────────────────────────────────────────────────────────────
    key: { 
        type: String, 
        required: true, 
        unique: true,
        // naming convention: CATEGORY_SUBCATEGORY_NAME
        // เช่น WHO_SUGAR_DAILY_G, VIP_PRICE_THB, SCAN_LIMIT_PER_DAY
    },

    // ── Value (flexible type) ───────────────────────────────────────────────
    value: { 
        type: mongoose.Schema.Types.Mixed, // รองรับ Number, String, Boolean, Array
        required: true 
    },

    // ── Metadata ───────────────────────────────────────────────────────────
    label:       { type: String, required: true },  // ชื่อแสดงผลสำหรับ Admin UI
    description: { type: String, default: '' },     // อธิบายว่าค่านี้ใช้ทำอะไร
    unit:        { type: String, default: '' },      // หน่วย เช่น "g/day", "฿", "ครั้ง"
    category:    { 
        type: String, 
        enum: ['health', 'vip', 'gamification', 'system'],
        default: 'system'
    },
    
    // ── Control ────────────────────────────────────────────────────────────
    isEditable: { type: Boolean, default: true },   // false = admin ดูได้แต่แก้ไม่ได้
    
}, { timestamps: true });

module.exports = mongoose.model('AppConfig', AppConfigSchema);