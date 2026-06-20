// routes/vip.js — InGreen Sprint 2
//
// Endpoints:
//   GET  /api/vip/status/:username   → (1) vip-status: ตรวจว่า user เป็น VIP ไหม และหมดเมื่อไหร่
//   POST /api/vip/upgrade            → (2) upgrade-vip: รับชำระเงิน ตั้งค่าวันหมดอายุ 30 วัน
//   GET  /api/vip/quota/:username    → (3) check-quota: เช็คว่า VIP user ยังมีสิทธิ์ใช้คูปองไหม
//
// Integration:
//   - Scan.jsx เรียก GET /api/vip/status/:username ตอน mount
//   - SugarTracker.jsx เรียก GET /api/vip/status/:username ก่อน load data
//   - Profile.jsx ปุ่ม "อัปเกรด VIP" → POST /api/vip/upgrade
//   - merchant.js scan-coupon เรียก GET /api/vip/quota/:username ก่อน deduct
//
// ★ check-quota ทำงานร่วมกับ CouponQuota.atomicDeduct() ใน merchant.js
//   ทั้งคู่ป้องกัน race condition คนละ layer:
//   - check-quota: ตรวจสิทธิ์ VIP ก่อนอนุญาตให้ redeem
//   - atomicDeduct: ตัดโควต้าแบบ atomic ป้องกัน oversell

const express          = require('express');
const router           = express.Router();
const VipSubscription  = require('../models/VipSubscription');
const CouponQuota      = require('../models/CouponQuota');
const Coupon           = require('../models/Coupon');
const { getConfig }    = require('./config');
const { runVipExpiryCheck, getLastRun } = require('../jobs/vipExpiryJob'); // ★ SPRINT 7

// ─── (1) GET /api/vip/status/:username ────────────────────────────────────────
// ตรวจว่า user เป็น VIP อยู่ไหม และหมดอายุเมื่อไหร่
// Response:
//   { success, isVip, status, daysRemaining, expiresAt, trialEndsAt }
//
// isVip = true  → ยังอยู่ใน trial period หรือ subscription active
// isVip = false → ไม่มี subscription, หมดอายุ, หรือ cancelled หลัง expiresAt
//
// ★ Frontend ใช้ isVip เป็น gate สำหรับ Sugar Tracker และ log-intake
//   ถ้า isVip = false → Sugar Tracker แสดง upgrade prompt แทน
router.get('/status/:username', async (req, res) => {
    try {
        const { username } = req.params;
        if (!username) {
            return res.status(400).json({ success: false, message: 'กรุณาระบุ username' });
        }

        const sub = await VipSubscription.findOne({ username });

        // ไม่เคย subscribe เลย → ไม่ใช่ VIP
        if (!sub) {
            return res.json({
                success:      true,
                isVip:        false,
                status:       null,
                daysRemaining: 0,
                expiresAt:    null,
                trialEndsAt:  null,
            });
        }

        // ใช้ virtual ของ Model ตรวจสอบ (รองรับ trial + active + cancelled)
        const isVip        = sub.isActive;         // virtual property
        const daysRemaining = sub.daysRemaining;   // virtual property

        // ถ้าหมดอายุแล้วแต่ status ยังไม่อัปเดต → fix ใน background
        if (!isVip && sub.status === 'active') {
            await VipSubscription.updateOne({ _id: sub._id }, { $set: { status: 'expired' } });
        }

        return res.json({
            success:       true,
            isVip,
            status:        sub.status,
            daysRemaining,
            expiresAt:     sub.expiresAt ? sub.expiresAt.toISOString() : null,
            trialEndsAt:   sub.trialEndsAt ? sub.trialEndsAt.toISOString() : null,
            startedAt:     sub.startedAt ? sub.startedAt.toISOString() : null,
        });

    } catch (err) {
        console.error('VIP Status Error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
    }
});

// ─── (2) POST /api/vip/upgrade ────────────────────────────────────────────────
// รับชำระเงินและตั้งค่าวันหมดอายุ 30 วัน
//
// Body: { username, amount, method, reference }
//   - amount:    จำนวนเงินที่ชำระ (default 69 บาท จาก Config)
//   - method:    วิธีชำระ เช่น 'promptpay', 'card', 'in_app'
//   - reference: หมายเลขอ้างอิงการชำระเงิน (optional)
//
// ★ Production note: ต่อ payment gateway จริงก่อน call endpoint นี้
//   ปัจจุบัน trust frontend ว่าชำระแล้ว (demo mode)
//   เมื่อต่อ payment จริง → verify payment reference ที่นี่ก่อน upgrade
router.post('/upgrade', async (req, res) => {
    try {
        const { username, amount, method = 'in_app', reference = null } = req.body;

        if (!username) {
            return res.status(400).json({ success: false, message: 'กรุณาระบุ username' });
        }

        // ดึงราคาและระยะเวลาจาก Config (เผื่อ Admin เปลี่ยนทีหลัง)
        const vipPrice    = await getConfig('VIP_PRICE_THB', 69);
        const vipDuration = await getConfig('VIP_DURATION_DAYS', 30);

        const paymentInfo = {
            amount:    amount || vipPrice,
            method,
            reference,
        };

        // Static method ใน VipSubscription model (upsert + push paymentHistory)
        const sub = await VipSubscription.upgrade(username, vipDuration, paymentInfo);

        console.log(`👑 VIP Upgraded: ${username} | ${vipDuration} days | ฿${paymentInfo.amount} | expires: ${sub.expiresAt?.toISOString()}`);

        return res.json({
            success:      true,
            message:      `อัปเกรด VIP สำเร็จ! ใช้งานได้ ${vipDuration} วัน`,
            status:       sub.status,
            expiresAt:    sub.expiresAt ? sub.expiresAt.toISOString() : null,
            daysRemaining: sub.daysRemaining,
            amountPaid:   paymentInfo.amount,
        });

    } catch (err) {
        console.error('VIP Upgrade Error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการอัปเกรด' });
    }
});

