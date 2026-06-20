// utils/userTrust.js — InGreen Sprint 7
//
// ★ Trust Level ของผู้ใช้ → ใช้ถ่วงน้ำหนักการโหวตสินค้า (Weighted Voting)
//
// เหตุผล: โหวต 1 คน = 1 เสียงเท่ากันหมด → กลุ่มบัญชีปลอม/มือใหม่ครอบงำได้ง่าย (bias)
//   ถ่วงน้ำหนักตาม trust ของ user ทำให้เสียงของคนที่พิสูจน์ตัวเองแล้วมีน้ำหนักกว่า
//
// สัญญาณที่ใช้ (จากข้อมูลที่มีอยู่แล้ว — ไม่ต้องเพิ่ม field):
//   • points              — สะสมจากการใช้งานจริง (สแกน/มีส่วนร่วม)
//   • อายุบัญชี (createdAt) — บัญชีเก่ากว่า = น่าเชื่อถือกว่า, กัน sybil เปิดใหม่รัว
//   • approvedContributions — จำนวนสินค้าที่ user เสนอแล้วผ่านการรับรอง (คุณภาพจริง)
//
// ผลลัพธ์: { level (1-4), weight, label, signals }
//   weight ถูก cap ภายนอกด้วย config PRODUCT_VOTE_MAX_WEIGHT_PER_USER

const LEVELS = [
    { level: 4, weight: 3.0, label: 'ผู้เชี่ยวชาญ' },   // Expert
    { level: 3, weight: 2.0, label: 'ที่เชื่อถือได้' }, // Trusted
    { level: 2, weight: 1.5, label: 'สมาชิก' },         // Member
    { level: 1, weight: 1.0, label: 'มือใหม่' },        // Newcomer
];

function daysSince(date) {
    if (!date) return 0;
    return (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24);
}

// computeUserTrust(user, { approvedContributions })
//   user: User document (ต้องมี points, createdAt)
//   approvedContributions: จำนวนสินค้าที่ user submit แล้ว approved (caller query มาให้)
function computeUserTrust(user, { approvedContributions = 0 } = {}) {
    const points     = Number(user?.points || 0);
    const ageDays    = daysSince(user?.createdAt);
    const contrib    = Number(approvedContributions || 0);

    let level = 1;

    // Level 4 — Expert: พิสูจน์คุณภาพชัดเจน
    if (points >= 1000 && contrib >= 3) {
        level = 4;
    // Level 3 — Trusted: แต้มสูง + มีผลงานผ่าน หรือ บัญชีเก่ามากพร้อมแต้มพอควร
    } else if ((points >= 500 && contrib >= 1) || (ageDays >= 60 && points >= 300)) {
        level = 3;
    // Level 2 — Member: เริ่มมีร่องรอยการใช้งานจริง
    } else if (points >= 100 || ageDays >= 14) {
        level = 2;
    } else {
        level = 1;
    }

    const def = LEVELS.find(l => l.level === level);
    return {
        level,
        weight: def.weight,
        label:  def.label,
        signals: { points, ageDays: Math.floor(ageDays), approvedContributions: contrib },
    };
}

// clamp weight ตาม config เพดาน (กันคนเดียวครอบงำ)
function cappedWeight(weight, maxWeight) {
    const cap = Number(maxWeight) || 3;
    return Math.min(weight, cap);
}

module.exports = { computeUserTrust, cappedWeight, LEVELS };
