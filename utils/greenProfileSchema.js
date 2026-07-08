// utils/greenProfileSchema.js — Green Profile API (DPSE-03)
//
// "Schema" ในสไลป์ 5 Core Architecture: แปลงข้อมูลที่กระจายอยู่ใน
//   - HealthProfile (allergens, conditions, เป้าหมายสุขภาพ)
//   - User.impactStats (ความยั่งยืน — ลดพลาสติก/สารเคมี)
// ให้กลายเป็น JSON มาตรฐานก้อนเดียว ที่ partner ภายนอกอ่านได้
//
// + ฟังก์ชัน greenCheck() = "Recommendation Service" (สไลด์ 4-5):
//   partner ส่งเมนูมา → คืน "ผลลัพธ์" (ปลอดภัย/ไม่, Green Score) โดยไม่เปิดข้อมูลดิบ
//   ใช้ allergyDetector.js ตัวเดิมที่แอปใช้ตรวจสินค้าอยู่แล้ว — ไม่เขียนตรรกะใหม่ซ้ำ

const crypto = require('crypto');
const { checkProductAgainstAllergens } = require('./allergyDetector');

const SCOPES = ['allergy', 'health', 'sustainability', 'account'];

// ── pseudonymous subject id — partner ไม่เห็น username จริง ──────────────────
function anonId(username) {
    return 'anon_' + crypto.createHash('sha256')
        .update('ingreen-green-profile:' + String(username))
        .digest('hex').slice(0, 8);
}

// allergen_severities เก็บเป็น Map ใน mongoose → แปลงเป็น plain object
function sevMapFromHp(hp) {
    const m = hp && hp.allergen_severities;
    if (!m) return {};
    if (m instanceof Map) return Object.fromEntries(m);
    if (typeof m === 'object') return { ...m };
    return {};
}

// ผู้ใช้ "เลี่ยงพลาสติก" ถ้าเคยมีพฤติกรรมลดพลาสติก (impactStats)
function derivePlasticAvoidance(user) {
    return (user && user.impactStats && user.impactStats.plastics > 0) || false;
}

// ── สร้าง Green Profile JSON เฉพาะ scope ที่ผู้ใช้อนุญาต ─────────────────────
function buildGreenProfile(user, hp, scopes = []) {
    const set = new Set(scopes);
    const data = {};

    if (set.has('allergy')) {
        // ใช้ allergen_entries (canonical) — ถ้า profile เก่ายังไม่มี ให้ fallback จาก mirror
        let entries = (hp && hp.allergen_entries) || [];
        if ((!entries || entries.length === 0) && hp && Array.isArray(hp.allergens) && hp.allergens.length) {
            const sev = sevMapFromHp(hp);
            entries = hp.allergens.map(a => ({ allergenId: a, severity: sev[a] || 'medium' }));
        }
        data.allergy = {
            allergens: entries.map(e => ({ id: e.allergenId, severity: e.severity })),
            conditions: Object.entries((hp && hp.conditions) || {})
                .filter(([, v]) => v === true).map(([k]) => k),
        };
    }

    if (set.has('health')) {
        data.health = {
            daily_calorie_goal:   (hp && hp.daily_calorie_goal)   != null ? hp.daily_calorie_goal   : 2000,
            daily_sodium_goal_mg: (hp && hp.daily_sodium_goal_mg) != null ? hp.daily_sodium_goal_mg : 2000,
            daily_sugar_goal_g:   (hp && hp.daily_sugar_goal_g)   != null ? hp.daily_sugar_goal_g   : 25,
        };
    }

    if (set.has('sustainability')) {
        data.sustainability = {
            plastic_avoidance: derivePlasticAvoidance(user),
            chemicals_avoided: (user && user.impactStats && user.impactStats.chemicals) || 0,
            plastics_avoided:  (user && user.impactStats && user.impactStats.plastics)  || 0,
            min_green_score:   70,
            // ── ต่อยอด: ความชอบด้านบรรจุภัณฑ์รักษ์โลก (partner ใช้จัดอันดับ/ตั้งค่าเริ่มต้น) ──
            //   ผู้ใช้ที่ยอมแชร์ scope sustainability = ให้ความสำคัญกับความยั่งยืน จึงตั้งค่าเริ่มต้นเป็น true
            prefer_eco_packaging:    true,   // อยากได้ร้าน/เมนูที่บรรจุภัณฑ์รักษ์โลกก่อน
            decline_plastic_cutlery: true,   // ไม่รับช้อนส้อมพลาสติกเป็นค่าเริ่มต้น
            packaging_ranking: ['bagasse', 'leaf', 'paper', 'reusable', 'plastic', 'foam'],
        };
    }

    if (set.has('account')) {
        data.account = {
            display_name: (user && user.username) || null,
            persona:      (user && user.persona)  || null,
        };
    }

    return {
        profile_version: 'v1',
        subject:   anonId(user && user.username),
        issued_at: new Date().toISOString(),
        scopes,
        data,
    };
}

