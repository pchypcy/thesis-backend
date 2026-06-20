// routes/settlements.js — InGreen v3 (Model B: Invoice/GP Fee)
//
// ระบบเรียกเก็บค่า GP จากร้านค้า:
//   - ลูกค้าจ่ายเงินที่ร้านโดยตรง → ร้านเก็บ 100%
//   - ระบบบันทึก: ร้านต้องจ่ายค่า GP 5% คืน InGreen
//   - ทุกสัปดาห์ admin ออกใบแจ้งหนี้ → ร้านโอนเงิน → admin ปิดใบ
//
// Endpoints:
//   1. GET  /preview                      → ดู invoices pending grouped by merchant
//   2. POST /create                       → ออกใบแจ้งหนี้งวด (รวม pending invoices)
//   3. GET  /                              → list all settlements
//   4. GET  /:id                           → settlement detail (รวม invoice list)
//   5. POST /:id/mark-paid                 → บันทึกการชำระ (ร้านโอนเงินมาแล้ว)
//   6. GET  /merchant/:merchantId          → settlement ของร้านคนเดียว

const express  = require('express');
const router   = express.Router();
const Invoice    = require('../models/Invoice');
const Settlement = require('../models/Settlement');
const Merchant   = require('../models/Merchant');
const emailer    = require('../utils/emailer');

// ── Helper: สร้าง batch code (year-month-week) ──────────────────────────────
function generateBatchCode(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    // ISO week number
    const tmp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
    return `SET-${y}${m}-W${String(week).padStart(2, '0')}`;
}

// ── Helper: กำหนด period (วันจันทร์ - อาทิตย์ของสัปดาห์ปัจจุบัน) ──────────────
function getCurrentWeekPeriod(date = new Date()) {
    const d = new Date(date);
    const day = d.getDay();              // 0=Sun, 1=Mon ... 6=Sat
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setDate(d.getDate() + diffToMonday);
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    return { from: monday, to: sunday };
}

