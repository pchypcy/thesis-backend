// routes/users.js — InGreen Sprint 2
// การเปลี่ยนแปลง:
//   [SPRINT 1] redeem route: เปลี่ยนจาก Math.random() → generateCouponCode() (HMAC)
//   [SPRINT 1] Coupon model: เพิ่ม field hmacSignature + issuedAt
//   [SPRINT 2] redeem route: เพิ่ม expiresAt = issuedAt + 30 นาที
//              → ร้านค้าต้องสแกนภายใน 30 นาทีหลัง user กด "แลกสิทธิ์"
//              → response ส่ง expiresAt กลับไปด้วย เพื่อให้ App แสดง countdown
//   [SPRINT 2] scan route: ★ VIP ×1.5 multiplier
//              → ถ้า user เป็น VIP → pointsAwarded = Math.round(base × 1.5)
//              → response ส่ง vipMultiplier: 1.5 กลับ เพื่อให้ Scan.jsx แสดง "+23 ×1.5"

const router  = require('express').Router();
const User    = require('../models/User');
const Product = require('../models/Product');
const Coupon  = require('../models/Coupon');
const Reward  = require('../models/Reward');         // ★ SPRINT 5: lookup reward by shopName เพื่อ check quota
const CouponQuota = require('../models/CouponQuota'); // ★ SPRINT 5: atomic deduction ตอน redeem
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { generateCouponCode } = require('../utils/couponCode'); // ★ SPRINT 1
const emailer = require('../utils/emailer');                    // ★ Email OTP

// ★ SPRINT 2: VIP multiplier
const VipSubscription = require('../models/VipSubscription');
// ★ SPRINT 4: HealthProfile auto-seed on register (Allergy feature)
const HealthProfile  = require('../models/HealthProfile');
const { getConfig }  = require('./config');

// ★ SPRINT 4: JWT secret (override ผ่าน env เสมอใน prod)
const JWT_SECRET   = process.env.JWT_SECRET || 'ingreen_super_secret_key_2026';
const JWT_EXPIRES  = '30d';

// ★ SPRINT 4: Simple in-memory rate limiter ป้องกัน brute-force login
const rateBuckets = new Map();
function rateLimit(key, limit, windowMs) {
    const now    = Date.now();
    const bucket = rateBuckets.get(key) || { hits: [], blockedUntil: 0 };
    bucket.hits = bucket.hits.filter(t => now - t < windowMs);
    if (now < bucket.blockedUntil) return { ok: false, retryAfter: Math.ceil((bucket.blockedUntil - now) / 1000) };
    if (bucket.hits.length >= limit) {
        bucket.blockedUntil = now + windowMs;
        rateBuckets.set(key, bucket);
        return { ok: false, retryAfter: Math.ceil(windowMs / 1000) };
    }
    bucket.hits.push(now);
    rateBuckets.set(key, bucket);
    return { ok: true };
}
function clientKey(req, suffix = '') {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
    return `${ip}:${suffix}`;
}

// ★ SPRINT 4: Issue JWT token
function issueToken(user) {
    return jwt.sign(
        { username: user.username, persona: user.persona, role: 'user' },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES }
    );
}

// ★ SPRINT 4: Input sanitization
function sanitizeUsername(s) {
    return String(s || '').trim().slice(0, 32).replace(/[^a-zA-Z0-9._-]/g, '');
}
function isValidEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}

// ★ SPRINT 2: ระยะเวลาที่คูปองยังใช้ได้หลัง redeem (มิลลิวินาที)
const COUPON_EXPIRY_MS = 30 * 60 * 1000; // 30 นาที
const VIP_POINTS_MULTIPLIER = 1.5;       // แต้มสะสม ×1.5 สำหรับ VIP

