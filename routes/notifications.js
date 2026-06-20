// routes/notifications.js — InGreen Sprint 4
//
// CRUD การตั้งค่าการแจ้งเตือนผู้ใช้
//
// Endpoints:
//   GET  /api/notifications/:username        → ดึงการตั้งค่า (auto-create ถ้ายังไม่มี)
//   PATCH /api/notifications/:username       → อัปเดต preferences
//   POST /api/notifications/:username/reset  → คืนค่า default ทั้งหมด

const express = require('express');
const router  = express.Router();
const NotificationPreference = require('../models/NotificationPreference');
const Notification           = require('../models/Notification'); // ★ SPRINT 7: in-app inbox

// ── GET ──
router.get('/:username', async (req, res) => {
    try {
        const { username } = req.params;
        let pref = await NotificationPreference.findOne({ username });
        if (!pref) {
            pref = await NotificationPreference.create({ username });
        }
        return res.json({ success: true, preferences: pref });
    } catch (err) {
        console.error('Notifications GET error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
    }
});

// ── PATCH ──
router.patch('/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const payload = req.body || {};

        const allowed = [
            'allergyAlerts', 'sugarDailySummary', 'vipTrialReminder',
            'scanReminders', 'rewardUpdates', 'marketingEmail', 'weeklyReport',
            'vibrate', 'sound',
        ];

        const update = {};
        for (const k of allowed) {
            if (k in payload) update[k] = !!payload[k];
        }

        // nested
        if (payload.channels && typeof payload.channels === 'object') {
            for (const k of ['inApp', 'push', 'email']) {
                if (k in payload.channels) update[`channels.${k}`] = !!payload.channels[k];
            }
        }
        if (payload.quietHours && typeof payload.quietHours === 'object') {
            if ('enabled'   in payload.quietHours) update['quietHours.enabled']   = !!payload.quietHours.enabled;
            if ('startHour' in payload.quietHours) update['quietHours.startHour'] = Math.max(0, Math.min(23, Number(payload.quietHours.startHour)));
            if ('endHour'   in payload.quietHours) update['quietHours.endHour']   = Math.max(0, Math.min(23, Number(payload.quietHours.endHour)));
        }

        const pref = await NotificationPreference.findOneAndUpdate(
            { username },
            { $set: update, $setOnInsert: { username } },
            { upsert: true, new: true }
        );

        return res.json({ success: true, message: 'บันทึกการตั้งค่าสำเร็จ', preferences: pref });
    } catch (err) {
        console.error('Notifications PATCH error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
    }
});

// ── RESET ──
router.post('/:username/reset', async (req, res) => {
    try {
        const { username } = req.params;
        await NotificationPreference.deleteOne({ username });
        const pref = await NotificationPreference.create({ username });
        return res.json({ success: true, message: 'รีเซ็ตเรียบร้อย', preferences: pref });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ── ★ SPRINT 7: In-app notification inbox ─────────────────────────────────
// GET /api/notifications/:username/inbox → ดึง notification + จำนวนที่ยังไม่อ่าน
router.get('/:username/inbox', async (req, res) => {
    try {
        const { username } = req.params;
        const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
        const [items, unread] = await Promise.all([
            Notification.find({ username }).sort({ createdAt: -1 }).limit(limit),
            Notification.countDocuments({ username, read: false }),
        ]);
        return res.json({ success: true, total: items.length, unread, items });
    } catch (err) {
        console.error('inbox GET error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// POST /api/notifications/:username/inbox/read → mark อ่านแล้ว (ทั้งหมด หรือเฉพาะ id)
//   Body: { ids?: [notificationId] }  — ไม่ส่ง ids = mark ทั้งหมดของ user
router.post('/:username/inbox/read', async (req, res) => {
    try {
        const { username } = req.params;
        const { ids } = req.body || {};
        const filter = { username, read: false };
        if (Array.isArray(ids) && ids.length) filter._id = { $in: ids };
        const result = await Notification.updateMany(filter, { $set: { read: true, readAt: new Date() } });
        return res.json({ success: true, modified: result.modifiedCount });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
