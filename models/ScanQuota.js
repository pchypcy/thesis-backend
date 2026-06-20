// models/ScanQuota.js — InGreen Sprint 5 (AI Receipt Scan Rate Limit)
//
// เก็บโควต้าการใช้งาน AI scan ใบเสร็จต่อ user ต่อวัน
// Logic:
//   - VIP        → 20 ครั้ง/วัน
//   - Free user  → 1 ครั้ง/2 วัน (50%/วัน เฉลี่ย)
//
// ใช้ count + lastReset แบบ rolling window 2 วันสำหรับ free user
// VIP ใช้ dateKey + count → reset ทุกเที่ยงคืน Bangkok

const mongoose = require('mongoose');

function getBangkokDateKey(date = new Date()) {
    return new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }))
        .toISOString()
        .slice(0, 10);
}

const ScanQuotaSchema = new mongoose.Schema({
    username: { type: String, required: true, index: true },
    feature:  { type: String, required: true, default: 'ai_receipt' }, // เผื่อขยายฟีเจอร์อื่น
    dateKey:  { type: String, required: true },                         // YYYY-MM-DD Bangkok

    count:    { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },

    // Free user 1 ครั้ง/2 วัน — ใช้ rolling timestamp
    // ถ้า now - lastUsedAt < 48h → reject
    coolingUntil: { type: Date, default: null },
}, { timestamps: true });

ScanQuotaSchema.index({ username: 1, feature: 1, dateKey: 1 }, { unique: true });

/**
 * tryConsume(username, isVip, limits) — atomic check+inc
 *   - VIP    : limits.vipPerDay (default 20)
 *   - Free   : limits.freeCoolHours (default 48)
 *
 * คืน { ok, reason, remaining, retryAfter (sec) }
 */
ScanQuotaSchema.statics.tryConsume = async function(username, isVip, limits = {}) {
    const vipPerDay     = Number(limits.vipPerDay     || 20);
    const freeCoolHours = Number(limits.freeCoolHours || 48);
    const now           = new Date();
    const dateKey       = getBangkokDateKey(now);

    // ── VIP path: count per day ────────────────────────────────────────────
    if (isVip) {
        const doc = await this.findOneAndUpdate(
            { username, feature: 'ai_receipt', dateKey },
            { $setOnInsert: { username, feature: 'ai_receipt', dateKey, count: 0 } },
            { upsert: true, new: true }
        );

        if (doc.count >= vipPerDay) {
            const tomorrow = new Date(now);
            tomorrow.setHours(24, 0, 0, 0);
            return {
                ok:         false,
                reason:     'VIP_DAILY_LIMIT',
                limit:      vipPerDay,
                used:       doc.count,
                remaining:  0,
                retryAfter: Math.ceil((tomorrow - now) / 1000),
            };
        }

        // Atomic increment
        const updated = await this.findOneAndUpdate(
            { username, feature: 'ai_receipt', dateKey, count: { $lt: vipPerDay } },
            { $inc: { count: 1 }, $set: { lastUsedAt: now } },
            { new: true }
        );

        if (!updated) {
            // race lost — try one more time with current count
            return { ok: false, reason: 'VIP_DAILY_LIMIT', limit: vipPerDay, used: vipPerDay, remaining: 0, retryAfter: 86400 };
        }

        return {
            ok:        true,
            isVip:     true,
            limit:     vipPerDay,
            used:      updated.count,
            remaining: Math.max(0, vipPerDay - updated.count),
        };
    }

    // ── Free path: 1 ครั้ง / freeCoolHours ────────────────────────────────
    // เก็บ doc เดียวต่อ user ต่อ feature (dateKey เป็น 'free-window')
    const FREE_KEY = 'free-window';
    const doc = await this.findOne({ username, feature: 'ai_receipt', dateKey: FREE_KEY });

    if (doc && doc.coolingUntil && doc.coolingUntil > now) {
        const secs = Math.ceil((doc.coolingUntil - now) / 1000);
        return {
            ok:         false,
            reason:     'FREE_COOLING',
            limit:      1,
            used:       1,
            remaining:  0,
            retryAfter: secs,
            nextAvailableAt: doc.coolingUntil.toISOString(),
            hint:       'อัปเกรด VIP เพื่อสแกนได้ 20 ครั้ง/วัน',
        };
    }

    const coolingUntil = new Date(now.getTime() + freeCoolHours * 3600 * 1000);
    await this.findOneAndUpdate(
        { username, feature: 'ai_receipt', dateKey: FREE_KEY },
        {
            $setOnInsert: { username, feature: 'ai_receipt', dateKey: FREE_KEY },
            $set:         { lastUsedAt: now, coolingUntil, count: 1 },
        },
        { upsert: true, new: true }
    );

    return {
        ok:        true,
        isVip:     false,
        limit:     1,
        used:      1,
        remaining: 0,
        nextAvailableAt: coolingUntil.toISOString(),
        hint:      'ผู้ใช้ Free ใช้ได้ 1 ครั้ง/2 วัน — อัปเกรด VIP เพื่อใช้ได้ 20 ครั้ง/วัน',
    };
};

ScanQuotaSchema.statics.getStatus = async function(username, isVip, limits = {}) {
    const vipPerDay     = Number(limits.vipPerDay     || 20);
    const freeCoolHours = Number(limits.freeCoolHours || 48);
    const now           = new Date();

    if (isVip) {
        const dateKey = getBangkokDateKey(now);
        const doc = await this.findOne({ username, feature: 'ai_receipt', dateKey });
        const used = doc?.count || 0;
        return {
            isVip:     true,
            limit:     vipPerDay,
            used,
            remaining: Math.max(0, vipPerDay - used),
        };
    }

    const doc = await this.findOne({ username, feature: 'ai_receipt', dateKey: 'free-window' });
    if (doc?.coolingUntil && doc.coolingUntil > now) {
        return {
            isVip:     false,
            limit:     1,
            used:      1,
            remaining: 0,
            nextAvailableAt: doc.coolingUntil.toISOString(),
            cooldownHours:   freeCoolHours,
        };
    }
    return {
        isVip:     false,
        limit:     1,
        used:      0,
        remaining: 1,
        cooldownHours: freeCoolHours,
    };
};

module.exports = mongoose.model('ScanQuota', ScanQuotaSchema);
module.exports.getBangkokDateKey = getBangkokDateKey;
