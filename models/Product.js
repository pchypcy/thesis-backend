const mongoose = require('mongoose');

// 🎯 ฟังก์ชันปัดเศษทศนิยม 2 ตำแหน่ง
const roundData = (val) => val ? Math.round(val * 100) / 100 : 0;

const ProductSchema = new mongoose.Schema({
    barcode: { type: String, required: true, unique: true }, 
    name: { type: String, required: true }, 
    brand: String, 
    image_url: String, 
    
    marketing_text: { type: String, default: "No description available." },
    earned: { type: Number, default: 0 },      //Point
    
    // 🎯 ใส่ set: roundData ให้กับฟิลด์ตัวเลขโภชนาการทั้งหมด
    sugar_g: { type: Number, default: 0, set: roundData },     //Health Shield 
    sodium_mg: { type: Number, default: 0, set: roundData },   
    fat_g: { type: Number, default: 0, set: roundData },   
    
    // (เพิ่มเผื่อไว้สำหรับโชว์ในหน้า Result)
    energy_kcal: { type: Number, default: 0, set: roundData },
    carbs_g: { type: Number, default: 0, set: roundData },
    protein_g: { type: Number, default: 0, set: roundData },    

    ingredients: [String], 
    ins_numbers: [String], 
    
    health_risk_level: {
        type: String,
        enum: ['Safe', 'Caution', 'Risk'],
        default: 'Safe'
    },
    is_green: { type: Boolean, default: false },
    green_message: String,
    packaging_type: String,

    // ★ SPRINT 5: Crowdsource verification (Wikipedia-style)
    //   - approved          : ผ่านการรับรองครบ → แสดงปกติ (จาก OFF / admin review / seed)
    //   - pending           : user submitted ใหม่ รอชุมชน vote
    //   - community_approved: ★ DPSE-03 R4 ใหม่ — ชุมชน vote ผ่านแล้ว แต่รอ admin ตรวจขั้นสุดท้าย
    //   - rejected          : ชุมชน vote down หรือ admin ปฏิเสธ
    verification_status: {
        type: String,
        enum: ['approved', 'pending', 'community_approved', 'rejected'],
        default: 'approved',
    },
    submitted_by: { type: String, default: null },          // username ผู้เพิ่มข้อมูล
    upvotes:      { type: Number, default: 0 },              // ดิบ (1 คน 1 เสียง — เก็บไว้ backward compat)
    downvotes:    { type: Number, default: 0 },

    // ★ SPRINT 7: Weighted Voting — คะแนนถ่วงน้ำหนักตาม trust level ของผู้โหวต
    weighted_upvotes:   { type: Number, default: 0 },
    weighted_downvotes: { type: Number, default: 0 },

    // ★ SPRINT 7: Vote Timer — หน้าต่างเวลาเปิดโหวต (set ตอน vote แรก)
    vote_window_started_at: { type: Date, default: null },
    vote_window_ends_at:    { type: Date, default: null },
    // เหตุผลการสรุปผล (audit): 'weighted_quorum' | 'window_majority' | 'community_downvote' | 'insufficient_quorum'
    vote_finalized_reason:  { type: String, default: null },
    // flag: หมดเวลาแล้วแต่ quorum ไม่ถึง → ส่งให้ admin ตัดสิน (กัน auto-reject สินค้าดีเพราะคนโหวตน้อย)
    needs_admin_review:     { type: Boolean, default: false },

    voters:       { type: [String], default: [] },          // username[] กัน vote ซ้ำ
    // ★ DPSE-03 R4: IP-based dedup — กัน account ปลอมโหวตรัวๆ จาก IP เดียวกัน
    //   ปกติ admin ตรวจดูได้ — ถ้า IP เดียวกันโหวต 3 ครั้ง คือ suspicious แล้ว
    ip_voters:    { type: [String], default: [] },
    approved_at:  { type: Date,    default: null },
    approved_by:  { type: String,  default: null },         // 'crowdsource' | 'admin' | 'system'

    // ★ DPSE-03 R4: Audit Trail — เก็บประวัติการ vote แบบมี timestamp + IP
    //   ทุก vote จะ append เข้าที่นี่ → admin/user เห็นได้ว่าใครยืนยัน จากที่ไหน เมื่อไหร่
    vote_log: {
        type: [{
            username:    { type: String, required: true },
            vote:        { type: String, enum: ['up', 'down'], required: true },
            at:          { type: Date,   default: Date.now },
            comment:     { type: String, default: null },
            ip:          { type: String, default: null },     // ★ R4: IP ของ voter (สำหรับ audit)
            demo_bypass: { type: Boolean, default: false },   // ★ R4: tag ว่า vote นี้ใช้ demo bypass
            // ★ SPRINT 7: น้ำหนัก + trust level ของผู้โหวต ณ ตอนที่โหวต (เก็บ snapshot)
            weight:      { type: Number, default: 1 },
            trust_level: { type: Number, default: 1 },
        }],
        default: [],
    },

    // ★ DPSE-03 R4: Community approval (ด่าน 1)
    community_approved_at: { type: Date, default: null },

    // ★ DPSE-03 R4: Admin Review (ด่าน 2 — ตัดสินสุดท้าย)
    //   legacy single-admin fields (เก็บไว้ backward compat)
    admin_reviewed_at:  { type: Date,   default: null },
    admin_reviewer:     { type: String, default: null },   // admin username/id
    admin_review_note:  { type: String, default: null },   // เหตุผลการ approve/reject

    // ★ DPSE-03 R4: Dual Sign-Off — สินค้าต้องมี admin 2 คนเห็นด้วย
    //   ป้องกัน admin คนเดียวคอร์รัปต์ (4-eye principle)
    admin_reviews: {
        type: [{
            admin:    { type: String, required: true },
            decision: { type: String, enum: ['approve', 'reject'], required: true },
            at:       { type: Date,   default: Date.now },
            note:     { type: String, default: null },
            fda_verified: { type: Boolean, default: false },  // ติ๊กว่าตรวจกับเว็บ อย. แล้ว
        }],
        default: [],
    },

    // ★ DPSE-03 R4: FDA Government Verification
    //   admin คลิกเปิดเว็บ อย. แล้วยืนยันว่าตรงจริง
    fda_verified_at:  { type: Date,   default: null },
    fda_verified_by:  { type: String, default: null },

    // ★ DPSE-03 R4: Audit Chain (blockchain-style hash chain)
    //   ทุก action สร้าง SHA-256 hash ที่ผูกกับ hash ก่อนหน้า
    //   แก้ย้อนหลังไม่ได้ — เปลี่ยน 1 record ทำให้ chain ทั้งหมดเสีย
    audit_chain: {
        type: [{
            seq:       { type: Number, required: true },        // ลำดับใน chain
            action:    { type: String, required: true },         // 'submit'|'vote'|'community_approve'|'admin_sign'|'fda_verify'|'reject'|'finalize'
            actor:     { type: String, required: true },         // ใครทำ
            at:        { type: Date,   default: Date.now },
            payload:   { type: mongoose.Schema.Types.Mixed },    // ข้อมูลของ action
            prev_hash: { type: String, default: null },          // hash ของ entry ก่อนหน้า
            hash:      { type: String, required: true },         // hash ของ entry นี้
        }],
        default: [],
    },

    // ★ DPSE-03 R4: Cached Trust Score (0-100)
    //   คำนวณใหม่ทุกครั้งที่มีการเปลี่ยนแปลง — เก็บ cache เพื่อแสดงเร็ว
    trust_score: { type: Number, default: 0, min: 0, max: 100 },
    trust_breakdown: {
        type: mongoose.Schema.Types.Mixed,
        default: () => ({}),                                     // { off_match: 25, fda_format: 15, ... }
    },

    // ★ DPSE-03 R4: Data-source provenance — แสดงให้ผู้ใช้/กรรมการเห็น
    //   ว่าข้อมูลแต่ละชิ้นมาจากแหล่งไหน เพื่อสร้างความน่าเชื่อถือ
    //   • openfoodfacts → auto-fetch จาก OFF (semi-verified)
    //   • fda_thailand  → user กรอกพร้อมเลขสารบบอาหาร อย. ที่ผ่าน format check
    //   • community     → user กรอกเอง + ผ่านชุมชน vote
    //   • admin         → admin ตรวจสอบเอง
    //   • seed          → mock data ตอน setup
    data_source: {
        type: String,
        enum: ['openfoodfacts', 'fda_thailand', 'community', 'admin', 'seed'],
        default: 'community',
    },

    // ★ DPSE-03 R4: Verification Tier — ใช้แสดง badge ใน UI
    //   tier 1 = unverified  (ไม่มี อย./ไม่มีรูป → รอ vote)
    //   tier 2 = semi        (มี อย. format ถูก หรือ มีรูปฉลาก หรือ มาจาก OFF)
    //   tier 3 = verified    (มีทั้ง อย. + รูปฉลาก, หรือ admin approve, หรือ vote ครบ)
    verification_tier: {
        type: Number,
        enum: [1, 2, 3],
        default: 1,
    },

    // ★ DPSE-03 R4: เลขสารบบอาหาร อย. (FDA Thailand reference number)
    //   รูปแบบมาตรฐาน: XX-X-XXXXX-X-XXXX (เช่น 10-1-12345-1-0001)
    //   ตรวจสอบที่: https://oryor.com (Thai FDA Public Lookup)
    fda_number: {
        type: String,
        default: null,
        validate: {
            validator: (v) => v == null || /^\d{2}-\d{1}-\d{5}-\d{1}-\d{4}$/.test(v),
            message: 'เลข อย. ต้องเป็นรูปแบบ XX-X-XXXXX-X-XXXX',
        },
    },

    // ★ DPSE-03 R4: รูปฉลากสินค้า (เป็นหลักฐาน)
    //   เก็บเป็น Base64 data URL หรือ external URL
    //   (ใน production ควรใช้ S3/Cloudinary แทน)
    label_photo: { type: String, default: null },

}, { timestamps: true });

ProductSchema.index({ verification_status: 1 });

module.exports = mongoose.model('Product', ProductSchema);