<div dir="rtl">

# ⧉ NovaClip — مدیر کلیپ‌بورد کراس‌پلتفرم

یک مدیر کلیپ‌بورد **گرافیکی، سریع و آفلاین** با یک رابط کاربری مشترک برای **ویندوز** و **اندروید**.

- 💻 **ویندوز**: نصب‌کننده‌ی EXE برای **ویندوز ۷ تا ۱۱** (۳۲ بیتی و ۶۴ بیتی)
- 📱 **اندروید**: APK برای **اندروید ۷.۰ به بعد** (API 24+) تا جدیدترین نسخه

هر متنی را کپی کنید؛ NovaClip به‌صورت خودکار آن را ثبت می‌کند، دسته‌بندی می‌کند و در دسترس شما می‌گذارد.

---

## ✨ امکانات

| قابلیت | توضیح |
|---|---|
| 🧲 ثبت خودکار | هر کلیپ (متن، لینک، ایمیل، رنگ، کد، تصویر) بلافاصله ذخیره می‌شود |
| 🧠 تشخیص خودکار نوع | متن / لینک / ایمیل / رنگ HEX و RGB / کد / تصویر |
| 🔍 جستجوی لحظه‌ای | با میانبر `Ctrl+K` در هر جای فهرست جستجو کنید |
| ★ علاقه‌مندی و 📌 سنجاق | کلیپ‌های مهم را نشان کنید و همیشه بالا نگه دارید |
| ↻ حذف تکراری‌ها | کلیپ تکراری به ابتدای فهرست منتقل می‌شود |
| 🎨 تم تاریک/روشن + رنگ‌های تاکیدی | ۵ رنگ برجسته قابل انتخاب |
| 🌐 دوزبانه | فارسی (راست‌به‌چپ) و انگلیسی |
| ✦ دستیار هوشمند (AI) | خلاصه، ترجمه، توضیح و بازنویسی با OpenAI / Anthropic / DeepSeek / Ollama / سفارشی |
| 🔒 رمزنگاری AES-GCM | رمزنگاری اختیاری تاریخچه با رمز عبور |
| ⭳ خروجی / ورودی JSON | پشتیبان‌گیری و بازیابی کامل تاریخچه |
| ⌨ کلید میانبر سراسری | `Ctrl+Shift+V` برای بازکردن پنجره (ویندوز) |
| 🗔 سینی سیستم | اجرا در پس‌زمینه و بستن به سینی (ویندوز) |
| 🔄 بروزرسانی خودکار | نسخهٔ جدید از گیت‌هاب بررسی می‌شود؛ نسخهٔ قدیمی مسدود و لینک دانلود مستقیم نمایش داده می‌شود |
| ⭐ یادآوری حمایت | هر ۲ روز یک‌بار پنجرهٔ حمایت (ستاره در گیت‌هاب) با گزینهٔ «بعداً» نمایش داده می‌شود |
| 🔗 لینک سازنده | لینک گیت‌هاب پروژه و تلگرام سازنده در بخش «درباره» |

---

## 🔄 بروزرسانی خودکار و مسدودسازی نسخهٔ قدیمی