// ==========================================
// ลงทะเบียน (Register)
// ==========================================
router.post('/create', async (req, res) => {
    try {
        // ★ Rate limit: 5 registrations / 10 min per IP
        const rl = rateLimit(clientKey(req, 'register'), 5, 10 * 60 * 1000);
        if (!rl.ok) return res.status(429).json({ message: `สมัครถี่เกินไป กรุณาลองใหม่ในอีก ${rl.retryAfter} วินาที` });

        let { username, email, password, persona, has_diabetes, has_kidney_disease, allergies } = req.body;

        // ★ Input validation + sanitization
        username = sanitizeUsername(username);
        if (!username || username.length < 3) {
            return res.status(400).json({ message: "ชื่อผู้ใช้ต้อง 3 ตัวอักษรขึ้นไป (a-z, 0-9, ._-)" });
        }
        if (!password || password.length < 6) {
            return res.status(400).json({ message: "รหัสผ่านต้อง 6 ตัวอักษรขึ้นไป" });
        }
        if (email && !isValidEmail(email)) {
            return res.status(400).json({ message: "รูปแบบอีเมลไม่ถูกต้อง" });
        }

        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ message: "ชื่อผู้ใช้นี้ถูกใช้งานแล้ว" });

        if (email) {
            const existingEmail = await User.findOne({ email });
            if (existingEmail) return res.status(400).json({ message: "อีเมลนี้มีผู้ใช้งานแล้ว" });
        }

        const newUser = new User({
            username, email, password,
            persona: persona || 'New User',
            points: 0,
            health_profile: {
                has_diabetes:      has_diabetes || false,
                has_kidney_disease: has_kidney_disease || false,
                has_high_pressure: false,
                allergies:         allergies || []
            },
            impactStats:   { chemicals: 0, plastics: 0 },
            scanHistory:   [],
            redeemHistory: []
        });

        const savedUser = await newUser.save();
        console.log("✅ New User Registered:", savedUser.username);

        // ★ SPRINT 4: Auto-start 3-day VIP trial (encourage upgrade conversion)
        try {
            const trialDays = await getConfig('VIP_FREE_TRIAL_DAYS', 3);
            await VipSubscription.startTrial(savedUser.username, trialDays);
            console.log(`🎁 Trial ${trialDays} days started for ${savedUser.username}`);
        } catch (trialErr) {
            // Non-critical — registration ยังสำเร็จ แม้ trial create fail
            console.warn('Trial start failed (non-critical):', trialErr.message);
        }

        // ★ SPRINT 4: Sync HealthProfile (Allergy detection) จาก quiz/register data
        try {
            await HealthProfile.syncFromUser(savedUser.username, savedUser.health_profile || {});
            console.log(`🩺 Health profile seeded for ${savedUser.username}`);
        } catch (hpErr) {
            console.warn('Health profile sync failed (non-critical):', hpErr.message);
        }

        // ★ SPRINT 4: issue JWT token แล้วส่งกลับไปให้ frontend
        const token = issueToken(savedUser);
        const safe = savedUser.toObject();
        delete safe.password;

        res.status(201).json({ ...safe, token });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err.message });
    }
});

// ==========================================
// เข้าสู่ระบบ (Login) — ★ SPRINT 4: rate limit + JWT issue
// ==========================================
router.post('/login', async (req, res) => {
    try {
        // ★ Rate limit: 10 logins / 5 min per IP (กัน brute force)
        const rl = rateLimit(clientKey(req, 'login'), 10, 5 * 60 * 1000);
        if (!rl.ok) return res.status(429).json({ message: `เข้าสู่ระบบถี่เกินไป กรุณาลองใหม่ในอีก ${rl.retryAfter} วินาที` });

        const username = sanitizeUsername(req.body?.username);
        const password = String(req.body?.password || '');

        if (!username || !password) {
            return res.status(400).json({ message: "กรุณากรอกข้อมูลให้ครบ" });
        }

        const user = await User.findOne({ username });
        if (!user) return res.status(404).json({ message: "ไม่พบชื่อผู้ใช้นี้" });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ message: "รหัสผ่านไม่ถูกต้อง" });

        // ★ SPRINT 4: issue JWT token
        const token = issueToken(user);

        // ไม่ส่ง password hash กลับ
        const safe = user.toObject();
        delete safe.password;

        console.log("🔓 User Logged In:", user.username);
        res.status(200).json({ ...safe, token });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ==========================================
// ★ SPRINT 4: GET /api/users/me — verify token + return current user
// ==========================================
router.get('/me/profile', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'ต้องส่ง token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await User.findOne({ username: decoded.username });
        if (!user) return res.status(404).json({ message: 'ไม่พบผู้ใช้' });

        const safe = user.toObject();
        delete safe.password;
        res.json({ success: true, user: safe });
    } catch (err) {
        res.status(401).json({ message: 'token ไม่ถูกต้องหรือหมดอายุ' });
    }
});

