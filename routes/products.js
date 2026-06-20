const express = require('express');
const router = express.Router();
const axios = require('axios'); // ต้องดึง axios เข้ามาใช้ยิง API ภายนอก
const Product = require('../models/Product');
const User = require('../models/User');                                 // ★ SPRINT 7: trust level
const { getConfig } = require('./config');
const { appendEntry, verifyChain } = require('../utils/auditChain');   // ★ DPSE-03 R4
const { computeTrustScore } = require('../utils/trustScore');           // ★ DPSE-03 R4
const { computeUserTrust, cappedWeight } = require('../utils/userTrust'); // ★ SPRINT 7

// ★ SPRINT 7: ดึง config ทั้งชุดสำหรับ weighted voting
async function getVotingConfig() {
    const [quorum, approveWeight, windowHours, maxWeight, threshold] = await Promise.all([
        getConfig('PRODUCT_VOTE_QUORUM', 3),
        getConfig('PRODUCT_VOTE_APPROVE_WEIGHT', 4),
        getConfig('PRODUCT_VOTE_WINDOW_HOURS', 72),
        getConfig('PRODUCT_VOTE_MAX_WEIGHT_PER_USER', 3),
        getConfig('PRODUCT_CROWDSOURCE_THRESHOLD', 3), // legacy unique-user fallback
    ]);
    return {
        quorum:        Number(quorum) || 3,
        approveWeight: Number(approveWeight) || 4,
        windowHours:   Number(windowHours) || 72,
        maxWeight:     Number(maxWeight) || 3,
        threshold:     Number(threshold) || 3,
    };
}

// ★ SPRINT 7: นับ unique voters + weighted tally จาก vote_log (source of truth)
function tallyVotes(product) {
    const upUsers = new Set();
    const downUsers = new Set();
    let wUp = 0, wDown = 0;
    for (const v of product.vote_log || []) {
        const w = Number(v.weight) || 1;
        if (v.vote === 'up')   { upUsers.add(v.username);   wUp += w; }
        else                   { downUsers.add(v.username); wDown += w; }
    }
    const uniqueVoters = new Set([...upUsers, ...downUsers]).size;
    return {
        uniqueVoters,
        uniqueUpvoters:   upUsers.size,
        uniqueDownvoters: downUsers.size,
        weightedUp:   Math.round(wUp * 100) / 100,
        weightedDown: Math.round(wDown * 100) / 100,
    };
}

// ★ SPRINT 7: ประเมินผลโหวต — ต้องผ่าน quorum ก่อนตัดสินใดๆ (ลด bias)
//   คืน { decision: 'approve'|'reject'|null, reason }
function evaluateOutcome(tally, cfg) {
    if (tally.uniqueVoters < cfg.quorum) {
        return { decision: null, reason: 'awaiting_quorum' };
    }
    const margin = tally.weightedUp - tally.weightedDown;
    if (margin >= cfg.approveWeight) {
        return { decision: 'approve', reason: 'weighted_quorum' };
    }
    if (-margin >= cfg.approveWeight) {
        return { decision: 'reject', reason: 'weighted_quorum' };
    }
    return { decision: null, reason: 'no_clear_margin' };
}

// ★ SPRINT 7: สรุปผลเมื่อหมดเวลาโหวต (Timer) — เรียกตอน read/vote/job
//   mutate product ในหน่วยความจำ; caller เป็นคน .save()
//   คืน true ถ้ามีการเปลี่ยน status
function finalizeIfWindowClosed(product, cfg, now = new Date()) {
    if (product.verification_status !== 'pending') return false;
    if (!product.vote_window_ends_at || now <= product.vote_window_ends_at) return false;

    const tally = tallyVotes(product);

    // quorum ไม่ถึงเมื่อหมดเวลา → ไม่ auto-reject (กัน bias จากคนโหวตน้อย) ส่งให้ admin
    if (tally.uniqueVoters < cfg.quorum) {
        product.needs_admin_review = true;
        product.vote_finalized_reason = 'insufficient_quorum';
        return true; // status ยัง pending แต่ flag เปลี่ยน
    }

    // quorum ถึง → ตัดสินด้วยเสียงข้างมากแบบถ่วงน้ำหนัก
    if (tally.weightedUp > tally.weightedDown) {
        product.verification_status   = 'community_approved';
        product.community_approved_at = now;
        product.vote_finalized_reason = 'window_majority';
        pushAuditAndScore(product, 'community_approve', 'system', {
            reason: 'window_majority', ...tally, window_closed: true,
        });
    } else {
        product.verification_status   = 'rejected';
        product.vote_finalized_reason = 'window_majority';
        pushAuditAndScore(product, 'reject', 'system', {
            reason: 'window_majority', ...tally, window_closed: true,
        });
    }
    return true;
}

