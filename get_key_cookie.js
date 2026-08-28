#!/usr/bin/env node
/**
 * B.AI GET API KEY — input COOKIE manual (lokal)
 * ==============================================
 * Buat API key B.AI dengan paste COOKIE SESSION dari browser yang SUDAH login.
 * Tidak perlu register/login lagi. Jalan di Node langsung (bukan Playwright).
 *
 * CARA AMBIL COOKIE (di browser yang sudah login chat.b.ai):
 *   F12 -> Application (Chrome) / Storage (Firefox) -> Cookies -> https://chat.b.ai
 *   Copy nilai semua cookie, atau copy dari header `Cookie:` di Network request.
 *   Lalu paste ke script ini.
 *
 * CARA PAKAI:
 *   node get_key_cookie.js [jumlah_key]
 *   -> paste cookie saat diminta
 *   -> script panggil apiKey.createApiKey dan tangkap key penuh
 *
 * Output: get_key_cookie_results.json
 */

const https = require("https");
const fs = require("fs");
const readline = require("readline");

const ORIGIN = "https://chat.b.ai";

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a.trim()); }));
}

function req(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request(u, {
      method,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Origin": ORIGIN,
        "Referer": `${ORIGIN}/key`,
        ...headers,
      },
    }, res => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  const count = parseInt(process.argv[2] || "1", 10);
  const rawCookie = await ask("Paste Cookie session chat.b.ai (dari DevTools -> Application -> Cookies): ");
  if (!rawCookie.trim()) { console.log("Tidak ada cookie."); process.exit(1); }

  // Cookie bisa dipaste sebagai "key=value; key2=value2" atau "key=value\nkey2=value"
  const cookieStr = rawCookie
    .replace(/\r?\n/g, "; ")
    .replace(/^cookie:\s*/i, "")
    .trim();

  // Pastikan ada session token
  const hasSession = /__Secure-authjs\.session-token|authjs\.session-token/i.test(cookieStr);
  console.log("[*] Cookie diterima:", cookieStr.slice(0, 60) + "...");
  console.log("[*] Session token ada:", hasSession ? "YA" : "TIDAK (mungkin belum login!)");

  // Ambil CSRF token (opsional, untuk header)
  let csrfToken = "";
  try {
    const csrf = await req("GET", `${ORIGIN}/api/auth/csrf`, undefined, { Cookie: cookieStr });
    const m = csrf.body.match(/"csrfToken":"([^"]+)"/);
    if (m) csrfToken = m[1];
  } catch(e){}
  console.log("[*] CSRF token:", csrfToken ? "didapat" : "tidak");

  const results = [];
  for (let i = 0; i < count; i++) {
    const name = "kc_" + Date.now().toString(36).slice(-6) + "_" + i;
    console.log(`\n[*] Create key #${i+1}: ${name}`);
    const body = JSON.stringify({ "0": { "json": { "group": "default", "name": name } } });
    const r = await req("POST", `${ORIGIN}/trpc/lambda/apiKey.createApiKey?batch=1`, body, {
      "Content-Type": "application/json",
      "Cookie": cookieStr,
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
    });
    console.log("[*] status:", r.status, "|", r.body.slice(0, 200));
    const m = r.body.match(/"key":"([^"]+)"/);
    if (m) {
      const key = m[1];
      const full = !key.includes("...") && !key.includes("*") && key.length === 35;
      console.log(full ? `🎉 KEY PENUH: ${key}` : `⚠️ KEY MASKED: ${key} (server samarkan — coba dari IP residential/manusia)`);
      results.push({ name, key, full, status: r.status, raw: r.body });
    } else {
      results.push({ name, status: r.status, raw: r.body, error: "no key in response" });
    }
    if (i < count - 1) await new Promise(res => setTimeout(res, 2000));
  }

  fs.writeFileSync("get_key_cookie_results.json", JSON.stringify(results, null, 2));
  console.log("\n=== HASIL ===");
  results.forEach(r => {
    if (r.full) console.log(`🎉 ${r.name}: ${r.key} (PENUH)`);
    else if (r.key) console.log(`⚠️ ${r.name}: ${r.key} (MASKED)`);
    else console.log(`❌ ${r.name}: ${r.error || r.raw}`);
  });
  console.log("\nDisimpan ke get_key_cookie_results.json");
})().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