// ==========================================
// สแกนสินค้า (จำกัด 5 ครั้ง/วัน)
// ★ SPRINT 2: VIP ×1.5 multiplier
// ==========================================
router.post('/scan', async (req, res) => {
    const { username, barcode, productName, points } = req.body;
    console.log(`📥 Scanning -> User: ${username} | Barcode: ${barcode}`);

    try {
        const user = await User.findOne({ username });
        if (!user) return res.status(404).json({ message: "User not found" });

        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        
        const scansToday = user.scanHistory.filter(scan => 
            new Date(scan.scannedAt) >= startOfDay && scan.barcode !== "BONUS"
        ).length;
        
        let pointsAwarded = 0;
        let limitReached  = false;
        // ★ SPRINT 2: ตรวจ VIP status สำหรับ multiplier
        let vipMultiplier = 1;
        let isVipUser     = false;

        // ★ SPRINT 5: ดึงค่าจาก AppConfig (เดิม hardcode 5/50/1.5)
        //   admin แก้ค่าใน UI → request ถัดไปใช้ค่าใหม่ทันที ไม่ต้อง deploy
        const scanLimit  = await getConfig('SCAN_LIMIT_PER_DAY',     5);
        const baseDefault = await getConfig('SCAN_POINTS_DEFAULT',   50);
        const vipMult    = await getConfig('VIP_POINTS_MULTIPLIER',  1.5);

        if (scansToday < scanLimit) {
            const basePoints = points || baseDefault;

            // ★ SPRINT 2: ตรวจ VIP → ถ้า active ให้คูณตาม VIP_POINTS_MULTIPLIER
            try {
                const vipSub = await VipSubscription.findOne({ username });
                if (vipSub && vipSub.isActive) {
                    isVipUser     = true;
                    vipMultiplier = vipMult;
                }
            } catch (vipErr) {
                // ถ้า query VIP fail → ไม่กระทบ scan (non-VIP multiplier)
                console.warn('VIP check failed in scan (non-critical):', vipErr.message);
            }

            pointsAwarded = isVipUser
                ? Math.round(basePoints * vipMult)
                : basePoints;

            user.points += pointsAwarded;
        } else {
            limitReached = true;
        }

        const safeName = (productName && productName.trim() && productName !== "Unknown Product")
            ? productName.trim()
            : `Barcode: ${barcode}`;

        user.scanHistory.push({ productName: safeName, barcode, points: pointsAwarded, scannedAt: new Date() });
        await user.save();
        
        console.log(`✅ Result: ${username} | +${pointsAwarded} pts${isVipUser ? ` (VIP ×${vipMultiplier})` : ''} (Today: ${scansToday + 1}/${scanLimit})`);
        res.status(200).json({
            pointsAwarded,
            totalPoints: user.points,
            limitReached,
            scansToday:   scansToday + 1,
            // ★ SPRINT 2: ส่ง VIP info กลับ → Scan.jsx แสดง "+23 ×1.5"
            isVip:        isVipUser,
            vipMultiplier: isVipUser ? vipMultiplier : null,
        });

    } catch (err) {
        console.error("💥 Scan Error:", err);
        res.status(500).json({ message: "Server Error", error: err.message });
    }
});

