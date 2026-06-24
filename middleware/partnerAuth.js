// middleware/partnerAuth.js — Green Profile API (DPSE-03)
//
// ตรวจ 2 ชั้นก่อนให้ partner เข้าถึงข้อมูลผู้ใช้:
//   1. API key   — Authorization: Bearer pk_live_...  → partner รายนี้มีตัวตนจริงไหม
//   2. Consent   — X-Consent-Token (หรือ body.consent_token / ?consent_token)
//                  → ผู้ใช้คนนี้อนุญาต partner รายนี้ไว้ และยังไม่เพิกถอน
//
// ถ้าผู้ใช้กด "เพิกถอนสิทธิ์" ในแอป → grant.status = 'revoked'
//   → ที่นี่ตอบ 403 consent_revoked ทันที (ใช้โชว์ตอนเดโม revoke แล้วข้อมูลหายสด)

const PartnerApp   = require('../models/PartnerApp');
const ConsentGrant = require('../models/ConsentGrant');

async function partnerAuth(req, res, next) {
    try {
        const authHeader = req.headers['authorization'];
        const apiKey = authHeader && authHeader.startsWith('Bearer ')
            ? authHeader.slice(7).trim() : null;

        if (!apiKey) {
            return res.status(401).json({ error: 'missing_api_key', message: 'ต้องแนบ API key (Authorization: Bearer pk_...)' });
        }

        const partner = await PartnerApp.findOne({ api_key: apiKey, status: 'active' });
        if (!partner) {
            return res.status(401).json({ error: 'invalid_api_key', message: 'API key ไม่ถูกต้องหรือถูกระงับ' });
        }

        const consentToken =
            req.headers['x-consent-token'] ||
            (req.body && req.body.consent_token) ||
            (req.query && req.query.consent_token);

        if (!consentToken) {
            return res.status(401).json({ error: 'missing_consent_token', message: 'ต้องแนบ consent token ที่ผู้ใช้อนุญาตไว้' });
        }

        const grant = await ConsentGrant.findOne({ consent_token: consentToken, partner_slug: partner.slug });
        if (!grant || grant.status !== 'active') {
            return res.status(403).json({ error: 'consent_revoked', message: 'ผู้ใช้ยังไม่อนุญาต หรือเพิกถอนสิทธิ์แล้ว' });
        }

        req.partner = partner;
        req.grant = grant;
        next();
    } catch (err) {
        console.error('partnerAuth error:', err);
        res.status(500).json({ error: 'server_error' });
    }
}

module.exports = partnerAuth;
