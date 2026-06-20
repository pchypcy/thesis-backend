const router = require('express').Router();
const Reward = require('../models/Reward');
const CouponQuota = require('../models/CouponQuota');

// 🎯 API: ดึงรายการของรางวัลทั้งหมดไปโชว์ที่หน้าแอป
//   ★ SPRINT 5: enrich ด้วย quota info (maxTotal, usedTotal, remaining) จาก CouponQuota
//                เพื่อให้ Frontend แสดงสิทธิ์คงเหลือต่อแคมเปญ (Coupon Permissions)
router.get('/', async (req, res) => {
    try {
        const rewards = await Reward.find().lean();

        // ดึง quota ทั้งหมดของ rewards เหล่านี้ในครั้งเดียว (กัน N+1)
        const rewardIds = rewards.map(r => r._id);
        const quotas   = await CouponQuota.find({ rewardId: { $in: rewardIds }, isActive: true }).lean();

        // map quota → rewardId เพื่อ lookup เร็ว
        const quotaByReward = {};
        quotas.forEach(q => {
            const key = String(q.rewardId);
            // ถ้า reward เดียวมีหลาย quota (เผื่อหลาย shop) → sum
            if (!quotaByReward[key]) {
                quotaByReward[key] = { maxTotal: 0, usedTotal: 0, hasUnlimited: false };
            }
            if (q.maxTotal == null) quotaByReward[key].hasUnlimited = true;
            else quotaByReward[key].maxTotal += q.maxTotal;
            quotaByReward[key].usedTotal += (q.usedTotal || 0);
        });

        const enriched = rewards.map(r => {
            const q = quotaByReward[String(r._id)];
            if (!q) {
                // ไม่มี quota record → unlimited (legacy)
                return { ...r, quota: null };
            }
            return {
                ...r,
                quota: {
                    maxTotal:  q.hasUnlimited ? null : q.maxTotal,
                    usedTotal: q.usedTotal,
                    remaining: q.hasUnlimited ? null : Math.max(0, q.maxTotal - q.usedTotal),
                    isFull:    !q.hasUnlimited && q.usedTotal >= q.maxTotal,
                },
            };
        });

        res.status(200).json(enriched);
    } catch (err) {
        res.status(500).json(err);
    }
});

// 🎯 API พิเศษ: ตัวช่วยเสกข้อมูล (Seed) ลง Database
router.get('/seed', async (req, res) => {
    const seedData = [
        { 
            shopName: "Patom Organic", 
            description: "คาเฟ่ออร์แกนิกและสินค้าจากธรรมชาติ ท่ามกลางสวนพื้นที่สีเขียว", 
            cost: 300, 
            discountValue: "ส่วนลด 15%", 
            image: "https://images.unsplash.com/photo-1554118811-1e0d58224f24?q=80&w=600&auto=format&fit=crop", 
            tag: "POPULAR", 
            category: "Cafe & Lifestyle" 
        },
        { 
            shopName: "Vista Cafe", 
            description: "เบเกอรี่และเครื่องดื่มเพื่อสุขภาพ ปราศจากไขมันทรานส์ ใช้แป้งสเปลท์", 
            cost: 200, 
            discountValue: "ฟรี 1 เมนู", 
            image: "https://images.unsplash.com/photo-1495474472205-51f750c40685?q=80&w=600&auto=format&fit=crop", 
            tag: "HEALTHY", 
            category: "Cafe" 
        },
        { 
            shopName: "Monsoon Tea", 
            description: "ชารักษ์ป่าปลูกร่วมกับป่าโดยไม่ทำลายธรรมชาติ", 
            cost: 250, 
            discountValue: "ซื้อ 1 แถม 1", 
            image: "https://images.unsplash.com/photo-1576092762791-dd9e2220c4af?q=80&w=600&auto=format&fit=crop", 
            tag: "ECO-FRIENDLY", 
            category: "Tea House" 
        },
        { 
            shopName: "Lemon Farm", 
            description: "ซูเปอร์มาร์เก็ตสินค้าเกษตรอินทรีย์ อาหารปลอดสารพิษ สนับสนุนเกษตรกรไทย", 
            cost: 150, 
            discountValue: "ส่วนลด 50฿", 
            image: "https://images.unsplash.com/photo-1542838132-92c53300491e?q=80&w=600&auto=format&fit=crop", 
            tag: "VERIFIED", 
            category: "Organic Market" 
        },
        { 
            shopName: "โอ้กะจู๋ (Ohkajhu)", 
            description: "ร้านอาหารเพื่อสุขภาพ สลัดผักออร์แกนิกส่งตรงจากฟาร์มถึงโต๊ะ ปลอดสารพิษ", 
            cost: 200, 
            discountValue: "ฟรี สลัด 1 จาน", 
            image: "https://images.unsplash.com/photo-1512621776951-a57141f2eefd?q=80&w=600&auto=format&fit=crop", 
            tag: "ORGANIC FOOD", 
            category: "Food" 
        },
        { 
            shopName: "ต้นกล้า ฟ้าใส", 
            description: "ร้านอาหาร Plant-based เพื่อสุขภาพ ปรุงโดยนักกำหนดอาหารและเภสัชกรแผนไทย", 
            cost: 250, 
            discountValue: "ส่วนลด 10%", 
            image: "https://images.unsplash.com/photo-1490645935967-10de6ba17061?q=80&w=600&auto=format&fit=crop", 
            tag: "PLANT-BASED", 
            category: "Food" 
        }

    ];

    try {
        // ลบของเก่าออกก่อน (กันข้อมูลซ้ำถ้าเผลอกดหลายรอบ)
        await Reward.deleteMany({});
        // ใส่ข้อมูลชุดใหม่เข้าไป
        await Reward.insertMany(seedData);
        res.status(201).json({ message: "✅ Seeded Rewards successfully! อัปเดตร้านค้าพาร์ทเนอร์ลง Database เรียบร้อย!" });
    } catch (err) {
        res.status(500).json(err);
    }
});

module.exports = router;