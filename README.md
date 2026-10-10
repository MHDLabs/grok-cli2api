# ⚡ Grok CLI → OpenAI Compatible Proxy

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript">
  <img src="https://img.shields.io/badge/License-MIT-00d4aa?style=for-the-badge" alt="MIT License">
  <img src="https://img.shields.io/badge/OpenAI-Compatible-7c6cf0?style=for-the-badge&logo=openai&logoColor=white" alt="OpenAI Compatible">
</p>

<p align="center">
  <b>یک پروکسی تک‌فایلی، سبک و قدرتمند برای تبدیل Grok CLI به یک API سازگار با OpenAI</b><br>
  کاملاً روی Cloudflare Workers اجرا می‌شود — بدون نیاز به سرور، بدون هزینه، با پنل ادمین دارک و شیک.
</p>

<p align="center">
  <a href="#-فارسی">🇮🇷 فارسی</a> • <a href="#-english">🇬🇧 English</a>
</p>

---

<div dir="rtl">

## 📖 فهرست مطالب (فارسی)

- [✨ ویژگی‌ها](#-ویژگیها)
- [🏗️ معماری](#️-معماری)
- [🚀 نصب و راه‌اندازی](#-نصب-و-راهاندازی)
- [🔑 استفاده از API](#-استفاده-از-api)
- [🎛️ پنل ادمین](#️-پنل-ادمین)
- [🔐 احراز هویت OAuth](#-احراز-هویت-oauth)
- [📋 لیست مدل‌ها](#-لیست-مدلها)
- [🧪 مثال‌های استفاده](#-مثالهای-استفاده)
- [⚠️ محدودیت‌ها و نکات](#️-محدودیتها-و-نکات)
- [❓ رفع اشکال](#-رفع-اشکال)
- [📄 مجوز](#-مجوز)

---

## ✨ ویژگی‌ها

- 🔥 **تک‌فایل** — همه چیز در یک `worker.js` بدون وابستگی خارجی
- 🆓 **میزبانی رایگان** — روی Cloudflare Workers با پلن رایگان (روزانه ۱۰۰٬۰۰۰ درخواست)
- 🎨 **پنل ادمین دارک** — رابط کاربری مدرن با تم Grok-like و طراحی واکنش‌گرا
- 🔐 **احراز هویت OAuth** — لاگین امن Grok CLI با Device Code Flow
- 👥 **مدیریت چند اکانت** — Round-Robin خودکار بین اکانت‌ها
- 🔑 **API Key اختصاصی** — کلیدهای مستقل با رهگیری مصرف
- 💾 **ذخیره‌سازی روی KV** — بدون نیاز به دیتابیس خارجی
- 🌊 **پشتیبانی از Stream** — پاسخ‌های SSE به سبک OpenAI
- 📦 **بدون Environment Variable** — همه چیز در KV ذخیره می‌شود
- 🔄 **سازگاری کامل** — با هر کلاینت OpenAI-compatible (NextChat، LobeChat، Cursor، Continue.dev و ...)
- 🌐 **CORS کامل** — برای استفاده در مرورگر و اپلیکیشن‌های وب

---

## 🏗️ معماری

```
┌──────────────┐      ┌─────────────────────────────┐      ┌─────────────────────┐
│   Client     │      │   Cloudflare Worker         │      │   Grok Upstream     │
│  (OpenAI     │─────▶│                             │─────▶│                     │
│  Compatible) │      │  /v1/chat/completions       │      │  cli-chat-proxy.    │
│              │◀─────│  /v1/models                 │◀─────│  grok.com           │
└──────────────┘      │                             │      └─────────────────────┘
                      │  /admin  (پنل ادمین)         │
                      │                             │      ┌─────────────────────┐
                      │  /admin/api/oauth/*         │─────▶│  auth.x.ai          │
                      │                             │      │  (OAuth Device Flow)│
                      └──────────────┬──────────────┘      └─────────────────────┘
                                     │
                                     ▼
                          ┌─────────────────────┐
                          │   Cloudflare KV     │
                          │  ─────────────────  │
                          │  auth:password      │
                          │  accounts:list      │
                          │  apikeys:list       │
                          │  oauth:endpoints    │
                          │  session:*          │
                          └─────────────────────┘
```

---

## 🚀 نصب و راه‌اندازی

### پیش‌نیازها

- یک حساب رایگان [Cloudflare](https://dash.cloudflare.com/sign-up)
- یک اکانت Grok با اشتراک فعال (SuperGrok یا اعتبار کافی)

### گام ۱: ساخت KV Namespace

1. وارد داشبورد Cloudflare شوید → **Workers & Pages** → **KV**
2. روی **Create a namespace** بزنید
3. نام: `GROK_KV` → Create

### گام ۲: ساخت Worker

1. در داشبورد → **Workers & Pages** → **Create Application** → **Create Worker**
2. یک نام دلخواه انتخاب کنید (مثلاً `grok-proxy`)
3. روی **Deploy** بزنید

### گام ۳: اتصال KV به Worker

1. وارد Worker شوید → **Settings** → **Variables and Secrets**
2. در بخش **KV Namespace Bindings** روی **Add binding** بزنید
3. Variable name: `GROK_KV`
4. KV namespace: `GROK_KV`
5. Save

### گام ۴: آپلود کد

1. در Worker → **Edit code**
2. محتوای `worker.js` را در ادیتور پیست کنید
3. **Deploy** بزنید

### گام ۵: ورود به پنل ادمین

به آدرس زیر بروید:

```
https://YOUR-WORKER.workers.dev/admin
```

**پسورد پیش‌فرض:** `123456`

> ⚠️ **مهم:** بلافاصله بعد از ورود، از تب **تنظیمات** پسورد را تغییر دهید!

---

## 🔑 استفاده از API

### ساخت API Key

1. وارد پنل ادمین شوید
2. تب **API Keys** → یک برچسب وارد کنید → **ساخت**
3. کلید ساخته‌شده را کپی کنید (فقط یک بار نمایش داده می‌شود)

### Endpointها

| Endpoint | Method | توضیح |
|----------|--------|-------|
| `/v1/chat/completions` | POST | چت با مدل‌های Grok |
| `/v1/models` | GET | لیست تمام مدل‌ها |
| `/v1/models?capability=text` | GET | فقط مدل‌های متنی |
| `/admin` | GET | پنل ادمین |

### استفاده در کد

```bash
curl -X POST https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer gk_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.7",
    "messages": [
      {"role": "user", "content": "سلام، حالت چطوره؟"}
    ]
  }'
```

### استفاده با کتابخانه OpenAI

**Python:**

```python
from openai import OpenAI

client = OpenAI(
    api_key="gk_YOUR_API_KEY",
    base_url="https://YOUR-WORKER.workers.dev/v1"
)

response = client.chat.completions.create(
    model="grok-4.7",
    messages=[{"role": "user", "content": "سلام!"}]
)
print(response.choices[0].message.content)
```

**JavaScript / Node.js:**

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'gk_YOUR_API_KEY',
  baseURL: 'https://YOUR-WORKER.workers.dev/v1',
});

const response = await client.chat.completions.create({
  model: 'grok-4.7',
  messages: [{ role: 'user', content: 'سلام!' }],
});
console.log(response.choices[0].message.content);
```

---

## 🎛️ پنل ادمین

پنل ادمین شامل سه تب اصلی است:

### ۱. تب اکانت‌ها

- افزودن اکانت Grok با OAuth
- لیست اکانت‌های فعال
- حذف اکانت

### ۲. تب API Keys

- ساخت کلید جدید
- مشاهده مصرف هر کلید
- حذف کلید

### ۳. تب تنظیمات

- تغییر پسورد پنل
- مشاهده آدرس پروکسی

---

## 🔐 احراز هویت OAuth

پروکسی از **OAuth 2.0 Device Code Flow** استفاده می‌کند که برای اپلیکیشن‌های headless طراحی شده است.

### مراحل

1. در پنل ادمین → تب **اکانت‌ها** → روی **شروع OAuth** کلیک کنید
2. یک کد ۸ رقمی نمایش داده می‌شود
3. یک تب جدید به‌صورت خودکار باز می‌شود (`accounts.x.ai/oauth2/device`)
4. کد را وارد کنید و تأیید کنید
5. پروکسی به‌صورت خودکار هر ۵ ثانیه وضعیت را چک می‌کند
6. با موفقیت، اکانت به لیست اضافه می‌شود

### Client ID مورد استفاده

```
b1a00492-073a-47ea-816f-4c329264a828
```

### هدرهای احراز هویت

پروکسی تمام درخواست‌ها را با هدرهای زیر به xAI می‌فرستد:

| هدر | مقدار |
|-----|-------|
| `User-Agent` | `grok-shell/1.0.44 (linux; x86_64)` |
| `x-grok-client-version` | `1.0.44` |
| `x-grok-client-identifier` | `grok-shell` |

---

## 📋 لیست مدل‌ها

پروکسی شامل ۲۹ مدل هاردکد شده است:

### مدل‌های متنی پیشرفته

| مدل | Context | قابلیت‌ها |
|-----|---------|----------|
| `grok-4.7` | 500K | text, image, reasoning, tools |
| `grok-4.6` | 500K | text, image, reasoning, tools |
| `grok-4.5` | 500K | text, image, reasoning, tools |
| `grok-4.3` | 1M | text, image, reasoning, tools |
| `grok-4.20-reasoning` | 1M | text, image, reasoning, tools |
| `grok-4.20-non-reasoning` | 1M | text, image, tools |
| `grok-4` | 131K | text, image, reasoning, tools |
| `grok-4-1-fast-reasoning` | 2M | text, reasoning, tools |
| `grok-4-1-fast-non-reasoning` | 2M | text, tools |
| `grok-3` | 131K | text, tools |
| `grok-3-mini` | 131K | text, reasoning, tools |
| `grok-build-0.1` | 256K | text, reasoning, tools |
| `grok-code-fast-1` | 131K | text, tools |

### مدل‌های تصویری

- `grok-imagine-image`
- `grok-imagine-image-quality`
- `grok-imagine-image-2.0`
- `grok-2-image-1212`

### مدل‌های ویدیویی

- `grok-imagine-video`
- `grok-imagine-video-1.5`

### مدل‌های صوتی

- `grok-voice-think-fast-2.0`

> 📝 برای مشاهده لیست کامل، به `/v1/models` درخواست بزنید.

---

## 🧪 مثال‌های استفاده

### چت ساده

```bash
curl -X POST https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer gk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.7",
    "messages": [{"role": "user", "content": "۲+۲ چند است؟"}]
  }'
```

### استریم پاسخ

```bash
curl -N -X POST https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer gk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.7",
    "stream": true,
    "messages": [{"role": "user", "content": "یک شعر بنویس"}]
  }'
```

### با System Prompt

```bash
curl -X POST https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer gk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.7",
    "messages": [
      {"role": "system", "content": "شما یک دستیار فارسی‌زبان هستید."},
      {"role": "user", "content": "خودت را معرفی کن"}
    ],
    "temperature": 0.7
  }'
```

### اتصال در NextChat

```
Base URL: https://YOUR-WORKER.workers.dev/v1
API Key: gk_YOUR_KEY
Model: grok-4.7
```

### اتصال در Cursor

```
Settings → Models → OpenAI API Key: gk_YOUR_KEY
Override OpenAI Base URL: https://YOUR-WORKER.workers.dev/v1
Model: grok-4.7
```

---

## ⚠️ محدودیت‌ها و نکات

### محدودیت‌های Cloudflare Workers رایگان

- ۱۰۰٬۰۰۰ درخواست در روز
- ۱٬۰۰۰ درخواست در دقیقه
- ۱۰ میلی‌ثانیه CPU time به ازای هر درخواست
- ۱ میلی‌ثانیه زمان راه‌اندازی

### محدودیت‌های اکانت Grok

- نیاز به **SuperGrok** یا اعتبار کافی
- محدودیت نرخ (Rate Limit) مشابه با خود CLI
- خطای `personal-team-blocked:spending-limit` یعنی اعتبار تمام شده

### نکات امنیتی

- ✅ پسورد پیش‌فرض را فوراً تغییر دهید
- ✅ از HTTPS استفاده کنید (Cloudflare به‌صورت خودکار فراهم می‌کند)
- ✅ API Keyها را در جای امن نگه دارید
- ⚠️ این پروکسی برای استفاده شخصی طراحی شده، برای محیط‌های عمومی از احراز هویت قوی‌تر استفاده کنید

---

## ❓ رفع اشکال

### ❌ خطای `personal-team-blocked:spending-limit`

**علت:** اکانت Grok شما اعتبار کافی ندارد.

**راه‌حل:** به `https://grok.com/supergrok` بروید و اشتراک بخرید، یا به `https://grok.com/?_s=usage` بروید و اعتبار اضافه کنید.

---

### ❌ دکمه «شروع OAuth» کار نمی‌کند

**راه‌حل:**
1. Console مرورگر (F12) را باز کنید
2. به تب Network بروید
3. روی درخواست `/admin/api/oauth/start` کلیک کنید
4. پاسخ JSON را بررسی کنید

---

### ❌ خطای `No active Grok account configured`

**علت:** هنوز اکانتی اضافه نکرده‌اید.

**راه‌حل:** در پنل ادمین → تب اکانت‌ها → یک اکانت اضافه کنید.

---

### ❌ خطای `Invalid API key`

**علت:** API Key اشتباه یا غیرفعال است.

**راه‌حل:** یک کلید جدید از تب API Keys بسازید.

---

### ❌ خطای `invalid_json` در OAuth

**راه‌حل:**
1. KV Namespace را بررسی کنید که درست بایند شده باشد
2. کد `worker.js` را دوباره deploy کنید
3. Worker را دوباره راه‌اندازی کنید

---

## 🤝 مشارکت

از مشارکت شما استقبال می‌کنیم! لطفاً:

1. پروژه را Fork کنید
2. یک شاخه جدید بسازید (`git checkout -b feature/amazing-feature`)
3. تغییرات را Commit کنید (`git commit -m 'Add amazing feature'`)
4. Push کنید (`git push origin feature/amazing-feature`)
5. یک Pull Request باز کنید

---

## 📄 مجوز

این پروژه تحت **مجوز MIT** منتشر شده است. برای جزئیات بیشتر به فایل [LICENSE](LICENSE) مراجعه کنید.

```
MIT License

Copyright (c) 2026 Grok CLI Proxy Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 🙏 تقدیر

- [xAI](https://x.ai) برای Grok
- [Cloudflare](https://cloudflare.com) برای Workers و KV
- تمام مشارکت‌کنندگان پروژه‌های متن‌باز مرتبط

---

<p align="center">
  ساخته شده با ❤️ برای جامعه فارسی‌زبان
</p>

</div>

---

# ⚡ Grok CLI → OpenAI Compatible Proxy

<p align="center">
  <b>A single-file, lightweight and powerful proxy that turns Grok CLI into an OpenAI-compatible API</b><br>
  Runs entirely on Cloudflare Workers — no server, no cost, with a sleek dark admin panel.
</p>

---

## 📖 Table of Contents (English)

- [✨ Features](#-features)
- [🏗️ Architecture](#️-architecture)
- [🚀 Installation](#-installation)
- [🔑 API Usage](#-api-usage)
- [🎛️ Admin Panel](#️-admin-panel)
- [🔐 OAuth Authentication](#-oauth-authentication)
- [📋 Model List](#-model-list)
- [🧪 Usage Examples](#-usage-examples)
- [⚠️ Limitations & Notes](#️-limitations--notes)
- [❓ Troubleshooting](#-troubleshooting)
- [🤝 Contributing](#-contributing)
- [📄 License](#-license)

---

## ✨ Features

- 🔥 **Single File** — Everything in one `worker.js` with zero external dependencies
- 🆓 **Free Hosting** — Runs on Cloudflare Workers free plan (100,000 requests/day)
- 🎨 **Dark Admin Panel** — Modern, responsive UI with a Grok-like theme
- 🔐 **OAuth Authentication** — Secure Grok CLI login via Device Code Flow
- 👥 **Multi-Account Management** — Automatic Round-Robin between accounts
- 🔑 **Dedicated API Keys** — Independent keys with usage tracking
- 💾 **KV Storage** — No external database required
- 🌊 **Stream Support** — OpenAI-style SSE responses
- 📦 **Zero Environment Variables** — Everything stored in KV
- 🔄 **Full Compatibility** — Works with any OpenAI-compatible client (NextChat, LobeChat, Cursor, Continue.dev, etc.)
- 🌐 **Full CORS** — Ready for browsers and web applications

---

## 🏗️ Architecture

```
┌──────────────┐      ┌─────────────────────────────┐      ┌─────────────────────┐
│   Client     │      │   Cloudflare Worker         │      │   Grok Upstream     │
│  (OpenAI     │─────▶│                             │─────▶│                     │
│  Compatible) │      │  /v1/chat/completions       │      │  cli-chat-proxy.    │
│              │◀─────│  /v1/models                 │◀─────│  grok.com           │
└──────────────┘      │                             │      └─────────────────────┘
                      │  /admin  (Admin Panel)      │
                      │                             │      ┌─────────────────────┐
                      │  /admin/api/oauth/*         │─────▶│  auth.x.ai          │
                      │                             │      │  (OAuth Device Flow)│
                      └──────────────┬──────────────┘      └─────────────────────┘
                                     │
                                     ▼
                          ┌─────────────────────┐
                          │   Cloudflare KV     │
                          │  ─────────────────  │
                          │  auth:password      │
                          │  accounts:list      │
                          │  apikeys:list       │
                          │  oauth:endpoints    │
                          │  session:*          │
                          └─────────────────────┘
```

---

## 🚀 Installation

### Prerequisites

- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account
- A Grok account with an active subscription (SuperGrok or sufficient credits)

### Step 1: Create a KV Namespace

1. Open the Cloudflare Dashboard → **Workers & Pages** → **KV**
2. Click **Create a namespace**
3. Name: `GROK_KV` → Create

### Step 2: Create a Worker

1. Dashboard → **Workers & Pages** → **Create Application** → **Create Worker**
2. Choose a name (e.g., `grok-proxy`)
3. Click **Deploy**

### Step 3: Bind KV to Worker

1. Open the Worker → **Settings** → **Variables and Secrets**
2. Under **KV Namespace Bindings**, click **Add binding**
3. Variable name: `GROK_KV`
4. KV namespace: `GROK_KV`
5. Save

### Step 4: Upload the Code

1. In the Worker → **Edit code**
2. Paste the contents of `worker.js` into the editor
3. Click **Deploy**

### Step 5: Access the Admin Panel

Navigate to:

```
https://YOUR-WORKER.workers.dev/admin
```

**Default password:** `123456`

> ⚠️ **Important:** Change the password immediately after first login via the **Settings** tab!

---

## 🔑 API Usage

### Create an API Key

1. Log in to the admin panel
2. Go to **API Keys** tab → enter a label → **Create**
3. Copy the generated key (shown only once)

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat with Grok models |
| `/v1/models` | GET | List all models |
| `/v1/models?capability=text` | GET | Text models only |
| `/admin` | GET | Admin panel |

### Basic Usage

```bash
curl -X POST https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer gk_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.7",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ]
  }'
```

### Using with OpenAI SDK

**Python:**

```python
from openai import OpenAI

client = OpenAI(
    api_key="gk_YOUR_API_KEY",
    base_url="https://YOUR-WORKER.workers.dev/v1"
)

response = client.chat.completions.create(
    model="grok-4.7",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

**JavaScript / Node.js:**

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'gk_YOUR_API_KEY',
  baseURL: 'https://YOUR-WORKER.workers.dev/v1',
});

const response = await client.chat.completions.create({
  model: 'grok-4.7',
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(response.choices[0].message.content);
```

---

## 🎛️ Admin Panel

The admin panel consists of three main tabs:

### 1. Accounts Tab

- Add Grok accounts via OAuth
- List active accounts
- Delete accounts

### 2. API Keys Tab

- Create new keys
- Monitor per-key usage
- Delete keys

### 3. Settings Tab

- Change panel password
- View proxy URL

---

## 🔐 OAuth Authentication

The proxy uses the **OAuth 2.0 Device Code Flow**, designed for headless applications.

### Flow

1. In the admin panel → **Accounts** tab → click **Start OAuth**
2. An 8-character code is displayed
3. A new tab opens automatically (`accounts.x.ai/oauth2/device`)
4. Enter the code and authorize
5. The proxy polls the status every 5 seconds
6. On success, the account is added to the list

### Client ID Used

```
b1a00492-073a-47ea-816f-4c329264a828
```

### Authentication Headers

The proxy sends all requests to xAI with the following headers:

| Header | Value |
|--------|-------|
| `User-Agent` | `grok-shell/1.0.44 (linux; x86_64)` |
| `x-grok-client-version` | `1.0.44` |
| `x-grok-client-identifier` | `grok-shell` |

---

## 📋 Model List

The proxy includes 29 hardcoded models:

### Advanced Text Models

| Model | Context | Capabilities |
|-------|---------|--------------|
| `grok-4.7` | 500K | text, image, reasoning, tools |
| `grok-4.6` | 500K | text, image, reasoning, tools |
| `grok-4.5` | 500K | text, image, reasoning, tools |
| `grok-4.3` | 1M | text, image, reasoning, tools |
| `grok-4.20-reasoning` | 1M | text, image, reasoning, tools |
| `grok-4.20-non-reasoning` | 1M | text, image, tools |
| `grok-4` | 131K | text, image, reasoning, tools |
| `grok-4-1-fast-reasoning` | 2M | text, reasoning, tools |
| `grok-4-1-fast-non-reasoning` | 2M | text, tools |
| `grok-3` | 131K | text, tools |
| `grok-3-mini` | 131K | text, reasoning, tools |
| `grok-build-0.1` | 256K | text, reasoning, tools |
| `grok-code-fast-1` | 131K | text, tools |

### Image Models

- `grok-imagine-image`
- `grok-imagine-image-quality`
- `grok-imagine-image-2.0`
- `grok-2-image-1212`

### Video Models

- `grok-imagine-video`
- `grok-imagine-video-1.5`

### Audio Models

- `grok-voice-think-fast-2.0`

> 📝 Request `/v1/models` for the full list.

---

## 🧪 Usage Examples

### Simple Chat

```bash
curl -X POST https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer gk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.7",
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'
```

### Streamed Response

```bash
curl -N -X POST https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer gk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.7",
    "stream": true,
    "messages": [{"role": "user", "content": "Write a poem"}]
  }'
```

### With System Prompt

```bash
curl -X POST https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer gk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.7",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Introduce yourself"}
    ],
    "temperature": 0.7
  }'
```

### NextChat Setup

```
Base URL: https://YOUR-WORKER.workers.dev/v1
API Key: gk_YOUR_KEY
Model: grok-4.7
```

### Cursor Setup

```
Settings → Models → OpenAI API Key: gk_YOUR_KEY
Override OpenAI Base URL: https://YOUR-WORKER.workers.dev/v1
Model: grok-4.7
```

---

## ⚠️ Limitations & Notes

### Cloudflare Workers Free Tier

- 100,000 requests/day
- 1,000 requests/minute
- 10 ms CPU time per request
- 1 ms startup time

### Grok Account Limits

- Requires **SuperGrok** or sufficient credits
- Rate limits similar to the official CLI
- `personal-team-blocked:spending-limit` error means credits are exhausted

### Security Notes

- ✅ Change the default password immediately
- ✅ Use HTTPS (Cloudflare provides automatically)
- ✅ Keep API keys in a secure location
- ⚠️ This proxy is designed for personal use; use stronger authentication for public environments

---

## ❓ Troubleshooting

### ❌ `personal-team-blocked:spending-limit` Error

**Cause:** Your Grok account has insufficient credits.

**Fix:** Visit `https://grok.com/supergrok` to subscribe, or `https://grok.com/?_s=usage` to add credits.

---

### ❌ "Start OAuth" Button Does Nothing

**Fix:**
1. Open browser Console (F12)
2. Go to Network tab
3. Click the `/admin/api/oauth/start` request
4. Inspect the JSON response

---

### ❌ `No active Grok account configured` Error

**Cause:** No account has been added yet.

**Fix:** Admin panel → Accounts tab → add an account.

---

### ❌ `Invalid API key` Error

**Cause:** Wrong or disabled API key.

**Fix:** Generate a new key from the API Keys tab.

---

### ❌ `invalid_json` Error in OAuth

**Fix:**
1. Verify KV Namespace is properly bound
2. Redeploy `worker.js`
3. Restart the Worker

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the project
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.

```
MIT License

Copyright (c) 2026 Grok CLI Proxy Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 🙏 Credits

- [xAI](https://x.ai) for Grok
- [Cloudflare](https://cloudflare.com) for Workers and KV
- All contributors of related open-source projects

---

<p align="center">
 Made with ❤️ at MHDLabs. Vibe code for free! 🚀
</p>
