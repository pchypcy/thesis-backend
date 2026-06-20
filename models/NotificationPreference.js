// models/NotificationPreference.js — InGreen Sprint 4
//
// เก็บการตั้งค่าการแจ้งเตือนของผู้ใช้แต่ละคน
// ใช้กับ:
//   - Allergy alert (เปิด/ปิด vibration, sound, popup)
//   - Sugar daily summary (สรุปน้ำตาลแต่ละวันก่อนนอน)
//   - VIP trial reminder (1 วันก่อนหมด)
//   - Marketing (ข่าวสาร promo)

const mongoose = require('mongoose');

const NotificationPreferenceSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, index: true },

    // ── ประเภทการแจ้งเตือน ────────────────────────────────────────────────
    allergyAlerts:        { type: Boolean, default: true  },  // เตือนสารก่อภูมิแพ้ (default ON — สำคัญ)
    sugarDailySummary:    { type: Boolean, default: true  },  // สรุปน้ำตาลรายวัน
    vipTrialReminder:     { type: Boolean, default: true  },  // เตือนก่อน trial หมด
    scanReminders:        { type: Boolean, default: true  },  // เตือนสแกน 3 ครั้ง/วัน
    rewardUpdates:        { type: Boolean, default: true  },  // คูปอง / รางวัลใหม่
    marketingEmail:       { type: Boolean, default: false },  // โปรโมชั่น (default OFF)
    weeklyReport:         { type: Boolean, default: true  },  // รายงานสรุปรายสัปดาห์

    // ── ช่องทาง ──────────────────────────────────────────────────────────
    channels: {
        inApp:  { type: Boolean, default: true  },
        push:   { type: Boolean, default: true  },
        email:  { type: Boolean, default: false },
    },

    // ── โหมดเงียบ (Do Not Disturb) ───────────────────────────────────────
    quietHours: {
        enabled:   { type: Boolean, default: false },
        startHour: { type: Number,  default: 22, min: 0, max: 23 }, // 22:00
        endHour:   { type: Number,  default: 7,  min: 0, max: 23 }, //  7:00
    },

    // ── Vibration / Sound (mobile) ──────────────────────────────────────
    vibrate: { type: Boolean, default: true },
    sound:   { type: Boolean, default: true },

}, { timestamps: true });

module.exports = mongoose.model('NotificationPreference', NotificationPreferenceSchema);
