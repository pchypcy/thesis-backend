// models/PartnerApp.js — Green Profile API (DPSE-03)
//
// "Partner" = แอป/แพลตฟอร์มภายนอกที่ขอเชื่อมต่อ Green Profile ของผู้ใช้
// (เช่น Food Delivery, ร้านค้า, ในอนาคตคือ Grab / LINE MAN / 7-Eleven)
//
// แต่ละ partner มี API key (pk_live_...) สำหรับยืนยันตัวตนตอนเรียก /api/partner/*
// การจะ "อ่านข้อมูลของผู้ใช้คนไหน" ต้องมี ConsentGrant ที่ผู้ใช้อนุญาตด้วย (ดู ConsentGrant.js)

const mongoose = require('mongoose');

// scope = ระดับข้อมูลที่ partner ขอเข้าถึงได้ (ตรงกับ 4 domain ในสไลด์)
const SCOPES = ['allergy', 'health', 'sustainability', 'account'];

const PartnerAppSchema = new mongoose.Schema({
    name:    { type: String, required: true },
    slug:    { type: String, required: true, unique: true, index: true },

    // API key สาธารณะของ partner — แนบมาใน Authorization: Bearer <api_key>
    api_key: { type: String, required: true, unique: true, index: true },

    // ใช้แสดงผลในหน้า "การเชื่อมต่อภายนอก"
    logo_icon:   { type: String, default: 'ti-building-store' },
    brand_color: { type: String, default: '#00B14F' },
    description: { type: String, default: '' },

    // scope ที่ partner รายนี้ขออนุญาตได้ (ผู้ใช้ยังเลือกเปิด/ปิดทีละข้อได้อีกชั้น)
    allowed_scopes: {
        type: [String],
        default: ['allergy', 'health', 'sustainability'],
        validate: {
            validator: (arr) => arr.every(s => SCOPES.includes(s)),
            message: 'scope ไม่ถูกต้อง',
        },
    },

    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
}, { timestamps: true });

module.exports = mongoose.model('PartnerApp', PartnerAppSchema);
module.exports.SCOPES = SCOPES;