// ─── (3) GET /api/vip/quota/:username ─────────────────────────────────────────
// ตรวจก่อนทุกการใช้คูปองว่า VIP user ยังมีสิทธิ์เหลืออยู่ไหม
//
// ตรวจสอบ:
//   1. VIP status (isVip)
//   2. คูปองที่ใช้ไปแล้วของ user ใน 30 วัน (maxPerUser ต่อแคมเปญ)
//   3. โควต้ารวมของแคมเปญ (maxTotal — ตรวจ CouponQuota)
//
// Response:
//   { success, hasQuota, reason, usedToday, maxPerDay, usedTotal }
//
// ★ เรียกใช้ใน merchant.js scan-coupon Step 5 (ก่อน atomicDeduct)
//   ถ้า hasQuota = false → reject ก่อน atomicDeduct เพื่อประหยัด write ops
router.get('/quota/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const { rewardId } = req.query; // optional: เช็คโควต้าของแคมเปญเฉพาะ

        // ── Step 1: ตรวจ VIP status ────────────────────────────────────────
        const sub = await VipSubscription.findOne({ username });
        const isVip = sub ? sub.isActive : false;

        if (!isVip) {
            return res.status(403).json({
                success:  false,
                hasQuota: false,
                reason:   'NOT_VIP',
                message:  'ต้องเป็นสมาชิก VIP เพื่อใช้สิทธิ์นี้',
            });
        }

        // ── Step 2: เช็คจำนวนคูปองที่ user ใช้ไปแล้วใน 30 วัน ────────────
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const usedCoupons   = await Coupon.countDocuments({
            username,
            status:    'redeemed',
            usedAt:    { $gte: thirtyDaysAgo },
            ...(rewardId ? { campaignId: rewardId } : {}),
        });

        // ── Step 3: ตรวจโควต้าของแคมเปญ (ถ้าระบุ rewardId) ───────────────
        let campaignFull = false;
        let quotaInfo    = null;

        if (rewardId) {
            const quota = await CouponQuota.findOne({ rewardId, isActive: true });
            if (quota) {
                // ตรวจ maxPerUser
                const userUsedInCampaign = await Coupon.countDocuments({
                    username,
                    status: 'redeemed',
                    // ในอนาคต เพิ่ม campaignId field ใน Coupon เพื่อ filter ได้ชัดขึ้น
                });

                if (quota.maxPerUser && userUsedInCampaign >= quota.maxPerUser) {
                    campaignFull = true;
                }

                // ตรวจ maxTotal (ผ่าน virtual isFull)
                if (quota.maxTotal !== null && quota.usedTotal >= quota.maxTotal) {
                    campaignFull = true;
                }

                quotaInfo = {
                    maxTotal:   quota.maxTotal,
                    usedTotal:  quota.usedTotal,
                    maxPerUser: quota.maxPerUser,
                };
            }
        }

        if (campaignFull) {
            return res.json({
                success:  true,
                hasQuota: false,
                reason:   'QUOTA_FULL',
                message:  'โควต้าของแคมเปญนี้ถูกใช้ครบแล้ว หรือคุณใช้สิทธิ์ครบแล้ว',
                ...quotaInfo,
            });
        }

        // ── All checks passed ───────────────────────────────────────────────
        return res.json({
            success:    true,
            hasQuota:   true,
            reason:     null,
            usedLast30: usedCoupons,
            message:    'มีสิทธิ์ใช้คูปอง',
            ...(quotaInfo || {}),
        });

    } catch (err) {
        console.error('VIP Quota Error:', err);
        return res.status(500).json({ success: false, hasQuota: false, reason: 'SERVER_ERROR', message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
    }
});

