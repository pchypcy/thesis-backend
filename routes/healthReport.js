// routes/healthReport.js — InGreen Sprint 5 (Monthly Health Report)
//
// Endpoint:
//   GET /api/health-report/:username?month=YYYY-MM   → JSON สรุปสุขภาพรายเดือน (VIP only)
//   GET /api/health-report/:username/html?month=YYYY-MM → HTML สวยๆ ใช้ print/save as PDF
//
// ใช้ HTML แทน lib PDF เพราะ:
//   - ไม่ต้องเพิ่ม dependency (puppeteer ~300MB / pdfkit ใหญ่)
//   - browser print → PDF ได้ดีอยู่แล้ว
//   - QR/ลายเซ็น/รูป support เต็มที่
//
// Production: ถ้าต้องการ PDF binary ใช้ html-pdf-node หรือ puppeteer

const express  = require('express');
const router   = express.Router();
const DailyIntake     = require('../models/DailyIntake');
const VipSubscription = require('../models/VipSubscription');
const User            = require('../models/User');
const HealthProfile   = require('../models/HealthProfile');
const { getConfig }   = require('./config');

async function checkVip(username) {
    const sub = await VipSubscription.findOne({ username });
    return sub ? sub.isActive : false;
}

function monthRange(monthStr) {
    // monthStr: 'YYYY-MM'; default = this month
    let year, month;
    if (monthStr && /^\d{4}-\d{2}$/.test(monthStr)) {
        [year, month] = monthStr.split('-').map(Number);
    } else {
        const now = new Date();
        year  = now.getFullYear();
        month = now.getMonth() + 1;
    }
    const start = new Date(year, month - 1, 1);
    const end   = new Date(year, month,     1); // exclusive
    return { start, end, year, month };
}

// ── สร้าง summary object ที่ใช้ทั้ง JSON และ HTML ──
async function buildReport(username, monthStr) {
    const { start, end, year, month } = monthRange(monthStr);

    const [intakes, user, profile, sugarLim, starchLim] = await Promise.all([
        DailyIntake.find({ username, date: { $gte: start, $lt: end } }).sort({ date: 1 }),
        User.findOne({ username }),
        HealthProfile.findOne({ username }),
        getConfig('WHO_SUGAR_DAILY_G',   50),
        getConfig('SUGAR_TRACKER_STARCH_G', 300),
    ]);

    const daysWithData    = intakes.length;
    const sumSugar        = intakes.reduce((s, r) => s + (r.total_sugar_g  || 0), 0);
    const sumStarch       = intakes.reduce((s, r) => s + (r.total_starch_g || 0), 0);
    const sumSodium       = intakes.reduce((s, r) => s + (r.total_sodium_mg || 0), 0);
    const sumKcal         = intakes.reduce((s, r) => s + (r.total_kcal     || 0), 0);
    const daysOverSugar   = intakes.filter(r => r.total_sugar_g  > sugarLim).length;
    const daysOverStarch  = intakes.filter(r => r.total_starch_g > starchLim).length;

    // top scanned products (จาก scans array)
    const productCounts = {};
    intakes.forEach(r => (r.scans || []).forEach(s => {
        const k = s.productName || s.barcode || 'Unknown';
        productCounts[k] = (productCounts[k] || 0) + 1;
    }));
    const topProducts = Object.entries(productCounts)
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([name, count]) => ({ name, count }));

    const totalDaysInMonth = new Date(year, month, 0).getDate();
    const adherence = totalDaysInMonth > 0 ? Math.round((daysWithData / totalDaysInMonth) * 100) : 0;

    // เปรียบกับเดือนก่อน (1 record summary)
    const prev = await DailyIntake.find({
        username,
        date: { $gte: new Date(year, month - 2, 1), $lt: start },
    });
    const prevSugar = prev.reduce((s, r) => s + (r.total_sugar_g || 0), 0);
    const avgSugar  = daysWithData ? sumSugar / daysWithData : 0;
    const avgPrev   = prev.length ? prevSugar / prev.length : null;
    const sugarTrend = avgPrev != null
        ? (avgSugar < avgPrev ? 'down' : avgSugar > avgPrev ? 'up' : 'flat')
        : null;

    // Generate insight text
    const insights = [];
    if (daysOverSugar > 0) insights.push(`เดือนนี้คุณบริโภคน้ำตาลเกินมาตรฐาน WHO ทั้งหมด ${daysOverSugar} วัน — แนะนำให้ลดเครื่องดื่มที่มีน้ำตาลในสัปดาห์ถัดไป`);
    if (sugarTrend === 'down') insights.push(`เก่ง! ค่าเฉลี่ยน้ำตาลลดลงจากเดือนก่อน ${Math.round((avgPrev - avgSugar) * 10) / 10}g/วัน`);
    if (sugarTrend === 'up')   insights.push(`ค่าเฉลี่ยน้ำตาลเพิ่มจากเดือนก่อน ${Math.round((avgSugar - avgPrev) * 10) / 10}g/วัน — ระวังเครื่องดื่มหวานและขนม`);
    if (adherence < 50)        insights.push('คุณบันทึกข้อมูลไม่ถึงครึ่งเดือน — สแกนสินค้าบ่อยขึ้นเพื่อข้อมูลที่แม่นยำขึ้น');
    if (insights.length === 0) insights.push('สุขภาพในเดือนนี้อยู่ในเกณฑ์ดี — ยังคงรักษาวินัยการกินอย่างนี้ต่อไป');

    return {
        username,
        period: { year, month, monthLabel: `${year}-${String(month).padStart(2, '0')}`, daysInMonth: totalDaysInMonth },
        user: user ? { persona: user.persona, points: user.points } : null,
        profile: profile ? { conditions: profile.conditions, allergens: profile.allergens } : null,
        whoLimits: { sugar_g: sugarLim, starch_g: starchLim },
        summary: {
            daysWithData,
            adherencePct:   adherence,
            total_sugar_g:  Math.round(sumSugar  * 10) / 10,
            total_starch_g: Math.round(sumStarch * 10) / 10,
            total_sodium_mg: Math.round(sumSodium),
            total_kcal:     Math.round(sumKcal),
            avg_sugar_g:    daysWithData ? Math.round((sumSugar / daysWithData) * 10) / 10 : 0,
            avg_starch_g:   daysWithData ? Math.round((sumStarch / daysWithData) * 10) / 10 : 0,
            days_over_sugar: daysOverSugar,
            days_over_starch: daysOverStarch,
        },
        trend: { sugar: sugarTrend, avg_prev_sugar_g: avgPrev != null ? Math.round(avgPrev * 10) / 10 : null },
        topProducts,
        daily: intakes.map(r => ({
            dateKey:        r.dateKey,
            sugar_g:        Math.round((r.total_sugar_g || 0) * 10) / 10,
            starch_g:       Math.round((r.total_starch_g || 0) * 10) / 10,
            sodium_mg:      Math.round(r.total_sodium_mg || 0),
            scans:          (r.scans || []).length,
        })),
        insights,
        generatedAt: new Date().toISOString(),
    };
}

