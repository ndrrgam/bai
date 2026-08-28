#!/usr/bin/env node
/**
 * B.AI REGISTER — dengan PROXY (bypass limit 3 akun/IP)
 * ======================================================
 * Register akun B.AI via YesCaptcha, dikirim lewat proxy residential.
 * Setiap proxy bisa register M aksun (default 3) sebelum dianggap capai limit.
 * Dengan banyak proxy -> banyak akun.
 *
 * CARA PAKAI:
 *   npm i ethers https-proxy-agent http-proxy-agent
 *
 *   # Proxy dari file proxies.txt (format: ip:port:user:pass per baris)
 *   node bai_register_proxy.js 3 proxies.txt
 *
 *   # Atau proxy inline (dipisah spasi/baris)
 *   node bai_register_proxy.js 3 "ip:port:user:pass ip2:port:user:pass ..."
 *
 *   Argumen: node bai_register_proxy.js <akun_per_proxy> <sumber_proxy>
 *
 * Output: bai_accounts.json (semua akun + sessionCookie)
 */

const { Wallet } = require("ethers");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { HttpProxyAgent } = require("http-proxy-agent");
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

// proxy string "ip:port:user:pass" -> "http://user:pass@ip:port"
function proxyUrl(proxy) {
  const [ip, port, user, pass] = proxy.split(":");
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${ip}:${port}`;
}

// req lewat proxy (untuk request B.AI). proxy = string "ip:port:user:pass" atau null
function req(method, url, body, headers = {}, jar = {}, proxy = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const allH = { ...FULL_HEADERS, ...headers };
    if (jar.cookie) allH.Cookie = jar.cookie;
    if (body) allH["Content-Type"] = headers["Content-Type"] || "application/x-www-form-urlencoded";
    const opts = { method, headers: allH };
    if (proxy) {
      opts.agent = u.protocol === "https:" ? new HttpsProxyAgent(proxyUrl(proxy)) : new HttpProxyAgent(proxyUrl(proxy));
    }
    const r = lib.request(u, opts, res => {
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
  const create = { clientKey, task: { type: "TurnstileTaskProxyless", websiteURL: ORIGIN, websiteKey: TURNSTILE_SITEKEY } };
  const c = await req("POST", `${YESCAPTCHA_API}/createTask`, JSON.stringify(create), { "Content-Type": "application/json" });
  let tid;
  try { tid = JSON.parse(c.body).taskId; } catch (e) { return null; }
  if (!tid) { console.log("   [YesCaptcha] createTask gagal:", c.body.slice(0, 120)); return null; }
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
  const exp = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const nonce = Math.random().toString(36).slice(2, 8).toUpperCase() + Date.now();
  return `Welcome to BAI !\nhttps://chat.b.ai wants you to sign in with your account:\n${addr}\n\nChain ID: 0x1\nExpiration Time: ${exp.toISOString()}\nNonce: ${nonce}`;
}

async function checkRegistered(addr, jar, proxy) {
  try {
    const r = await req("POST", `${ORIGIN}/trpc/lambda/wallet.checkWalletRegistration?batch=1`,
      JSON.stringify({ "0": { "json": { "address": addr, "chain": "eth" } } }),
      { "Content-Type": "application/json" }, jar, proxy);
    return !!JSON.parse(r.body)[0]?.result?.data?.json?.registered;
  } catch (e) { return false; }
}

