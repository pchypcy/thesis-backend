// routes/admin.js — InGreen Sprint 2
// การเปลี่ยนแปลง:
//   [SPRINT 2] dashboard-summary: เพิ่ม VipSubscription stats
//              → vip.activeCount, vip.trialCount, vip.revenue (real subscription count × price)
//              → users list เพิ่ม vipStatus field สำหรับแสดงใน Users table

const express = require('express');
const router = express.Router();

const User            = require('../models/User');
const Invoice         = require('../models/Invoice');
const Coupon          = require('../models/Coupon');
const Reward          = require('../models/Reward');
const CouponQuota     = require('../models/CouponQuota'); // ★ SPRINT 5
const Merchant        = require('../models/Merchant');
const VipSubscription = require('../models/VipSubscription'); // ★ SPRINT 2

// ─── Shop registry (ร้านเดิม Hardcode ยังอยู่ครบ) ──────────────────────────
const shopNamesMap = {
  'shop_001': 'Patom Organic',
  'shop_002': 'Vista Cafe',
  'shop_003': 'Monsoon Tea',
  'shop_004': 'Lemon Farm',
  'shop_005': 'โอ้กะจู๋ (Ohkajhu)',
  'shop_006': 'ต้นกล้า ฟ้าใส',
};

// ─── Login ───────────────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'admin123') {
    return res.status(200).json({ success: true, message: 'เข้าสู่ระบบสำเร็จ', role: 'admin' });
  }
  return res.status(401).json({ success: false, message: 'Username หรือ Password ไม่ถูกต้อง' });
});