// ==========================================
// เพิ่มแต้มโบนัส (Bonus Points)
// ==========================================
router.post('/add-points', async (req, res) => {
    try {
        const { username, points, activity, productName } = req.body;
        const user = await User.findOne({ username });
        if (!user) return res.status(404).json({ message: "User not found" });

        user.points += points;
        user.scanHistory.push({
            productName: `${activity} ${productName ? `(${productName})` : ''}`,
            barcode: "BONUS", points, scannedAt: new Date()
        });

        await user.save();
        console.log(`🎉 Bonus: ${username} | +${points} pts | ${activity}`);
        res.status(200).json(user);
    } catch (err) {
        res.status(500).json({ message: "Server Error", error: err.message });
    }
});

// ==========================================
// แลกแต้ม (Redeem) — ★ SPRINT 2: Coupon Expiry
// ==========================================
router.post('/redeem', async (req, res) => {
    try {
        const { username, pointsToUse, merchantName, rewardDetail } = req.body;
        const user = await User.findOne({ username });

        if (!user)                      return res.status(404).json({ message: "ไม่พบผู้ใช้งาน" });
        if (user.points < pointsToUse) return res.status(400).json({ message: "แต้มสะสมไม่เพียงพอ" });

        // ★ SPRINT 5: หา reward ที่ match (shopName + discountValue + cost) เพื่อ atomic deduct quota
        //   ทำก่อนหักแต้ม — ถ้า quota หมดจะ reject โดยไม่กระทบ user
        //   ถ้าไม่เจอ reward record หรือไม่มี quota → ปล่อยผ่าน (legacy/unlimited)
        let rewardId = null;
        const reward = await Reward.findOne({
            shopName: merchantName,
            discountValue: rewardDetail,
            cost: Number(pointsToUse),
        });
        if (reward) {
            rewardId = reward._id;
            const quota = await CouponQuota.findOne({ rewardId, isActive: true });
            if (quota) {
                // เช็ค campaign expiry
                if (quota.validUntil && new Date() > quota.validUntil) {
                    return res.status(400).json({
                        message: "แคมเปญนี้หมดอายุแล้ว",
                        errorCode: 'CAMPAIGN_EXPIRED',
                    });
                }
                // atomic check-and-deduct — กัน race condition คนแลกพร้อมกัน
                const ok = await CouponQuota.atomicDeduct(rewardId);
                if (!ok) {
                    return res.status(400).json({
                        message: "สิทธิ์ในแคมเปญนี้ถูกใช้ครบแล้ว",
                        errorCode: 'QUOTA_FULL',
                    });
                }
            }
        }

        // ── หักแต้ม ──
        user.points -= pointsToUse;
        user.redeemHistory.push({ merchantName, pointsUsed: pointsToUse, rewardDetail, redeemedAt: new Date() });
        await user.save();

        // ★ SPRINT 1: HMAC Coupon Code
        const { code: generatedCode, signature, issuedAt } = generateCouponCode(username, merchantName);

        // ★ SPRINT 2: คำนวณเวลาหมดอายุ = เวลา issue + 30 นาที
        // เหตุผล: ป้องกัน user แคปหน้าจอ QR แล้วเอาไปใช้ในภายหลัง
        // ร้านค้าต้องสแกนภายในเวลาที่กำหนด มิฉะนั้น server จะ reject
        const expiresAt = new Date(issuedAt + COUPON_EXPIRY_MS);

        const newCoupon = new Coupon({
            username,
            shopName:      merchantName,
            couponCode:    generatedCode,
            status:        'active',
            hmacSignature: signature,
            issuedAt:      new Date(issuedAt),
            // ★ SPRINT 2: field ใหม่ — หมดอายุใน 30 นาที
            expiresAt,
        });
        await newCoupon.save();

        console.log(`🎟️ Coupon issued: ${generatedCode} → ${username} @ ${merchantName} | expires: ${expiresAt.toISOString()}`);

        res.status(200).json({ 
            message:       "แลกรางวัลสำเร็จ", 
            currentPoints: user.points,
            couponCode:    generatedCode,
            // ★ SPRINT 2: ส่ง expiresAt กลับให้ App แสดง countdown บน QR modal
            expiresAt:     expiresAt.toISOString(),
        });
    } catch (err) {
        res.status(500).json({ message: "Server Error", error: err.message });
    }
});

