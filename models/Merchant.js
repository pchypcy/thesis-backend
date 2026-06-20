// models/Merchant.js
const mongoose = require('mongoose');

const MerchantSchema = new mongoose.Schema({
    shopId: { type: String, required: true, unique: true }, // เช่น shop_007
    name: { type: String, required: true },                 // ชื่อร้าน
    password: { type: String, required: true },             // รหัสผ่านเข้าสู่ระบบ
    status: { type: String, default: 'active' },

    // ★ Settlement: ข้อมูลบัญชีธนาคารสำหรับโอนเงินงวดให้ร้าน
    bankInfo: {
        bankName:    { type: String, default: null },   // "ไทยพาณิชย์", "กสิกรไทย", "กรุงเทพ"
        bankCode:    { type: String, default: null },   // SCB, KBANK, BBL
        accountNo:   { type: String, default: null },   // เลขบัญชี (เก็บแบบ string เผื่อ 0 นำหน้า)
        accountName: { type: String, default: null },   // ชื่อบัญชี
    },
}, { timestamps: true });

module.exports = mongoose.model('Merchant', MerchantSchema);