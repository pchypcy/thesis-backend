// routes/tts.js — InGreen Text-to-Speech (เสียงพูด Neural)
//
// POST /api/tts   Body: { text, lang }  → { success, audioContent(base64), mime, voice }
//
// ลำดับ engine (เลือกอัตโนมัติ):
//   1) Gemini TTS  — ใช้ GEMINI_API_KEY ตัวเดิม (ฟรี ไม่ต้องผูกบัตร) เสียงเป็นธรรมชาติ
//   2) Google Cloud TTS — ใช้ GOOGLE_TTS_API_KEY (ต้องมี GCP billing)
//   3) ไม่มี key → { success:false, fallback:true } ให้แอปใช้เสียงเบราว์เซอร์
//
// เปลี่ยนเสียง/โมเดลได้ผ่าน env:
//   GEMINI_TTS_MODEL (default gemini-2.5-flash-preview-tts)
//   GEMINI_TTS_VOICE (default Kore — ลองอื่นได้: Aoede, Leda, Puck, Charon, Zephyr)

const express = require('express');
const axios   = require('axios');
const router  = express.Router();

const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const GEMINI_TTS_VOICE = process.env.GEMINI_TTS_VOICE || 'Kore';
const geminiTtsUrl = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

const G_CLOUD_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const CLOUD_VOICES = {
    TH: { languageCode: 'th-TH', name: process.env.GOOGLE_TTS_VOICE_TH || 'th-TH-Neural2-C' },
    EN: { languageCode: 'en-US', name: process.env.GOOGLE_TTS_VOICE_EN || 'en-US-Neural2-F' },
};

// หุ้ม raw PCM (จาก Gemini) ด้วย WAV header → เบราว์เซอร์เล่นได้
function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
    const byteRate   = sampleRate * channels * bitsPerSample / 8;
    const blockAlign = channels * bitsPerSample / 8;
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.writeUInt32LE(36 + pcm.length, 4);
    h.write('WAVE', 8);
    h.write('fmt ', 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);           // PCM
    h.writeUInt16LE(channels, 22);
    h.writeUInt32LE(sampleRate, 24);
    h.writeUInt32LE(byteRate, 28);
    h.writeUInt16LE(blockAlign, 32);
    h.writeUInt16LE(bitsPerSample, 34);
    h.write('data', 36);
    h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
}

// ── Gemini TTS (ฟรี — ใช้ GEMINI_API_KEY เดิม) ──────────────────────────────
async function geminiTTS(text) {
    const resp = await axios.post(`${geminiTtsUrl(GEMINI_TTS_MODEL)}?key=${process.env.GEMINI_API_KEY}`, {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_TTS_VOICE } } },
        },
    }, { headers: { 'content-type': 'application/json' }, timeout: 20000 });

    const cand = resp.data?.candidates?.[0];
    const part = (cand?.content?.parts || []).find((p) => p.inlineData || p.inline_data);
    const inline = part?.inlineData || part?.inline_data;
    if (!inline?.data) throw new Error(`no_audio(finish=${cand?.finishReason || 'none'})`);

    const mime = inline.mimeType || inline.mime_type || 'audio/L16;rate=24000';
    const rateM = /rate=(\d+)/.exec(mime);
    const sampleRate = rateM ? parseInt(rateM[1], 10) : 24000;
    const wav = pcmToWav(Buffer.from(inline.data, 'base64'), sampleRate);
    return { audioContent: wav.toString('base64'), mime: 'audio/wav', voice: `gemini:${GEMINI_TTS_VOICE}` };
}

router.post('/', async (req, res) => {
    try {
        const { text, lang } = req.body || {};
        if (!text || !String(text).trim()) {
            return res.status(400).json({ success: false, message: 'no text' });
        }
        const clean = String(text).slice(0, 900);

        // 1) Gemini TTS (ฟรี)
        if (process.env.GEMINI_API_KEY) {
            try {
                const out = await geminiTTS(clean);
                return res.json({ success: true, ...out });
            } catch (e) {
                console.error('TTS Gemini failed:', e.response?.data?.error?.message || e.message);
                // ตกไปลอง engine ถัดไป
            }
        }

        // 2) Google Cloud TTS (ถ้ามี key)
        if (process.env.GOOGLE_TTS_API_KEY) {
            try {
                const v = CLOUD_VOICES[String(lang || 'TH').toUpperCase()] || CLOUD_VOICES.TH;
                const r = await axios.post(`${G_CLOUD_URL}?key=${process.env.GOOGLE_TTS_API_KEY}`, {
                    input: { text: clean },
                    voice: { languageCode: v.languageCode, name: v.name },
                    audioConfig: {
                        audioEncoding: 'MP3',
                        speakingRate: Number(process.env.GOOGLE_TTS_RATE || 1.0),
                        pitch: Number(process.env.GOOGLE_TTS_PITCH || 0),
                    },
                }, { timeout: 15000 });
                if (r.data?.audioContent) {
                    return res.json({ success: true, audioContent: r.data.audioContent, mime: 'audio/mpeg', voice: v.name });
                }
            } catch (e) {
                console.error('TTS Cloud failed:', e.response?.data?.error?.message || e.message);
            }
        }

        // 3) ไม่มี engine → ให้แอปใช้เสียงเบราว์เซอร์
        return res.json({ success: false, fallback: true, reason: 'no_engine' });
    } catch (err) {
        console.error('TTS Error:', err.response?.data?.error?.message || err.message);
        return res.json({ success: false, fallback: true, reason: 'error' });
    }
});

module.exports = router;
