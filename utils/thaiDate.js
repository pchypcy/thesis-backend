// utils/thaiDate.js — จัดรูปวันที่/เวลาแบบไทย (UTC+7, พ.ศ.)
//
// ใช้ให้ระบบสื่อสาร "เริ่มวันไหน หมดวันไหน" ได้ชัดเจนกับผู้ใช้และในเอกสาร
// ไทยไม่มี DST → ออฟเซ็ตคงที่ +7 เสมอ

const TH_OFFSET_MS = 7 * 60 * 60 * 1000;
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

// แปลงเป็น "หน้าปัดเวลาไทย" (ใช้ getUTC* อ่านค่าได้ตรงตามเวลาไทย)
function toThai(date) {
    return new Date(new Date(date).getTime() + TH_OFFSET_MS);
}

// "17 ก.ค. 2569 เวลา 00:00 น."
function fmtThaiDateTime(date) {
    if (!date) return null;
    const t = toThai(date);
    const d = t.getUTCDate();
    const mo = TH_MONTHS[t.getUTCMonth()];
    const y = t.getUTCFullYear() + 543; // พ.ศ.
    const hh = String(t.getUTCHours()).padStart(2, '0');
    const mm = String(t.getUTCMinutes()).padStart(2, '0');
    return `${d} ${mo} ${y} เวลา ${hh}:${mm} น.`;
}

// "17 ก.ค. 2569"
function fmtThaiDate(date) {
    if (!date) return null;
    const t = toThai(date);
    return `${t.getUTCDate()} ${TH_MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear() + 543}`;
}

// "14–17 ก.ค. 2569"  (ช่วงวันที่ อ่านง่าย)
function fmtThaiRange(start, end) {
    if (!start || !end) return null;
    const s = toThai(start), e = toThai(end);
    const sameMonth = s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear();
    if (sameMonth) {
        return `${s.getUTCDate()}–${e.getUTCDate()} ${TH_MONTHS[e.getUTCMonth()]} ${e.getUTCFullYear() + 543}`;
    }
    return `${fmtThaiDate(start)} – ${fmtThaiDate(end)}`;
}

module.exports = { TH_OFFSET_MS, toThai, fmtThaiDateTime, fmtThaiDate, fmtThaiRange };
