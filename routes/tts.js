// routes/tts.js — InGreen Text-to-Speech (เสียงพูด Neural)
//
// POST /api/tts   Body: { text, lang }  → { success, audioContent(base64 mp3), mime, voice }
//
// ใช้ Google Cloud Text-to-Speech (เสียง Neural ฟังเป็นมนุษย์)
//   - ต้องมี GOOGLE_TTS_API_KEY ใน env
//   - เปลี่ยนเสียงได้ผ่าน env: GOOGLE_TTS_VOICE_TH / GOOGLE_TTS_VOICE_EN
//     (เช่น th-TH-Neural2-C, หรือ Chirp3-HD: th-TH-Chirp3-HD-Achernar)
//
// ถ้าไม่มี key หรือเรียกไม่สำเร็จ → ตอบ { success:false, fallback:true }
//   ให้ฝั่งแอปใช้เสียงเบราว์เซอร์ (speechSynthesis) แทน โดยไม่ error

const express = require('express');
const axios   = require('axios');
const router  = express.Router();

const G_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

const VOICES = {
    TH: { languageCode: 'th-TH', name: process.env.GOOGLE_TTS_VOICE_TH || 'th-TH-Neural2-C' },
    EN: { languageCode: 'en-US', name: process.env.GOOGLE_TTS_VOICE_EN || 'en-US-Neural2-F' },
};

router.post('/', async (req, res) => {
    try {
        const { text, lang } = req.body || {};
        if (!text || !String(text).trim()) {
            return res.status(400).json({ success: false, message: 'no text' });
        }

        const key = process.env.GOOGLE_TTS_API_KEY;
        if (!key) {
            return res.json({ success: false, fallback: true, reason: 'no_key' });
        }

        const v = VOICES[String(lang || 'TH').toUpperCase()] || VOICES.TH;
        const body = {
            input: { text: String(text).slice(0, 900) },   // กันข้อความยาวเกิน
            voice: { languageCode: v.languageCode, name: v.name },
            audioConfig: {
                audioEncoding: 'MP3',
                speakingRate:  Number(process.env.GOOGLE_TTS_RATE  || 1.0),
                pitch:         Number(process.env.GOOGLE_TTS_PITCH || 0),
            },
        };

        const r = await axios.post(`${G_URL}?key=${key}`, body, { timeout: 15000 });
        const audio = r.data?.audioContent;
        if (!audio) {
            return res.json({ success: false, fallback: true, reason: 'empty' });
        }

        return res.json({ success: true, audioContent: audio, mime: 'audio/mpeg', voice: v.name });
    } catch (err) {
        // ไม่ทำให้ฝั่งแอป error — ให้ fallback ไปเสียงเบราว์เซอร์
        console.error('TTS Error:', err.response?.data?.error?.message || err.message);
        return res.json({ success: false, fallback: true, reason: 'error' });
    }
});

module.exports = router;
