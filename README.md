# B.AI Wallet Auto-Register & API Key Bot

Auto-register akun [chat.b.ai](https://chat.b.ai) via **EVM wallet** + **auto-get API key**, untuk dipakai di [9Router](https://9router.uselessje.dev).

## Fitur / Script

| Script | Fungsi | Jalan di |
|--------|--------|----------|
| `bai_wallet_yescaptcha.js` | Auto-register wallet, Turnstile di-solve otomatis via YesCaptcha | Lokal (IP residential) |
| `bai_wallet_proxy.js` | Auto-register wallet lewat HTTP proxy | VPS/server |
| `bai_wallet_browser.js` | Full browser flow (manual solve Turnstile di browser) | Lokal |
| `bai_auto_register_getkey.js` | **Register + Get API key** dalam satu proses | Lokal |
| `auto_get_key_local.js` | Login wallet + get API key penuh | Lokal |

## Setup

```bash
npm init -y
npm i ethers playwright
npx playwright install chromium
```

## Cara Pakai

### 1. Auto-register wallet (YesCaptcha) — lokal
```bash
node bai_wallet_yescaptcha.js 5
```
Masukkan **YesCaptcha client key** saat diminta. Output → `bai_wallet_yes_results.json`.

### 2. Auto-register wallet (proxy) — VPS
```bash
node bai_wallet_proxy.js 5 "http://user:pass@ip:port"
```
Output → `bai_wallet_proxy_results.json`.

### 3. Register + get API key (satu proses) — lokal
```bash
node bai_auto_register_getkey.js
```
Buka browser → solve Turnstile manual kalau muncul → script lanjut buat API key otomatis.
Output → `bai_auto_results.json` (address + private key + apiKey).

### 4. Get API key untuk akun yang sudah ada — lokal
```bash
node auto_get_key_local.js 1
```
Masukkan address + private key. Output → `auto_get_keys.json`.

## Inject ke 9Router

Setelah dapat key `sk-...`, inject ke 9Router (dari VPS yang punya DB):
```bash
node fix_inject_bai.js "sk-XXXX"
```

## Catatan Penting

- **Private key = kunci wallet**, simpan aman. Jangan commit file hasil (`*.json` sudah di `.gitignore`).
- `apiAccessToken` dari auto-register **bukan** API key — itu JWT session chat UI saja.
- Key `sk-` penuh hanya muncul di **IP residential / browser yang dianggap manusia**. Di IP data-center / browser otomatis, B.AI menyamarkan key (`sk-xx...yy`).
- YesCaptcha `TurnstileTaskProxyless` valid hanya di IP residential/proxy. Di IP data-center → `Configuration`.

## Skema Callback (untuk referensi)
```
POST /api/auth/callback/metamask?
Content-Type: application/x-www-form-urlencoded
X-Auth-Return-Redirect: 1
body: chain=eth&message=...&signature=...&turnstileToken=...&version=2&csrfToken=...&callbackUrl=https://chat.b.ai/chat
```
**`version` harus `2`** (bukan 1). Turnstile sitekey: `0x4AAAAAADKhTSXIozuHjOoF`.
