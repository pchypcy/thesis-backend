// routes/merchant.js — InGreen Sprint 2
//
// การเปลี่ยนแปลงจาก Sprint 1:
//   [SPRINT 2] scan-coupon: early-detect คูปองที่ "ใช้แล้ว" หรือ "หมดอายุ"
//              → ส่ง errorCode กลับทันที ก่อนถามราคา ไม่ต้องรอกรอกยอด
//              → Admin MerchantScan จะ alert ทันทีตาม errorCode
//   [SPRINT 2] scan-coupon: ตรวจ expiresAt → ถ้าเลยเวลา → reject + update status = 'expired'
//   [SPRINT 2] scan-coupon: Atomic quota deduction ด้วย CouponQuota.atomicDeduct()
//              → ป้องกัน race condition กรณีหลายคนสแกนพร้อมกัน

const express      = require('express');
const router       = express.Router();
const Coupon       = require('../models/Coupon');
const CouponQuota  = require('../models/CouponQuota');
const Invoice      = require('../models/Invoice');
const Reward       = require('../models/Reward');
const Merchant     = require('../models/Merchant');
const { getConfig } = require('./config'); // ★ SPRINT 5: Dynamic AppConfig

// ─── Login (เช็คทั้งร้านใหม่และร้านเก่า) ──────────────────────────────────────────
const validMerchants = {
  'shop_001': { id: 'shop_001', name: 'Patom Organic',      pass: '1234' },
  'shop_002': { id: 'shop_002', name: 'Vista Cafe',          pass: '1234' },
  'shop_003': { id: 'shop_003', name: 'Monsoon Tea',         pass: '1234' },
  'shop_004': { id: 'shop_004', name: 'Lemon Farm',          pass: '1234' },
  'shop_005': { id: 'shop_005', name: 'โอ้กะจู๋ (Ohkajhu)', pass: '1234' },
  'shop_006': { id: 'shop_006', name: 'ต้นกล้า ฟ้าใส',      pass: '1234' },
};

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    // 1. ค้นหาจาก Database ก่อน (ร้านค้าใหม่ที่เพิ่มผ่านแอดมิน)
    const dbShop = await Merchant.findOne({ shopId: username, password: password });
    if (dbShop) {
      return res.json({ success: true, message: 'เข้าสู่ระบบสำเร็จ', merchantId: dbShop.shopId, merchantName: dbShop.name });
    }

    // 2. ถ้าใน DB ไม่มี ให้ค้นหาจาก Hardcode (ร้านค้าเก่า)
    const shop = validMerchants[username];
    if (shop && password === shop.pass) {
      return res.json({ success: true, message: 'เข้าสู่ระบบสำเร็จ', merchantId: shop.id, merchantName: shop.name });
    }

    return res.status(401).json({ success: false, message: 'รหัสร้านค้า หรือรหัสผ่านไม่ถูกต้อง' });
  } catch (err) {
    console.error('Login Error:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ' });
  }
});

