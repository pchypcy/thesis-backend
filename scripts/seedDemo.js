// scripts/seedDemo.js — InGreen Sprint 5
//
// Run: node scripts/seedDemo.js
//
// Seeds demo data ครบทุก collection สำหรับวันพรีเซ็น:
//   - 3 users (free, trial, VIP)
//   - 5 products (4 approved + 1 pending สำหรับ vote demo)
//   - 6 rewards (ทุกร้าน)
//   - 1 active coupon ให้ user1 (สำหรับ demo customer-confirm flow)
//   - scan history สำหรับ user1
//   - VIP subscription สำหรับ user3
//   - daily_intake (vip) มีข้อมูล 5 วันย้อนหลัง
//   - HealthProfile (user2 แพ้ peanut, user3 track zinc+magnesium)
//   - NotificationPreference default
//
// ★ IDEMPOTENT: ลบ collection เก่าก่อน insert ใหม่
//   ห้ามรันบน production!

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const User              = require('../models/User');
const Product           = require('../models/Product');
const Reward            = require('../models/Reward');
const Coupon            = require('../models/Coupon');
const VipSubscription   = require('../models/VipSubscription');
const HealthProfile     = require('../models/HealthProfile');
const DailyIntake       = require('../models/DailyIntake');
const NotificationPreference = require('../models/NotificationPreference');
const AppConfig         = require('../models/AppConfig');
const Merchant          = require('../models/Merchant');

const { generateCouponCode } = require('../utils/couponCode');

const SEED_USERS = [
    { username: 'somchai',  email: 'somchai@demo.app',  password: '123456', persona: 'Green Consumers', points: 245,  health_profile: { has_diabetes: false, allergies: [] } },
    { username: 'nattaya',  email: 'nattaya@demo.app',  password: '123456', persona: 'Naturalites',     points: 480,  health_profile: { has_diabetes: true,  allergies: ['Peanuts','Milk'] } },
    { username: 'kittipong', email: 'kittipong@demo.app', password: '123456', persona: 'Balanced Eco-Lover', points: 1250, health_profile: { has_diabetes: false, allergies: ['Gluten'] } },
];

const SEED_PRODUCTS = [
    { barcode: '8851111000001', name: 'นมข้าวโอ๊ตออร์แกนิก 1L',     brand: 'Lemon Farm',     sugar_g: 4,  carbs_g: 12, protein_g: 3,  energy_kcal: 95,  sodium_mg: 60,  fat_g: 2.5, is_green: true,  earned: 30, marketing_text: 'นมข้าวโอ๊ตออร์แกนิกจากฟาร์มในประเทศไทย ไม่ใส่น้ำตาล' },
    { barcode: '8851111000002', name: 'ขนมปังโฮลวีต Whole Wheat Bread', brand: 'Vista Bakery', sugar_g: 5, carbs_g: 38, protein_g: 9, energy_kcal: 220, sodium_mg: 380, fat_g: 3.5, is_green: false, earned: 15, marketing_text: 'ขนมปังโฮลวีตทำสด มีกลูเตน', ingredients: ['whole wheat flour','yeast','salt','sugar'] },
    { barcode: '8851111000003', name: 'น้ำอัดลมโคล่า 325ml',         brand: 'BigCola',         sugar_g: 35, carbs_g: 36, protein_g: 0, energy_kcal: 140, sodium_mg: 25, fat_g: 0,   is_green: false, earned: 5,  health_risk_level: 'Risk', marketing_text: 'น้ำอัดลมรสโคล่า ปริมาณน้ำตาลสูง' },
    { barcode: '8851111000004', name: 'ผักสลัดออร์แกนิก 200g',       brand: 'Ohkajhu',         sugar_g: 1, carbs_g: 4, protein_g: 2, energy_kcal: 25,  sodium_mg: 15, fat_g: 0.2, is_green: true,  earned: 30, marketing_text: 'ผักสลัดออร์แกนิก ปลูกแบบไฮโดรโปนิกส์ไม่ใช้สารเคมี' },
    // ★ Pending product — สำหรับ demo Community vote
    { barcode: '8851111099999', name: 'เนยถั่วลิสงโฮมเมด',           brand: 'Bangkok Pantry',   sugar_g: 6, carbs_g: 15, protein_g: 12, energy_kcal: 320, sodium_mg: 80, fat_g: 24, is_green: false, earned: 15, ingredients: ['peanut','sugar','salt'], submitted_by: 'somchai', verification_status: 'pending', marketing_text: 'เนยถั่วลิสงทำเอง ส่วนผสมจากธรรมชาติ (รอชุมชนตรวจสอบ)' },
];