router.get('/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const isVip = await checkVip(username);
        if (!isVip) {
            return res.status(403).json({ success: false, code: 'NOT_VIP', message: 'ฟีเจอร์รายงานสุขภาพรายเดือนสำหรับ VIP เท่านั้น' });
        }
        const report = await buildReport(username, req.query.month);
        return res.json({ success: true, report });
    } catch (err) {
        console.error('Health Report Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/:username/html', async (req, res) => {
    try {
        const { username } = req.params;
        const isVip = await checkVip(username);
        if (!isVip) return res.status(403).send('<h1>VIP only</h1>');

        const r = await buildReport(username, req.query.month);
        const html = renderReportHtml(r);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
    } catch (err) {
        console.error('Health Report HTML Error:', err);
        return res.status(500).send(`<pre>${err.message}</pre>`);
    }
});

function renderReportHtml(r) {
    const s = r.summary;
    const sugarPct  = r.whoLimits.sugar_g  ? Math.round((s.avg_sugar_g  / r.whoLimits.sugar_g)  * 100) : 0;
    const starchPct = r.whoLimits.starch_g ? Math.round((s.avg_starch_g / r.whoLimits.starch_g) * 100) : 0;

    const dailyBars = r.daily.map(d => {
        const pct = Math.min(100, Math.round((d.sugar_g / r.whoLimits.sugar_g) * 100));
        const c   = d.sugar_g > r.whoLimits.sugar_g ? '#D32F2F' : d.sugar_g > r.whoLimits.sugar_g * 0.7 ? '#F57C00' : '#2E7D32';
        return `<div class="bar-row"><div class="bar-label">${d.dateKey.slice(5)}</div><div class="bar-wrap"><div class="bar" style="width:${pct}%;background:${c}"></div></div><div class="bar-val">${d.sugar_g}g</div></div>`;
    }).join('');

    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>InGreen Monthly Report — ${r.period.monthLabel}</title>
<style>
  * { box-sizing: border-box; font-family: 'IBM Plex Sans Thai', system-ui, sans-serif; }
  body { margin: 0; padding: 24px; background: #FAFAFA; color: #1B1B1B; }
  .doc { max-width: 800px; margin: 0 auto; background: white; padding: 32px 36px; box-shadow: 0 12px 40px rgba(0,0,0,0.06); border-radius: 18px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1B5E20; padding-bottom: 16px; margin-bottom: 22px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .logo { width: 42px; height: 42px; background: #1B5E20; border-radius: 10px; display: grid; place-items: center; color: #CCFF00; font-size: 24px; font-weight: 900; }
  h1 { margin: 0; font-size: 22px; color: #1B5E20; font-weight: 900; }
  .sub { font-size: 12px; color: #888; font-weight: 600; }
  .crown { background: linear-gradient(135deg, #F4FDC6, #CCFF00); color: #1B5E20; padding: 6px 12px; border-radius: 20px; font-size: 11px; font-weight: 900; }
  h2 { font-size: 14px; color: #1B5E20; font-weight: 900; margin: 24px 0 10px; text-transform: uppercase; letter-spacing: 1px; }
  .kpi { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .kpi .card { background: #F8FFF0; padding: 14px; border-radius: 14px; border: 1px solid #E8F5E9; }
  .kpi .v { font-size: 22px; font-weight: 900; color: #1B5E20; }
  .kpi .l { font-size: 11px; color: #666; font-weight: 700; margin-top: 2px; }
  .progress { background: #F0F0F0; height: 10px; border-radius: 10px; overflow: hidden; margin-top: 6px; }
  .progress > div { height: 100%; border-radius: 10px; }
  .bar-row { display: flex; align-items: center; gap: 10px; margin: 3px 0; font-size: 12px; }
  .bar-label { width: 56px; color: #888; font-weight: 700; }
  .bar-wrap { flex: 1; background: #F5F5F5; height: 10px; border-radius: 4px; overflow: hidden; }
  .bar { height: 100%; }
  .bar-val { width: 56px; text-align: right; font-weight: 800; color: #333; }
  .insights { background: linear-gradient(180deg, #F8FFF0, #FFFFFF); padding: 14px 16px; border-radius: 14px; border: 1px solid #C8E6C9; }
  .insights li { margin: 6px 0; font-size: 13px; color: #2E7D32; font-weight: 600; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #F0F0F0; text-align: left; }
  th { color: #888; font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; }
  footer { margin-top: 28px; padding-top: 14px; border-top: 1px solid #F0F0F0; font-size: 10px; color: #AAA; display: flex; justify-content: space-between; }
  .print-btn { position: fixed; bottom: 24px; right: 24px; padding: 14px 22px; background: #1B5E20; color: #CCFF00; border: none; border-radius: 50px; font-weight: 900; cursor: pointer; box-shadow: 0 8px 25px rgba(27,94,32,0.3); }
  @media print { .print-btn { display: none; } body { background: white; padding: 0; } .doc { box-shadow: none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">💾 บันทึกเป็น PDF</button>
<div class="doc">
  <header>
    <div class="brand"><div class="logo">🌿</div><div><h1>InGreen Monthly Health Report</h1><div class="sub">${r.period.monthLabel} · ${r.username}${r.user ? ' · ' + r.user.persona : ''}</div></div></div>
    <span class="crown">👑 VIP REPORT</span>
  </header>

  <h2>สรุปภาพรวม</h2>
  <div class="kpi">
    <div class="card"><div class="v">${s.avg_sugar_g}g</div><div class="l">น้ำตาลเฉลี่ย/วัน</div><div class="progress"><div style="width:${Math.min(100,sugarPct)}%;background:${sugarPct>100?'#D32F2F':sugarPct>70?'#F57C00':'#2E7D32'}"></div></div></div>
    <div class="card"><div class="v">${s.avg_starch_g}g</div><div class="l">แป้งเฉลี่ย/วัน</div><div class="progress"><div style="width:${Math.min(100,starchPct)}%;background:#26A69A"></div></div></div>
    <div class="card"><div class="v">${s.days_over_sugar}</div><div class="l">วันที่เกินขีดน้ำตาล WHO</div></div>
    <div class="card"><div class="v">${s.adherencePct}%</div><div class="l">บันทึกข้อมูล (${s.daysWithData}/${r.period.daysInMonth} วัน)</div></div>
  </div>

  <h2>น้ำตาลรายวัน (g) — เส้น WHO ที่ ${r.whoLimits.sugar_g}g</h2>
  ${dailyBars || '<div style="color:#888;font-size:12px;">ไม่มีข้อมูลในเดือนนี้</div>'}

  <h2>คำแนะนำเฉพาะคุณ</h2>
  <div class="insights"><ul>${r.insights.map(i => `<li>${i}</li>`).join('')}</ul></div>

  <h2>สินค้าที่สแกนบ่อย</h2>
  <table><thead><tr><th>#</th><th>สินค้า</th><th>จำนวนครั้ง</th></tr></thead><tbody>
    ${r.topProducts.length ? r.topProducts.map((p, i) => `<tr><td>${i+1}</td><td>${p.name}</td><td>${p.count}</td></tr>`).join('') : '<tr><td colspan="3" style="color:#888">ยังไม่มีข้อมูล</td></tr>'}
  </tbody></table>

  <footer><span>InGreen © ${new Date().getFullYear()}</span><span>Generated ${new Date(r.generatedAt).toLocaleString('th-TH')}</span></footer>
</div></body></html>`;
}

module.exports = router;
