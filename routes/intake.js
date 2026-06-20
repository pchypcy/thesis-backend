// routes/intake.js — InGreen Sprint 2
//
// Endpoints:
//   POST /api/intake/log                      → log-intake: บันทึกน้ำตาล/แป้งหลังสแกน (VIP only)
//   GET  /api/intake/summary/:username        → intake-summary: สรุปรายวัน/สัปดาห์สำหรับ SugarTracker
//
// ★ log-intake:
//   - ทุกครั้งที่ VIP user สแกนสินค้า → Scan.jsx เรียก logIntakeIfVip() → POST /api/intake/log
//   - ดึง sugar_g และ carbs_g จาก product แล้ว $inc สะสมใน DailyIntake ของวันนั้น
//   - เป็น "silent" call — ถ้า fail ไม่กระทบ UX ของ scan
//   - ใช้ DailyIntake.logScan() static method (atomic upsert ป้องกัน race condition)
//
// ★ intake-summary:
//   - SugarTracker.jsx เรียกทุกครั้งที่ toggle day/week
//   - ?period=day → ข้อมูลวันนี้ (1 record)
//   - ?period=week → ข้อมูล 7 วันย้อนหลัง + weekly summary stats
//   - WHO limits ดึงจาก AppConfig (ไม่ hardcode)
//
// ★ VIP gate:
//   - ทั้งสอง endpoint ตรวจ VIP status ก่อนทำงาน
//   - Non-VIP → 403 (SugarTracker จะ redirect ไปหน้า upgrade prompt)

const express         = require('express');
const router          = express.Router();
const DailyIntake     = require('../models/DailyIntake');
const VipSubscription = require('../models/VipSubscription');
const { getConfig }   = require('./config');

// ── Helper: ตรวจ VIP status ───────────────────────────────────────────────────
async function checkVip(username) {
    const sub = await VipSubscription.findOne({ username });
    return sub ? sub.isActive : false;
}

// ─── POST /api/intake/log ─────────────────────────────────────────────────────
// บันทึกน้ำตาล/แป้งหลังสแกน — เรียกทุกครั้งที่ VIP user สแกนสำเร็จ
//
// Body:
//   {
//     username: String,
//     product: {
//       barcode, name,
//       sugar_g, carbs_g, sodium_mg, fat_g, energy_kcal
//     }
//   }
//
// ★ Silent fail design: ถ้า log ไม่ได้ (Network timeout, DB hiccup)
//   → return 200 พร้อม { success: false, silent: true }
//   → Scan.jsx จะ swallow error และไม่แสดง UI ใดๆ แก่ user
//
// ★ Atomic upsert: ใช้ DailyIntake.logScan() ซึ่งทำ findOneAndUpdate + $inc
//   ป้องกัน race condition ถ้าสแกนหลายอย่างพร้อมกัน (เช่น scan rapid ผ่าน automation)
router.post('/log', async (req, res) => {
    try {
        const { username, product } = req.body;

        if (!username || !product) {
            return res.status(400).json({ success: false, message: 'กรุณาส่ง username และ product' });
        }

        // ── VIP gate ──────────────────────────────────────────────────────────
        const isVip = await checkVip(username);
        if (!isVip) {
            // ไม่ใช่ VIP → silent fail (ไม่ error เพราะ Scan.jsx เรียกโดยไม่ตรวจผล)
            return res.json({ success: false, silent: true, message: 'feature สำหรับ VIP เท่านั้น' });
        }

        // ── ดึง WHO limits จาก Config (fallback ถ้า config ยังไม่ได้ seed) ──
        const [sugarLimit, starchLimit, proteinGoal] = await Promise.all([
            getConfig('WHO_SUGAR_DAILY_G', 50),
            getConfig('SUGAR_TRACKER_STARCH_G', 300),
            getConfig('PROTEIN_GOAL_DAILY_G', 50),
        ]);

        // ── Atomic log (upsert by username + dateKey) ─────────────────────
        const record = await DailyIntake.logScan(username, product, {
            sugar:   sugarLimit,
            starch:  starchLimit,
            protein: proteinGoal,
        });

        console.log(`📊 Intake logged: ${username} | sugar+${product.sugar_g || 0}g | carbs+${product.carbs_g || 0}g | protein+${product.protein_g || 0}g`);

        return res.json({
            success: true,
            dateKey: record.dateKey,
            totals:  {
                sugar_g:    record.total_sugar_g,
                starch_g:   record.total_starch_g,
                sodium_mg:  record.total_sodium_mg,
                fat_g:      record.total_fat_g,
                kcal:       record.total_kcal,
                protein_g:  record.total_protein_g,
                custom:     record.custom_nutrients || {},
            },
            limits: {
                sugar_g:   record.sugar_limit_g,
                starch_g:  record.starch_limit_g,
                protein_g: record.protein_goal_g,
            },
        });

    } catch (err) {
        console.error('Intake Log Error:', err);
        // ★ ส่ง 200 พร้อม silent: true ป้องกัน Scan.jsx แสดง error ต่อ user
        return res.status(200).json({ success: false, silent: true, message: 'log ไม่สำเร็จ (non-critical)' });
    }
});