// ★ DPSE-03 R4: helper — append entry เข้า audit chain + recalc trust score
//   เรียกหลังทุก action เพื่อ keep cache เป็นปัจจุบัน
function pushAuditAndScore(product, action, actor, payload) {
    const entry = appendEntry(product.audit_chain || [], { action, actor, payload });
    product.audit_chain.push(entry);
    const { score, breakdown } = computeTrustScore(product);
    product.trust_score     = score;
    product.trust_breakdown = breakdown;
    return entry;
}

// ★ DPSE-03 R4: คำนวณ verification tier จากข้อมูลที่ผู้ใช้ส่งมา
//   tier 1 (unverified)  — ไม่มี อย./ไม่มีรูป → ต้องผ่าน vote ครบ
//   tier 2 (semi)        — มี อย. format ถูก หรือ มีรูปฉลาก → vote 2 พอ
//   tier 3 (verified)    — มีทั้ง อย. + รูปฉลาก → ลด threshold เหลือ 1 vote หรือ admin approve
function computeTier({ fdaNumber, labelPhoto }) {
    const FDA_REGEX = /^\d{2}-\d{1}-\d{5}-\d{1}-\d{4}$/;
    const hasFda   = fdaNumber && FDA_REGEX.test(String(fdaNumber).trim());
    const hasPhoto = !!labelPhoto;

    if (hasFda && hasPhoto) return { tier: 3, dataSource: 'fda_thailand', label: 'verified' };
    if (hasFda || hasPhoto) return { tier: 2, dataSource: hasFda ? 'fda_thailand' : 'community', label: 'semi_verified' };
    return { tier: 1, dataSource: 'community', label: 'unverified' };
}

// ★ SPRINT 5: User-submitted (crowdsource) — เพิ่มข้อมูลสินค้าด้วย status: pending
// Body: { barcode, name, brand, ingredients[], marketing_text?, submitted_by,
//         fdaNumber?, labelPhoto? }
router.post('/add', async (req, res) => {
    try {
        const {
            barcode, name, brand,
            ingredients, marketing_text,
            submitted_by, image_url,
            sugar_g, sodium_mg, fat_g, energy_kcal, carbs_g, protein_g,
            fdaNumber, labelPhoto,
        } = req.body || {};

        if (!barcode || !name) {
            return res.status(400).json({ message: 'กรุณาส่ง barcode และ name' });
        }

        const existing = await Product.findOne({ barcode });
        if (existing) {
            return res.status(400).json({ message: 'สินค้านี้มีอยู่ในระบบแล้ว', status: existing.verification_status });
        }

        // ★ DPSE-03 R4: คำนวณ tier ตามหลักฐานที่ส่งมา
        const { tier, dataSource, label } = computeTier({ fdaNumber, labelPhoto });

        const newProduct = new Product({
            barcode,
            name:           String(name).trim(),
            brand:          (brand || '').trim() || 'Unknown Brand',
            image_url:      image_url || null,
            marketing_text: marketing_text || 'ข้อมูลจากผู้ใช้งาน InGreen (รอตรวจสอบ)',
            ingredients:    Array.isArray(ingredients) ? ingredients : (ingredients ? String(ingredients).split(',') : []),
            sugar_g, sodium_mg, fat_g, energy_kcal, carbs_g, protein_g,
            earned: 15,
            is_green: false,
            verification_status: 'pending',  // ★ ต้องผ่าน vote ก่อน (ยกเว้น tier 3 ที่อาจ auto-approve)
            submitted_by: submitted_by || null,
            data_source:       dataSource,
            verification_tier: tier,
            fda_number:        fdaNumber ? String(fdaNumber).trim() : null,
            label_photo:       labelPhoto || null,
        });

        // ★ DPSE-03 R4: genesis entry ใน audit chain
        pushAuditAndScore(newProduct, 'submit', submitted_by || 'anonymous', {
            barcode, name: newProduct.name, brand: newProduct.brand, tier,
            has_fda: !!fdaNumber, has_photo: !!labelPhoto,
        });

        const saved = await newProduct.save();
        console.log(`📝 Crowdsource: new product ${barcode} by ${submitted_by || 'anonymous'} | tier=${tier} | source=${dataSource}`);
        return res.status(201).json({
            success: true,
            message: tier === 3
                ? 'เพิ่มข้อมูลเข้าระบบแล้ว (มีหลักฐาน อย. + รูปฉลาก ครบ — รอตรวจสอบขั้นสุดท้าย)'
                : tier === 2
                    ? 'เพิ่มข้อมูลเข้าระบบแล้ว (มีหลักฐานบางส่วน — รอชุมชนยืนยัน)'
                    : 'เพิ่มข้อมูลเข้าระบบแล้ว (รอชุมชนตรวจสอบ)',
            product: saved,
            verification_status: 'pending',
            verification_tier:   tier,
            data_source:         dataSource,
            tier_label:          label,
        });
    } catch (err) {
        console.error('Add Product Error:', err);
        return res.status(500).json({ message: 'เกิดข้อผิดพลาด', error: err.message });
    }
});

