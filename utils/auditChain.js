// utils/auditChain.js — DPSE-03 R4
//
// Blockchain-style audit log: ทุก action ที่เกิดกับสินค้า สร้าง SHA-256 hash
// ที่ผูกกับ hash ของ entry ก่อนหน้า เป็น chain
//
// ผลคือ: ถ้ามีคนเปลี่ยนข้อมูลของ entry เก่าย้อนหลัง → hash จะไม่ตรง
//        → ตรวจจับการ tampering ได้ทันที (tamper-evident)
//
// ไม่ใช่ blockchain จริง (ไม่มี consensus, ไม่มี decentralization)
// แต่ให้คุณสมบัติเดียวกัน: integrity verification

const crypto = require('crypto');

/**
 * สร้าง hash สำหรับ audit entry
 * payload + actor + at + prev_hash → SHA-256
 */
function computeHash({ seq, action, actor, at, payload, prev_hash }) {
    const canonical = JSON.stringify({
        seq,
        action,
        actor,
        at: new Date(at).toISOString(),
        payload: payload || null,
        prev_hash: prev_hash || null,
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Append entry ใหม่เข้า chain
 * @param {Array} chain — array of existing audit entries
 * @param {Object} entry — { action, actor, payload }
 * @returns {Object} new entry พร้อม seq + prev_hash + hash
 */
function appendEntry(chain, { action, actor, payload }) {
    const last = chain.length > 0 ? chain[chain.length - 1] : null;
    const seq = (last?.seq ?? 0) + 1;
    const prev_hash = last?.hash || null;
    const at = new Date();

    const hash = computeHash({ seq, action, actor, at, payload, prev_hash });

    return { seq, action, actor, at, payload, prev_hash, hash };
}

/**
 * Verify ทั้ง chain ว่ายังไม่ถูก tamper
 * @returns {{ valid: boolean, brokenAt: number|null, total: number }}
 */
function verifyChain(chain) {
    if (!Array.isArray(chain) || chain.length === 0) {
        return { valid: true, brokenAt: null, total: 0 };
    }

    for (let i = 0; i < chain.length; i++) {
        const entry = chain[i];
        const expectedPrevHash = i === 0 ? null : chain[i - 1].hash;

        // เช็ค prev_hash ตรงกับ hash ของ entry ก่อนหน้า
        if (entry.prev_hash !== expectedPrevHash) {
            return { valid: false, brokenAt: i, total: chain.length, reason: 'prev_hash mismatch' };
        }

        // recompute hash จาก content แล้วเทียบ
        const recomputed = computeHash({
            seq:       entry.seq,
            action:    entry.action,
            actor:     entry.actor,
            at:        entry.at,
            payload:   entry.payload,
            prev_hash: entry.prev_hash,
        });

        if (recomputed !== entry.hash) {
            return { valid: false, brokenAt: i, total: chain.length, reason: 'content modified' };
        }
    }

    return { valid: true, brokenAt: null, total: chain.length };
}

module.exports = { computeHash, appendEntry, verifyChain };
