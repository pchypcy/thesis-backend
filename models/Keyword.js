// models/Keyword.js
const mongoose = require('mongoose');

const keywordSchema = new mongoose.Schema({
    word: { type: String, required: true, unique: true }, // คำที่ต้องการดักจับบนฉลาก
    meaning: { type: String, required: true },            // ความหมายสั้นๆ 
    fact: { type: String, required: true },               // ความจริงที่ซ่อนอยู่ (Health/Eco Fact)
    category: { type: String, default: 'General' },       // หมวดหมู่ (เช่น Sugar, Fat, Additive, Marketing)
    isActive: { type: Boolean, default: true }            // เปิด/ปิด การใช้งานคำนี้
});

module.exports = mongoose.model('Keyword', keywordSchema);