// ★ SPRINT 5: รายการสินค้าที่รอ vote (สำหรับ Community / Admin tab)
// ★ SPRINT 7: เพิ่ม weighted progress + quorum + เวลาที่เหลือ + lazy finalize ของที่หมดเวลา
router.get('/pending/list', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
        const cfg = await getVotingConfig();
        const now = new Date();

        const docs = await Product.find({ verification_status: 'pending' })
            .sort({ createdAt: -1 })
            .limit(limit);

        const items = [];
        for (const p of docs) {
            // lazy finalize: ถ้าหมดเวลาแล้ว → สรุปผล แล้วไม่แสดงในลิสต์ pending อีก (ยกเว้นที่ flag ส่ง admin)
            if (finalizeIfWindowClosed(p, cfg, now)) {
                await p.save();
                if (p.verification_status !== 'pending') continue;
            }
            const tally = tallyVotes(p);
            const secondsLeft = p.vote_window_ends_at
                ? Math.max(0, Math.floor((p.vote_window_ends_at - now) / 1000))
                : null;
            items.push({
                barcode: p.barcode, name: p.name, brand: p.brand, image_url: p.image_url,
                ingredients: p.ingredients, submitted_by: p.submitted_by, createdAt: p.createdAt,
                upvotes: p.upvotes, downvotes: p.downvotes,
                // ★ SPRINT 7 voting progress
                weighted_up: tally.weightedUp, weighted_down: tally.weightedDown,
                unique_voters: tally.uniqueVoters,
                quorum: cfg.quorum, quorum_met: tally.uniqueVoters >= cfg.quorum,
                approve_weight: cfg.approveWeight,
                vote_window_ends_at: p.vote_window_ends_at,
                seconds_left: secondsLeft,
                needs_admin_review: p.needs_admin_review,
            });
        }
        return res.json({ success: true, total: items.length, items, config: cfg });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ★ SPRINT 5 + DPSE-03 R4: Vote on pending product
// Body: { barcode, username, vote: 'up' | 'down', comment? }
//
// ★ DPSE-03 R4 — Two-stage approval pipeline:
//   pending ─(community vote: 3 unique users + 3 unique IPs)→ community_approved ─(admin)→ approved
//   เปลี่ยนจากเดิมที่ community vote ครบ → approved ทันที (เสี่ยง sybil/coordinated vote)
//
// ★ Anti-fraud (R4):
//   - dedup username: ห้ามโหวตซ้ำ
//   - dedup IP: ห้าม IP เดียวกันโหวตหลายชื่อ (กัน account ปลอม)
//   - บันทึก IP ใน vote_log → admin เห็น audit ได้
function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    return req.ip || req.connection?.remoteAddress || 'unknown';
}

