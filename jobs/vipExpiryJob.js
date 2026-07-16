// jobs/vipExpiryJob.js — InGreen Sprint 7
//
// ★ ระบบตัดสิทธิ์ VIP Trial อัตโนมัติ (Scheduled Job)
//
// ทำงานทุกรอบ (default ทุก 60 นาที — ตั้งใน config VIP_EXPIRY_JOB_INTERVAL_MIN):
//   1. ตัดสิทธิ์ trial ที่หมดอายุ (trialEndsAt < now, status='trial') → status='expired'
//   2. ตัดสิทธิ์ subscription ที่หมดอายุ (expiresAt < now, status='active') → status='expired'
//   3. แจ้งเตือนล่วงหน้า 1 วัน: trial ที่จะหมดภายใน 24 ชม. → สร้าง Notification (กันซ้ำด้วย dedupeKey)
//
// ทุกการตัดสิทธิ์ + reminder มี console log (audit) + เก็บ Notification ให้ user
// เคารพ NotificationPreference.vipTrialReminder (ถ้า user ปิด → ไม่สร้าง reminder)
//
// ไม่ใช้ external cron library — ใช้ setInterval ภายใน process (เริ่มใน server.js หลัง mongo connect)
// Manual trigger: POST /api/vip/run-expiry-job (admin/test)

const VipSubscription      = require('../models/VipSubscription');
const Notification         = require('../models/Notification');
const NotificationPreference = require('../models/NotificationPreference');
const { getConfig }        = require('../routes/config');

