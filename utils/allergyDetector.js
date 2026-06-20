// utils/allergyDetector.js — InGreen Sprint 4 (May 10-16)
//
// ภารกิจ:
//   ตรวจจับสารก่อภูมิแพ้หลักของ EU 14 จากข้อความ ingredients / marketing_text / allergens
//   ให้ความสำคัญสูงสุดกับ "ถั่วลิสง" (Peanut) เพราะแพ้รุนแรงและอาจถึงตายได้
//
// ใช้กับ:
//   - POST /api/health-profile/check  (Allergy Alert flow ที่หน้า Result)
//   - log/scan (เผื่อ block ก่อนนำทาง)
//
// Disclaimer:
//   ระบบนี้ไม่ได้แม่นยำ 100% — ข้อมูลส่วนผสมจาก OpenFoodFacts/user-submitted
//   อาจไม่ครบ และอาจมี cross-contamination (สารผสมแฝง) ที่ตรวจไม่พบ
//   ผู้ใช้ต้องอ่านฉลากด้วยตนเองเสมอ (แจ้งใน UI ทุกครั้ง)

// ── Allergen Definition (EU 14 + Thai keywords) ─────────────────────────────
// แต่ละ key คือ allergen ID ที่ใช้ใน HealthProfile.allergens
// keywords: คำที่อาจปรากฏใน ingredients/text — ทั้งไทย/อังกฤษ/รากศัพท์
// severity_default: ระดับเริ่มต้น 'critical' = แพ้ถึงตายได้, 'high' = อาการรุนแรง, 'medium' = ระคายเคือง
const ALLERGEN_DB = {
    Peanuts: {
        labelTH: 'ถั่วลิสง',
        labelEN: 'Peanuts',
        icon: 'fluent-emoji-high-contrast:peanuts',
        severity_default: 'critical', // ★ critical = ถึงตายได้ (anaphylaxis)
        keywords: [
            // English
            'peanut', 'peanuts', 'groundnut', 'ground nut', 'arachis',
            'arachis hypogaea', 'peanut oil', 'peanut butter', 'peanut flour',
            // Thai
            'ถั่วลิสง', 'ถั่วดิน', 'น้ำมันถั่วลิสง', 'เนยถั่ว', 'แป้งถั่วลิสง',
        ],
        crossContaminationWarning: true,
    },
    TreeNuts: {
        labelTH: 'ถั่วเปลือกแข็ง (อัลมอนด์ วอลนัท เม็ดมะม่วงหิมพานต์)',
        labelEN: 'Tree Nuts',
        icon: 'tdesign:nut',
        severity_default: 'critical',
        keywords: [
            'almond', 'almonds', 'walnut', 'walnuts', 'cashew', 'cashews',
            'hazelnut', 'hazelnuts', 'pistachio', 'pistachios', 'pecan', 'pecans',
            'brazil nut', 'macadamia', 'tree nut', 'tree nuts', 'nut',
            'อัลมอนด์', 'วอลนัท', 'เม็ดมะม่วงหิมพานต์', 'เม็ดมะม่วง', 'พิสตาชิโอ',
            'เฮเซลนัท', 'แมคคาเดเมีย', 'ถั่วเปลือกแข็ง',
        ],
        crossContaminationWarning: true,
    },
    Milk: {
        labelTH: 'นมและผลิตภัณฑ์จากนม (รวมแลคโตส)',
        labelEN: 'Milk',
        icon: 'ph:cow',
        severity_default: 'high',
        keywords: [
            'milk', 'whole milk', 'skim milk', 'lactose', 'whey', 'casein',
            'butter', 'cream', 'cheese', 'yogurt', 'yoghurt', 'condensed milk',
            'milk powder', 'milk protein', 'butterfat',
            'นม', 'นมวัว', 'นมผง', 'แลคโตส', 'เวย์', 'เคซีน', 'เนย', 'ครีม',
            'ชีส', 'โยเกิร์ต', 'นมข้น', 'หางนม',
        ],
        crossContaminationWarning: false,
    },
    Eggs: {
        labelTH: 'ไข่',
        labelEN: 'Eggs',
        icon: 'ic:outline-egg',
        severity_default: 'high',
        keywords: [
            'egg', 'eggs', 'albumin', 'albumen', 'egg white', 'egg yolk',
            'lecithin (egg)', 'mayonnaise',
            'ไข่', 'ไข่ขาว', 'ไข่แดง', 'ไข่ผง', 'เลซิติน (จากไข่)', 'มายองเนส',
        ],
        crossContaminationWarning: false,
    },
    Fish: {
        labelTH: 'ปลา',
        labelEN: 'Fish',
        icon: 'hugeicons:fish-food',
        severity_default: 'high',
        keywords: [
            'fish', 'tuna', 'salmon', 'cod', 'anchovy', 'anchovies', 'sardine',
            'mackerel', 'fish sauce', 'fish oil', 'surimi',
            'ปลา', 'ทูน่า', 'แซลมอน', 'แมคเคอเรล', 'ปลาทู', 'น้ำปลา', 'น้ำมันปลา',
            'ปลาแอนโชวี่', 'ปลาซาร์ดีน',
        ],
        crossContaminationWarning: false,
    },
    Crustaceans: {
        labelTH: 'สัตว์น้ำมีเปลือก (กุ้ง ปู ล็อบสเตอร์)',
        labelEN: 'Crustaceans',
        icon: 'fluent-emoji-high-contrast:lobster',
        severity_default: 'high',
        keywords: [
            'shrimp', 'prawn', 'crab', 'lobster', 'crayfish', 'shellfish',
            'crustacean',
            'กุ้ง', 'ปู', 'ล็อบสเตอร์', 'กุ้งเครย์ฟิช', 'อาหารทะเล',
        ],
        crossContaminationWarning: true,
    },
    Molluscs: {
        labelTH: 'หอย (หอยลาย หอยนางรม ปลาหมึก)',
        labelEN: 'Molluscs',
        icon: 'streamline:shell-remix',
        severity_default: 'high',
        keywords: [
            'mollusc', 'mollusk', 'oyster', 'mussel', 'clam', 'scallop',
            'squid', 'octopus', 'cuttlefish', 'snail',
            'หอย', 'หอยนางรม', 'หอยแมลงภู่', 'หอยลาย', 'หอยแครง', 'ปลาหมึก',
            'หมึก', 'หอยเชอรี่',
        ],
        crossContaminationWarning: false,
    },
    Soybeans: {
        labelTH: 'ถั่วเหลือง',
        labelEN: 'Soybeans',
        icon: 'lucide:bean',
        severity_default: 'medium',
        keywords: [
            'soy', 'soya', 'soybean', 'soybeans', 'soy sauce', 'tofu', 'tempeh',
            'edamame', 'soy lecithin', 'soy protein', 'miso',
            'ถั่วเหลือง', 'ซอสถั่วเหลือง', 'โชยุ', 'เต้าหู้', 'ซีอิ๊ว', 'มิโซะ',
            'เลซิติน (จากถั่วเหลือง)', 'นมถั่วเหลือง',
        ],
        crossContaminationWarning: false,
    },
    Gluten: {
        labelTH: 'กลูเตน (ข้าวสาลี ข้าวบาร์เลย์ ข้าวไรย์)',
        labelEN: 'Gluten / Wheat',
        icon: 'lucide:wheat',
        severity_default: 'high',
        keywords: [
            'wheat', 'gluten', 'barley', 'rye', 'spelt', 'kamut', 'farro',
            'semolina', 'bulgur', 'durum', 'wheat flour', 'malt', 'malted',
            'breadcrumbs', 'pasta', 'noodle', 'noodles', 'flour',
            'ข้าวสาลี', 'กลูเตน', 'ข้าวบาร์เลย์', 'ข้าวไรย์', 'แป้งสาลี',
            'มอลต์', 'เซโมลินา', 'พาสต้า', 'บะหมี่', 'ขนมปัง',
        ],
        crossContaminationWarning: false,
    },
    Sesame: {
        labelTH: 'งา',
        labelEN: 'Sesame',
        icon: 'game-icons:sesame',
        severity_default: 'high',
        keywords: [
            'sesame', 'sesame seed', 'sesame oil', 'tahini',
            'งา', 'น้ำมันงา', 'เมล็ดงา', 'ทาฮีนี',
        ],
        crossContaminationWarning: false,
    },
    Celery: {
        labelTH: 'ขึ้นฉ่าย',
        labelEN: 'Celery',
        icon: 'healthicons:vegetables',
        severity_default: 'medium',
        keywords: [
            'celery', 'celeriac',
            'ขึ้นฉ่าย', 'ขึ้นฉ่ายฝรั่ง',
        ],
        crossContaminationWarning: false,
    },
    Mustard: {
        labelTH: 'มัสตาร์ด',
        labelEN: 'Mustard',
        icon: 'mdi:soy-sauce',
        severity_default: 'medium',
        keywords: [
            'mustard', 'mustard seed', 'mustard powder',
            'มัสตาร์ด', 'เมล็ดมัสตาร์ด',
        ],
        crossContaminationWarning: false,
    },
    Sulphites: {
        labelTH: 'ซัลไฟต์ (> 10mg/kg)',
        labelEN: 'Sulphites',
        icon: 'healthicons:virus-lab-research-test-tube',
        severity_default: 'medium',
        keywords: [
            'sulphite', 'sulfite', 'sulphites', 'sulfites', 'sulphur dioxide',
            'sulfur dioxide', 'e220', 'e221', 'e222', 'e223', 'e224', 'e225',
            'e226', 'e227', 'e228',
            'ซัลไฟต์', 'ซัลเฟอร์ไดออกไซด์', 'สารกันบูด',
        ],
        crossContaminationWarning: false,
    },
    Lupin: {
        labelTH: 'ถั่วลูพิน',
        labelEN: 'Lupin',
        icon: 'ph:coffee-bean-bold',
        severity_default: 'medium',
        keywords: [
            'lupin', 'lupine', 'lupin flour',
            'ถั่วลูพิน', 'แป้งลูพิน',
        ],
        crossContaminationWarning: false,
    },
};