// ─── Pre-check Coupon (ใหม่ SPRINT 2) ────────────────────────────────────────
// Admin MerchantScan เรียก endpoint นี้ทันทีหลังสแกน QR
// เพื่อ detect สถานะคูปองก่อนเปิด AmountModal
// → ถ้าคูปองใช้แล้ว/หมดอายุ → ส่ง errorCode กลับทันที → Admin alert ทันที
// → ถ้าคูปอง valid → ส่ง { ok: true } → Admin ค่อยเปิด AmountModal
router.post('/check-coupon', async (req, res) => {
  try {
    const { couponCode } = req.body;

    if (!couponCode) {
      return res.status(400).json({ success: false, errorCode: 'INVALID_FORMAT', message: 'รหัสคูปองไม่ถูกต้อง' });
    }

    // ค้นหาคูปองในระบบ (ไม่ filter status เพื่อให้จับ redeemed/expired ได้)
    const coupon = await Coupon.findOne({ couponCode });

    if (!coupon) {
      return res.status(404).json({
        success: false,
        errorCode: 'NOT_FOUND',
        message: 'ไม่พบคูปองในระบบ',
      });
    }

    // ★ SPRINT 2: ตรวจสอบ status ก่อนเลย
    if (coupon.status === 'redeemed') {
      return res.status(400).json({
        success: false,
        errorCode: 'ALREADY_USED',
        // usedAt ส่งกลับไปด้วยเพื่อให้ Admin แสดงเวลาที่ใช้ไป
        usedAt:  coupon.usedAt ? coupon.usedAt.toISOString() : null,
        message: `คูปองนี้ถูกใช้งานไปแล้ว${coupon.usedAt ? ` (${new Date(coupon.usedAt).toLocaleString('th-TH')})` : ''}`,
      });
    }

    if (coupon.status === 'expired') {
      return res.status(400).json({
        success: false,
        errorCode: 'EXPIRED',
        expiresAt: coupon.expiresAt ? coupon.expiresAt.toISOString() : null,
        message:   'คูปองหมดอายุการใช้งานแล้ว',
      });
    }

    // ★ SPRINT 2: ตรวจสอบ expiresAt แม้ status ยังเป็น 'active'
    // (กรณีที่ยังไม่มีใครสแกน แต่เวลาผ่านไปแล้ว)
    if (coupon.expiresAt && new Date() > coupon.expiresAt) {
      // อัปเดต status → 'expired' ใน background
      await Coupon.updateOne({ _id: coupon._id }, { $set: { status: 'expired' } });

      return res.status(400).json({
        success: false,
        errorCode: 'EXPIRED',
        expiresAt: coupon.expiresAt.toISOString(),
        message:   'คูปองหมดอายุการใช้งานแล้ว (เกิน 30 นาที)',
      });
    }

    // คูปอง valid — ส่งข้อมูลกลับให้ Admin แสดงใน AmountModal
    return res.json({
      success:   true,
      errorCode: null,
      coupon: {
        username:  coupon.username,
        shopName:  coupon.shopName,
        expiresAt: coupon.expiresAt ? coupon.expiresAt.toISOString() : null,
      },
    });

  } catch (err) {
    console.error('Check Coupon Error:', err);
    return res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
  }
});

