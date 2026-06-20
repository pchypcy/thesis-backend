// jobs/voteFinalizeJob.js — InGreen Sprint 7
//
// ★ Timer enforcement สำหรับ Weighted Product Voting
//   สรุปผลโหวตสินค้าที่ "หมดเวลา" (vote_window_ends_at < now) อัตโนมัติ
//   แม้ไม่มีใครเข้ามาโหวต/อ่านเพิ่ม — กันสินค้าค้างใน pending ตลอดกาล
//
// ทำงานทุกรอบ (default 30 นาที — config VOTE_FINALIZE_JOB_INTERVAL_MIN)
// ใช้ logic เดียวกับ POST /api/products/finalize-expired-votes
//
// ไม่ใช้ external cron — setInterval ภายใน process (เริ่มใน server.js หลัง mongo connect)

const Product = require('../models/Product');
const { getConfig } = require('../routes/config');
// re-use finalize logic ที่ export จาก products route
const { _voteInternals } = require('../routes/products');

let _isRunning = false;
let _lastRun = null;
let _timer = null;

async function runVoteFinalize(trigger = 'interval') {
    if (_isRunning) return { skipped: true };
    if (!_voteInternals) return { error: 'vote internals unavailable' };
    _isRunning = true;
    const startedAt = new Date();
    try {
        const cfg = await _voteInternals.getVotingConfig();
        const now = new Date();
        const pendings = await Product.find({
            verification_status: 'pending',
            vote_window_ends_at: { $ne: null, $lte: now },
        });

        let approved = 0, rejected = 0, toAdmin = 0;
        for (const p of pendings) {
            if (_voteInternals.finalizeIfWindowClosed(p, cfg, now)) {
                await p.save();
                if (p.verification_status === 'community_approved') approved++;
                else if (p.verification_status === 'rejected') rejected++;
                else if (p.needs_admin_review) toAdmin++;
            }
        }

        const summary = {
            ranAt: startedAt.toISOString(), trigger,
            processed: pendings.length, approved, rejected, sentToAdmin: toAdmin,
            durationMs: Date.now() - startedAt.getTime(),
        };
        _lastRun = summary;
        if (pendings.length) console.log('✅ [vote-finalize] run done:', JSON.stringify(summary));
        return summary;
    } catch (err) {
        console.error('❌ [vote-finalize] run failed:', err);
        return { error: err.message };
    } finally {
        _isRunning = false;
    }
}

async function startVoteFinalizeScheduler() {
    if (_timer) return;
    const intervalMin = await getConfig('VOTE_FINALIZE_JOB_INTERVAL_MIN', 30);
    const intervalMs  = Math.max(1, Number(intervalMin)) * 60 * 1000;
    console.log(`🗓️  [vote-finalize] scheduler started — every ${intervalMin} min`);
    runVoteFinalize('startup');
    _timer = setInterval(() => runVoteFinalize('interval'), intervalMs);
    if (_timer.unref) _timer.unref();
}

function getLastRun() { return _lastRun; }

module.exports = { runVoteFinalize, startVoteFinalizeScheduler, getLastRun };
