#!/usr/bin/env node
/**
 * B.AI REGISTER + SAVE COOKIE — auto (lokal, IP residential)
 * ===========================================================
 * Register akun baru via YesCaptcha (otomatis solve Turnstile),
 * lalu SIMPAN session cookie ke file — siap dipakai get_key_cookie.js.
 *
 * Workflow: Register akun → yescaptcha → get cookie → save cookie
 *
 * CARA PAKAI (di LOKAL, IP residential):
 *   1. npm i ethers
 *   2. node bai_register_save_cookie.js <jumlah>
 *   3. Masukkan YESCAPTCHA_CLIENT_KEY saat diminta (atau set env)
 *
 * Output:
 *   - cookies/<address>.txt  -> cookie session (untuk get_key_cookie.js)
 *   - bai_register_cookies.json -> ringkasan semua akun
 */

const { Wallet } = require("ethers");
const https = require("https");
const http = require("http");
const fs = require("fs");
const readline = require("readline");

const ORIGIN = "https://chat.b.ai";
const TURNSTILE_SITEKEY = "0x4AAAAAADKhTSXIozuHjOoF";
const YESCAPTCHA_API = "https://api.yescaptcha.com";

const FULL_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/x-www-form-urlencoded, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": ORIGIN,
  "Referer": `${ORIGIN}/chat`,
};

function req(method, url, body, headers = {}, jar = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const allH = { ...FULL_HEADERS, ...headers };
    if (jar.cookie) allH.Cookie = jar.cookie;
    if (body) allH["Content-Type"] = headers["Content-Type"] || "application/x-www-form-urlencoded";
    const r = lib.request(u, { method, headers: allH }, res => {
      let d = ""; res.setEncoding("utf8"); res.on("data", c => d += c);
      res.on("end", () => {
        const sc = res.headers["set-cookie"];
        if (sc) jar.cookie = sc.map(s => s.split(";")[0]).join("; ");
        resolve({ status: res.statusCode, body: d, headers: res.headers, jar });
      });
    });
    r.on("error", reject);
    if (body) r.write(typeof body === "string" ? body : JSON.stringify(body));
    r.end();
  });
}

async function solveTurnstile(clientKey) {
  const create = {
    clientKey,
    task: { type: "TurnstileTaskProxyless", websiteURL: ORIGIN, websiteKey: TURNSTILE_SITEKEY },
  };
  const c = await req("POST", `${YESCAPTCHA_API}/createTask`, JSON.stringify(create), { "Content-Type": "application/json" });
  let tid;
  try { tid = JSON.parse(c.body).taskId; } catch (e) { return null; }
  if (!tid) { console.log("[!] YesCaptcha createTask gagal:", c.body.slice(0, 150)); return null; }
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const rr = await req("POST", `${YESCAPTCHA_API}/getTaskResult`, JSON.stringify({ clientKey, taskId: tid }), { "Content-Type": "application/json" });
    let d; try { d = JSON.parse(rr.body); } catch (e) { continue; }
    if (d.status === "ready") return d.solution?.token || null;
    if (d.errorId !== 0) return null;
  }
  return null;
}

function buildMessage(addr) {
  const now = new Date();
  const exp = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const nonce = Math.random().toString(36).slice(2, 8).toUpperCase() + Date.now();
  return `Welcome to BAI !\nhttps://chat.b.ai wants you to sign in with your account:\n${addr}\n\nChain ID: 0x1\nExpiration Time: ${exp.toISOString()}\nNonce: ${nonce}`;
}

async function checkRegistered(addr, jar) {
  try {
    const r = await req("POST", `${ORIGIN}/trpc/lambda/wallet.checkWalletRegistration?batch=1`,
      JSON.stringify({ "0": { "json": { "address": addr, "chain": "eth" } } }),
      { "Content-Type": "application/json" }, jar);
    return !!JSON.parse(r.body)[0]?.result?.data?.json?.registered;
  } catch (e) { return false; }
}

