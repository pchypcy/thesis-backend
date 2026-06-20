// models/Notification.js — InGreen Sprint 7
//
// In-app notification inbox (เก็บ notification ที่ระบบสร้างให้ user)
// ใช้ครั้งแรกกับ: VIP trial reminder (เตือนล่วงหน้า 1 วันก่อนหมด trial)
//
// แยกจาก NotificationPreference (ที่เก็บ "user อยากรับแจ้งเตือนแบบไหน")
//   Notification = ตัว message จริงที่ส่งถึง user
//   NotificationPreference = setting ว่าเปิด/ปิดประเภทไหน
//
// การส่งจริง (push/email) ยังไม่ทำใน sprint นี้ — เก็บ in-app ก่อน
// frontend ดึงผ่าน GET /api/notifications/:username/inbox

const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
    username: { type: String, required: true, index: true },

    // ประเภท — ใช้ map กับ NotificationPreference toggle
    type: {
        type: String,
        enum: ['vip_trial_reminder', 'vip_expired', 'allergy', 'reward', 'system'],
        required: true,
        index: true,
    },

    title:   { type: String, required: true },
    message: { type: String, required: true },

    // ระดับความสำคัญ — frontend ใช้เลือกสี/ไอคอน
    severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },

    // metadata เสริม (เช่น daysRemaining, expiresAt)
    data: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

    read:   { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },

    // ★ idempotency key — กันสร้าง notification ซ้ำจาก job ที่รันหลายรอบ
    //   เช่น 'vip_trial_reminder:somchai:2026-06-20'
    dedupeKey: { type: String, default: null, index: true, unique: true, sparse: true },

}, { timestamps: true });

// query inbox เร็ว: ของ user เรียงใหม่ก่อน
NotificationSchema.index({ username: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', NotificationSchema);