// ── Green Score ของเมนู 1 รายการ (0-100) ────────────────────────────────────
function computeGreenScore(item = {}) {
    let s = 60;

    const pkg = String(item.packaging || '').toLowerCase();
    if (/(compost|biodegrad|leaf|banana|bagasse|sugarcane|cornstarch)/.test(pkg)) s += 28;
    else if (/(paper|carton|kraft|reusable|bring|none)/.test(pkg)) s += 12;
    else if (/(styro|foam)/.test(pkg)) s -= 26;
    else if (/(plastic)/.test(pkg)) s -= 16;

    const tags = (item.tags || []).map(t => String(t).toLowerCase());
    if (tags.includes('organic')) s += 8;
    if (tags.includes('local')) s += 6;
    if (tags.includes('plant_based') || tags.includes('vegan')) s += 12;
    if (tags.includes('beef') || tags.includes('red_meat')) s -= 12;

    const ings = (item.ingredients || []).map(i => String(i).toLowerCase());
    if (ings.some(i => /beef|pork/.test(i))) s -= 6;

    return Math.max(0, Math.min(100, Math.round(s)));
}

// ── ข้อมูลบรรจุภัณฑ์ (แสดง "วัสดุจริง" = โปร่งใส กันฟอกเขียว) ─────────────────
function packagingInfo(pkg) {
    const p = String(pkg || '').toLowerCase();
    if (/(bagasse|sugarcane|cornstarch)/.test(p))      return { material: p, label: 'กล่องชานอ้อย', tier: 'eco',  eco_delta: 28 };
    if (/(leaf|banana|compost|biodegrad)/.test(p))     return { material: p, label: 'บรรจุภัณฑ์ย่อยสลายได้', tier: 'eco',  eco_delta: 28 };
    if (/(paper|carton|kraft|reusable|bring)/.test(p)) return { material: p, label: 'กล่องกระดาษ/ใช้ซ้ำ', tier: 'good', eco_delta: 12 };
    if (/(styro|foam)/.test(p))                        return { material: p, label: 'กล่องโฟม', tier: 'bad',  eco_delta: -26 };
    if (/(plastic)/.test(p))                           return { material: p, label: 'กล่องพลาสติก', tier: 'poor', eco_delta: -16 };
    return { material: p || 'unknown', label: 'ไม่ระบุบรรจุภัณฑ์', tier: 'unknown', eco_delta: 0 };
}

// ── ธงเตือนสุขภาพ เทียบกับเป้าหมายของผู้ใช้ ─────────────────────────────────
function healthFlags(item, hp) {
    const flags = [];
    const sodiumGoal = (hp && hp.daily_sodium_goal_mg) || 2000;
    const sugarGoal  = (hp && hp.daily_sugar_goal_g)   || 25;
    const calGoal    = (hp && hp.daily_calorie_goal)   || 2000;

    if (item.sodium_mg != null) {
        if (item.sodium_mg > sodiumGoal * 0.5) flags.push('high_sodium');
        else if (item.sodium_mg > sodiumGoal * 0.3) flags.push('watch_sodium');
    }
    if (item.sugar_g != null && item.sugar_g > sugarGoal * 0.6) flags.push('high_sugar');
    if (item.kcal != null && item.kcal > (calGoal / 3) * 1.4) flags.push('high_calorie');
    if (hp && hp.conditions && hp.conditions.has_diabetes && item.sugar_g != null && item.sugar_g > 15) {
        flags.push('diabetes_caution');
    }
    return flags;
}

// ── Recommendation Service: ตรวจเมนูทั้งชุดให้ partner ───────────────────────
function greenCheck(items, user, hp) {
    const allergenIds = (hp && hp.allergens) || [];
    const sevMap = sevMapFromHp(hp);

    const results = (items || []).map(it => {
        const chk = checkProductAgainstAllergens(
            { name: it.name, ingredients: it.ingredients || [] },
            allergenIds, sevMap
        );
        const hits = [...new Set((chk.matches || []).map(m => m.allergenId))];
        const maxSeverity = chk.highestUserSeverity || chk.highestBaseSeverity || null;
        const flags = healthFlags(it, hp);
        const score = computeGreenScore(it);
        const pkg = packagingInfo(it.packaging);

        let recommendation;
        if (chk.hasMatch) recommendation = 'avoid';
        else if (score >= 80 && flags.length === 0) recommendation = 'recommend';
        else recommendation = 'ok';

        return {
            name: it.name,
            allergy: {
                safe: !chk.hasMatch,
                hits,
                max_severity: chk.hasMatch ? maxSeverity : null,
            },
            health_flags: flags,
            green_score: score,
            eco: {
                packaging: pkg.material,
                packaging_label: pkg.label,
                packaging_tier: pkg.tier,          // eco | good | poor | bad | unknown
                eco_friendly: pkg.tier === 'eco' || pkg.tier === 'good',
            },
            recommendation,
        };
    });

    return { subject: anonId(user && user.username), results };
}

module.exports = { SCOPES, anonId, buildGreenProfile, computeGreenScore, packagingInfo, healthFlags, greenCheck };
