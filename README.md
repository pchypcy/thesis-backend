# InGreen — Backend API

ระบบ backend สำหรับแอปพลิเคชัน **InGreen** — แอปสแกนสินค้าเพื่อสุขภาพและสิ่งแวดล้อม

## 🚀 Quick Start (Demo)

```bash
# 1. Install dependencies
npm install

# 2. ตั้งค่า .env
echo "MONGO_URI=mongodb+srv://your-cluster..." > .env
echo "PORT=5001" >> .env

# 3. Seed config (รันครั้งเดียว)
node server.js &
curl http://localhost:5001/api/config/seed

# 4. Seed demo data
node scripts/seedDemo.js

# 5. Run
node server.js
# server พร้อมที่ http://localhost:5001
```

## 👥 Demo Accounts

| User | Password | Role |
|---|---|---|
| **somchai** | `123456` | Free user, มี active coupon |
| **nattaya** | `123456` | Trial VIP, แพ้ถั่ว+นม + เบาหวาน |
| **kittipong** | `123456` | VIP active, มี intake history + custom nutrients |
| **admin** | `admin123` | Admin panel |
| **shop_001** ... **shop_006** | `1234` | Merchant logins |

## 🗺️ Routes Map

### User-facing
- `POST   /api/users/create` — register
- `POST   /api/users/login` — login (JWT)
- `POST   /api/users/scan` — log scan + earn points (VIP ×1.5)
- `POST   /api/users/redeem` — แลกแต้มเป็นคูปอง (HMAC-signed)

### VIP & Tracking (Sprint 2-3)
- `GET    /api/vip/status/:username`
- `POST   /api/vip/upgrade` — ฿69/30days
- `POST   /api/vip/cancel` — ยกเลิก (ใช้ได้ถึงวันหมดอายุ)
- `POST   /api/vip/start-trial` — auto-called ตอน register
- `POST   /api/intake/log` — VIP only, atomic upsert
- `GET    /api/intake/summary/:username?period=day|week`

### Allergy (Free for everyone — Sprint 4)
- `GET    /api/health-profile/allergen-list` — EU 14 list + disclaimer
- `GET    /api/health-profile/:username`
- `PATCH  /api/health-profile/:username` — allergens + conditions + tracked nutrients
- `POST   /api/health-profile/check` — ตรวจสินค้ากับ allergen profile

### Crowdsource (Sprint 5)
- `POST   /api/products/add` — submit pending
- `GET    /api/products/pending/list` — รายการรอ vote
- `POST   /api/products/vote` — vote up/down (atomic, anti-self-vote, threshold=3)

### Coupon Customer-Confirm (Sprint 5)
- `POST   /api/merchant/check-coupon` — pre-check ก่อนกรอกยอด
- `POST   /api/merchant/request-confirm` — ร้านขอลูกค้ายืนยันยอด (3 นาที window)
- `GET    /api/coupons/pending-confirm/:username` — ลูกค้าดูคำขอ
- `POST   /api/coupons/confirm` / `reject` — ลูกค้ายืนยัน
- `POST   /api/merchant/scan-coupon` — สรุปรายการจริง (atomic deduct)

### AI Receipt Scan (Sprint 5)
- `GET    /api/ai-scan/quota/:username` — สถานะโควต้า
- `POST   /api/ai-scan/receipt` — สแกน OCR (mock — รอ OpenAI key)
  - **VIP**: 20 ครั้ง/วัน
  - **Free**: 1 ครั้ง/2 วัน (rolling 48h)

### Admin & Merchant Dashboard
- `GET    /api/admin/dashboard-summary` — KPI + VIP revenue
- `GET    /api/merchant/revenue/:merchantId?period=day|week|month`
- `GET    /api/health-report/:username` — JSON monthly report (VIP)
- `GET    /api/health-report/:username/html` — printable HTML report

### Config Table
- `GET    /api/config` — ทั้งหมด (grouped)
- `GET    /api/config/seed` — seed 19 default values
- `PATCH  /api/config/:key` — admin edit

## 🏗️ Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  ingreen-app    │     │  ingreen-admin  │     │  merchant-app   │
│   (Customer)    │     │     (Admin)     │     │   (POS scan)    │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                     ┌───────────▼───────────┐
                     │   Express + Mongoose  │
                     │      Port 5001        │
                     └───────────┬───────────┘
                                 │
                     ┌───────────▼───────────┐
                     │   MongoDB Atlas (M0)  │
                     └───────────────────────┘
```

## 🔐 Security highlights

- **bcrypt** password hashing (10 rounds)
- **JWT** auth — 30-day token, auto-injected via `utils/api.js`
- **HMAC-SHA256** coupon codes (`GRN-XXXXXXXX`) — ไม่สามารถ guess ได้
- **Atomic operations** สำหรับ:
  - `CouponQuota.atomicDeduct()` — ป้องกัน race condition
  - `DailyIntake.logScan()` — `$inc` atomic upsert
  - `ScanQuota.tryConsume()` — AI scan rate limit
- **Rate limiting** ใน-memory สำหรับ login (10/5min) + register (5/10min)
- **Disclaimer** ในทุกผลการตรวจ allergen (กันการฟ้องร้อง)

## 📊 Models (Mongoose)

```
User, Product, Reward, Coupon, Invoice, Merchant,
AppConfig, CouponQuota, VipSubscription,
DailyIntake, HealthProfile, NotificationPreference,
ScanQuota, Keyword
```

## 🧪 Smoke Test

```bash
# All routes ที่สำคัญ
curl http://localhost:5001/                            # health
curl http://localhost:5001/api/config | head -c 200
curl http://localhost:5001/api/health-profile/allergen-list | jq .total
curl http://localhost:5001/api/ai-scan/quota/somchai
curl http://localhost:5001/api/products/pending/list
```

## 🌱 Sprint History

- **Sprint 1**: Config table + HMAC coupon + schemas
- **Sprint 2**: VIP system + Sugar Tracker + intake logging
- **Sprint 3**: AI Insight + ×1.5 multiplier
- **Sprint 4**: Allergy system (Free) + Notification preferences
- **Sprint 5**: AI Receipt Scan + Customer Confirm + Crowdsource + Monthly Report

## 📝 License
MIT
