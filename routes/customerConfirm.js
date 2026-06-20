// routes/customerConfirm.js — InGreen Sprint 5
//
// Customer-confirm flow ป้องกันร้านโกงยอด:
//   1. ร้านกรอกยอด → POST /merchant/request-confirm  (สร้าง pendingConfirm)
//   2. ลูกค้าดู /api/coupons/pending-confirm/:username → กดยืนยัน/ปฏิเสธ
//   3. ลูกค้ายืนยัน → ร้านเรียก /merchant/scan-coupon เพื่อสรุปรายการ
//
// Endpoints:
//   GET  /api/coupons/pending-confirm/:username   → ดูคูปองที่ร้านขอยืนยัน
//   POST /api/coupons/confirm                     → ลูกค้ายืนยันยอด
//   POST /api/coupons/reject                      → ลูกค้าปฏิเสธ (ยอดผิด/ไม่ได้สั่ง)
//
// Window: ลูกค้าต้องยืนยันภายใน 3 นาที มิฉะนั้น status → 'timeout'

const express = require('express');
const router  = express.Router();
const Coupon  = require('../models/Coupon');

// ── GET /api/coupons/active/:username ─────────────────────────────────────
// คูปองที่ user แลกไปแล้ว และยังใช้ได้ (status='active' + ยังไม่หมดอายุ)
// ใช้ที่หน้า Rewards ให้ลูกค้าวนกลับมาดู QR ได้ในระยะเวลาที่ยังไม่หมดอายุ
router.get('/active/:username', async (req, res) => {
    try {
        const { username } = req.params;
        if (!username) return res.status(400).json({ success: false, message: 'กรุณาระบุ username' });

        const now = new Date();
        const items = await Coupon.find({
            username,
            status:    'active',
            $or: [
                { expiresAt: null },           // ไม่มี expiresAt (legacy)
                { expiresAt: { $gt: now } },   // ยังไม่หมดอายุ
            ],
        })
        .sort({ createdAt: -1 })
        .limit(20);

        return res.json({
            success: true,
            total:   items.length,
            items:   items.map(c => ({
                couponCode: c.couponCode,
                shopName:   c.shopName,
                expiresAt:  c.expiresAt,
                issuedAt:   c.issuedAt || c.createdAt,
                secondsLeft: c.expiresAt
                    ? Math.max(0, Math.floor((c.expiresAt - now) / 1000))
                    : null,
            })),
        });
    } catch (err) {
        console.error('active coupons error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
});

// ── GET /api/coupons/pending-confirm/:username ────────────────────────────
router.get('/pending-confirm/:username', async (req, res) => {
    try {
        const { username } = req.params;
        if (!username) return res.status(400).json({ success: false, message: 'กรุณาระบุ username' });

        const now = new Date();
        const pending = await Coupon.find({
            username,
            'pendingConfirm.status':            'pending',
            'pendingConfirm.confirmExpiresAt':  { $gt: now },
        }).sort({ 'pendingConfirm.requestedAt': -1 });

        // หมดเวลา → อัปเดต status เป็น timeout
        await Coupon.updateMany(
            {
                username,
                'pendingConfirm.status':            'pending',
                'pendingConfirm.confirmExpiresAt':  { $lte: now },
            },
            { $set: { 'pendingConfirm.status': 'timeout' } }
        );

        return res.json({
            success: true,
            total:   pending.length,
            items:   pending.map(c => ({
                couponCode:        c.couponCode,
                shopName:          c.shopName,
                merchantId:        c.pendingConfirm.merchantId,
                // ★ Sprint 6: Order Summary fields — fallback ถ้า coupon เก่ายังไม่มี
                originalAmount:    c.pendingConfirm.originalAmount ?? c.pendingConfirm.totalAmount,
                discountAmount:    c.pendingConfirm.discountAmount ?? 0,
                totalAmount:       c.pendingConfirm.totalAmount,
                discountValue:     c.pendingConfirm.discountValue,
                requestedAt:       c.pendingConfirm.requestedAt,
                confirmExpiresAt:  c.pendingConfirm.confirmExpiresAt,
                secondsLeft:       Math.max(0, Math.floor((c.pendingConfirm.confirmExpiresAt - now) / 1000)),
            })),
        });
    } catch (err) {
        console.error('pending-confirm error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
});

// ── POST /api/coupons/confirm ─────────────────────────────────────────────
// Body: { couponCode, username }
router.post('/confirm', async (req, res) => {
    try {
        const { couponCode, username } = req.body || {};
        if (!couponCode || !username) {
            return res.status(400).json({ success: false, message: 'กรุณาระบุ couponCode และ username' });
        }

        const coupon = await Coupon.findOne({ couponCode, username });
        if (!coupon) return res.status(404).json({ success: false, message: 'ไม่พบคูปอง' });

        if (coupon.pendingConfirm?.status !== 'pending') {
            return res.status(400).json({
                success: false,
                errorCode: 'NO_PENDING_REQUEST',
                message: 'ไม่มีคำขอยืนยันที่รอดำเนินการ',
                currentStatus: coupon.pendingConfirm?.status || 'none',
            });
        }

        if (coupon.pendingConfirm.confirmExpiresAt < new Date()) {
            coupon.pendingConfirm.status = 'timeout';
            await coupon.save();
            return res.status(400).json({ success: false, errorCode: 'EXPIRED_WINDOW', message: 'หมดเวลาในการยืนยัน (3 นาที)' });
        }

        coupon.pendingConfirm.status      = 'confirmed';
        coupon.pendingConfirm.confirmedAt = new Date();
        await coupon.save();

        console.log(`✅ Customer confirmed: ${couponCode} by ${username} | amount=${coupon.pendingConfirm.totalAmount}`);

        return res.json({
            success: true,
            message: 'ยืนยันยอดเรียบร้อย — ร้านสามารถสรุปรายการได้แล้ว',
            confirmedAt: coupon.pendingConfirm.confirmedAt,
        });
    } catch (err) {
        console.error('confirm error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
});

// ── POST /api/coupons/reject ──────────────────────────────────────────────
// Body: { couponCode, username, reason? }
router.post('/reject', async (req, res) => {
    try {
        const { couponCode, username, reason } = req.body || {};
        if (!couponCode || !username) {
            return res.status(400).json({ success: false, message: 'กรุณาระบุ couponCode และ username' });
        }

        const coupon = await Coupon.findOne({ couponCode, username });
        if (!coupon) return res.status(404).json({ success: false, message: 'ไม่พบคูปอง' });

        if (coupon.pendingConfirm?.status !== 'pending') {
            return res.status(400).json({
                success: false,
                errorCode: 'NO_PENDING_REQUEST',
                message: 'ไม่มีคำขอยืนยันที่รอดำเนินการ',
            });
        }

        coupon.pendingConfirm.status       = 'rejected';
        coupon.pendingConfirm.rejectedAt   = new Date();
        coupon.pendingConfirm.rejectReason = (reason || '').slice(0, 200);
        await coupon.save();

        console.log(`❌ Customer rejected: ${couponCode} by ${username} | reason: ${reason || '-'}`);

        return res.json({ success: true, message: 'ปฏิเสธยอดเรียบร้อย' });
    } catch (err) {
        console.error('reject error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
});

module.exports = router;