// ==========================================
// อัปเดตสถิติ Impact
// ==========================================
router.post('/update-impact', async (req, res) => {
    try {
        const { username, type } = req.body;
        const user = await User.findOne({ username });
        if (!user) return res.status(404).json({ message: "User not found" });

        if (!user.impactStats) user.impactStats = { chemicals: 0, plastics: 0 };
        if (type === 'chemical') user.impactStats.chemicals += 1;
        else if (type === 'plastic') user.impactStats.plastics += 1;

        await user.save();
        res.status(200).json(user.impactStats);
    } catch (err) {
        res.status(500).json({ message: "Server Error", error: err.message });
    }
});

// ── GET user by username ─────────────────────────────────────────────────────
// ─── PASSWORD RESET (OTP-Based) ─────────────────────────────────────────────
//
// Flow:
//   1. POST /forgot-password  { identifier }            → gen OTP + ส่งกลับ (demo) หรือส่ง email
//   2. POST /verify-otp       { identifier, otp }       → ตรวจ OTP ก่อน (ไม่บังคับ — เพื่อ UX)
//   3. POST /reset-password   { identifier, otp, newPassword } → reset
//
// Security:
//   - OTP ถูก hash ด้วย bcrypt (ไม่เก็บ plaintext)
//   - expire 10 นาที
//   - rate limit 3 requests / 10 นาที (กัน spam)
//   - max 5 wrong OTP attempts → invalidate
//   - ไม่บอกว่า user มีอยู่จริงไหม (ป้องกัน enumeration)
//
// Email mode: ส่ง OTP ผ่าน SMTP จริง (ถ้าตั้ง env แล้ว)
//             ไม่ตั้ง → fallback demo mode (return OTP ใน response)

function generateOtp() {
    // 6 หลัก, leading zero ได้
    return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
}