// ── Severity ladder ────────────────────────────────────────────────────────
const SEVERITY_RANK = { critical: 3, high: 2, medium: 1, low: 0 };

// ★ Sprint 6: ดึง allergen map จาก DB (AllergenGroup) — overlay บน ALLERGEN_DB hardcoded
// ถ้า DB ว่าง (ยังไม่ได้ seed) → return ALLERGEN_DB hardcoded ตามเดิม
// ถ้า DB มี → ใช้ DB เป็น source of truth (active=true เท่านั้น)
async function getAllergenMap() {
    try {
        // lazy-require เพื่อหลีกเลี่ยง circular dependency (AllergenGroup → utils → ...)
        const AllergenGroup = require('../models/AllergenGroup');
        const groups = await AllergenGroup.find({ isActive: true }).lean();
        if (!groups.length) return { ...ALLERGEN_DB };

        const map = {};
        for (const g of groups) {
            map[g.id] = {
                labelTH: g.labelTH,
                labelEN: g.labelEN,
                icon:    g.icon,
                severity_default: g.severity_default,
                keywords: g.keywords || [],
                crossContaminationWarning: !!g.crossContaminationWarning,
            };
        }
        return map;
    } catch (err) {
        console.error('getAllergenMap fallback to hardcoded:', err.message);
        return { ...ALLERGEN_DB };
    }
}