هر بار که برنامه اجرا می‌شود، آخرین نسخهٔ منتشرشده را از
[GitHub Releases](https://github.com/AnishtayiN/ClipBoard/releases)
بررسی می‌کند. اگر نسخهٔ جدیدتری وجود داشته باشد:

1. برنامه **مسدود** می‌شود (یک پنجرهٔ تمام‌صفحه روی رابط قرار می‌گیرد).
2. لینک **دانلود مستقیم** فایل نصب جدید (EXE برای ویندوز / APK برای اندروید) نمایش داده می‌شود.
3. کاربر با کلیک روی آن، فایل جدید را مستقیماً دانلود می‌کند.

### روش ۱ — رانِ دستی با ورود نسخه (پیشنهادی)

در صفحه‌ی **Actions** مخزن، گزینه‌ی **«Build & Release (Windows EXE + Android APK)»** را انتخاب کنید و
روی **Run workflow** بزنید. سپس این ورودی‌ها را پر کنید:

| ورودی | توضیح | مثال |
|---|---|---|
| `App version` | نسخه‌ی برنامه (سِـمور `MAJOR.MINOR.PATCH`) | `1.2.0` |
| `Android versionCode` | شماره‌ی نسخه‌ی اندروید (عدد صحیح) | `2` |
| `What to build` | کدام خروجی ساخته شود: `both` (هر دو) / `windows` / `android` | `both` |
| `Release notes` | توضیحات انتشار (اختیاری، مارک‌داون) | `Initial release` |
| `Draft` | ساخت به‌صورت پیش‌نویس | `false` یا `true` |
| `Prerelease` | علامت‌گذاری به‌عنوان پیش‌انتشار | `false` یا `true` |

CI، نسخه را به‌صورت خودکار در فایل‌های `package.json`، `package-lock.json`،
`app/config.js`، `app/index.html` و `android/app/build.gradle` اعمال می‌کند، سپس
EXE/APK را با همان نسخه می‌سازد و Release را با تگ `v<version>` منتشر می‌کند.
برای اعمال محلی نسخه هم می‌توانید از این دستور استفاده کنید:
`npm run set:version -- 1.2.0 2`

### روش ۲ — انتشار با تگ گیت‌هاب

1. نسخه را در **هر دو** فایل زیر افزایش دهید (مثلاً `1.0.0` → `1.0.1`):
   - `package.json` → فیلد `version`
   - `app/config.js` → `APP_VERSION`
2. تغییرات را commit کنید و یک **تگ نسخه** بسازید:
   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```
3. CI به‌صورت خودکار EXE و APK را می‌سازد و در یک Release با همان تگ منتشر می‌کند.
4. از این پس، همهٔ کاربرانِ نسخه‌های قدیمی هنگام بازکردن برنامه، نسخهٔ جدید را می‌بینند و مسدود می‌شوند.

> ⚠️ نسخهٔ داخل `app/config.js` و تگ گیت‌هاب باید **دقیقاً هم‌خوان** باشند؛ در غیر این صورت برنامه ممکن است خودش را هم مسدود کند.

---

## ⭐ یادآوری حمایت (هر ۲ روز)

برای حمایت از توسعهٔ برنامه، هر **۲ روز یک‌بار** پنجره‌ای نمایش داده می‌شود که کاربر را به صفحهٔ گیت‌هاب برای زدن **ستاره** هدایت می‌کند. این پنجره دکمهٔ **«بعداً»** دارد و کاربر می‌تواند آن را ببندد؛ پس از ۲ روز دوباره ظاهر می‌شود.

- گیت‌هاب پروژه: [github.com/AnishtayiN/ClipBoard](https://github.com/AnishtayiN/ClipBoard)
- تلگرام سازنده: [t.me/AnishtayiN](https://t.me/AnishtayiN)

---

## ⬇️ دانلود

به صفحه‌ی [Releases](https://github.com/AnishtayiN/ClipBoard/releases) بروید:

| فایل | پلتفرم |
|---|---|
| `NovaClip-Setup-1.0.0-x64.exe` | ویندوز ۷ تا ۱۱ — ۶۴ بیتی |
| `NovaClip-Setup-1.0.0-ia32.exe` | ویندوز ۷ تا ۱۱ — ۳۲ بیتی |
| `NovaClip-Setup-1.0.0.exe` | نصب‌کننده ترکیبی (هر دو معماری) |
| `NovaClip-v1.0.0-android.apk` | اندروید ۷.۰ به بعد |

---

## 🛠 ساخت از سورس

### پیش‌نیاز
- Node.js 18+ و npm
- برای ویندوز: فقط Node (ساخت روی CI هم انجام می‌شود)
- برای اندروید: JDK 17 + Android SDK (platform 34)

### نصب
```bash
npm install
```

### نسخه ویندوز (نصب‌کننده NSIS)
```bash
npm run build:win
```
خروجی در پوشه‌ی `dist/` تولید می‌شود:
- `NovaClip-Setup-1.0.0-x64.exe`
- `NovaClip-Setup-1.0.0-ia32.exe`

### نسخه اندروید (APK)
```bash
npm run build:android
```
خروجی: `android/app/build/outputs/apk/release/app-release.apk`

> پروژه‌ی اندروید از قبل در پوشه‌ی `android/` قرار دارد. اگر آن را حذف کردید:
> ```bash
> npx cap add android && npm run build:android
> ```

---

## 🧭 ساختار پروژه

```
ClipBoard/
├── app/                    # رابط کاربری مشترک (HTML/CSS/JS — برای هر دو پلتفرم)
│   ├── index.html          # ساختار رابط
│   ├── styles.css          # استایل‌ها، تم‌ها، واکنش‌گرایی
│   ├── config.js           # نسخه + لینک‌های گیت‌هاب/تلگرام سازنده
│   ├── i18n.js             # ترجمه‌ها (فارسی/انگلیسی)
│   ├── bridge.js           # لایه‌ی اتصال به پلتفرم (الکترون/اندروید/مرورگر)
│   ├── store.js            # ذخیره‌سازی + رمزنگاری AES-GCM
│   ├── updater.js          # بررسی بروزرسانی + یادآوری حمایت
│   └── app.js              # منطق اصلی برنامه
├── electron/               # پوسته‌ی ویندوز (Electron 22 — سازگار با ویندوز ۷)
│   ├── main.js             # کلیپ‌بورد، میانبر، سینی، IPC
│   └── preload.js          # پل امن بین UI و سیستم
├── android/                # پروژه‌ی اندروید (Capacitor 6 — minSdk 24)
│   └── app/src/main/java/com/novaclip/app/
│       ├── ClipboardManagerPlugin.java        # افزونه‌ی کلیپ‌بورد
│       ├── ClipboardMonitorService.java       # سرویس ثبت خودکار (اندروید ۷–۹)
│       └── ClipboardAccessibilityService.java # ثبت پس‌زمینه (اندروید ۱۰+)
├── build/                  # آیکون‌های برنامه (PNG/ICO)
├── .github/workflows/      # CI: ساخت EXE + APK و انتشار Release
└── scripts/                # تست دود (smoke test) + اسکریپت تنظیم نسخه
    ├── smoke.js            # تست دود رابط کاربری
    └── set-version.js      # اعمال نسخه در package.json / config.js / build.gradle
```

---

## ✦ راه‌اندازی دستیار هوشمند

در **تنظیمات ← هوش مصنوعی** یکی از سرویس‌دهنده‌ها را انتخاب کنید:

| سرویس | آدرس پایه (پیش‌فرض) | نیاز به کلید |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | ✅ |
| Anthropic | `https://api.anthropic.com/v1` | ✅ |
| DeepSeek | `https://api.deepseek.com/v1` | ✅ |
| Ollama (محلی) | `http://localhost:11434/v1` | ❌ |
| Custom | دلخواه | اختیاری |

---

## 🔒 رمزنگاری تاریخچه

در **تنظیمات ← امنیت** گزینه‌ی «رمزنگاری تاریخچه» را فعال کنید و یک رمز عبور تعیین کنید.
متن کلیپ‌ها با الگوریتم **AES-GCM 256** (مشتق‌سازی کلید PBKDF2 با ۱۵۰,۰۰۰ تکرار) رمزنگاری می‌شوند و بدون رمز عبور قابل خواندن نیستند.

---

## 📝 نکته‌ی اندروید

- در **اندروید ۷ تا ۹** ثبت خودکار کلیپ‌ها به‌صورت کامل در پس‌زمینه انجام می‌شود.
- در **اندروید ۱۰ به بعد** سیستم‌عامل دسترسی به کلیپ‌بورد در پس‌زمینه را محدود کرده است؛ برای ثبت خودکار کامل، سرویس دسترس‌پذیری NovaClip را در **تنظیمات ← دسترس‌پذیری** فعال کنید (بدون این سرویس، کلیپ‌ها هنگام باز بودن برنامه ثبت می‌شوند).

---

## 🧪 تست

```bash
npm run smoke
```

---

## 📄 مجوز

[MIT](LICENSE)

</div>

<hr/>

# ⧉ NovaClip — Cross-platform Clipboard Manager

A graphical, fast, offline clipboard manager with one shared UI for **Windows** and **Android**.

- 💻 **Windows**: EXE installer for **Windows 7 → 11** (32-bit & 64-bit)
- 📱 **Android**: APK for **Android 7.0+** (API 24+) up to the latest release

Copy anything and NovaClip saves, categorizes and re-serves it instantly.

## ✨ Features

- Automatic clipboard capture (text, links, emails, colors, code, images)
- Automatic type detection: text / link / email / HEX & RGB color / code / image
- Instant search (`Ctrl+K`), favorites ★ and pinning 📌
- Duplicate removal, sorting, JSON export/import
- Dark/light themes + 5 accent colors, RTL Persian & English UI
- AI assistant (summarize / translate / explain / rewrite) via OpenAI, Anthropic, DeepSeek, Ollama or any OpenAI-compatible endpoint
- Optional AES-GCM encrypted history with a password
- Global hotkey `Ctrl+Shift+V` and system tray (Windows)
- Automatic update check (blocks old builds + direct download links)
- Support reminder every 2 days (GitHub star) with a "Later" option
- Developer links (GitHub + Telegram) in the About section

## 🔀 Release with a custom version

### Manual Run (recommended)

Go to **Actions** → **Build & Release (Windows EXE + Android APK)** → **Run workflow**, then fill in:

| Input | Description | Example |
|---|---|---|
| `App version` | App version (semver `MAJOR.MINOR.PATCH`) | `1.2.0` |
| `Android versionCode` | Android build number (integer) | `2` |
| `What to build` | `both`, `windows` or `android` | `both` |
| `Release notes` | Optional Markdown release notes | `Initial release` |
| `Draft` | Create as draft | `false` / `true` |
| `Prerelease` | Mark as prerelease | `false` / `true` |

CI applies the version to `package.json`, `package-lock.json`, `app/config.js`, `app/index.html` and `android/app/build.gradle` automatically, builds the requested packages and publishes a GitHub Release tagged `v<version>`. To apply a version locally you can run `npm run set:version -- 1.2.0 2`.

### Tag Release

1. Bump the version in `package.json` (`version`) and `app/config.js` (`APP_VERSION`).
2. Commit the changes and push a tag:
   ```bash
   git tag v1.2.0
   git push origin v1.2.0
   ```
3. CI builds Windows EXE + Android APK and publishes a Release with that tag automatically.

## ⬇️ Download

See the [Releases](https://github.com/AnishtayiN/ClipBoard/releases) page.

| File | Platform |
|---|---|
| `NovaClip-Setup-1.0.0-x64.exe` | Windows 7 → 11 (64-bit) |
| `NovaClip-Setup-1.0.0-ia32.exe` | Windows 7 → 11 (32-bit) |
| `NovaClip-Setup-1.0.0.exe` | Combined installer (both architectures) |
| `NovaClip-v1.0.0-android.apk` | Android 7.0+ |

## 🛠 Build from source

```bash
npm install
npm run build:win      # Windows NSIS installer → dist/
npm run build:android  # Android APK → android/app/build/outputs/apk/release/
```

## 🧭 Tech stack

- **Windows**: Electron 22 (Chromium 108 — the last line compatible with Windows 7) + electron-builder/NSIS
- **Android**: Capacitor 6 (minSdk 24) + a native Java clipboard plugin (foreground service + accessibility service)
- **Shared UI**: vanilla HTML/CSS/JS — no framework, no CDN dependencies, fully offline

## 📄 License

[MIT](LICENSE)
