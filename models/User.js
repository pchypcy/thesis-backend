const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); 

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, unique: true, sparse: true }, // 🎯 เพิ่มฟิลด์ email เข้ามา (ใช้ sparse: true เผื่อยูสเซอร์เก่าที่ไม่มีอีเมล)
    password: { type: String, required: true },
    persona: { type: String, default: 'New User' },
    points: { type: Number, default: 0 },

    health_profile: {
        has_diabetes: { type: Boolean, default: false }, 
        has_kidney_disease: { type: Boolean, default: false }, 
        has_high_pressure: { type: Boolean, default: false }, 
        allergies: { type: [String], default: [] } 
    },
    
    // 🎯 สิ่งที่เพิ่มเข้ามา: เก็บสถิติผลกระทบต่อโลก/สุขภาพ
    impactStats: {
        chemicals: { type: Number, default: 0 },
        plastics: { type: Number, default: 0 }
    },
    
    scanHistory: [{
        productName: String, barcode: String, points: Number, scannedAt: { type: Date, default: Date.now }
    }],
    redeemHistory: [{
        merchantName: String, pointsUsed: Number, rewardDetail: String, redeemedAt: { type: Date, default: Date.now }
    }],
    status: { type: String, default: 'active' },

    // ★ Password Reset (OTP-based)
    //   - code:      6 หลัก, hash ด้วย bcrypt ก่อนเก็บ (ไม่เก็บ plaintext)
    //   - expiresAt: 10 นาทีหลัง gen
    //   - attempts:  จำกัด wrong OTP ไม่เกิน 5 ครั้ง
    reset_otp: {
        code_hash:  { type: String, default: null },
        expiresAt:  { type: Date,   default: null },
        attempts:   { type: Number, default: 0 },
    }

}, { timestamps: true });

UserSchema.pre('save', async function() {
    if (!this.isModified('password')) return;
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

module.exports = mongoose.model('User', UserSchema);