// YYYY-MM-DD ตาม "เวลาไทย" (UTC+7) สำหรับ dedupeKey ของ reminder รายวัน
// ★ ใช้วันแบบไทย ให้สอดคล้องกับการตัดสิทธิ์ที่เที่ยงคืนเวลาไทย
function dayStamp(date = new Date()) {
    return new Date(date.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ── (1)+(2) ตัดสิทธิ์ที่หมดอายุ ────────────────────────────────────────────
async function expireEnded(now) {
    const results = { trialExpired: 0, subscriptionExpired: 0 };

    // trial หมด: status='trial' และ trialEndsAt <= now
    const endedTrials = await VipSubscription.find({
        status: 'trial',
        trialEndsAt: { $ne: null, $lte: now },
    });
    for (const sub of endedTrials) {
        sub.status         = 'expired';
        sub.expiredByJobAt = now;
        sub.expiryReason   = 'trial_ended';
        await sub.save();
        results.trialExpired++;
        console.log(`⏳ [vip-expiry] Trial expired: ${sub.username} (trialEndsAt=${sub.trialEndsAt?.toISOString()})`);

        // notify ว่าหมด trial แล้ว (ไม่กันด้วย pref — เป็น transactional ไม่ใช่ marketing)
        await createNotification({
            username: sub.username,
            type:     'vip_expired',
            title:    'ทดลองใช้ VIP หมดอายุแล้ว',
            message:  'ช่วงทดลองใช้ VIP 3 วันของคุณสิ้นสุดแล้ว สมัคร VIP เพื่อใช้ Sugar Tracker และฟีเจอร์พิเศษต่อ',
            severity: 'warning',
            data:     { reason: 'trial_ended' },
            dedupeKey: `vip_expired:${sub.username}:${dayStamp(now)}`,
        });
    }

    // subscription หมด: status='active'/'cancelled' และ expiresAt <= now
    const endedSubs = await VipSubscription.find({
        status: { $in: ['active', 'cancelled'] },
        expiresAt: { $ne: null, $lte: now },
    });
    for (const sub of endedSubs) {
        sub.status         = 'expired';
        sub.expiredByJobAt = now;
        sub.expiryReason   = 'subscription_ended';
        await sub.save();
        results.subscriptionExpired++;
        console.log(`⏳ [vip-expiry] Subscription expired: ${sub.username} (expiresAt=${sub.expiresAt?.toISOString()})`);

        await createNotification({
            username: sub.username,
            type:     'vip_expired',
            title:    'สมาชิก VIP หมดอายุแล้ว',
            message:  'สมาชิก VIP ของคุณหมดอายุแล้ว ต่ออายุเพื่อใช้สิทธิ์พิเศษต่อเนื่อง',
            severity: 'warning',
            data:     { reason: 'subscription_ended' },
            dedupeKey: `vip_expired:${sub.username}:${dayStamp(now)}`,
        });
    }

    return results;
}

// ── (3) แจ้งเตือนล่วงหน้า 1 วัน ────────────────────────────────────────────
async function remindExpiringSoon(now) {
    const result = { reminded: 0, skippedByPref: 0 };

    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // trial ที่ยัง active แต่จะหมดภายใน 24 ชม. และยังไม่เคยส่ง reminder
    const soon = await VipSubscription.find({
        status: 'trial',
        trialEndsAt: { $gt: now, $lte: in24h },
        $or: [
            { trialReminderSentAt: null },
            // ส่งซ้ำได้ถ้า reminder ครั้งก่อนเกิน 20 ชม. (กันกรณี trial ถูกขยาย) — แต่ปกติ dedupeKey กันรายวันอยู่แล้ว
        ],
    });

    for (const sub of soon) {
        // เคารพ preference ของ user (default เปิด)
        const pref = await NotificationPreference.findOne({ username: sub.username });
        if (pref && pref.vipTrialReminder === false) {
            result.skippedByPref++;
            // mark ว่าพิจารณาแล้ว กันวน
            sub.trialReminderSentAt = now;
            await sub.save();
            continue;
        }

        const hoursLeft = Math.max(1, Math.round((sub.trialEndsAt - now) / (60 * 60 * 1000)));
        const created = await createNotification({
            username: sub.username,
            type:     'vip_trial_reminder',
            title:    'ทดลองใช้ VIP จะหมดในอีก 1 วัน',
            message:  `ช่วงทดลองใช้ฟรีของคุณจะสิ้นสุดในอีกประมาณ ${hoursLeft} ชั่วโมง สมัคร VIP เพื่อใช้งานต่อโดยไม่สะดุด`,
            severity: 'info',
            data:     { trialEndsAt: sub.trialEndsAt, hoursLeft },
            // dedupeKey รายวัน — กันส่งซ้ำถ้า job รันหลายรอบในวันเดียว
            dedupeKey: `vip_trial_reminder:${sub.username}:${dayStamp(now)}`,
        });

        sub.trialReminderSentAt = now;
        await sub.save();
        if (created) {
            result.reminded++;
            console.log(`🔔 [vip-expiry] Trial reminder sent: ${sub.username} (~${hoursLeft}h left)`);
        }
    }

    return result;
}

// ── helper: สร้าง Notification แบบ idempotent (กันซ้ำด้วย dedupeKey) ─────────
async function createNotification(payload) {
    try {
        const doc = await Notification.create(payload);
        return doc;
    } catch (err) {
        // duplicate key (E11000) = เคยสร้างแล้ว → ไม่ใช่ error จริง
        if (err.code === 11000) return null;
        console.error('[vip-expiry] createNotification error:', err.message);
        return null;
    }
}

// ── Main entry — รัน 1 รอบ ─────────────────────────────────────────────────
let _isRunning = false;
let _lastRun = null;

async function runVipExpiryCheck(trigger = 'interval') {
    if (_isRunning) {
        console.log('[vip-expiry] previous run still in progress — skip');
        return { skipped: true };
    }
    _isRunning = true;
    const startedAt = new Date();
    try {
        const expired = await expireEnded(startedAt);
        const reminded = await remindExpiringSoon(startedAt);

        const summary = {
            ranAt:               startedAt.toISOString(),
            trigger,
            trialExpired:        expired.trialExpired,
            subscriptionExpired: expired.subscriptionExpired,
            reminded:            reminded.reminded,
            skippedByPref:       reminded.skippedByPref,
            durationMs:          Date.now() - startedAt.getTime(),
        };
        _lastRun = summary;
        console.log(`✅ [vip-expiry] run done:`, JSON.stringify(summary));
        return summary;
    } catch (err) {
        console.error('❌ [vip-expiry] run failed:', err);
        return { error: err.message };
    } finally {
        _isRunning = false;
    }
}

// ── Scheduler — เริ่ม interval (เรียกจาก server.js หลัง mongo connect) ───────
let _timer = null;

async function startVipExpiryScheduler() {
    if (_timer) return; // กันเริ่มซ้ำ
    const intervalMin = await getConfig('VIP_EXPIRY_JOB_INTERVAL_MIN', 60);
    const intervalMs  = Math.max(1, Number(intervalMin)) * 60 * 1000;

    console.log(`🗓️  [vip-expiry] scheduler started — every ${intervalMin} min`);
    // รันทันที 1 รอบตอน boot (catch สิ่งที่ค้างระหว่าง server down)
    runVipExpiryCheck('startup');
    _timer = setInterval(() => runVipExpiryCheck('interval'), intervalMs);
    // ไม่ block process exit
    if (_timer.unref) _timer.unref();
}

function getLastRun() { return _lastRun; }

module.exports = {
    runVipExpiryCheck,
    startVipExpiryScheduler,
    getLastRun,
};