// ── Helper: normalize ตัวอักษรเพื่อเปรียบเทียบ ────────────────────────────────
function normalize(text) {
    return String(text || '').toLowerCase().trim();
}

// ── Match Allergen ─────────────────────────────────────────────────────────
// รับ keywords list (ส่วนผสมและข้อความ) → คืน list ของ allergen ที่เจอ
// พร้อม keyword ที่ทำให้ match (เพื่อแสดงใน UI ให้ผู้ใช้ตรวจสอบเอง)
function findAllergensInText(searchText, userAllergenIds = [], allergenDbOverride = null) {
    const text = normalize(searchText);
    if (!text) return [];

    // ★ Sprint 6: ใช้ DB-backed map ถ้ามี — fallback hardcoded
    const db = allergenDbOverride || ALLERGEN_DB;

    const matches = [];

    // วน user allergens เท่านั้น (ไม่วนทั้งหมด — ประหยัด CPU + relevant)
    for (const allergenId of userAllergenIds) {
        const def = db[allergenId];
        if (!def) continue;

        // หา keyword ที่ match
        const matchedKeywords = [];
        for (const kw of def.keywords) {
            const kwNorm = normalize(kw);
            // ใช้ word boundary สำหรับภาษาอังกฤษ — Thai ไม่มี boundary
            // วิธีง่ายๆ: ถ้า keyword สั้น (<4) ต้องเป็น word boundary ป้องกัน false-positive
            // เช่น "egg" ไม่อยากให้เจอใน "egg-free" (FIXME: edge case ที่ดีกว่านี้)
            const isThaiKw = /[฀-๿]/.test(kwNorm);
            const isShortEn = !isThaiKw && kwNorm.length <= 4;

            let found = false;
            if (isShortEn) {
                // word boundary check
                const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(kwNorm)}([^a-z0-9]|$)`, 'i');
                found = re.test(text);
            } else {
                found = text.includes(kwNorm);
            }

            if (found) matchedKeywords.push(kw);
        }

        if (matchedKeywords.length > 0) {
            matches.push({
                allergenId,
                labelTH:   def.labelTH,
                labelEN:   def.labelEN,
                icon:      def.icon,
                severity:  def.severity_default,
                matchedKeywords,
                crossContaminationWarning: def.crossContaminationWarning,
            });
        }
    }

    return matches;
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Detect Cross-Contamination Phrases ─────────────────────────────────────
// บางสินค้ามีคำเตือน "may contain traces of peanut" หรือ "ผลิตในโรงงานที่ผลิตถั่วลิสงด้วย"
// ★ Critical สำหรับผู้แพ้รุนแรง — ต้องเตือนแม้ไม่มีในส่วนผสมจริง
const CROSS_CONTAMINATION_PHRASES = [
    'may contain', 'may contain traces of', 'manufactured in a facility',
    'made in a facility', 'processed in a facility', 'cross contamination',
    'cross-contamination', 'shared equipment',
    'อาจมีส่วนผสมของ', 'อาจมี', 'ผลิตในโรงงานเดียวกับ', 'ผลิตในสายการผลิตเดียวกับ',
    'อาจมีสารผสมแฝง', 'อาจปนเปื้อน',
];

function detectCrossContamination(text) {
    const t = normalize(text);
    if (!t) return null;
    for (const phrase of CROSS_CONTAMINATION_PHRASES) {
        if (t.includes(normalize(phrase))) {
            return phrase;
        }
    }
    return null;
}

// ── Main: ตรวจสินค้ากับ user allergen profile ─────────────────────────────
// product:  { name, brand, ingredients: [], allergens, marketing_text, ingredients_text }
// userAllergenIds:  ['Peanuts', ...]  → list ของ allergen ที่ user สนใจ
// userSeverityMap:  { Peanuts: 'severe', Milk: 'mild', ... }  → ★ Sprint 6 user-overridden severity
//
// คืน:
//   {
//     hasMatch, matches: [{ allergenId, ..., baseSeverity, userSeverity }],
//     highestBaseSeverity   ← ใช้ตัดสิน Layer 1 (system) — friction, สีหัวกล่อง
//     highestUserSeverity   ← ใช้ตัดสิน Layer 2 (user) — สีกล่อง user
//     highestSeverity       ← (backward-compat) = highestBaseSeverity
//     crossContamination, disclaimer
//   }
function checkProductAgainstAllergens(product, userAllergenIds = [], userSeverityMap = {}, allergenDbOverride = null) {
    if (!userAllergenIds || userAllergenIds.length === 0) {
        return {
            hasMatch:              false,
            highestSeverity:       null,
            highestBaseSeverity:   null,
            highestUserSeverity:   null,
            matches:               [],
            crossContamination:    null,
            disclaimer:            DEFAULT_DISCLAIMER,
        };
    }

    // รวมข้อความที่ต้องตรวจ (ingredients array + text fields)
    const ingredientsText = Array.isArray(product.ingredients)
        ? product.ingredients.join(', ')
        : String(product.ingredients || '');

    const searchText = [
        product.name || '',
        ingredientsText,
        product.ingredients_text || '',
        product.allergens || '',
        product.marketing_text || '',
        product.categories || '',
    ].join(' || ');

    const rawMatches = findAllergensInText(searchText, userAllergenIds, allergenDbOverride);

    // ★ Sprint 6: enrich แต่ละ match ด้วย baseSeverity + userSeverity
    const matches = rawMatches.map(m => {
        const userSev = userSeverityMap?.[m.allergenId] || null; // null = ใช้ base เป็น default
        return {
            ...m,
            baseSeverity: m.severity,    // จาก ALLERGEN_DB — ระบบประเมิน (Layer 1)
            userSeverity: userSev,        // จาก HealthProfile — user ตั้งเอง (Layer 2) — 'mild'|'medium'|'severe'|null
        };
    });

    // หา severity สูงสุดทั้ง 2 layer แยกกัน
    let highestBaseSeverity = null;
    let baseRankMax = -1;
    for (const m of matches) {
        const r = SEVERITY_RANK[m.baseSeverity] ?? 0;
        if (r > baseRankMax) { baseRankMax = r; highestBaseSeverity = m.baseSeverity; }
    }

    const USER_RANK = { severe: 3, medium: 2, mild: 1 };
    let highestUserSeverity = null;
    let userRankMax = -1;
    for (const m of matches) {
        if (!m.userSeverity) continue;
        const r = USER_RANK[m.userSeverity] ?? 0;
        if (r > userRankMax) { userRankMax = r; highestUserSeverity = m.userSeverity; }
    }

    // ตรวจ cross-contamination warning
    const crossPhrase = detectCrossContamination(searchText);

    return {
        hasMatch:              matches.length > 0,
        highestSeverity:       highestBaseSeverity, // backward compat
        highestBaseSeverity,
        highestUserSeverity,
        matches,
        crossContamination:    crossPhrase,
        disclaimer:            DEFAULT_DISCLAIMER,
    };
}

// ── Disclaimer (ใช้ทุกที่ที่แสดงผลการตรวจสารก่อภูมิแพ้) ─────────────────────
const DEFAULT_DISCLAIMER = {
    th: 'ระบบนี้ไม่ได้แม่นยำ 100% — ข้อมูลส่วนผสมอาจไม่ครบ และอาจมีสารผสมแฝง (cross-contamination) ที่ตรวจไม่พบ กรุณาอ่านฉลากด้วยตนเองทุกครั้งและปรึกษาแพทย์หากแพ้รุนแรง',
    en: 'This system is NOT 100% accurate — ingredient data may be incomplete and cross-contamination may not be detected. Always read the label yourself and consult a doctor if you have severe allergies.',
};

module.exports = {
    ALLERGEN_DB,
    SEVERITY_RANK,
    getAllergenMap,           // ★ Sprint 6: async — pull from DB w/ fallback
    findAllergensInText,
    detectCrossContamination,
    checkProductAgainstAllergens,
    DEFAULT_DISCLAIMER,
};