// ─── Request Customer Confirm (★ SPRINT 5) ──────────────────────────────────
// ร้านกรอกยอด → สร้าง pendingConfirm → ลูกค้าต้องกดยืนยันใน 3 นาที
// Body: { merchantId, couponCode, totalAmount, discountValue? }
router.post('/request-confirm', async (req, res) => {
  try {
    // ★ Sprint 6: Order Summary — รับ originalAmount + discountAmount แยกชัด
    //   totalAmount = ยอดสุทธิ (ตามเดิม, backward compat)
    //   ถ้าไม่ส่ง originalAmount/discountAmount → infer: originalAmount = totalAmount, discount = 0
    const { merchantId, couponCode, totalAmount, originalAmount, discountAmount, discountValue } = req.body || {};

    if (!merchantId || !couponCode || totalAmount == null) {
      return res.status(400).json({ success: false, message: 'กรุณาส่ง merchantId, couponCode และ totalAmount' });
    }

    const coupon = await Coupon.findOne({ couponCode });
    if (!coupon) return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', message: 'ไม่พบคูปอง' });
    if (coupon.status !== 'active') {
      return res.status(400).json({ success: false, errorCode: coupon.status === 'redeemed' ? 'ALREADY_USED' : 'EXPIRED', message: 'คูปองใช้ไม่ได้' });
    }
    if (coupon.expiresAt && new Date() > coupon.expiresAt) {
      await Coupon.updateOne({ _id: coupon._id }, { $set: { status: 'expired' } });
      return res.status(400).json({ success: false, errorCode: 'EXPIRED', message: 'คูปองหมดอายุ' });
    }

    // ★ Sprint 6: validate Order Summary consistency
    const net      = Number(totalAmount);
    const original = originalAmount != null ? Number(originalAmount) : net;
    const discount = discountAmount != null ? Number(discountAmount) : Math.max(0, original - net);

    if (original < 0 || net < 0 || discount < 0) {
      return res.status(400).json({ success: false, message: 'จำนวนเงินต้องเป็นค่าบวก' });
    }
    if (discount > original + 0.01) {
      return res.status(400).json({ success: false, message: 'ส่วนลดมากกว่าราคาเต็ม' });
    }

    const now = new Date();
    const CONFIRM_WINDOW_MS = 3 * 60 * 1000; // 3 นาที

    coupon.pendingConfirm = {
      merchantId,
      originalAmount:   original,
      discountAmount:   discount,
      totalAmount:      net,
      discountValue:    discountValue || null,
      requestedAt:      now,
      confirmExpiresAt: new Date(now.getTime() + CONFIRM_WINDOW_MS),
      status:           'pending',
      confirmedAt:      null,
      rejectedAt:       null,
      rejectReason:     null,
    };
    await coupon.save();

    console.log(`📨 Confirm requested: ${couponCode} by ${merchantId} | amount=${totalAmount} | expires in 3min`);

    return res.json({
      success: true,
      message: 'ส่งคำขอยืนยันให้ลูกค้าแล้ว — รอลูกค้ากดยืนยันภายใน 3 นาที',
      couponCode,
      username:         coupon.username,
      confirmExpiresAt: coupon.pendingConfirm.confirmExpiresAt.toISOString(),
      windowSec:        Math.floor(CONFIRM_WINDOW_MS / 1000),
    });
  } catch (err) {
    console.error('Request Confirm Error:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
  }
});

// ─── Poll Customer Confirm Status (★ SPRINT 5) ──────────────────────────────
// ฝั่งร้านเรียกซ้ำเพื่อเช็คว่าลูกค้ายืนยันหรือยัง (long-poll alternative)
router.get('/confirm-status/:couponCode', async (req, res) => {
  try {
    const coupon = await Coupon.findOne({ couponCode: req.params.couponCode });
    if (!coupon) return res.status(404).json({ success: false, message: 'ไม่พบคูปอง' });

    const pc = coupon.pendingConfirm || {};
    // auto-mark timeout
    if (pc.status === 'pending' && pc.confirmExpiresAt && new Date() > pc.confirmExpiresAt) {
      coupon.pendingConfirm.status = 'timeout';
      await coupon.save();
    }

    return res.json({
      success: true,
      status:           coupon.pendingConfirm.status,
      confirmedAt:      coupon.pendingConfirm.confirmedAt,
      rejectedAt:       coupon.pendingConfirm.rejectedAt,
      rejectReason:     coupon.pendingConfirm.rejectReason,
      confirmExpiresAt: coupon.pendingConfirm.confirmExpiresAt,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Scan Coupon (ยืนยันการรับออเดอร์จริง) ───────────────────────────────────
router.post('/scan-coupon', async (req, res) => {
  try {
    const { merchantId, couponCode, totalAmount, skipCustomerConfirm } = req.body;

    // ── Step 1: ค้นหาคูปอง (ไม่ filter status เพื่อให้ catch ทุกกรณี) ──
    const coupon = await Coupon.findOne({ couponCode });

    if (!coupon) {
      return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', message: 'ไม่พบคูปองในระบบ' });
    }

    // ★ SPRINT 5: บังคับให้ผ่าน customer-confirm flow ก่อนจะ scan สรุปรายการได้
    // ยกเว้นกรณี Admin/legacy ที่ส่ง skipCustomerConfirm: true (เช่น ทดสอบ/ฉุกเฉิน)
    if (!skipCustomerConfirm && coupon.pendingConfirm?.status !== 'confirmed') {
      const reqStatus = coupon.pendingConfirm?.status || 'none';
      if (reqStatus === 'rejected') {
        return res.status(400).json({ success: false, errorCode: 'CUSTOMER_REJECTED', message: 'ลูกค้าปฏิเสธยอด — ทำรายการไม่ได้' });
      }
      if (reqStatus === 'timeout' || reqStatus === 'none') {
        return res.status(400).json({ success: false, errorCode: 'NEED_CUSTOMER_CONFIRM', message: 'กรุณาให้ลูกค้ายืนยันยอดก่อนทำรายการ (เริ่มจาก /request-confirm)' });
      }
      if (reqStatus === 'pending') {
        return res.status(400).json({ success: false, errorCode: 'AWAITING_CONFIRM', message: 'รอลูกค้ายืนยันยอด' });
      }
    }

    // ── Step 2: ★ SPRINT 2 — Early status checks (ส่ง error ทันทีก่อนประมวลผลต่อ) ──
    if (coupon.status === 'redeemed') {
      return res.status(400).json({
        success:   false,
        errorCode: 'ALREADY_USED',
        usedAt:    coupon.usedAt ? coupon.usedAt.toISOString() : null,
        message:   `คูปองนี้ถูกใช้งานไปแล้ว${coupon.usedAt ? ` (${new Date(coupon.usedAt).toLocaleString('th-TH')})` : ''}`,
      });
    }

    if (coupon.status === 'expired') {
      return res.status(400).json({
        success:   false,
        errorCode: 'EXPIRED',
        expiresAt: coupon.expiresAt ? coupon.expiresAt.toISOString() : null,
        message:   'คูปองหมดอายุการใช้งานแล้ว',
      });
    }

    // ── Step 3: ★ SPRINT 2 — ตรวจสอบ expiresAt (time-based expiry) ──
    if (coupon.expiresAt && new Date() > coupon.expiresAt) {
      await Coupon.updateOne({ _id: coupon._id }, { $set: { status: 'expired' } });
      return res.status(400).json({
        success:   false,
        errorCode: 'EXPIRED',
        expiresAt: coupon.expiresAt.toISOString(),
        message:   'คูปองหมดอายุการใช้งานแล้ว (เกิน 30 นาที)',
      });
    }

    // ── Step 4: ดึงแคมเปญปัจจุบันของร้านค้า ──
    const activeCampaign = await Reward.findOne({ shopId: merchantId, active: true })
      .sort({ updatedAt: -1 });

    const currentRate        = activeCampaign?.discountValue || activeCampaign?.discountRate || 'ไม่ระบุโปรโมชั่น';
    const couponOriginalRate = coupon.discountRate || null;
    const rateChanged        = couponOriginalRate && currentRate &&
      String(couponOriginalRate) !== String(currentRate);

    // ── Step 5: ★ SPRINT 2 — Atomic Quota Deduction ──────────────────────────
    // ใช้ CouponQuota.atomicDeduct() แทนการ update ธรรมดา
    // findOneAndUpdate + condition ทำให้ atomic: ถ้า usedTotal >= maxTotal → return null
    // ป้องกัน race condition: คนหลายคนสแกนพร้อมกัน → มีแค่คนเดียวที่ได้ deduct สำเร็จ
    if (activeCampaign) {
      const quota = await CouponQuota.findOne({ rewardId: activeCampaign._id, isActive: true });

      if (quota) {
        // ตรวจสอบวันหมดอายุของแคมเปญ
        if (quota.validUntil && new Date() > quota.validUntil) {
          return res.status(400).json({
            success:   false,
            errorCode: 'CAMPAIGN_EXPIRED',
            message:   'แคมเปญนี้หมดอายุแล้ว',
          });
        }

        // Atomic check-and-deduct
        const deducted = await CouponQuota.atomicDeduct(activeCampaign._id);
        if (!deducted) {
          return res.status(400).json({
            success:   false,
            errorCode: 'QUOTA_FULL',
            message:   'สิทธิ์ในแคมเปญนี้ถูกใช้ครบแล้ว',
          });
        }
      }
    }

    // ── Step 6: บันทึก Invoice ──
    // ★ SPRINT 5: ดึง GP fee % จาก AppConfig (เดิม hardcode 0.05)
    //   admin แก้ค่าใน UI → request ถัดไปใช้ค่าใหม่ทันที ไม่ต้อง deploy
    const parsedAmount = parseFloat(totalAmount);
    const feePercent   = await getConfig('INGREEN_FEE_PERCENT', 5); // default 5%
    const fee          = Math.round(parsedAmount * (feePercent / 100) * 100) / 100;

    const invoice = new Invoice({
      merchantId,
      username:             coupon.username,
      couponCode,
      totalAmount:          parsedAmount,
      inGreenFee:           fee,
      status:               'pending',
      discountRate:         currentRate,
      couponDiscount:       currentRate,
      previousDiscountRate: rateChanged ? couponOriginalRate : null,
      campaignLabel:        currentRate,
      campaignId:           activeCampaign?._id || null,
    });
    await invoice.save();

    // ── Step 7: Mark คูปองเป็น 'redeemed' ──
    coupon.status = 'redeemed';
    coupon.usedAt = new Date();
    await coupon.save();

    console.log(`✅ Coupon redeemed: ${couponCode} | Merchant: ${merchantId} | Amount: ${parsedAmount}`);

    return res.json({
      success: true,
      message: 'ทำรายการสำเร็จ',
      data: {
        totalAmount:          parsedAmount,
        inGreenFee:           fee,
        discountRate:         currentRate,
        campaignLabel:        currentRate,
        previousDiscountRate: rateChanged ? couponOriginalRate : null,
        rateChanged:          !!rateChanged,
      },
    });

  } catch (err) {
    console.error('Scan Coupon Error:', err);
    return res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
  }
});

// ─── Invoices ─────────────────────────────────────────────────────────────────
router.get('/invoices/:merchantId', async (req, res) => {
  try {
    const invoices = await Invoice.find({ merchantId: req.params.merchantId }).sort({ redeemedAt: -1 });
    const totalPendingFee = invoices.filter(i => i.status === 'pending').reduce((s, i) => s + i.inGreenFee, 0);
    return res.json({ success: true, totalPendingFee, invoices });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Revenue Share Dashboard (★ SPRINT 5) ───────────────────────────────────
// แสดงสรุปร้านค้า: ยอดที่ลูกค้าใช้คูปอง, GP ที่ InGreen หัก, สุทธิที่ร้านได้
// Query: ?period=day|week|month|all  (default = month)
router.get('/revenue/:merchantId', async (req, res) => {
  try {
    const { merchantId } = req.params;
    const period = (req.query.period || 'month').toLowerCase();

    const now = new Date();
    let since = null;
    if (period === 'day')   since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (period === 'week')  since = new Date(now.getTime() - 7  * 86400000);
    if (period === 'month') since = new Date(now.getTime() - 30 * 86400000);

    const filter = { merchantId };
    if (since) filter.redeemedAt = { $gte: since };

    const invoices = await Invoice.find(filter).sort({ redeemedAt: -1 });

    const gross         = invoices.reduce((s, i) => s + (i.totalAmount || 0), 0);
    const ingreenFee    = invoices.reduce((s, i) => s + (i.inGreenFee  || 0), 0);
    const netToMerchant = gross - ingreenFee;

    const pending = invoices.filter(i => i.status === 'pending');
    const paid    = invoices.filter(i => i.status === 'paid');

    // breakdown รายวัน (ใช้ใน chart)
    const byDay = {};
    invoices.forEach(inv => {
      const k = new Date(inv.redeemedAt).toISOString().slice(0, 10);
      if (!byDay[k]) byDay[k] = { date: k, count: 0, gross: 0, fee: 0, net: 0 };
      byDay[k].count += 1;
      byDay[k].gross += inv.totalAmount || 0;
      byDay[k].fee   += inv.inGreenFee  || 0;
      byDay[k].net   += (inv.totalAmount - inv.inGreenFee) || 0;
    });

    return res.json({
      success: true,
      period,
      since: since ? since.toISOString() : null,
      summary: {
        transactions:    invoices.length,
        grossRevenue:    Math.round(gross * 100) / 100,
        ingreenFee:      Math.round(ingreenFee * 100) / 100,
        netToMerchant:   Math.round(netToMerchant * 100) / 100,
        pendingPayout:   Math.round(pending.reduce((s, i) => s + (i.totalAmount - i.inGreenFee), 0) * 100) / 100,
        paidOut:         Math.round(paid.reduce(   (s, i) => s + (i.totalAmount - i.inGreenFee), 0) * 100) / 100,
        feePercent:      gross > 0 ? Math.round((ingreenFee / gross) * 1000) / 10 : 0,
      },
      breakdown: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
      recentTransactions: invoices.slice(0, 20).map(i => ({
        couponCode:   i.couponCode,
        username:     i.username,
        totalAmount:  i.totalAmount,
        inGreenFee:   i.inGreenFee,
        netAmount:    Math.round(((i.totalAmount || 0) - (i.inGreenFee || 0)) * 100) / 100,
        status:       i.status,
        campaignLabel: i.campaignLabel,
        redeemedAt:   i.redeemedAt,
      })),
    });
  } catch (err) {
    console.error('Revenue Error:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

module.exports = router;