// ─── Dashboard Summary ────────────────────────────────────────────────────────
router.get('/dashboard-summary', async (req, res) => {
  try {
    // ★ SPRINT 2: เพิ่ม VipSubscription.find() เข้า Promise.all
    const [users, invoices, coupons, rewards, merchantsDb, vipSubs] = await Promise.all([
      User.find(),
      Invoice.find(),
      Coupon.find(),
      Reward.find().sort({ createdAt: 1 }), 
      Merchant.find(),
      VipSubscription.find(), // ★ SPRINT 2
    ]);

    // ── คำนวณรายได้ ──
    const totalCouponUsage = invoices.reduce((s, i) => s + (i.totalAmount || 0), 0);
    const couponFeeRevenue = invoices.reduce((s, i) => s + (i.inGreenFee || 0), 0);

    // ★ SPRINT 2: คำนวณ VIP stats ─────────────────────────────────────────────
    const now = new Date();
    const vipActiveCount = vipSubs.filter(s => {
      if (s.status === 'active' && s.expiresAt && now < s.expiresAt) return true;
      return false;
    }).length;
    const vipTrialCount = vipSubs.filter(s => {
      if (s.status === 'trial' && s.trialEndsAt && now < s.trialEndsAt) return true;
      return false;
    }).length;
    // รายได้ VIP = นับจาก paymentHistory จริง (ไม่ใช่ estimate จาก count)
    const vipRevenue = vipSubs.reduce((sum, s) => {
      return sum + (s.paymentHistory || []).reduce((ps, p) => ps + (p.amount || 0), 0);
    }, 0);

    // ── สร้าง Map ของ VIP status ต่อ username (สำหรับ Users table) ──────────
    const vipStatusMap = {};
    vipSubs.forEach(s => {
      let isActive = false;
      if (s.status === 'trial'  && s.trialEndsAt && now < s.trialEndsAt) isActive = true;
      if (s.status === 'active' && s.expiresAt    && now < s.expiresAt)  isActive = true;
      vipStatusMap[s.username] = {
        isVip:         isActive,
        status:        s.status,
        daysRemaining: isActive ? Math.ceil((( s.status === 'trial' ? s.trialEndsAt : s.expiresAt) - now) / 86400000) : 0,
        expiresAt:     s.expiresAt ? s.expiresAt.toISOString() : null,
        trialEndsAt:   s.trialEndsAt ? s.trialEndsAt.toISOString() : null,
      };
    });

    // ── สร้าง shopStats (รวมร้านเก่า + ร้านใหม่) ──
    const shopStats = {};
    
    Object.keys(shopNamesMap).forEach(key => {
      shopStats[key] = {
        id: key,
        name: shopNamesMap[key],
        totalAmount: 0,
        inGreenFee: 0,
        transactions: [],
        campaigns: [],  
      };
    });

    merchantsDb.forEach(m => {
      shopStats[m.shopId] = {
        id: m.shopId,
        name: m.name,
        totalAmount: 0,
        inGreenFee: 0,
        transactions: [],
        campaigns: [],
      };
    });

    invoices.forEach(inv => {
      const s = shopStats[inv.merchantId];
      if (s) {
        s.totalAmount += inv.totalAmount || 0;
        s.inGreenFee  += inv.inGreenFee  || 0;
        s.transactions.push(inv);
      }
    });

    rewards.forEach(r => {
      const rObj = r.toObject();
      if (r.shopId && shopStats[r.shopId]) {
        shopStats[r.shopId].campaigns.push(rObj);
      } else if (!r.shopId) {
        const matchKey = Object.keys(shopNamesMap).find(
          k => shopNamesMap[k] === r.shopName
        );
        if (matchKey && shopStats[matchKey]) {
          shopStats[matchKey].campaigns.push(rObj);
        }
      }
    });

    const activeUsers = users.filter(u => u.status !== 'banned');

    // ★ SPRINT 2: เพิ่ม vipStatus ต่อ user ใน list
    const usersWithVip = users.map(u => ({
      ...u.toObject(),
      vipStatus: vipStatusMap[u.username] || { isVip: false, status: null, daysRemaining: 0 },
    }));

    // รายได้ subscription = VIP revenue จริง (จาก paymentHistory) ไม่ใช่ estimate
    // แต่เพื่อ backward compat กับ Admin UI เดิม ส่งทั้ง vipRevenue และ legacyRevenue
    const legacyRevenue = activeUsers.length * 69; // estimate เดิม

    return res.json({
      success: true,
      data: {
        users: { 
          count: activeUsers.length, 
          revenue: vipRevenue || legacyRevenue, // ★ SPRINT 2: ใช้ revenue จริง
          list: usersWithVip, // ★ SPRINT 2: เพิ่ม vipStatus
        },
        coupons:      { count: coupons.length, totalUsage: totalCouponUsage, feeRevenue: couponFeeRevenue },
        totalRevenue: (vipRevenue || legacyRevenue) + couponFeeRevenue,
        shops:        Object.values(shopStats),
        rewards,
        // ★ SPRINT 2: VIP summary สำหรับ Dashboard KPI card
        vip: {
          activeCount: vipActiveCount,
          trialCount:  vipTrialCount,
          revenue:     vipRevenue,
          totalSubs:   vipSubs.length,
        },
      },
    });

  } catch (err) {
    console.error('❌ Dashboard Error:', err);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// ─── POST สร้างร้านค้าใหม่ ───────────────────────────────────────────────────
router.post('/shops', async (req, res) => {
  try {
    const { id, name, password } = req.body;

    const existsInDb = await Merchant.findOne({ shopId: id });
    if (existsInDb || shopNamesMap[id]) {
      return res.status(400).json({ success: false, message: 'รหัสร้านค้านี้มีอยู่แล้วในระบบ กรุณาใช้รหัสอื่น' });
    }

    const newMerchant = new Merchant({ shopId: id, name, password });
    await newMerchant.save();
    
    return res.status(201).json({ success: true, data: newMerchant });
  } catch (err) {
    console.error('❌ Add Shop Error:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
  }
});

// ─── CRUD: Rewards ────────────────────────────────────────────────────────────

router.post('/rewards', async (req, res) => {
  try {
    const { shopId, shopName, discountValue, discountRate, description, cost, active, image, tag, category, maxTotal } = req.body;

    const resolvedShopId = shopId || Object.keys(shopNamesMap).find(k => shopNamesMap[k] === shopName);
    const newRate = extractRate(discountValue);

    const reward = new Reward({
      shopId:        resolvedShopId,
      shopName:      shopName || shopNamesMap[resolvedShopId] || 'Unknown Shop',
      discountValue: discountValue || '',
      discountRate:  discountRate || newRate,
      description:   description  || '',
      cost:          Number(cost) || 0,
      active:        active !== undefined ? active : true,
      image:         image || '',
      tag:           tag   || '',
      category:      category || '',
      changeHistory: [],
    });

    await reward.save();

    // ★ SPRINT 5: auto-create CouponQuota record (admin ใส่ maxTotal ตอน create ได้)
    //   ถ้าไม่ใส่ → default 50 สิทธิ์
    //   ถ้าใส่ null/empty/"unlimited" → null = ไม่จำกัด
    let finalMaxTotal = 50;
    if (maxTotal !== undefined) {
      if (maxTotal === null || maxTotal === '' || maxTotal === 'unlimited') finalMaxTotal = null;
      else finalMaxTotal = Number(maxTotal);
    }
    await CouponQuota.create({
      rewardId:    reward._id,
      shopId:      resolvedShopId || 'shop_unknown',
      shopName:    reward.shopName,
      maxTotal:    finalMaxTotal,
      maxPerUser:  1,
      usedTotal:   0,
      isActive:    true,
    });

    return res.status(201).json({ success: true, data: reward });

  } catch (err) {
    console.error('❌ Create Reward Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/rewards/:id', async (req, res) => {
  try {
    const { discountValue, discountRate, description, cost, active, shopId, shopName, image, tag, category, maxTotal } = req.body;
    const reward = await Reward.findById(req.params.id);
    if (!reward) return res.status(404).json({ success: false, message: 'ไม่พบแคมเปญ' });

    // ★ SPRINT 5: update quota.maxTotal — auto-upsert ถ้ายังไม่มี (กัน edge case admin แก้ reward เก่าที่ไม่มี quota)
    if (maxTotal !== undefined) {
      let finalMaxTotal;
      if (maxTotal === null || maxTotal === '' || maxTotal === 'unlimited') finalMaxTotal = null;
      else finalMaxTotal = Number(maxTotal);

      const quota = await CouponQuota.findOne({ rewardId: reward._id });
      if (quota) {
        quota.maxTotal = finalMaxTotal;
        await quota.save();
      } else {
        // ไม่มี → create ใหม่ (auto-fill ค่าอื่นเป็น default)
        await CouponQuota.create({
          rewardId:    reward._id,
          shopId:      reward.shopId || 'shop_unknown',
          shopName:    reward.shopName,
          maxTotal:    finalMaxTotal,
          maxPerUser:  1,
          usedTotal:   0,
          isActive:    true,
        });
      }
    }

    const newRate = discountValue ? extractRate(discountValue) : null;

    if (discountValue !== undefined && String(discountValue) !== String(reward.discountValue)) {
      if (!reward.changeHistory) reward.changeHistory = [];
      reward.changeHistory.push({
        discountValue: reward.discountValue,
        discountRate:  reward.discountRate,
        description:   reward.description,
        cost:          reward.cost,
        active:        reward.active,
        changedAt:     new Date(),
        changedBy:     'admin',
      });
    }

    if (discountValue !== undefined) reward.discountValue = discountValue;
    if (discountRate  !== undefined) reward.discountRate  = discountRate;
    else if (discountValue)          reward.discountRate  = newRate;
    if (description   !== undefined) reward.description   = description;
    if (cost          !== undefined) reward.cost          = Number(cost);
    if (active        !== undefined) reward.active        = active;
    if (shopId        !== undefined) reward.shopId        = shopId;
    if (shopName      !== undefined) reward.shopName      = shopName;
    if (image         !== undefined) reward.image         = image;
    if (tag           !== undefined) reward.tag           = tag;
    if (category      !== undefined) reward.category      = category;

    await reward.save();
    return res.json({ success: true, data: reward });

  } catch (err) {
    console.error('❌ Update Reward Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/rewards/:id/toggle', async (req, res) => {
  try {
    const reward = await Reward.findById(req.params.id);
    if (!reward) return res.status(404).json({ success: false, message: 'ไม่พบแคมเปญ' });

    reward.active = req.body.active !== undefined ? req.body.active : !reward.active;
    await reward.save();
    return res.json({ success: true, data: reward });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/rewards/:id', async (req, res) => {
  try {
    const reward = await Reward.findByIdAndDelete(req.params.id);
    if (!reward) return res.status(404).json({ success: false, message: 'ไม่พบแคมเปญ' });
    return res.json({ success: true, message: 'ลบแคมเปญสำเร็จ' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/rewards/seed', async (req, res) => {
  try {
    await Reward.deleteMany({});
    const seedData = [
      { shopId: 'shop_001', shopName: 'Patom Organic',      discountValue: 'ส่วนลด 15%',   discountRate: 'ส่วนลด 15%',       description: 'คาเฟ่ออร์แกนิก', cost: 300, active: true,  tag: 'POPULAR',      category: 'Cafe & Lifestyle' },
      { shopId: 'shop_002', shopName: 'Vista Cafe',          discountValue: 'ฟรี 1 เมนู',   discountRate: 'ฟรี 1 เมนู',   description: 'เบเกอรี่เพื่อสุขภาพ', cost: 200, active: true,  tag: 'HEALTHY',      category: 'Cafe' },
      { shopId: 'shop_003', shopName: 'Monsoon Tea',         discountValue: 'ซื้อ 1 แถม 1', discountRate: 'ซื้อ 1 แถม 1', description: 'ชารักษ์ป่า', cost: 250, active: true,  tag: 'ECO-FRIENDLY', category: 'Tea House' },
      { shopId: 'shop_004', shopName: 'Lemon Farm',          discountValue: 'ส่วนลด 50฿',   discountRate: 'ส่วนลด 50฿',  description: 'ซูเปอร์มาร์เก็ตออร์แกนิก', cost: 150, active: true,  tag: 'VERIFIED',     category: 'Organic Market' },
      { shopId: 'shop_005', shopName: 'โอ้กะจู๋ (Ohkajhu)', discountValue: 'ฟรี สลัด 1 จาน', discountRate: 'ฟรี สลัด 1 จาน', description: 'อาหารเพื่อสุขภาพ', cost: 200, active: true,  tag: 'ORGANIC FOOD', category: 'Food' },
      { shopId: 'shop_006', shopName: 'ต้นกล้า ฟ้าใส',      discountValue: 'ส่วนลด 10%',   discountRate: 'ส่วนลด 10%',       description: 'Plant-based', cost: 250, active: true,  tag: 'PLANT-BASED',  category: 'Food' },
    ];
    const inserted = await Reward.insertMany(seedData);
    return res.json({ success: true, message: `Seeded ${inserted.length} rewards`, data: inserted });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── CRUD: Coupon Quota (★ SPRINT 5) ─────────────────────────────────────────
//
// Quota ผูกกับ Reward (1 reward = 1 quota record)
// Admin สามารถ:
//   - GET  /api/admin/quotas         → list ทั้งหมด (รวม reward info)
//   - PATCH /api/admin/quotas/:id    → แก้ maxTotal, maxPerUser, isActive
//   - POST  /api/admin/quotas/seed   → seed initial quota (คิดจาก cost ของแต่ละ reward)

router.get('/quotas', async (req, res) => {
  try {
    const quotas = await CouponQuota.find().lean();
    const rewardIds = quotas.map(q => q.rewardId);
    const rewards = await Reward.find({ _id: { $in: rewardIds } }).lean();
    const rewardMap = {};
    rewards.forEach(r => { rewardMap[String(r._id)] = r; });

    const enriched = quotas.map(q => {
      const r = rewardMap[String(q.rewardId)];
      const remaining = q.maxTotal != null ? Math.max(0, q.maxTotal - (q.usedTotal || 0)) : null;
      const percent   = q.maxTotal != null && q.maxTotal > 0 ? Math.round((q.usedTotal / q.maxTotal) * 100) : 0;
      return {
        ...q,
        remaining,
        percent,
        isFull: q.maxTotal != null && (q.usedTotal || 0) >= q.maxTotal,
        reward: r ? { _id: r._id, shopName: r.shopName, discountValue: r.discountValue, cost: r.cost, image: r.image } : null,
      };
    });

    return res.json({ success: true, total: enriched.length, data: enriched });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/quotas/:id', async (req, res) => {
  try {
    const { maxTotal, maxPerUser, maxPerDay, isActive, validUntil } = req.body || {};
    const quota = await CouponQuota.findById(req.params.id);
    if (!quota) return res.status(404).json({ success: false, message: 'ไม่พบ quota record' });

    if (maxTotal !== undefined)   quota.maxTotal   = maxTotal === null || maxTotal === '' ? null : Number(maxTotal);
    if (maxPerUser !== undefined) quota.maxPerUser = Number(maxPerUser) || 1;
    if (maxPerDay !== undefined)  quota.maxPerDay  = maxPerDay === null || maxPerDay === '' ? null : Number(maxPerDay);
    if (isActive !== undefined)   quota.isActive   = Boolean(isActive);
    if (validUntil !== undefined) quota.validUntil = validUntil ? new Date(validUntil) : null;

    await quota.save();
    return res.json({ success: true, data: quota });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Seed: คิดสิทธิ์อัตโนมัติจาก cost — แพง = น้อย, ถูก = เยอะ (ทำให้ดู realistic)
//   cost ≤ 150 → 100 สิทธิ์
//   cost ≤ 200 → 80
//   cost ≤ 250 → 60
//   cost ≤ 300 → 40
//   cost > 300 → 30
router.post('/quotas/seed', async (req, res) => {
  try {
    const rewards = await Reward.find().lean();
    let created = 0, skipped = 0;

    for (const r of rewards) {
      const existing = await CouponQuota.findOne({ rewardId: r._id });
      if (existing) { skipped++; continue; }

      const cost = Number(r.cost) || 200;
      let maxTotal = 50;
      if (cost <= 150)      maxTotal = 100;
      else if (cost <= 200) maxTotal = 80;
      else if (cost <= 250) maxTotal = 60;
      else if (cost <= 300) maxTotal = 40;
      else                   maxTotal = 30;

      // ★ Demo: สุ่ม usedTotal บางส่วนเพื่อให้ progress bar ดูสวย (0-40% used)
      const usedTotal = Math.floor(maxTotal * (Math.random() * 0.4));

      await CouponQuota.create({
        rewardId:    r._id,
        shopId:      r.shopId || 'shop_unknown',
        shopName:    r.shopName || 'Unknown',
        maxTotal,
        maxPerUser:  1,
        usedTotal,
        isActive:    true,
      });
      created++;
    }

    return res.json({
      success: true,
      message: `Seeded ${created} quota records (${skipped} already existed)`,
      created,
      skipped,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Helper ───────────────────────────────────────────────────────────────────
function extractRate(discountValue = '') {
  const match = String(discountValue).match(/(\d+)%/);
  return match ? match[1] : String(discountValue).trim();
}

module.exports = router;