// ═════════════════════════════════════════════════════════════════════════
// GET /preview — ดูว่าถ้าสร้าง batch ตอนนี้จะมีร้านอะไรบ้าง ยอดเท่าไหร่
// ═════════════════════════════════════════════════════════════════════════
router.get('/preview', async (req, res) => {
    try {
        const pendingInvoices = await Invoice.find({
            status: 'pending',
            settlementId: null,
        }).sort({ redeemedAt: 1 });

        // Group by merchantId
        const groups = {};
        pendingInvoices.forEach(inv => {
            if (!groups[inv.merchantId]) {
                groups[inv.merchantId] = {
                    merchantId:   inv.merchantId,
                    invoiceCount: 0,
                    grossAmount:  0,
                    feeAmount:    0,
                    netAmount:    0,
                    firstDate:    inv.redeemedAt,
                    lastDate:     inv.redeemedAt,
                };
            }
            const g = groups[inv.merchantId];
            g.invoiceCount += 1;
            g.grossAmount  += inv.totalAmount || 0;
            g.feeAmount    += inv.inGreenFee  || 0;
            g.netAmount    += (inv.totalAmount - inv.inGreenFee) || 0;
            if (inv.redeemedAt < g.firstDate) g.firstDate = inv.redeemedAt;
            if (inv.redeemedAt > g.lastDate)  g.lastDate  = inv.redeemedAt;
        });

        // Resolve merchant names + bank info
        const merchantIds = Object.keys(groups);
        const merchants   = await Merchant.find({ shopId: { $in: merchantIds } });
        const merchMap    = Object.fromEntries(merchants.map(m => [m.shopId, m]));

        const items = Object.values(groups).map(g => {
            const m = merchMap[g.merchantId];
            return {
                ...g,
                merchantName: m?.name || g.merchantId,
                hasBankInfo:  !!(m?.bankInfo?.accountNo),
                bankInfo:     m?.bankInfo || null,
                // round 2 decimals
                grossAmount:  Math.round(g.grossAmount * 100) / 100,
                feeAmount:    Math.round(g.feeAmount * 100) / 100,
                netAmount:    Math.round(g.netAmount * 100) / 100,
            };
        });

        const period    = getCurrentWeekPeriod();
        const batchCode = generateBatchCode();

        return res.json({
            success: true,
            preview: {
                batchCode,
                period: {
                    from:  period.from.toISOString(),
                    to:    period.to.toISOString(),
                    label: `${period.from.toLocaleDateString('th-TH', { day: '2-digit', month: 'short' })} - ${period.to.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' })}`,
                },
                totalMerchants: items.length,
                totalInvoices:  items.reduce((s, i) => s + i.invoiceCount, 0),
                totalGross:     Math.round(items.reduce((s, i) => s + i.grossAmount, 0) * 100) / 100,
                totalFee:       Math.round(items.reduce((s, i) => s + i.feeAmount,   0) * 100) / 100,
                totalNet:       Math.round(items.reduce((s, i) => s + i.netAmount,   0) * 100) / 100,
                merchants:      items,
            },
        });
    } catch (err) {
        console.error('Settlement preview error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /create — สร้าง settlement batch (รวม pending invoices)
// Body: { createdBy?: 'admin' }
// ═════════════════════════════════════════════════════════════════════════
router.post('/create', async (req, res) => {
    try {
        const { createdBy = 'admin' } = req.body || {};

        const pendingInvoices = await Invoice.find({
            status: 'pending',
            settlementId: null,
        });
        if (pendingInvoices.length === 0) {
            return res.status(400).json({ success: false, message: 'ไม่มี invoices ที่รอเคลียร์เงิน' });
        }

        const period    = getCurrentWeekPeriod();
        const batchCode = generateBatchCode();

        // Group by merchant
        const groups = {};
        pendingInvoices.forEach(inv => {
            if (!groups[inv.merchantId]) groups[inv.merchantId] = [];
            groups[inv.merchantId].push(inv);
        });

        const merchantIds = Object.keys(groups);
        const merchants   = await Merchant.find({ shopId: { $in: merchantIds } });
        const merchMap    = Object.fromEntries(merchants.map(m => [m.shopId, m]));

        const created = [];
        for (const [mId, invs] of Object.entries(groups)) {
            const m = merchMap[mId];
            const grossAmount = invs.reduce((s, i) => s + (i.totalAmount || 0), 0);
            const feeAmount   = invs.reduce((s, i) => s + (i.inGreenFee  || 0), 0);
            const netAmount   = grossAmount - feeAmount;

            // Check ว่ามี settlement ของร้านนี้ใน batch นี้แล้วหรือยัง
            const existing = await Settlement.findOne({ merchantId: mId, batchCode });
            if (existing) {
                console.log(`⚠️  Skip: settlement already exists for ${mId} in ${batchCode}`);
                continue;
            }

            const settlement = new Settlement({
                batchCode,
                period: {
                    from:  period.from,
                    to:    period.to,
                    label: `${period.from.toLocaleDateString('th-TH', { day: '2-digit', month: 'short' })} - ${period.to.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' })}`,
                },
                merchantId:   mId,
                merchantName: m?.name || mId,
                bankSnapshot: m?.bankInfo || {},
                invoiceIds:   invs.map(i => i._id),
                invoiceCount: invs.length,
                grossAmount:  Math.round(grossAmount * 100) / 100,
                feeAmount:    Math.round(feeAmount * 100) / 100,
                netAmount:    Math.round(netAmount * 100) / 100,
                status:       'pending',
                createdBy,
            });
            await settlement.save();

            // Link invoices to this settlement (ยังไม่ mark paid)
            await Invoice.updateMany(
                { _id: { $in: invs.map(i => i._id) } },
                { $set: { settlementId: settlement._id } }
            );

            created.push(settlement);
            console.log(`📦 Settlement created: ${batchCode} / ${mId} → ${invs.length} invoices · net ${netAmount.toFixed(2)}฿`);
        }

        return res.json({
            success: true,
            message: `ออกใบแจ้งหนี้งวด ${batchCode} เรียบร้อย (${created.length} ร้าน)`,
            batchCode,
            settlements: created,
        });
    } catch (err) {
        console.error('Settlement create error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ═════════════════════════════════════════════════════════════════════════
// GET / — list all settlements (latest first)
// ═════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
    try {
        const { status, batchCode } = req.query;
        const filter = {};
        if (status)    filter.status    = status;
        if (batchCode) filter.batchCode = batchCode;

        const items = await Settlement.find(filter)
            .sort({ createdAt: -1 })
            .limit(200);

        // group by batchCode for UI rendering
        const batches = {};
        items.forEach(s => {
            if (!batches[s.batchCode]) {
                batches[s.batchCode] = {
                    batchCode: s.batchCode,
                    period:    s.period,
                    createdAt: s.createdAt,
                    settlements: [],
                    totalNet:    0,
                    pendingCount: 0,
                    paidCount:    0,
                };
            }
            batches[s.batchCode].settlements.push(s);
            batches[s.batchCode].totalNet += s.netAmount;
            if (s.status === 'pending') batches[s.batchCode].pendingCount++;
            if (s.status === 'paid')    batches[s.batchCode].paidCount++;
        });

        return res.json({
            success: true,
            total:   items.length,
            items,
            batches: Object.values(batches).sort((a, b) => b.batchCode.localeCompare(a.batchCode)),
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /invoices — list invoices จริงจาก DB (สำหรับหน้า AdminInvoices)
//   ★ FIX: ต้อง register ก่อน /:id เพราะ Express match ตามลำดับ
//          (มิฉะนั้น "invoices" จะถูกตีว่าเป็น settlement._id แล้ว findById fail)
// Query: ?status=pending|paid&merchantId=shop_001
// ═════════════════════════════════════════════════════════════════════════
router.get('/invoices', async (req, res) => {
    try {
        const { status, merchantId } = req.query;
        const filter = {};
        if (status)     filter.status     = status;
        if (merchantId) filter.merchantId = merchantId;

        console.log('[invoices] filter:', filter);

        const invoices = await Invoice.find(filter)
            .sort({ redeemedAt: -1 })
            .limit(500)
            .lean();

        console.log(`[invoices] found ${invoices.length} records`);

        // enrich ด้วยชื่อร้าน — defensive: filter out null/undefined merchantIds
        const merchantIds = [...new Set(
            invoices.map(i => i.merchantId).filter(id => id && typeof id === 'string')
        )];

        let shopNameMap = {};
        if (merchantIds.length > 0) {
            try {
                const merchants = await Merchant.find({ shopId: { $in: merchantIds } }).lean();
                merchants.forEach(m => { shopNameMap[m.shopId] = m.name; });
            } catch (mErr) {
                // ถ้า lookup Merchant fail → ไม่ block — ใช้ merchantId เป็น shopName แทน
                console.warn('[invoices] Merchant lookup failed (non-critical):', mErr.message);
            }
        }

        const enriched = invoices.map(inv => ({
            ...inv,
            shopName: shopNameMap[inv.merchantId] || inv.merchantId || 'Unknown',
        }));

        const summary = {
            total:        enriched.length,
            paidCount:    enriched.filter(i => i.status === 'paid').length,
            pendingCount: enriched.filter(i => i.status !== 'paid').length,
            totalFee:     enriched.filter(i => i.status === 'paid').reduce((s, i) => s + (Number(i.inGreenFee) || 0), 0),
            pendingFee:   enriched.filter(i => i.status !== 'paid').reduce((s, i) => s + (Number(i.inGreenFee) || 0), 0),
        };

        return res.json({ success: true, summary, items: enriched });
    } catch (err) {
        console.error('[invoices] list error:', err);
        console.error('[invoices] stack:', err.stack);
        return res.status(500).json({
            success: false,
            message: err.message,
            errorType: err.name,
            // ใน dev mode ส่ง stack กลับให้ frontend debug ง่าย
            ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
        });
    }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /invoices/:id/mark-paid — mark invoice เดี่ยวเป็น paid
//   ★ FIX: เช่นเดียวกัน ต้องอยู่ก่อน /:id/mark-paid
// Body: { paymentRef, paymentNote? }
// ═════════════════════════════════════════════════════════════════════════
router.post('/invoices/:id/mark-paid', async (req, res) => {
    try {
        const { paymentRef, paymentNote = null } = req.body || {};
        if (!paymentRef) return res.status(400).json({ success: false, message: 'กรุณาระบุเลขอ้างอิงโอนเงิน' });

        const invoice = await Invoice.findById(req.params.id);
        if (!invoice) return res.status(404).json({ success: false, message: 'ไม่พบใบแจ้งหนี้' });
        if (invoice.status === 'paid') {
            return res.status(400).json({ success: false, message: 'invoice นี้ถูก mark paid แล้ว', paidAt: invoice.paidAt });
        }

        invoice.status  = 'paid';
        invoice.paidAt  = new Date();
        invoice.paidRef = String(paymentRef).trim();
        if (paymentNote) invoice.paymentNote = paymentNote;
        await invoice.save();

        console.log(`✅ Invoice paid: ${invoice._id} · ref=${paymentRef}`);

        return res.json({ success: true, message: 'บันทึกการชำระเรียบร้อย', invoice });
    } catch (err) {
        console.error('invoice mark-paid error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /:id — settlement detail (รวม invoice items)
// ═════════════════════════════════════════════════════════════════════════
router.get('/:id', async (req, res) => {
    try {
        const settlement = await Settlement.findById(req.params.id);
        if (!settlement) return res.status(404).json({ success: false, message: 'ไม่พบ settlement' });

        const invoices = await Invoice.find({ _id: { $in: settlement.invoiceIds } }).sort({ redeemedAt: 1 });

        return res.json({ success: true, settlement, invoices });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /:id/mark-paid — บันทึกว่าจ่ายแล้ว
// Body: { paymentRef, paidBy?, paymentNote? }
// ═════════════════════════════════════════════════════════════════════════
router.post('/:id/mark-paid', async (req, res) => {
    try {
        const { paymentRef, paidBy = 'admin', paymentNote = null } = req.body || {};
        if (!paymentRef) return res.status(400).json({ success: false, message: 'กรุณาระบุเลขอ้างอิงโอนเงิน' });

        const settlement = await Settlement.findById(req.params.id);
        if (!settlement) return res.status(404).json({ success: false, message: 'ไม่พบ settlement' });
        if (settlement.status === 'paid') {
            return res.status(400).json({ success: false, message: 'settlement นี้ถูก mark paid ไปแล้ว', paidAt: settlement.paidAt });
        }

        settlement.status        = 'paid';
        settlement.paidAt        = new Date();
        settlement.paidBy        = paidBy;
        settlement.paymentRef    = String(paymentRef).trim();
        settlement.paymentNote   = paymentNote;
        await settlement.save();

        // Mark all invoices ใน batch นี้เป็น paid ด้วย
        await Invoice.updateMany(
            { _id: { $in: settlement.invoiceIds } },
            { $set: { status: 'paid', paidAt: settlement.paidAt, paidRef: settlement.paymentRef } }
        );

        console.log(`✅ Settlement paid: ${settlement.batchCode} / ${settlement.merchantId} · ref=${paymentRef}`);

        // ส่ง email แจ้งร้าน (best-effort)
        try {
            const merchant = await Merchant.findOne({ shopId: settlement.merchantId });
            if (merchant && emailer.isConfigured()) {
                // ส่งไป admin's email (เพราะ Merchant ไม่มี email field) — production จะ add field
                // ถ้าไม่มี email ก็ skip ไม่ throw
            }
        } catch (mailErr) {
            console.error('Settlement email error:', mailErr.message);
        }

        return res.json({
            success: true,
            message: 'บันทึกการชำระค่า GP เรียบร้อย — ใบแจ้งหนี้งวดนี้ปิดแล้ว',
            settlement,
        });
    } catch (err) {
        console.error('Settlement mark-paid error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /merchant/:merchantId — settlement ของร้านคนเดียว (สำหรับ MerchantPayout)
// ═════════════════════════════════════════════════════════════════════════
router.get('/merchant/:merchantId', async (req, res) => {
    try {
        const items = await Settlement.find({ merchantId: req.params.merchantId })
            .sort({ createdAt: -1 })
            .limit(50);

        const summary = {
            totalPaid:      0,
            totalPending:   0,
            countPaid:      0,
            countPending:   0,
        };
        items.forEach(s => {
            if (s.status === 'paid')    { summary.totalPaid    += s.netAmount; summary.countPaid++; }
            if (s.status === 'pending') { summary.totalPending += s.netAmount; summary.countPending++; }
        });

        return res.json({
            success: true,
            total: items.length,
            items,
            summary: {
                totalPaid:    Math.round(summary.totalPaid * 100) / 100,
                totalPending: Math.round(summary.totalPending * 100) / 100,
                countPaid:    summary.countPaid,
                countPending: summary.countPending,
            },
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ═════════════════════════════════════════════════════════════════════════
// PATCH /merchant-bank/:merchantId — แก้/เพิ่ม bank info ของร้าน
// Body: { bankName, bankCode, accountNo, accountName }
// ═════════════════════════════════════════════════════════════════════════
router.patch('/merchant-bank/:merchantId', async (req, res) => {
    try {
        const { bankName, bankCode, accountNo, accountName } = req.body || {};
        const merchant = await Merchant.findOne({ shopId: req.params.merchantId });
        if (!merchant) return res.status(404).json({ success: false, message: 'ไม่พบร้านค้า' });

        merchant.bankInfo = {
            bankName:    bankName    || merchant.bankInfo?.bankName    || null,
            bankCode:    bankCode    || merchant.bankInfo?.bankCode    || null,
            accountNo:   accountNo   || merchant.bankInfo?.accountNo   || null,
            accountName: accountName || merchant.bankInfo?.accountName || null,
        };
        await merchant.save();

        return res.json({ success: true, message: 'บันทึกข้อมูลบัญชีเรียบร้อย', bankInfo: merchant.bankInfo });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