async function registerOne(clientKey, proxy) {
  const w = Wallet.createRandom();
  const jar = {};
  const addr = w.address;

  const turnstileToken = await solveTurnstile(clientKey);
  if (!turnstileToken) return { address: addr, privateKey: w.privateKey, error: "turnstile-solve-fail" };

  const message = buildMessage(addr);
  const signature = await w.signMessage(message);

  const csrf = await req("GET", `${ORIGIN}/api/auth/csrf`, undefined, {}, jar, proxy);
  const csrfToken = JSON.parse(csrf.body).csrfToken;
  jar.cookie = csrf.jar.cookie;

  const url = `${ORIGIN}/api/auth/callback/metamask?`;
  const form = new URLSearchParams({ chain: "eth", message, signature, turnstileToken, version: "2", csrfToken, callbackUrl: `${ORIGIN}/chat` });
  const resp = await req("POST", url, form.toString(), { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" }, jar, proxy);

  let result = "?", apiAccessToken = null, userId = null;
  try {
    const j = JSON.parse(resp.body);
    result = j.url ? (new URL(j.url).searchParams.get("error") || "SUCCESS") : "?";
    if (j.apiAccessToken) {
      apiAccessToken = j.apiAccessToken;
      try { const p = JSON.parse(Buffer.from(j.apiAccessToken.split(".")[1], "base64url").toString()); userId = p.external_user_id || p.sub; } catch (e) {}
    }
  } catch (e) { result = resp.body.slice(0, 60); }

  let sessionCookie = jar.cookie || "";
  const hasSession = /__Secure-authjs\.session-token|authjs\.session-token/i.test(sessionCookie);

  await new Promise(r => setTimeout(r, 1500));
  const registered = await checkRegistered(addr, jar, proxy);

  return { address: addr, privateKey: w.privateKey, callbackStatus: resp.status, result, userId, apiAccessToken, registered, sessionCookie, proxy, createdAt: new Date().toISOString() };
}

function askKey() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question("YesCaptcha client key: ", a => { rl.close(); res(a.trim()); }));
}

(async () => {
  const perProxy = parseInt(process.argv[2] || "3", 10);
  const proxySource = process.argv[3] || "proxies.txt";

  let clientKey = process.env.YESCAPTCHA_CLIENT_KEY;
  if (!clientKey) clientKey = await askKey();
  if (!clientKey) { console.log("Tidak ada client key."); process.exit(1); }

  // Baca proxy dari file atau argumen inline
  let proxies = [];
  if (fs.existsSync(proxySource)) {
    proxies = fs.readFileSync(proxySource, "utf-8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } else {
    proxies = proxySource.split(/[\s,]+/).filter(Boolean);
  }
  if (!proxies.length) { console.log("Tidak ada proxy. Buat proxies.txt (format ip:port:user:pass) atau kasih argumen."); process.exit(1); }
  console.log(`[*] ${proxies.length} proxy, ${perProxy} akun per proxy (max), total potensi ${proxies.length * perProxy} akun`);

  // Append ke bai_accounts.json
  const DB_FILE = "bai_accounts.json";
  let all = [];
  if (fs.existsSync(DB_FILE)) { try { all = JSON.parse(fs.readFileSync(DB_FILE, "utf-8")); } catch (e) { all = []; } }

  const results = [];
  for (const proxy of proxies) {
    console.log(`\n===== PROXY ${proxy} =====`);
    let succ = 0, fail = 0;
    for (let i = 0; i < perProxy; i++) {
      try {
        const r = await registerOne(clientKey, proxy);
        console.log(`  [${i+1}] ${r.address}: result=${r.result} registered=${r.registered} session=${r.sessionCookie ? "YA" : "TIDAK"}${r.error ? " ERROR:" + r.error : ""}`);
        if (!r.error && r.result === "SUCCESS") {
          succ++;
          if (r.sessionCookie) all.push(r);
        } else {
          fail++;
          if (r.error) { console.log(`     -> stop akun di proxy ini (${r.error})`); break; }
        }
      } catch (e) {
        console.log(`  [${i+1}] ERROR: ${e.message}`);
        fail++;
      }
      await new Promise(r => setTimeout(r, 2500));
    }
    console.log(`  -> proxy ${proxy}: ${succ} sukses, ${fail} gagal`);
  }

  fs.writeFileSync(DB_FILE, JSON.stringify(all, null, 2));
  console.log(`\n[*] Total akun tersimpan di ${DB_FILE}: ${all.length}`);
})().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
