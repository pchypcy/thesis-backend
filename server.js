// server.js — InGreen Sprint 2
// การเปลี่ยนแปลง:
//   [SPRINT 1] เพิ่ม /api/config route สำหรับ Config Table
//   [FIX]      ลบ /api/keywords ที่ mount ซ้ำ 2 บรรทัด
//   [SPRINT 2] เพิ่ม /api/vip   → vip-status, upgrade-vip, check-quota, start-trial
//   [SPRINT 2] เพิ่ม /api/intake → log-intake (บันทึกน้ำตาล/แป้ง), intake-summary (สรุปรายวัน/สัปดาห์)

const express   = require('express');
const mongoose  = require('mongoose');
const cors      = require('cors');
require('dotenv').config();

const productRoute  = require('./routes/products'); 
const userRoute     = require('./routes/users'); 
const rewardRoute   = require('./routes/rewards'); 
const merchantRoute = require('./routes/merchant');
const keywordsRoute = require('./routes/keywords');
const configRoute   = require('./routes/config');   // ★ SPRINT 1
const vipRoute      = require('./routes/vip');       // ★ SPRINT 2
const intakeRoute   = require('./routes/intake');    // ★ SPRINT 2
const healthProfileRoute = require('./routes/healthProfile'); // ★ SPRINT 4 (Allergy)
const notificationsRoute = require('./routes/notifications'); // ★ SPRINT 4 (Notifications)
const aiScanRoute          = require('./routes/aiScan');           // ★ SPRINT 5: AI receipt scan + rate limit
const customerConfirmRoute = require('./routes/customerConfirm');  // ★ SPRINT 5: coupon confirm flow
const healthReportRoute    = require('./routes/healthReport');     // ★ SPRINT 5: monthly health report
const connectionsRoute     = require('./routes/connections');      // ★ Green Profile API: ฝั่งผู้ใช้ (consent)
const partnerApiRoute      = require('./routes/partnerApi');       // ★ Green Profile API: ฝั่ง partner ภายนอก

const app = express();

// ★ DPSE-03 R4: trust proxy = อ่าน IP จริงจาก X-Forwarded-For
//   (รองรับเวลา deploy หลัง reverse proxy / ngrok)
app.set('trust proxy', true);

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning', 'X-Forwarded-For']
}));

// ★ DPSE-03 R4: เพิ่ม limit เป็น 10mb รองรับรูปฉลากสินค้า (base64) ใน AddProduct
//                และรูปใบเสร็จใน aiScan
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
    console.log(`🚀 [API HIT] ${req.method} ${req.url}`);
    next();
});

const { startVipExpiryScheduler }    = require('./jobs/vipExpiryJob');    // ★ SPRINT 7
const { startVoteFinalizeScheduler } = require('./jobs/voteFinalizeJob'); // ★ SPRINT 7

mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log("✅ MongoDB Connected");
        // ★ SPRINT 7: เริ่ม scheduled jobs หลัง DB พร้อม
        startVipExpiryScheduler().catch(err => console.error('vip-expiry scheduler start error:', err));
        startVoteFinalizeScheduler().catch(err => console.error('vote-finalize scheduler start error:', err));
    })
    .catch((err) => console.error("❌ MongoDB Error:", err));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/products',  productRoute);
app.use('/api/users',     userRoute);
app.use('/api/rewards',   rewardRoute); 
app.use('/api/merchant',  merchantRoute);
app.use('/api/admin',     require('./routes/admin'));
app.use('/api/keywords',  keywordsRoute);           // [FIX] ลบบรรทัดซ้ำออก
app.use('/api/config',    configRoute);              // ★ SPRINT 1
app.use('/api/vip',       vipRoute);                 // ★ SPRINT 2: vip-status, upgrade-vip, check-quota
app.use('/api/intake',    intakeRoute);              // ★ SPRINT 2: log-intake, intake-summary
app.use('/api/health-profile', healthProfileRoute);  // ★ SPRINT 4: allergy detection (FREE feature)
app.use('/api/notifications',  notificationsRoute);  // ★ SPRINT 4: notification preferences
app.use('/api/ai-scan',        aiScanRoute);          // ★ SPRINT 5: AI receipt scan (rate-limited)
app.use('/api/coupons',        customerConfirmRoute); // ★ SPRINT 5: customer-confirm flow (pending-confirm, confirm, reject)
app.use('/api/health-report',  healthReportRoute);    // ★ SPRINT 5: VIP monthly health report
app.use('/api/settlements',    require('./routes/settlements'));   // ★ v3: merchant settlement/payout
app.use('/api/admin/allergen-groups', require('./routes/allergenGroups')); // ★ SPRINT 6: admin CRUD กลุ่มอาหารแพ้
app.use('/api/connections', connectionsRoute);   // ★ Green Profile API: ผู้ใช้คุมการแชร์ (grant/revoke/audit)
app.use('/api/partner',     partnerApiRoute);     // ★ Green Profile API: endpoint สำหรับแอปภายนอก (MockFood)

app.get('/', (req, res) => res.send('InGreen Backend is Running! 🌿'));

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));