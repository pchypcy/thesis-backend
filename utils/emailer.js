// utils/emailer.js — InGreen email helper
//
// Configure via .env:
//   SMTP_HOST          = smtp.gmail.com       (or smtp.sendgrid.net / smtp.mailgun.org)
//   SMTP_PORT          = 587                  (or 465 for SSL)
//   SMTP_SECURE        = false                (true ถ้าใช้ port 465)
//   SMTP_USER          = your-email@gmail.com
//   SMTP_PASS          = app_password          (Gmail = App Password 16 หลัก)
//   SMTP_FROM_NAME     = InGreen
//   SMTP_FROM_EMAIL    = your-email@gmail.com (default = SMTP_USER)
//
// Gmail setup:
//   1. เปิด 2FA ที่ https://myaccount.google.com/security
//   2. สร้าง App Password ที่ https://myaccount.google.com/apppasswords
//   3. ใส่ password 16 หลัก (ไม่มีช่องว่าง) ใน SMTP_PASS
//
// ถ้าไม่ตั้ง SMTP_HOST → emailer ทำงานใน demo mode (return OTP กลับใน API)

const nodemailer = require('nodemailer');

let transporter = null;
let lastVerifyError = null;

function isConfigured() {
    return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
    if (!isConfigured()) return null;
    if (transporter) return transporter;

    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',   // true = SSL (port 465), false = STARTTLS (port 587)
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });

    // verify async — log error but don't throw
    transporter.verify().then(() => {
        console.log(`📧 SMTP ready: ${process.env.SMTP_HOST} (${process.env.SMTP_USER})`);
    }).catch(err => {
        lastVerifyError = err.message;
        console.error(`📧 SMTP verify failed: ${err.message}`);
    });

    return transporter;
}

