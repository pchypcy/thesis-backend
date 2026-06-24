// models/ConsentGrant.js — Green Profile API (DPSE-03)
//
// "ความยินยอม" 1 ใบ = ผู้ใช้ 1 คน อนุญาตให้ partner 1 ราย เข้าถึงข้อมูลบาง scope
//   - consent_token : รหัสจับคู่ที่ partner ต้องแนบมาทุกครั้ง (X-Consent-Token / body.consent_token)
//   - status        : active = ใช้ได้, revoked = ผู้ใช้เพิกถอนแล้ว (partner เรียกไม่ได้ทันที)
//   - access_log     : บันทึกทุกครั้งที่ partner เข้าถึง — ผูกเป็น hash chain (tamper-evident)
//                      ใช้ utils/auditChain.js ตัวเดียวกับ Public Audit ของสินค้า
//
// แนวคิดตรงกับสไลด์: OAuth / Consent Management + Audit Log
// ผู้ใช้คุมเองว่าให้ใครเห็นอะไร และถอนได้ตลอดเวลา

const mongoose = require('mongoose');

const ConsentGrantSchema = new mongoose.Schema({
    username:      { type: String, required: true, index: true },
    partner_slug:  { type: String, required: true, index: true },

    scopes:        { type: [String], default: [] },

    consent_token: { type: String, required: true, unique: true, index: true },
    status:        { type: String, enum: ['active', 'revoked'], default: 'active' },

    last_access_at: { type: Date,   default: null },
    access_count:   { type: Number, default: 0 },

    // hash-chained audit entries: { seq, action, actor, at, payload, prev_hash, hash }
    access_log:     { type: Array,  default: [] },
}, { timestamps: true });

// 1 user : 1 partner = 1 grant (re-grant คือ update ใบเดิม)
ConsentGrantSchema.index({ username: 1, partner_slug: 1 }, { unique: true });

module.exports = mongoose.model('ConsentGrant', ConsentGrantSchema);