async function registerOne(clientKey) {
  const w = Wallet.createRandom();
  const jar = {};
  const addr = w.address;
  console.log(`\n[*] Wallet: ${addr}`);

  console.log("[*] Solve Turnstile via YesCaptcha...");
  const turnstileToken = await solveTurnstile(clientKey);
  if (!turnstileToken) { console.log("[!] Gagal solve turnstile."); return { address: addr, privateKey: w.privateKey, error: "turnstile-solve-fail" }; }
  console.log(`[*] Turnstile token OK (${turnstileToken.length} chars)`);

  const message = buildMessage(addr);
  const signature = await w.signMessage(message);

  const csrf = await req("GET", `${ORIGIN}/api/auth/csrf`);
  const csrfToken = JSON.parse(csrf.body).csrfToken;
  jar.cookie = csrf.jar.cookie;

  const url = `${ORIGIN}/api/auth/callback/metamask?`;
  const form = new URLSearchParams({ chain: "eth", message, signature, turnstileToken, version: "2", csrfToken, callbackUrl: `${ORIGIN}/chat` });
  const resp = await req("POST", url, form.toString(), { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" }, jar);

  let result = "?", apiAccessToken = null, userId = null;
  try {
    const j = JSON.parse(resp.body);
    result = j.url ? (new URL(j.url).searchParams.get("error") || "SUCCESS") : "?";
    if (j.apiAccessToken) {
      apiAccessToken = j.apiAccessToken;
      try { const payload = JSON.parse(Buffer.from(j.apiAccessToken.split(".")[1], "base64url").toString()); userId = payload.external_user_id || payload.sub; } catch (e) {}
    }
  } catch (e) { result = resp.body.slice(0, 60); }

  // SETELAH callback, ambil session cookie dari jar
  const sessionCookie = jar.cookie || "";
  const hasSession = /__Secure-authjs\.session-token|authjs\.session-token/i.test(sessionCookie);
  console.log(`[*] Callback: status=${resp.status} | result=${result} | apiToken=${apiAccessToken ? "YES" : "NO"} | sessionCookie=${hasSession ? "YA" : "TIDAK"}`);
  if (sessionCookie) console.log(`[*] Cookie: ${sessionCookie.slice(0, 60)}...`);

  await new Promise(r => setTimeout(r, 1500));
  const registered = await checkRegistered(addr, jar);
  console.log(`[*] Terdaftar: ${registered}`);

  // Simpan cookie ke file
  const cookieFile = `cookies/${addr}.txt`;
  if (sessionCookie) {
    fs.mkdirSync("cookies", { recursive: true });
    fs.writeFileSync(cookieFile, sessionCookie);
    console.log(`[*] Cookie disimpan: ${cookieFile}`);
  }

  return { address: addr, privateKey: w.privateKey, callbackStatus: resp.status, result, userId, apiAccessToken, registered, sessionCookie: sessionCookie ? sessionCookie.slice(0, 80) : "", cookieFile: sessionCookie ? cookieFile : null };
}

function askKey() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question("YesCaptcha client key: ", a => { rl.close(); res(a.trim()); }));
}

(async () => {
  const count = parseInt(process.argv[2] || "1", 10);
  let clientKey = process.env.YESCAPTCHA_CLIENT_KEY;
  if (!clientKey) clientKey = await askKey();
  if (!clientKey) { console.log("Tidak ada client key."); process.exit(1); }

  fs.mkdirSync("cookies", { recursive: true });
  const results = [];
  for (let i = 0; i < count; i++) {
    try { results.push(await registerOne(clientKey)); }
    catch (e) { console.log("[!] Error:", e.message); results.push({ error: e.message }); }
    if (i < count - 1) await new Promise(r => setTimeout(r, 3000));
  }
  fs.writeFileSync("bai_register_cookies.json", JSON.stringify(results, null, 2));
  console.log("\n=== RINGKASAN ===");
  results.forEach(r => {
    if (r.error) console.log(`❌ ${r.address || "?"}: ${r.error}`);
    else console.log(`${r.sessionCookie ? "✅" : "⚠️"} ${r.address}: result=${r.result} registered=${r.registered} cookie=${r.cookieFile || "TIDAK"}`);
  });
  console.log("\nDisimpan: bai_register_cookies.json + cookies/<addr>.txt");
})().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