// ── HTML template (responsive, brand-styled) ─────────────────────────────
function renderOtpEmail({ username, otp, expiresInMin = 10 }) {
    return `<!DOCTYPE html>
<html lang="th">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:#FAFAFA;font-family:'IBM Plex Sans Thai','Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FAFAFA;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:480px;background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 12px 35px rgba(0,0,0,0.05);">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#1B5E37 0%,#2E7D32 100%);padding:32px 24px;text-align:center;">
          <div style="display:inline-block;width:60px;height:60px;background:rgba(213,238,122,0.2);border-radius:18px;line-height:60px;margin-bottom:12px;">
            <span style="font-size:30px;">🔐</span>
          </div>
          <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:800;">รีเซ็ตรหัสผ่าน InGreen</h1>
          <p style="margin:6px 0 0;color:#D5EE7A;font-size:13px;font-weight:600;">Password Reset Request</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px 28px 20px;">
          <p style="margin:0 0 6px;color:#1B5E37;font-size:15px;font-weight:700;">สวัสดีคุณ ${escapeHtml(username)}</p>
          <p style="margin:0 0 24px;color:#666;font-size:14px;line-height:1.6;">มีคำขอรีเซ็ตรหัสผ่านสำหรับบัญชีของคุณ กรุณาใช้รหัส OTP ด้านล่างเพื่อยืนยัน — รหัสนี้จะหมดอายุภายใน <strong style="color:#1B5E37;">${expiresInMin} นาที</strong></p>

          <!-- OTP box -->
          <div style="background:linear-gradient(135deg,#F4FDC6 0%,#D5EE7A 100%);border-radius:20px;padding:24px;text-align:center;margin-bottom:24px;">
            <div style="font-size:11px;font-weight:800;color:#1B5E37;letter-spacing:2px;margin-bottom:10px;">รหัส OTP ของคุณ</div>
            <div style="font-family:'Courier New',monospace;font-size:38px;font-weight:900;color:#1B5E37;letter-spacing:10px;line-height:1;">${otp}</div>
            <div style="font-size:11px;color:#558B2F;margin-top:10px;font-weight:600;">ห้ามแชร์รหัสนี้ให้ผู้อื่น</div>
          </div>

          <p style="margin:0 0 12px;color:#888;font-size:13px;line-height:1.6;">หากคุณไม่ได้เป็นผู้ขอเปลี่ยนรหัสผ่าน <strong style="color:#D32F2F;">โปรดเพิกเฉยอีเมลฉบับนี้</strong> และเปลี่ยนรหัสผ่านของคุณทันทีเพื่อความปลอดภัย</p>

          <!-- Security tips -->
          <div style="background:#FFF8E1;border-left:4px solid #FFB300;padding:12px 14px;border-radius:8px;margin-top:16px;">
            <div style="font-size:12px;font-weight:800;color:#E65100;margin-bottom:4px;">💡 ทิปความปลอดภัย</div>
            <ul style="margin:0;padding-left:18px;color:#5D4037;font-size:12px;line-height:1.6;">
              <li>InGreen ไม่ขอ password / OTP ทางโทรศัพท์</li>
              <li>กรอกผิด 5 ครั้ง — รหัส OTP จะหมดอายุทันที</li>
              <li>หมดอายุใน ${expiresInMin} นาที</li>
            </ul>
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#FAFAFA;padding:18px 28px;text-align:center;border-top:1px solid #F0F0F0;">
          <p style="margin:0;color:#999;font-size:11px;line-height:1.5;">
            อีเมลนี้ส่งโดยอัตโนมัติ กรุณาอย่าตอบกลับ<br/>
            © InGreen · ${new Date().getFullYear()}
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

function renderPasswordChangedEmail({ username, when, ip }) {
    return `<!DOCTYPE html>
<html lang="th">
<head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:0;background:#FAFAFA;font-family:'IBM Plex Sans Thai',Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FAFAFA;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:480px;background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 12px 35px rgba(0,0,0,0.05);">
        <tr><td style="background:linear-gradient(135deg,#1B5E37 0%,#2E7D32 100%);padding:30px 24px;text-align:center;">
          <div style="font-size:36px;margin-bottom:4px;">✅</div>
          <h1 style="margin:0;color:#fff;font-size:20px;font-weight:800;">รหัสผ่านถูกเปลี่ยนแล้ว</h1>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 12px;color:#1B5E37;font-size:15px;font-weight:700;">สวัสดีคุณ ${escapeHtml(username)}</p>
          <p style="margin:0 0 18px;color:#666;font-size:14px;line-height:1.6;">รหัสผ่านสำหรับบัญชีของคุณถูกเปลี่ยนเรียบร้อยแล้ว</p>
          <div style="background:#FAFAFA;border-radius:14px;padding:14px 16px;font-size:12px;color:#666;line-height:1.8;">
            <strong style="color:#333;">เวลา:</strong> ${escapeHtml(when)}<br/>
            <strong style="color:#333;">IP:</strong> ${escapeHtml(ip || 'unknown')}
          </div>
          <div style="background:#FFEBEE;border-left:4px solid #C62828;padding:12px 14px;border-radius:8px;margin-top:18px;font-size:12px;color:#C62828;line-height:1.5;">
            <strong>ไม่ได้เป็นคุณใช่ไหม?</strong> โปรดติดต่อทีมงาน InGreen ทันที — บัญชีของคุณอาจถูกบุกรุก
          </div>
        </td></tr>
        <tr><td style="background:#FAFAFA;padding:14px;text-align:center;border-top:1px solid #F0F0F0;">
          <p style="margin:0;color:#999;font-size:11px;">© InGreen · ${new Date().getFullYear()}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// ── Main send functions ──────────────────────────────────────────────────
async function sendOtpEmail({ to, username, otp, expiresInMin = 10 }) {
    const tx = getTransporter();
    if (!tx) throw new Error('SMTP_NOT_CONFIGURED');

    const fromName  = process.env.SMTP_FROM_NAME  || 'InGreen';
    const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;

    const info = await tx.sendMail({
        from:    `"${fromName}" <${fromEmail}>`,
        to,
        subject: `รหัส OTP รีเซ็ตรหัสผ่าน InGreen (${otp})`,
        html:    renderOtpEmail({ username, otp, expiresInMin }),
        text:    `รหัส OTP ของคุณคือ ${otp} หมดอายุใน ${expiresInMin} นาที — หากไม่ได้ขอ โปรดเพิกเฉย`,
    });

    console.log(`📧 OTP email sent to ${to} (messageId: ${info.messageId})`);
    return { messageId: info.messageId };
}

async function sendPasswordChangedEmail({ to, username, ip }) {
    const tx = getTransporter();
    if (!tx) throw new Error('SMTP_NOT_CONFIGURED');

    const fromName  = process.env.SMTP_FROM_NAME  || 'InGreen';
    const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;

    const when = new Date().toLocaleString('th-TH', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });

    const info = await tx.sendMail({
        from:    `"${fromName}" <${fromEmail}>`,
        to,
        subject: 'รหัสผ่านบัญชี InGreen ของคุณถูกเปลี่ยนแล้ว',
        html:    renderPasswordChangedEmail({ username, when, ip }),
        text:    `รหัสผ่านของคุณถูกเปลี่ยนเมื่อ ${when} จาก IP ${ip || 'unknown'} — ถ้าไม่ใช่คุณ โปรดติดต่อทีมงานทันที`,
    });

    console.log(`📧 Password-changed notice sent to ${to}`);
    return { messageId: info.messageId };
}

module.exports = {
    isConfigured,
    sendOtpEmail,
    sendPasswordChangedEmail,
    getLastVerifyError: () => lastVerifyError,
};