router.post('/vote', async (req, res) => {
    try {
        const { barcode, username, vote, comment } = req.body || {};
        if (!barcode || !username || !['up', 'down'].includes(vote)) {
            return res.status(400).json({ success: false, message: 'กรุณาส่ง barcode, username และ vote (up|down)' });
        }

        const clientIp = getClientIp(req);
        const cfg = await getVotingConfig();   // ★ SPRINT 7

        const product = await Product.findOne({ barcode });
        if (!product) return res.status(404).json({ success: false, message: 'ไม่พบสินค้า' });

        // ★ SPRINT 7: หมดเวลาโหวตแล้ว → สรุปผลก่อน (อาจทำให้ไม่ใช่ pending แล้ว)
        if (finalizeIfWindowClosed(product, cfg)) {
            await product.save();
        }

        if (product.verification_status !== 'pending') {
            return res.status(400).json({ success: false, message: 'สินค้านี้ไม่ได้อยู่ในสถานะรอตรวจสอบ', status: product.verification_status });
        }
        if (product.submitted_by === username) {
            return res.status(400).json({ success: false, errorCode: 'OWN_SUBMISSION', message: 'ห้ามโหวตสินค้าที่ตนเองเพิ่ม' });
        }
        if (product.voters.includes(username)) {
            return res.status(400).json({ success: false, errorCode: 'ALREADY_VOTED', message: 'คุณได้โหวตสินค้านี้แล้ว' });
        }
        // ★ R4: IP-based dedup — กัน account ปลอมจาก IP เดียวกัน
        //   Demo override: ENV ALLOW_DUPLICATE_IP_VOTE=true → bypass (สำหรับเทสในเครื่องเดียว)
        const ipDedupBypass = process.env.ALLOW_DUPLICATE_IP_VOTE === 'true';
        if (!ipDedupBypass && clientIp !== 'unknown' && (product.ip_voters || []).includes(clientIp)) {
            return res.status(400).json({
                success: false,
                errorCode: 'IP_ALREADY_VOTED',
                message: 'IP นี้ได้โหวตสินค้านี้ไปแล้ว (กัน account ปลอม)',
            });
        }

        // ★ SPRINT 7: คำนวณ trust weight ของผู้โหวต
        const voter = await User.findOne({ username });
        const approvedContributions = voter
            ? await Product.countDocuments({ submitted_by: username, verification_status: 'approved' })
            : 0;
        const trust = computeUserTrust(voter, { approvedContributions });
        const weight = cappedWeight(trust.weight, cfg.maxWeight);

        // ★ SPRINT 7: เปิดหน้าต่างเวลาโหวตตอน vote แรก (Timer)
        const now = new Date();
        if (!product.vote_window_started_at) {
            product.vote_window_started_at = now;
            product.vote_window_ends_at    = new Date(now.getTime() + cfg.windowHours * 60 * 60 * 1000);
        }

        // ★ R4: load full doc แทน findOneAndUpdate เพื่อ append audit chain ได้
        product.voters.push(username);
        if (clientIp !== 'unknown' && !product.ip_voters.includes(clientIp)) {
            product.ip_voters.push(clientIp);
        }
        product.vote_log.push({
            username, vote, at: now,
            comment: comment || null,
            ip: clientIp,
            weight,                       // ★ SPRINT 7
            trust_level: trust.level,     // ★ SPRINT 7
            ...(ipDedupBypass && (product.ip_voters || []).filter(x => x === clientIp).length > 1 && { demo_bypass: true }),
        });
        // raw counters (backward compat) + weighted counters
        if (vote === 'up') { product.upvotes += 1; product.weighted_upvotes += weight; }
        else               { product.downvotes += 1; product.weighted_downvotes += weight; }

        // ★ DPSE-03 R4: append audit entry สำหรับ vote (รวม IP + weight)
        pushAuditAndScore(product, 'vote', username, { vote, comment: comment || null, ip: clientIp, weight, trust_level: trust.level });

        // ★ SPRINT 7: ตัดสินผลแบบ weighted + quorum
        const tally = tallyVotes(product);
        const outcome = evaluateOutcome(tally, cfg);

        let promoted = false;
        if (outcome.decision === 'approve') {
            product.verification_status   = 'community_approved';
            product.community_approved_at = now;
            product.vote_finalized_reason = outcome.reason;
            pushAuditAndScore(product, 'community_approve', 'system', { reason: outcome.reason, ...tally, quorum: cfg.quorum, approveWeight: cfg.approveWeight });
            promoted = true;
            console.log(`👥 Community approved (weighted): ${barcode} | up=${tally.weightedUp} down=${tally.weightedDown} voters=${tally.uniqueVoters}`);
        } else if (outcome.decision === 'reject') {
            product.verification_status   = 'rejected';
            product.vote_finalized_reason = outcome.reason;
            pushAuditAndScore(product, 'reject', 'system', { reason: outcome.reason, ...tally, quorum: cfg.quorum });
            console.log(`❌ Community rejected (weighted): ${barcode} | up=${tally.weightedUp} down=${tally.weightedDown}`);
        }

        await product.save();

        // เวลาที่เหลือใน window
        const secondsLeft = product.vote_window_ends_at
            ? Math.max(0, Math.floor((product.vote_window_ends_at - now) / 1000))
            : null;

        return res.json({
            success: true,
            message: vote === 'up' ? 'โหวตยืนยันเรียบร้อย' : 'โหวตปฏิเสธเรียบร้อย',
            verification_status: product.verification_status,
            // raw (backward compat)
            upvotes:   product.upvotes,
            downvotes: product.downvotes,
            // ★ SPRINT 7: weighted voting progress
            voter_trust: { level: trust.level, label: trust.label, weight },
            weighted_up:   tally.weightedUp,
            weighted_down: tally.weightedDown,
            unique_voters: tally.uniqueVoters,
            quorum:        cfg.quorum,
            approve_weight: cfg.approveWeight,
            quorum_met:    tally.uniqueVoters >= cfg.quorum,
            vote_window_ends_at: product.vote_window_ends_at,
            seconds_left:  secondsLeft,
            promoted,
            note: promoted ? 'ส่งต่อให้แอดมินตรวจสอบขั้นสุดท้าย' : (outcome.reason === 'awaiting_quorum' ? `รอผู้โหวตให้ครบ ${cfg.quorum} คน` : null),
        });
    } catch (err) {
        console.error('Vote Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ★ SPRINT 7: GET /api/products/vote-config — ให้ frontend แสดงกติกา (quorum/window/weights)
router.get('/vote-config', async (req, res) => {
    try {
        const cfg = await getVotingConfig();
        return res.json({ success: true, config: cfg });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ★ SPRINT 7: POST /api/products/finalize-expired-votes — สรุปผลทุกสินค้าที่หมดเวลาโหวต
//   เรียกจาก scheduled job หรือ admin manual — ลด bias จากการรอ vote ค้างนานเกินไป
router.post('/finalize-expired-votes', async (req, res) => {
    try {
        const cfg = await getVotingConfig();
        const now = new Date();
        const pendings = await Product.find({
            verification_status: 'pending',
            vote_window_ends_at: { $ne: null, $lte: now },
        });
        let approved = 0, rejected = 0, toAdmin = 0;
        for (const p of pendings) {
            if (finalizeIfWindowClosed(p, cfg, now)) {
                await p.save();
                if (p.verification_status === 'community_approved') approved++;
                else if (p.verification_status === 'rejected') rejected++;
                else if (p.needs_admin_review) toAdmin++;
            }
        }
        return res.json({ success: true, processed: pendings.length, approved, rejected, sentToAdmin: toAdmin });
    } catch (err) {
        console.error('finalize-expired-votes error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ★ DPSE-03 R4: System Status — admin ดู bypass mode ปัจจุบัน
router.get('/admin-review/system-status', (req, res) => {
    return res.json({
        ip_dedup_bypass: process.env.ALLOW_DUPLICATE_IP_VOTE === 'true',
        threshold: 3,
        node_env:  process.env.NODE_ENV || 'development',
    });
});

// ★ DPSE-03 R4: รายการสินค้าที่ชุมชนผ่านแล้ว รอ admin ตรวจขั้นสุดท้าย
//   sort: Tier 3 (FDA + photo) ขึ้นก่อน → admin ปล่อยได้เร็ว
router.get('/admin-review/list', async (req, res) => {
    try {
        const items = await Product.find({ verification_status: 'community_approved' })
            .sort({ verification_tier: -1, community_approved_at: 1 })   // tier สูง + เก่าก่อน
            .select('barcode name brand image_url ingredients sugar_g sodium_mg fat_g energy_kcal carbs_g protein_g upvotes downvotes voters vote_log submitted_by createdAt community_approved_at data_source verification_tier fda_number label_photo marketing_text');
        return res.json({ success: true, total: items.length, items });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ★ DPSE-03 R4: Admin Approve (Dual Sign-Off)
//   - สินค้าต้องมี admin 2 คน (ต่างกัน) approve → ถึงจะ approved จริง
//   - admin คนแรก approve → status คงเป็น community_approved + บันทึก review #1
//   - admin คนที่สอง (ต่าง username) approve → status = approved
// Body: { barcode, reviewer, note?, fdaVerified?: boolean }
router.post('/admin-review/approve', async (req, res) => {
    try {
        const { barcode, reviewer, note, fdaVerified } = req.body || {};
        if (!barcode || !reviewer) return res.status(400).json({ success: false, message: 'กรุณาส่ง barcode และ reviewer' });

        const product = await Product.findOne({ barcode });
        if (!product) return res.status(404).json({ success: false, message: 'ไม่พบสินค้า' });
        if (!['community_approved', 'pending'].includes(product.verification_status)) {
            return res.status(400).json({ success: false, message: 'สินค้านี้ไม่ได้อยู่ในคิว admin review', status: product.verification_status });
        }

        // ★ DPSE-03 R4: เช็คว่า admin คนนี้เคย approve แล้วหรือยัง — ป้องกัน admin คนเดียวกด 2 ครั้ง
        const existingApprovals = (product.admin_reviews || []).filter(r => r.decision === 'approve');
        if (existingApprovals.some(r => r.admin === reviewer)) {
            return res.status(400).json({
                success: false,
                errorCode: 'ALREADY_SIGNED',
                message: `คุณ (${reviewer}) เคย approve สินค้านี้ไปแล้ว ต้องรอ admin คนอื่นมา sign อีก 1 คน`,
                signedAdmins: existingApprovals.map(r => r.admin),
            });
        }

        // บันทึก review นี้
        product.admin_reviews.push({
            admin:        reviewer,
            decision:     'approve',
            at:           new Date(),
            note:         note || null,
            fda_verified: !!fdaVerified,
        });

        // ★ FDA verified flag
        if (fdaVerified && !product.fda_verified_at) {
            product.fda_verified_at = new Date();
            product.fda_verified_by = reviewer;
            pushAuditAndScore(product, 'fda_verify', reviewer, { fda_number: product.fda_number });
        }

        // append audit entry สำหรับ admin sign-off
        pushAuditAndScore(product, 'admin_sign', reviewer, {
            decision: 'approve', note: note || null, fda_verified: !!fdaVerified,
        });

        const approvedCount = product.admin_reviews.filter(r => r.decision === 'approve').length;
        const FINAL_THRESHOLD = 2;   // ★ ต้องการ 2 admins

        if (approvedCount >= FINAL_THRESHOLD) {
            // Final approval
            product.verification_status = 'approved';
            product.approved_at         = new Date();
            product.approved_by         = 'admin';
            product.admin_reviewed_at   = new Date();
            product.admin_reviewer      = reviewer;
            product.admin_review_note   = note || null;
            if (product.verification_tier < 3) product.verification_tier = 3;
            pushAuditAndScore(product, 'finalize', 'system', {
                final_admin: reviewer,
                approvals: product.admin_reviews.filter(r => r.decision === 'approve').map(r => r.admin),
            });
            await product.save();
            console.log(`✅ FINAL approved: ${barcode} by ${reviewer} (dual sign-off complete)`);
            return res.json({
                success: true,
                final:   true,
                message: `อนุมัติขั้นสุดท้ายเรียบร้อย (มี admin ${approvedCount} คนเห็นด้วย)`,
                product,
            });
        }

        // ยังไม่ครบ 2 คน — บันทึกไว้แต่ยังไม่ approved
        await product.save();
        console.log(`☑️ First admin sign-off: ${barcode} by ${reviewer} (รอ admin คนที่ 2)`);
        return res.json({
            success: true,
            final:   false,
            message: `Sign-off คนที่ ${approvedCount}/${FINAL_THRESHOLD} แล้ว — รอ admin อีก ${FINAL_THRESHOLD - approvedCount} คนยืนยัน`,
            product,
            signedAdmins: product.admin_reviews.filter(r => r.decision === 'approve').map(r => r.admin),
        });
    } catch (err) {
        console.error('Admin Approve Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ★ DPSE-03 R4: Mark FDA Verified — admin คลิกเปิดเว็บ อย. ตรวจสายตาแล้วยืนยัน
//   ไม่ต้องรอจน approve final — flag นี้ส่งผลต่อ trust_score ทันที
// Body: { barcode, reviewer }
router.post('/admin-review/fda-verify', async (req, res) => {
    try {
        const { barcode, reviewer } = req.body || {};
        if (!barcode || !reviewer) return res.status(400).json({ success: false, message: 'กรุณาส่ง barcode และ reviewer' });

        const product = await Product.findOne({ barcode });
        if (!product) return res.status(404).json({ success: false, message: 'ไม่พบสินค้า' });
        if (!product.fda_number) return res.status(400).json({ success: false, message: 'สินค้านี้ไม่มีเลข อย. ให้ตรวจ' });

        product.fda_verified_at = new Date();
        product.fda_verified_by = reviewer;
        pushAuditAndScore(product, 'fda_verify', reviewer, { fda_number: product.fda_number });
        await product.save();

        console.log(`🏛️ FDA verified: ${barcode} by ${reviewer}`);
        return res.json({ success: true, message: 'บันทึกว่าตรวจสอบกับ อย. แล้ว', trust_score: product.trust_score });
    } catch (err) {
        console.error('FDA Verify Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ★ DPSE-03 R4: Admin Reject — ปฏิเสธสินค้า (ข้อมูลผิด/ปลอม)
// Body: { barcode, reviewer, note }
router.post('/admin-review/reject', async (req, res) => {
    try {
        const { barcode, reviewer, note } = req.body || {};
        if (!barcode || !reviewer) return res.status(400).json({ success: false, message: 'กรุณาส่ง barcode และ reviewer' });

        const product = await Product.findOne({ barcode });
        if (!product) return res.status(404).json({ success: false, message: 'ไม่พบสินค้า' });
        if (!['community_approved', 'pending'].includes(product.verification_status)) {
            return res.status(400).json({ success: false, message: 'สินค้านี้ไม่ได้อยู่ในคิว admin review', status: product.verification_status });
        }

        // ★ R4: บันทึก rejection ใน admin_reviews
        product.admin_reviews.push({
            admin:    reviewer,
            decision: 'reject',
            at:       new Date(),
            note:     note || 'ปฏิเสธโดยแอดมิน',
        });
        product.verification_status = 'rejected';
        product.admin_reviewed_at   = new Date();
        product.admin_reviewer      = reviewer;
        product.admin_review_note   = note || 'ปฏิเสธโดยแอดมิน';
        pushAuditAndScore(product, 'admin_sign', reviewer, { decision: 'reject', note: note || null });
        pushAuditAndScore(product, 'reject', 'system', { reason: 'admin_decision', note: note || null });
        await product.save();

        console.log(`❌ Admin rejected: ${barcode} by ${reviewer} — ${note || '-'}`);
        return res.json({ success: true, message: 'ปฏิเสธสินค้าเรียบร้อย', product });
    } catch (err) {
        console.error('Admin Reject Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ★ DPSE-03 R4: PUBLIC Audit Endpoint — ใครก็เข้าดูได้ ไม่ต้องล็อกอิน
//   ใช้สำหรับ public audit page ที่ /verify/:barcode บนแอป
//   แสดงทุก step ของการตรวจสอบ + verify hash chain ว่าไม่ถูก tamper
router.get('/audit/:barcode', async (req, res) => {
    try {
        const product = await Product.findOne({ barcode: req.params.barcode })
            .select('barcode name brand image_url submitted_by createdAt verification_status verification_tier data_source fda_number fda_verified_at fda_verified_by label_photo upvotes downvotes voters vote_log admin_reviews community_approved_at audit_chain trust_score trust_breakdown approved_at admin_reviewed_at admin_reviewer');

        if (!product) return res.status(404).json({ success: false, message: 'ไม่พบสินค้า' });

        // verify chain ทุกครั้งที่ดึง — ตรวจ tamper
        const integrity = verifyChain(product.audit_chain || []);

        // recompute score ปัจจุบัน (เผื่อ cache stale)
        const { score, breakdown, label } = computeTrustScore(product);

        return res.json({
            success: true,
            product: {
                barcode:               product.barcode,
                name:                  product.name,
                brand:                 product.brand,
                image_url:             product.image_url,
                submitted_by:          product.submitted_by,
                createdAt:             product.createdAt,
                verification_status:   product.verification_status,
                verification_tier:     product.verification_tier,
                data_source:           product.data_source,
                fda_number:            product.fda_number,
                fda_verified_at:       product.fda_verified_at,
                fda_verified_by:       product.fda_verified_by,
                label_photo:           product.label_photo,
                upvotes:               product.upvotes,
                downvotes:             product.downvotes,
                community_approved_at: product.community_approved_at,
                approved_at:           product.approved_at,
            },
            community_votes: product.vote_log || [],
            admin_reviews:   product.admin_reviews || [],
            audit_chain:     product.audit_chain || [],
            integrity,
            trust: { score, breakdown, label },
        });
    } catch (err) {
        console.error('Audit Endpoint Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// ค้นหาสินค้า (ระบบ Cache & Fallback)
// ==========================================
router.get('/:barcode', async (req, res) => {
    const { barcode } = req.params;

    try {
        // 1. ค้นหาใน Local Database ของเราก่อน (Cache Hit)
        const localProduct = await Product.findOne({ barcode: barcode });
        
        if (localProduct) {
            console.log(`📦 [CACHE HIT] ดึงข้อมูลจาก Local DB: ${barcode}`);
            return res.status(200).json(localProduct);
        }

        // 2. ถ้าไม่เจอ ให้ดึงจาก OpenFoodFacts (Cache Miss)
        console.log(`🌐 [CACHE MISS] กำลังค้นหาจาก OpenFoodFacts: ${barcode}`);
        
        // ใส่ Timeout ให้ Backend 5 วินาที กันเซิร์ฟเวอร์ค้าง
        const offResponse = await axios.get(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`, { timeout: 10000 });
        
        if (offResponse.data.status === 1) {
            const p = offResponse.data.product;

            // คำนวณโซเดียม
            let sodium_value = 0;
            if (p.nutriments?.sodium) sodium_value = parseFloat(p.nutriments.sodium) * 1000;
            else if (p.nutriments?.salt) sodium_value = (parseFloat(p.nutriments.salt) / 2.5) * 1000;

            // คลีนข้อมูลส่วนผสม
            let cleanIngredients = ["No Data"];
            if (p.ingredients_tags && p.ingredients_tags.length > 0) {
                cleanIngredients = p.ingredients_tags.map(tag => tag.replace(/^[a-z]{2}:/, '').replace(/-/g, ' '));
            }

            const isEcoFriendly = p.ecoscore_grade === 'a' || p.ecoscore_grade === 'b' || p.nutriscore_grade === 'a' || p.nutriscore_grade === 'b';

            // 3. จัด Format ให้ตรงกับ Schema ของเรา
            // 🔧 FIX: ต้อง trim() ก่อน เพราะ OpenFoodFacts อาจคืนค่า "" (string ว่าง)
            //         ซึ่ง "" เป็น truthy ใน JS ทำให้ fallback ไม่ทำงาน
            const resolvedName = 
                (p.product_name?.trim())       ||
                (p.product_name_th?.trim())    ||
                (p.product_name_en?.trim())    ||
                (p.abbreviated_product_name?.trim()) ||
                null;

            const newProductData = {
                barcode: barcode,
                name: resolvedName || "Unknown Product",
                brand: p.brands?.trim() || p.brand_owner?.trim() || "Unknown Brand",
                image_url: p.image_url || p.image_front_url || p.image_front_small_url || null,
                marketing_text: p.ingredients_text || "No description available.",
                earned: isEcoFriendly ? 30 : 15,
                sugar_g: p.nutriments?.sugars ? parseFloat(p.nutriments.sugars) : 0,
                sodium_mg: Math.round(sodium_value),
                fat_g: p.nutriments?.fat ? parseFloat(p.nutriments.fat) : 0,
                ingredients: cleanIngredients,
                is_green: isEcoFriendly,
                packaging_type: p.packaging_tags ? p.packaging_tags.join(', ') : "Unknown",
                // ★ DPSE-03 R4: tag ที่มาของข้อมูล → tier 2 (semi-verified จากฐานข้อมูลสากล)
                data_source:         'openfoodfacts',
                verification_tier:   2,
                verification_status: 'approved',
            };

            // 🔧 FIX: ถ้าชื่อสินค้ายังไม่มีหลังดึงจาก OpenFoodFacts ให้ return 404
            //         เพื่อให้ Frontend แสดง popup "ไม่พบสินค้า" และไปหน้า AddProduct แทน
            if (!resolvedName) {
                return res.status(404).json({ message: "ไม่พบชื่อสินค้านี้ในฐานข้อมูลสากล กรุณาเพิ่มข้อมูลเอง" });
            }

            // 4. บันทึกลง Database ของเรา (Save Cache)
            const newProduct = new Product(newProductData);
            const savedProduct = await newProduct.save();

            console.log(`✅ [CACHE SAVED] บันทึกข้อมูลใหม่ลง DB สำเร็จ: ${barcode}`);
            return res.status(200).json(savedProduct);

        } else {
            // กรณี OpenFoodFacts ก็ไม่มีข้อมูลนี้
            return res.status(404).json({ message: "ไม่พบข้อมูลสินค้านี้ในระบบและฐานข้อมูลสากล" });
        }

    } catch (err) {
        console.error("💥 Error Fetching Product:", err.message);
        // กรณีเชื่อมต่อ OpenFoodFacts ล้มเหลว หรือ Timeout
        res.status(500).json({ message: "ระบบขัดข้อง หรือเชื่อมต่อฐานข้อมูลล้มเหลว", error: err.message });
    }
});

module.exports = router;
// ★ SPRINT 7: expose voting internals ให้ scheduled job (voteFinalizeJob) ใช้ logic เดียวกัน
module.exports._voteInternals = { getVotingConfig, tallyVotes, evaluateOutcome, finalizeIfWindowClosed };