// ─── POST /api/vip/start-trial ────────────────────────────────────────────────
// เริ่ม trial period สำหรับ user ใหม่ (เรียกตอน register หรือครั้งแรกที่ login)
// เพื่อให้ใช้ Sugar Tracker ได้ 3 วันฟรีก่อนต้องสมัคร VIP
router.post('/start-trial', async (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.status(400).json({ success: false, message: 'กรุณาระบุ username' });

        const trialDays = await getConfig('VIP_FREE_TRIAL_DAYS', 3);

        // $setOnInsert → ถ้ามีอยู่แล้วไม่ทับ (idempotent)
        const sub = await VipSubscription.startTrial(username, trialDays);

        return res.json({
            success:     true,
            isVip:       sub.isActive,
            status:      sub.status,
            trialEndsAt: sub.trialEndsAt ? sub.trialEndsAt.toISOString() : null,
            message:     `เริ่ม trial ${trialDays} วันสำเร็จ`,
        });

    } catch (err) {
        console.error('Start Trial Error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
});

// ─── POST /api/vip/cancel ────────────────────────────────────────────────────
// ★ SPRINT 5: ยกเลิก VIP (ยังใช้งานต่อได้จนถึง expiresAt ปัจจุบัน)
// Body: { username }
router.post('/cancel', async (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.status(400).json({ success: false, message: 'กรุณาระบุ username' });

        const sub = await VipSubscription.findOne({ username });
        if (!sub) return res.status(404).json({ success: false, message: 'ไม่พบ subscription' });

        if (sub.status === 'cancelled') {
            return res.json({ success: true, alreadyCancelled: true, expiresAt: sub.expiresAt, message: 'ยกเลิกไปแล้ว — ใช้งานต่อได้ถึงวันหมดอายุ' });
        }
        if (sub.status !== 'active') {
            return res.status(400).json({ success: false, message: 'subscription ไม่ใช่สถานะ active' });
        }

        sub.status = 'cancelled';
        await sub.save();

        console.log(`🚫 VIP cancelled: ${username} | will keep access until ${sub.expiresAt?.toISOString()}`);

        return res.json({
            success: true,
            message: 'ยกเลิกสำเร็จ คุณยังใช้งาน VIP ได้จนถึงวันหมดอายุ',
            expiresAt:     sub.expiresAt ? sub.expiresAt.toISOString() : null,
            daysRemaining: sub.daysRemaining,
        });

    } catch (err) {
        console.error('VIP Cancel Error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
});

// ─── ★ SPRINT 7: Manual trigger VIP expiry job (admin / testing) ─────────────
// รัน scheduled job ทันที 1 รอบ — ใช้ทดสอบหรือ force ตัดสิทธิ์นอกรอบ
// Response: summary { trialExpired, subscriptionExpired, reminded, ... }
router.post('/run-expiry-job', async (req, res) => {
    try {
        const summary = await runVipExpiryCheck('manual');
        return res.json({ success: true, summary });
    } catch (err) {
        console.error('run-expiry-job error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ─── ★ SPRINT 7: ดู summary ของ job รอบล่าสุด ───────────────────────────────
router.get('/expiry-job/last-run', (req, res) => {
    return res.json({ success: true, lastRun: getLastRun() });
});

module.exports = router;