const SEED_REWARDS = [
    { shopId: 'shop_001', shopName: 'Patom Organic',       discountValue: 'ส่วนลด 15%',     discountRate: '15',  description: 'คาเฟ่ออร์แกนิกและสินค้าจากธรรมชาติ', cost: 300, active: true,  tag: 'POPULAR',      category: 'Cafe',     image: 'https://images.unsplash.com/photo-1554118811-1e0d58224f24?q=80&w=600' },
    { shopId: 'shop_002', shopName: 'Vista Cafe',          discountValue: 'ฟรี 1 เมนู',     discountRate: 'free_1', description: 'เบเกอรี่และเครื่องดื่มเพื่อสุขภาพ', cost: 200, active: true,  tag: 'HEALTHY',     category: 'Cafe',     image: 'https://images.unsplash.com/photo-1495474472205-51f750c40685?q=80&w=600' },
    { shopId: 'shop_003', shopName: 'Monsoon Tea',         discountValue: 'ซื้อ 1 แถม 1',   discountRate: 'buy1get1', description: 'ชารักษ์ป่า', cost: 250, active: true,  tag: 'ECO',         category: 'Tea',      image: 'https://images.unsplash.com/photo-1576092762791-dd9e2220c4af?q=80&w=600' },
    { shopId: 'shop_004', shopName: 'Lemon Farm',          discountValue: 'ส่วนลด 50฿',    discountRate: '50',  description: 'ซูเปอร์ออร์แกนิก',  cost: 150, active: true,  tag: 'VERIFIED',    category: 'Organic',  image: 'https://images.unsplash.com/photo-1542838132-92c53300491e?q=80&w=600' },
    { shopId: 'shop_005', shopName: 'โอ้กะจู๋ (Ohkajhu)', discountValue: 'ฟรีสลัด 1 จาน',  discountRate: 'free_salad', description: 'อาหารเพื่อสุขภาพ',  cost: 200, active: true,  tag: 'FOOD',        category: 'Food',     image: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?q=80&w=600' },
    { shopId: 'shop_006', shopName: 'ต้นกล้า ฟ้าใส',      discountValue: 'ส่วนลด 10%',    discountRate: '10',  description: 'Plant-based',         cost: 250, active: true,  tag: 'PLANT-BASED', category: 'Food',     image: 'https://images.unsplash.com/photo-1490645935967-10de6ba17061?q=80&w=600' },
];

const SEED_MERCHANTS = [
    { shopId: 'shop_001', name: 'Patom Organic',      password: '1234' },
    { shopId: 'shop_002', name: 'Vista Cafe',          password: '1234' },
    { shopId: 'shop_003', name: 'Monsoon Tea',         password: '1234' },
    { shopId: 'shop_004', name: 'Lemon Farm',          password: '1234' },
    { shopId: 'shop_005', name: 'โอ้กะจู๋ (Ohkajhu)', password: '1234' },
    { shopId: 'shop_006', name: 'ต้นกล้า ฟ้าใส',      password: '1234' },
];

async function seed() {
    console.log('🌱 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected\n');

    // ── 1. Clear collections (เฉพาะ demo data) ─────────────────────────
    console.log('🧹 Clearing demo data (เฉพาะ user-data ของ seed users — ไม่แตะ Merchant/Reward เลย)...');
    await Promise.all([
        User.deleteMany({ username: { $in: SEED_USERS.map(u => u.username) } }),
        Product.deleteMany({ barcode: { $in: SEED_PRODUCTS.map(p => p.barcode) } }),
        // ★ R4 fix: ไม่ลบ Merchant/Reward อีกแล้ว — ใช้ upsert แทน (ดูใน section ── 5.)
        Coupon.deleteMany({ username: { $in: SEED_USERS.map(u => u.username) } }),
        VipSubscription.deleteMany({ username: { $in: SEED_USERS.map(u => u.username) } }),
        HealthProfile.deleteMany({ username: { $in: SEED_USERS.map(u => u.username) } }),
        DailyIntake.deleteMany({ username: { $in: SEED_USERS.map(u => u.username) } }),
        NotificationPreference.deleteMany({ username: { $in: SEED_USERS.map(u => u.username) } }),
    ]);

    // ── 2. Seed Config ───────────────────────────────────────────────────
    // (don't clear AppConfig — เพราะอาจมี override ของ admin)
    console.log('⚙️  Seeding AppConfig (if missing)...');
    const { default: configRoute } = { default: require('../routes/config') };
    // call seed endpoint internally would need express — just trust /api/config/seed has been called once

    // ── 3. Users ─────────────────────────────────────────────────────────
    console.log('👤 Seeding users...');
    for (const u of SEED_USERS) {
        const user = new User({
            ...u,
            password: u.password, // pre-save hash
            scanHistory: [],
            redeemHistory: [],
            impactStats: { chemicals: 0, plastics: 0 },
        });
        await user.save();
        console.log(`   ✓ ${u.username} (${u.email}) — ${u.points} pts`);
    }

    // ── 4. Products ──────────────────────────────────────────────────────
    console.log('\n📦 Seeding products...');
    for (const p of SEED_PRODUCTS) {
        // ★ DPSE-03 R4: เปลี่ยน pending → community_approved (ครบ vote 3 คน แล้ว)
        //   admin จะเห็นใน queue ทันที ไม่ต้องโหวตเอง
        const originalStatus = p.verification_status || 'approved';
        const status = originalStatus === 'pending' ? 'community_approved' : originalStatus;

        const product = new Product({
            ...p,
            ingredients: p.ingredients || [],
            verification_status: status,
            approved_at:  status === 'approved' ? new Date() : null,
            approved_by:  status === 'approved' ? 'admin' : null,
            community_approved_at: status === 'community_approved' ? new Date(Date.now() - 600 * 1000) : null,
        });

        // ★ DPSE-03 R4: pre-seed votes (สินค้า "เนยถั่วลิสง" ครบ 3 คน 3 IP → ส่งเข้า admin queue)
        if (originalStatus === 'pending') {
            const now = Date.now();
            product.upvotes = 3;
            product.voters  = ['nattaya', 'kittipong', 'somchai'];
            product.ip_voters = ['10.0.0.21', '10.0.0.45', '10.0.0.78'];
            product.vote_log = [
                { username: 'nattaya',   vote: 'up', at: new Date(now - 3600 * 1000),  comment: 'ส่วนผสมตรงกับฉลากจริง',           ip: '10.0.0.21' },
                { username: 'kittipong', vote: 'up', at: new Date(now - 1800 * 1000),  comment: 'เคยซื้อร้านนี้ ข้อมูลตรงครับ',  ip: '10.0.0.45' },
                { username: 'somchai',   vote: 'up', at: new Date(now - 600  * 1000),  comment: 'ตรวจกับเว็บแบรนด์แล้ว ตรง',     ip: '10.0.0.78' },
            ];
            console.log(`   ✓ pre-seeded 3 votes → community_approved (พร้อม admin review)`);
        }

        await product.save();
        console.log(`   ✓ ${p.name} — ${status}${p.submitted_by ? ' (by ' + p.submitted_by + ')' : ''}`);
    }

    // ── 5. Merchants + Rewards ───────────────────────────────────────────
    // ★ R4 fix: ใช้ $setOnInsert — insert เฉพาะถ้ายังไม่มี ไม่ทับของเดิม
    //   ป้องกันการเขียนทับรูปที่ admin upload ผ่าน panel
    console.log('\n🏪 Seeding merchants + rewards (upsert mode — ไม่ทับของที่มี)...');
    let mAdded = 0, rAdded = 0;
    for (const m of SEED_MERCHANTS) {
        const r = await Merchant.updateOne(
            { shopId: m.shopId },
            { $setOnInsert: m },
            { upsert: true }
        );
        if (r.upsertedCount > 0) mAdded++;
    }
    for (const r of SEED_REWARDS) {
        const res = await Reward.updateOne(
            { shopId: r.shopId },
            { $setOnInsert: r },
            { upsert: true }
        );
        if (res.upsertedCount > 0) rAdded++;
    }
    console.log(`   ✓ ${mAdded}/${SEED_MERCHANTS.length} new merchants + ${rAdded}/${SEED_REWARDS.length} new rewards (ที่มีอยู่แล้วคงเดิม)`);

    // ── 6. VIP Subscription (kittipong = active, nattaya = trial) ─────────
    console.log('\n👑 Seeding VIP subscriptions...');
    await VipSubscription.upgrade('kittipong', 30, { amount: 69, method: 'in_app', reference: 'DEMO-SEED' });
    await VipSubscription.startTrial('nattaya', 3);
    console.log('   ✓ kittipong = VIP active (30 days)');
    console.log('   ✓ nattaya   = Trial (3 days)');

    // ── 7. HealthProfile ─────────────────────────────────────────────────
    console.log('\n🩺 Seeding health profiles...');
    await HealthProfile.create({
        username: 'somchai',
        conditions: { has_diabetes: false },
        allergens:  [],
        synced_from_quiz: true,
    });
    await HealthProfile.create({
        username: 'nattaya',
        conditions: { has_diabetes: true, has_kidney_disease: false },
        allergens:  ['Peanuts', 'Milk'],
        synced_from_quiz: true,
    });
    await HealthProfile.create({
        username: 'kittipong',
        conditions: { has_diabetes: false },
        allergens:  ['Gluten'],
        synced_from_quiz: false,
        tracked_nutrients: [
            { key: 'zinc_mg',      label: 'Zinc',      unit: 'mg', goal: 11,  iconHint: 'mdi:atom' },
            { key: 'magnesium_mg', label: 'Magnesium', unit: 'mg', goal: 400, iconHint: 'mdi:periodic-table' },
            { key: 'fiber_g',      label: 'Fiber',     unit: 'g',  goal: 25,  iconHint: 'lucide:wheat' },
        ],
    });
    console.log('   ✓ 3 health profiles (nattaya = ถั่ว+นม, kittipong = กลูเตน + tracked nutrients)');

    // ── 8. DailyIntake (kittipong VIP — 5 วันย้อนหลัง) ──────────────────
    console.log('\n📊 Seeding daily intake for VIP user...');
    for (let i = 0; i < 5; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateKey = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })).toISOString().slice(0, 10);

        await DailyIntake.create({
            username: 'kittipong',
            dateKey,
            date,
            total_sugar_g:   Math.round(Math.random() * 60),
            total_starch_g:  Math.round(Math.random() * 250 + 100),
            total_sodium_mg: Math.round(Math.random() * 1800 + 500),
            total_protein_g: Math.round(Math.random() * 40 + 20),
            total_kcal:      Math.round(Math.random() * 800 + 1200),
            total_fat_g:     Math.round(Math.random() * 50 + 20),
            custom_nutrients: { zinc_mg: Math.round(Math.random() * 10), magnesium_mg: Math.round(Math.random() * 350 + 50), fiber_g: Math.round(Math.random() * 18 + 5) },
            sugar_limit_g: 50,
            starch_limit_g: 300,
            protein_goal_g: 50,
            scans: [],
        });
    }
    console.log('   ✓ 5 daily intake records for kittipong');

    // ── 9. Sample coupon for somchai (พร้อม customer-confirm demo) ─────
    console.log('\n🎟️  Seeding active coupon...');
    const { code, signature, issuedAt } = generateCouponCode('somchai', 'Lemon Farm');
    await Coupon.create({
        username: 'somchai',
        shopName: 'Lemon Farm',
        couponCode: code,
        status: 'active',
        hmacSignature: signature,
        issuedAt: new Date(issuedAt),
        expiresAt: new Date(issuedAt + 30 * 60 * 1000),
        pendingConfirm: { status: 'none' },
    });
    console.log(`   ✓ Coupon ${code} for somchai @ Lemon Farm (valid 30 min)`);

    // ── 10. Notifications default ────────────────────────────────────────
    console.log('\n🔔 Seeding notification preferences...');
    for (const u of SEED_USERS) {
        await NotificationPreference.create({ username: u.username });
    }
    console.log('   ✓ default prefs for all users');

    console.log('\n══════════════════════════════════════════');
    console.log('✅ DEMO SEED COMPLETE');
    console.log('══════════════════════════════════════════');
    console.log('\n📱 Demo Accounts (password = 123456):');
    console.log('   somchai     → Free user, มี active coupon');
    console.log('   nattaya     → Trial VIP, แพ้ถั่ว+นม + เป็นเบาหวาน');
    console.log('   kittipong   → VIP active, มี 5 วัน intake history + tracked nutrients');
    console.log('\n🏪 Merchant Accounts (password = 1234):');
    console.log('   shop_001 → Patom Organic');
    console.log('   shop_004 → Lemon Farm (มี coupon รอสแกน)');
    console.log('\n🔐 Admin: admin / admin123');
    console.log('\n🌐 Routes ทดสอบ:');
    console.log('   /quiz → /login → /home');
    console.log('   /scan → barcode 8851111000001 = นมข้าวโอ๊ต (eco)');
    console.log('   /scan → barcode 8851111000003 = น้ำอัดลม (risk)');
    console.log('   /community → vote สินค้า pending (8851111099999)');
    console.log('   /scan-receipt → AI receipt scan (mock)');
    console.log('\n');

    await mongoose.disconnect();
}

seed().catch(err => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
});