router.post('/forgot-password', async (req, res) => {
    try {
        const { identifier } = req.body || {};
        if (!identifier) return res.status(400).json({ success: false, message: 'กรุณาระบุ username หรือ email' });

        // Rate limit ต่อ IP — กัน spam OTP
        const rl = rateLimit(clientKey(req, 'forgot'), 3, 10 * 60 * 1000);
        if (!rl.ok) {
            return res.status(429).json({
                success: false,
                message: `คำขอบ่อยเกินไป กรุณารอ ${Math.ceil(rl.retryAfter / 60)} นาทีก่อนลองใหม่`,
            });
        }

        const emailMode = emailer.isConfigured();

        // ค้นหา user ทั้งทาง username + email
        const user = await User.findOne({
            $or: [
                { username: String(identifier).trim() },
                { email:    String(identifier).trim().toLowerCase() },
            ]
        });

        // ★ Production: ไม่บอกว่า user ไม่มีอยู่จริง — กัน enumeration attack
        //   Demo (ไม่ตั้ง SMTP): บอกชัดเพื่อ UX ทดสอบ
        if (!user) {
            if (!emailMode) {
                return res.status(404).json({
                    success: false,
                    message: 'ไม่พบบัญชีนี้ในระบบ',
                    demo_note: 'Production จะไม่ตอบแบบนี้เพื่อกัน enumeration attack',
                });
            }
            // เพื่อให้ timing ใกล้เคียงกับเคสที่มี user → ป้องกัน timing attack
            await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
            return res.json({
                success: true,
                message: 'หากบัญชีนี้มีอยู่ในระบบ ระบบจะส่งรหัส OTP ไปยังอีเมลที่ลงทะเบียนไว้',
            });
        }

        // Generate + hash OTP
        const otp     = generateOtp();
        const otpHash = await bcrypt.hash(otp, 10);
        user.reset_otp = {
            code_hash: otpHash,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),  // 10 นาที
            attempts:  0,
        };
        await user.save();

        console.log(`🔑 Password reset requested: ${user.username} (${user.email || 'no email'}) → OTP=${otp}`);

        // ★ ส่ง email จริงถ้าตั้ง SMTP แล้ว
        let emailSent     = false;
        let emailErrorMsg = null;
        if (emailMode && user.email) {
            try {
                await emailer.sendOtpEmail({
                    to: user.email,
                    username: user.username,
                    otp,
                    expiresInMin: 10,
                });
                emailSent = true;
            } catch (mailErr) {
                console.error('Email send failed:', mailErr.message);
                emailErrorMsg = mailErr.message;
                // ไม่ revoke OTP — return error ให้ user ลองใหม่
            }
        }

        const emailMasked = user.email?.replace(/(.{2}).+(@.+)/, '$1***$2') || null;

        // กรณีที่ user ไม่มี email → ไม่สามารถส่ง email ได้
        if (emailMode && !user.email) {
            return res.status(400).json({
                success: false,
                errorCode: 'NO_EMAIL',
                message: 'บัญชีนี้ไม่ได้ตั้งอีเมลไว้ — ติดต่อ admin เพื่อกู้บัญชี',
            });
        }

        if (emailMode && !emailSent) {
            return res.status(502).json({
                success: false,
                errorCode: 'EMAIL_FAILED',
                message: 'ส่งอีเมลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
                detail:  process.env.NODE_ENV === 'production' ? undefined : emailErrorMsg,
            });
        }

        return res.json({
            success: true,
            message: emailMode
                ? `ส่งรหัส OTP ไปยัง ${emailMasked} แล้ว กรุณาตรวจสอบกล่องจดหมาย`
                : 'สร้างรหัส OTP สำเร็จ (โหมด Demo — แสดง OTP ในหน้าจอ)',
            email_masked: emailMasked,
            expiresInSec: 600,
            email_sent:   emailSent,
            ...(!emailMode && {
                demo_otp:  otp,
                demo_note: '⚠️ โหมด Demo เท่านั้น — Production จะส่ง OTP ผ่าน email ไม่ใช่ตอบกลับ API',
            }),
        });
    } catch (err) {
        console.error('Forgot Password Error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
});

// ─── Change Password (Logged-in user) ────────────────────────────────────
// Body: { username, currentPassword, newPassword }
// Verify current password → bcrypt update → ส่ง notification email
router.post('/change-password', async (req, res) => {
    try {
        const { username, currentPassword, newPassword } = req.body || {};
        if (!username || !currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: 'กรุณาส่ง username, currentPassword และ newPassword' });
        }
        if (String(newPassword).length < 6) {
            return res.status(400).json({ success: false, message: 'รหัสผ่านใหม่ต้องอย่างน้อย 6 ตัวอักษร' });
        }
        if (currentPassword === newPassword) {
            return res.status(400).json({ success: false, message: 'รหัสผ่านใหม่ต้องไม่เหมือนรหัสผ่านเดิม' });
        }

        // Rate limit — กัน brute-force currentPassword
        const rl = rateLimit(clientKey(req, `chpass:${username}`), 5, 15 * 60 * 1000);
        if (!rl.ok) {
            return res.status(429).json({
                success: false,
                message: `พยายามมากเกินไป กรุณารอ ${Math.ceil(rl.retryAfter / 60)} นาทีก่อนลองใหม่`,
            });
        }

        const user = await User.findOne({ username: String(username).trim() });
        if (!user) return res.status(404).json({ success: false, message: 'ไม่พบบัญชี' });

        const ok = await bcrypt.compare(currentPassword, user.password);
        if (!ok) {
            return res.status(400).json({ success: false, errorCode: 'WRONG_PASSWORD', message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
        }

        user.password = String(newPassword);   // pre-save hook hash ให้
        await user.save();

        console.log(`✅ Password changed: ${user.username}`);

        // ส่ง notification email (best-effort — ไม่ block flow ถ้า fail)
        if (emailer.isConfigured() && user.email) {
            const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
            emailer.sendPasswordChangedEmail({ to: user.email, username: user.username, ip })
                .catch(err => console.error('Notification email failed:', err.message));
        }

        return res.json({ success: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ' });
    } catch (err) {
        console.error('Change Password Error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
});

router.post('/verify-otp', async (req, res) => {
    try {
        const { identifier, otp } = req.body || {};
        if (!identifier || !otp) return res.status(400).json({ success: false, message: 'กรุณาระบุ identifier และ otp' });

        const user = await User.findOne({
            $or: [
                { username: String(identifier).trim() },
                { email:    String(identifier).trim().toLowerCase() },
            ]
        });
        if (!user || !user.reset_otp?.code_hash) {
            return res.status(400).json({ success: false, errorCode: 'NO_OTP', message: 'ไม่มีคำขอรีเซ็ตที่ใช้งานได้' });
        }
        if (new Date() > user.reset_otp.expiresAt) {
            return res.status(400).json({ success: false, errorCode: 'EXPIRED', message: 'OTP หมดอายุแล้ว กรุณาขอใหม่' });
        }
        if (user.reset_otp.attempts >= 5) {
            return res.status(400).json({ success: false, errorCode: 'TOO_MANY_ATTEMPTS', message: 'กรอก OTP ผิดเกิน 5 ครั้ง กรุณาขอใหม่' });
        }

        const ok = await bcrypt.compare(String(otp), user.reset_otp.code_hash);
        if (!ok) {
            user.reset_otp.attempts += 1;
            await user.save();
            return res.status(400).json({
                success: false,
                errorCode: 'INVALID_OTP',
                message: `รหัส OTP ไม่ถูกต้อง (เหลืออีก ${5 - user.reset_otp.attempts} ครั้ง)`,
                attemptsLeft: 5 - user.reset_otp.attempts,
            });
        }

        return res.json({ success: true, message: 'รหัส OTP ถูกต้อง — กรุณาตั้งรหัสผ่านใหม่' });
    } catch (err) {
        console.error('Verify OTP Error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
});

router.post('/reset-password', async (req, res) => {
    try {
        const { identifier, otp, newPassword } = req.body || {};
        if (!identifier || !otp || !newPassword) {
            return res.status(400).json({ success: false, message: 'กรุณาระบุ identifier, otp และ newPassword' });
        }
        if (String(newPassword).length < 6) {
            return res.status(400).json({ success: false, message: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' });
        }

        const user = await User.findOne({
            $or: [
                { username: String(identifier).trim() },
                { email:    String(identifier).trim().toLowerCase() },
            ]
        });
        if (!user || !user.reset_otp?.code_hash) {
            return res.status(400).json({ success: false, errorCode: 'NO_OTP', message: 'ไม่มีคำขอรีเซ็ตที่ใช้งานได้' });
        }
        if (new Date() > user.reset_otp.expiresAt) {
            return res.status(400).json({ success: false, errorCode: 'EXPIRED', message: 'OTP หมดอายุแล้ว กรุณาขอใหม่' });
        }
        if (user.reset_otp.attempts >= 5) {
            return res.status(400).json({ success: false, errorCode: 'TOO_MANY_ATTEMPTS', message: 'กรอก OTP ผิดเกิน 5 ครั้ง กรุณาขอใหม่' });
        }

        const ok = await bcrypt.compare(String(otp), user.reset_otp.code_hash);
        if (!ok) {
            user.reset_otp.attempts += 1;
            await user.save();
            return res.status(400).json({
                success: false,
                errorCode: 'INVALID_OTP',
                message: `รหัส OTP ไม่ถูกต้อง (เหลืออีก ${5 - user.reset_otp.attempts} ครั้ง)`,
                attemptsLeft: 5 - user.reset_otp.attempts,
            });
        }

        // Reset password (pre-save hook จะ hash ให้)
        user.password  = String(newPassword);
        user.reset_otp = { code_hash: null, expiresAt: null, attempts: 0 };  // clear OTP
        await user.save();

        console.log(`✅ Password reset successful: ${user.username}`);
        return res.json({ success: true, message: 'รีเซ็ตรหัสผ่านสำเร็จ — กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่' });
    } catch (err) {
        console.error('Reset Password Error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
});

router.get('/:username', async (req, res) => {
    try {
        const user = await User.findOne({ username: req.params.username });
        if (!user) return res.status(404).json("User not found");
        res.status(200).json(user);
    } catch (err) {
        res.status(500).json(err);
    }
});

module.exports = router;