// middleware/auth.js
const jwt = require('jsonwebtoken');

// 🎯 คีย์ลับสำหรับเข้ารหัส (ถ้าขึ้น Production จริงๆ ควรเอาไปซ่อนไว้ในไฟล์ .env)
const JWT_SECRET = process.env.JWT_SECRET || 'ingreen_super_secret_key_2026';

const verifyToken = (req, res, next) => {
    // ดึง Token จาก Header ที่ Frontend ส่งมาให้
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // รูปแบบจะต้องเป็น "Bearer <token>"

    if (!token) {
        return res.status(403).json({ success: false, message: "ไม่อนุญาตให้เข้าถึง (ไม่มี Token)" });
    }

    try {
        // ถอดรหัสเช็คว่า Token ถูกต้องและยังไม่หมดอายุใช่ไหม
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // เอาข้อมูลที่ถอดรหัสได้ (เช่น username, role) ฝังไว้ใน req เผื่อให้ API เอาไปใช้ต่อ
        req.user = decoded; 
        
        next(); // ผ่านด่านได้! อนุญาตให้เข้าไปทำคำสั่งใน API ต่อไป
    } catch (err) {
        return res.status(401).json({ success: false, message: "Token ไม่ถูกต้อง หรือหมดอายุแล้ว" });
    }
};

module.exports = verifyToken;