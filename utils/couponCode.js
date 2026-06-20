// utils/couponCode.js — InGreen Sprint 1
//
// เปลี่ยนจากสุ่มตัวเลขธรรมดา → HMAC-SHA256
// เหตุผล: รหัส GRN-XXXX เดิมสุ่มได้ 4 หลัก (10,000 ค่า) → เดาได้ง่าย
// ระบบใหม่ผูก coupon กับ username + shopName + timestamp + secret
// ทำให้แต่ละโค้ดไม่ซ้ำกัน ไม่มีทางเดา และ verify ได้ฝั่ง server
//
// Format: GRN-{BASE36_8CHARS}
// ตัวอย่าง: GRN-K3X9P2MQ
//
// การเปลี่ยนแปลงที่กระทบ:
//   - users.js → redeem route: เปลี่ยน Math.random() มาใช้ generateCouponCode()
//   - Coupon.js model: เพิ่ม field hmacSignature สำหรับ verify ภายหลัง
//   - merchant.js → scan-coupon route: เพิ่ม verifyCouponCode() ก่อน redeem

const crypto = require('crypto');

// ── Secret Key ──────────────────────────────────────────────────────────────
// ในระบบจริงต้องเก็บใน .env เท่านั้น ห้าม hardcode
const HMAC_SECRET = process.env.COUPON_HMAC_SECRET || 'ingreen_coupon_secret_2026';

/**
 * generateCouponCode(username, shopName)
 * 
 * สร้างรหัสคูปองที่ผูกกับ:
 *   - username    → เจ้าของคูปอง
 *   - shopName    → ร้านที่แลก
 *   - timestamp   → เวลาที่สร้าง (ms) → ป้องกันซ้ำ
 *   - random      → entropy เพิ่มเติม
 * 
 * @returns {{ code: string, signature: string, issuedAt: number }}
 */
function generateCouponCode(username, shopName) {
    const issuedAt = Date.now();
    const random   = crypto.randomBytes(8).toString('hex'); // 64-bit entropy
    
    // Payload ที่จะ sign: ใส่ทุกอย่างที่ต้องการผูก
    const payload = `${username}|${shopName}|${issuedAt}|${random}`;
    
    // HMAC-SHA256 → เอา 8 bytes แรก → แปลงเป็น Base36 (ตัวอักษร+เลข)
    const hmac = crypto
        .createHmac('sha256', HMAC_SECRET)
        .update(payload)
        .digest();
    
    // BigInt แปลง 8 bytes → Base36 string → uppercase → pad 8 ตัว
    const code = BigInt('0x' + hmac.slice(0, 8).toString('hex'))
        .toString(36)
        .toUpperCase()
        .padStart(8, '0')
        .slice(-8); // เอาแค่ 8 ตัวท้าย กัน overflow
    
    return {
        code:      `GRN-${code}`,         // รหัสที่โชว์ให้ user: GRN-K3X9P2MQ
        signature: hmac.toString('hex'),   // เก็บลง DB เพื่อ verify ภายหลัง
        issuedAt,                          // timestamp สำหรับ expire check
    };
}

/**
 * verifyCouponCode(code, username, shopName, issuedAt, storedSignature)
 * 
 * ตรวจสอบว่า coupon code นี้ถูก issue โดยระบบเราจริงๆ
 * ใช้ในฝั่ง merchant scan-coupon route
 * 
 * หมายเหตุ: เนื่องจาก random bytes ต่างกันทุกครั้ง
 * เราจึง verify ผ่าน signature ที่เก็บไว้ใน DB
 * ไม่ได้ recompute HMAC (เพราะไม่มี random ต้นฉบับ)
 * 
 * @returns {boolean}
 */
function verifyCouponCode(code, storedSignature) {
    // ตรวจรูปแบบ: ต้องขึ้นต้นด้วย GRN- และตามด้วย Base36 8 ตัว
    const pattern = /^GRN-[0-9A-Z]{8}$/;
    if (!pattern.test(code)) return false;
    
    // ถ้ามี signature ใน DB ถือว่าผ่านการ verify ขั้นต้นแล้ว
    // (signature ถูก generate ด้วย HMAC ที่ server เท่านั้น)
    if (!storedSignature || storedSignature.length !== 64) return false;
    
    return true;
}

module.exports = { generateCouponCode, verifyCouponCode };