// ─── GET /api/intake/summary/:username ────────────────────────────────────────
// สรุปข้อมูลสำหรับ SugarTracker — รับ ?period=day|week
//
// ?period=day  → คืน array ของวันนี้ (1 item หรือ empty array ถ้ายังไม่สแกน)
// ?period=week → คืน array 7 วัน + summary stats
//
// Response:
//   {
//     success, period,
//     data: [ { dateKey, total_sugar_g, total_starch_g, ... } ],
//     whoLimits: { sugar_g, starch_g },
//     summary: {          // เฉพาะ period=week
//       avg_sugar_g, avg_starch_g,
//       days_over_sugar, days_over_starch,
//       totalDays
//     }
//   }
//
// ★ Admin ใช้ AppConfig ดึง WHO limit จาก DB → ถ้า Admin เปลี่ยนค่า
//   กราฟใน SugarTracker จะอัปเดตโดยอัตโนมัติโดยไม่ต้อง deploy ใหม่
router.get('/summary/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const period       = req.query.period || 'week'; // 'day' | 'week'

        // ── VIP gate ──────────────────────────────────────────────────────────
        const isVip = await checkVip(username);
        if (!isVip) {
            return res.status(403).json({
                success: false,
                message: 'ฟีเจอร์นี้สำหรับ VIP เท่านั้น',
                code:    'NOT_VIP',
            });
        }

        // ── ดึง WHO limits จาก Config ─────────────────────────────────────
        const [sugarLimit, starchLimit, proteinGoal] = await Promise.all([
            getConfig('WHO_SUGAR_DAILY_G', 50),
            getConfig('SUGAR_TRACKER_STARCH_G', 300),
            getConfig('PROTEIN_GOAL_DAILY_G', 50),
        ]);

        const whoLimits = { sugar_g: sugarLimit, starch_g: starchLimit, protein_g: proteinGoal };

        // ── Query ตาม period ──────────────────────────────────────────────
        let records = [];

        if (period === 'day') {
            // วันนี้เท่านั้น (Bangkok timezone)
            const today = new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' });
            const todayKey = new Date(today).toISOString().slice(0, 10);

            const record = await DailyIntake.findOne({ username, dateKey: todayKey })
                .select('dateKey total_sugar_g total_starch_g total_sodium_mg total_fat_g total_kcal total_protein_g custom_nutrients sugar_limit_g starch_limit_g protein_goal_g scans');

            records = record ? [record] : [];

        } else {
            // 7 วันย้อนหลัง (วันนี้รวม) ใช้ static method ของ Model
            records = await DailyIntake.getWeeklySummary(username);

            // ถ้ามีน้อยกว่า 7 วัน → pad เพื่อให้กราฟ plot ครบ 7 bars
            // สร้าง dateKey ของ 7 วันย้อนหลัง
            const last7 = [];
            for (let i = 6; i >= 0; i--) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                const dk = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }))
                    .toISOString().slice(0, 10);
                last7.push(dk);
            }

            // Merge: ถ้าวันไหนไม่มีข้อมูล → ใส่ record ว่าง (sugar=0, starch=0)
            const recordMap = {};
            records.forEach(r => { recordMap[r.dateKey] = r; });

            records = last7.map(dk => recordMap[dk] || {
                dateKey:        dk,
                total_sugar_g:  0,
                total_starch_g: 0,
                total_sodium_mg: 0,
                total_protein_g: 0,          // ★ SPRINT 5
                custom_nutrients: {},
                sugar_limit_g:   sugarLimit,
                starch_limit_g:  starchLimit,
                protein_goal_g:  proteinGoal,
            });
        }

        // ── Weekly summary stats (period=week เท่านั้น) ──────────────────
        let summary = null;
        if (period === 'week' && records.length > 0) {
            const daysWithData    = records.filter(r => r.total_sugar_g > 0 || r.total_starch_g > 0 || r.total_protein_g > 0);
            const totalDays       = daysWithData.length;
            const totalSugar      = records.reduce((s, r) => s + (r.total_sugar_g   || 0), 0);
            const totalStarch     = records.reduce((s, r) => s + (r.total_starch_g  || 0), 0);
            const totalProtein    = records.reduce((s, r) => s + (r.total_protein_g || 0), 0);
            const daysOverSugar   = records.filter(r => r.total_sugar_g   > sugarLimit).length;
            const daysOverStarch  = records.filter(r => r.total_starch_g  > starchLimit).length;
            // ★ SPRINT 5: สำหรับ protein "ถึงเป้า" = ดี (ตรงข้ามกับ sugar)
            const daysMeetingProtein = records.filter(r => r.total_protein_g >= proteinGoal).length;

            summary = {
                totalDays,
                avg_sugar_g:     totalDays > 0 ? Math.round((totalSugar   / 7) * 10) / 10 : 0,
                avg_starch_g:    totalDays > 0 ? Math.round((totalStarch  / 7) * 10) / 10 : 0,
                avg_protein_g:   totalDays > 0 ? Math.round((totalProtein / 7) * 10) / 10 : 0,
                days_over_sugar:        daysOverSugar,
                days_over_starch:       daysOverStarch,
                days_meeting_protein:   daysMeetingProtein,
                total_sugar_g:    Math.round(totalSugar   * 10) / 10,
                total_starch_g:   Math.round(totalStarch  * 10) / 10,
                total_protein_g:  Math.round(totalProtein * 10) / 10,
            };
        }

        return res.json({
            success:   true,
            period,
            data:      records,
            whoLimits,
            summary,
        });

    } catch (err) {
        console.error('Intake Summary Error:', err);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
    }
});

module.exports = router;