#!/usr/bin/env node
/**
 * B.AI Wallet Auto-Register — lewat PROXY (VPS)
 * =============================================
 * Sama seperti bai_wallet_yescaptcha.js, tapi callback dikirim lewat PROXY
 * (IP residential/proxy) supaya account creation lolos anti-bot IP.
 *
 * CARA PAKAI (di VPS/server):
 *   1. npm i ethers https-proxy-agent http-proxy-agent
 *   2. node bai_wallet_proxy.js <jumlah> <proxy_url>
 *      contoh: node bai_wallet_proxy.js 1 "http://gqjoutmc:jusgw043ihnb@142.111.67.146:5611"
 *   3. Masukkan YesCaptcha client key saat diminta.
 *
 * Output: alamat + private key + apiAccessToken -> bai_wallet_proxy_results.json
 */

const { Wallet } = require("ethers");
const https = require("https");
const http = require("http");
const fs = require("fs");
const readline = require("readline");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { HttpProxyAgent } = require("http-proxy-agent");

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

let proxyAgent = null; // agent for chat.b.ai requests (proxy)

function req(method, url, body, headers = {}, jar = {}, useProxy = true) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const allH = { ...FULL_HEADERS, ...headers };
    if (jar.cookie) allH.Cookie = jar.cookie;
    if (body) allH["Content-Type"] = headers["Content-Type"] || "application/x-www-form-urlencoded";
    const opts = { method, headers: allH };
    if (useProxy && proxyAgent) {
      opts.agent = u.protocol === "https:" ? proxyAgent.https : proxyAgent.http;
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

// YesCaptcha — TIDAK lewat proxy (proxyless)
async function solveTurnstile(clientKey) {
  const create = { clientKey, task: { type: "TurnstileTaskProxyless", websiteURL: ORIGIN, websiteKey: TURNSTILE_SITEKEY } };
  const c = await req("POST", `${YESCAPTCHA_API}/createTask`, JSON.stringify(create), { "Content-Type": "application/json" }, {}, false);
  let tid; try { tid = JSON.parse(c.body).taskId; } catch (e) { return null; }
  if (!tid) { console.log("[!] YesCaptcha createTask gagal:", c.body.slice(0, 150)); return null; }
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const rr = await req("POST", `${YESCAPTCHA_API}/getTaskResult`, JSON.stringify({ clientKey, taskId: tid }), { "Content-Type": "application/json" }, {}, false);
    let d; try { d = JSON.parse(rr.body); } catch (e) { continue; }
    if (d.status === "ready") return d.solution?.token || null;
    if (d.errorId !== 0) return null;
  }
  return null;
}

function buildMessage(address) {
  const exp = new Date(Date.now() + 864e5).toISOString();
  const nonce = Math.random().toString(36).slice(2, 8).toUpperCase() + Date.now();
  return `Welcome to BAI !\n${ORIGIN} wants you to sign in with your account:\n${address}\n\nChain ID: 0x1\nExpiration Time: ${exp}\nNonce: ${nonce}`;
}

async function checkRegistered(address, jar) {
  const input = JSON.stringify({ "0": { json: { address, chain: "eth" } } });
  const url = `${ORIGIN}/trpc/lambda/wallet.checkWalletRegistration?batch=1&input=${encodeURIComponent(input)}`;
  const r = await req("GET", url, undefined, { "x-ainft-chat-auth": "N00DBisQEVOB2EQpTVhHallAPhoMESEYB3Cw2FYlCwcXak9AIx8HCykcQF0=" }, jar);
  try { return !!JSON.parse(r.body)[0]?.result?.data?.json?.registered; } catch (e) { return false; }
}

async function registerOne(clientKey) {
  const w = Wallet.createRandom();
  const jar = {};
  const addr = w.address;
  console.log(`\n[*] Wallet: ${addr}`);

  console.log("[*] Solve Turnstile via YesCaptcha...");
  const turnstileToken = await solveTurnstile(clientKey);
  if (!turnstileToken) { console.log("[!] Gagal solve turnstile."); return { address: addr, privateKey: w.privateKey, error: "turnstile-solve-fail" }; }
  console.log(`[*] Turnstile OK (${turnstileToken.length})`);

  const message = buildMessage(addr);
  const signature = await w.signMessage(message);

  console.log("[*] Kirim callback lewat PROXY...");
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
      try { const p = JSON.parse(Buffer.from(j.apiAccessToken.split(".")[1], "base64url").toString()); userId = p.external_user_id || p.sub; } catch (e) {}
    }
  } catch (e) { result = resp.body.slice(0, 60); }

  console.log(`[*] Callback: status=${resp.status} | result=${result} | apiToken=${apiAccessToken ? "YES" : "NO"}`);

  await new Promise(r => setTimeout(r, 1500));
  const registered = await checkRegistered(addr, jar);
  console.log(`[*] Terdaftar: ${registered}`);

  return { address: addr, privateKey: w.privateKey, callbackStatus: resp.status, result, userId, apiAccessToken, registered };
}

function askKey() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question("YesCaptcha client key: ", a => { rl.close(); res(a.trim()); }));
}

(async () => {
  const args = process.argv.slice(2);
  const count = parseInt(args[0] || "1", 10);
  const proxyUrl = args[1] || process.env.PROXY_URL;
  if (!proxyUrl) { console.log("Gunakan: node bai_wallet_proxy.js <jumlah> <proxy_url>"); process.exit(1); }

  proxyAgent = {
    https: new HttpsProxyAgent(proxyUrl),
    http: new HttpProxyAgent(proxyUrl),
  };
  console.log(`[*] Proxy: ${proxyUrl.replace(/\/\/[^:]+:[^@]+@/, "//***:***@")}`);

  let clientKey = process.env.YESCAPTCHA_CLIENT_KEY;
  if (!clientKey) clientKey = await askKey();
  if (!clientKey) { console.log("Tidak ada client key."); process.exit(1); }

  const results = [];
  for (let i = 0; i < count; i++) {
    try { results.push(await registerOne(clientKey)); }
    catch (e) { console.log("[!] Error:", e.message); results.push({ error: e.message }); }
    if (i < count - 1) await new Promise(r => setTimeout(r, 3000));
  }
  fs.writeFileSync("bai_wallet_proxy_results.json", JSON.stringify(results, null, 2));
  console.log("\n=== DISIMPAN KE bai_wallet_proxy_results.json ===");
  results.forEach((r, i) => {
    if (r.address) console.log(`${i+1}. ${r.address} | ${r.result} | registered=${r.registered}${r.apiAccessToken ? " | HAS API TOKEN" : ""}`);
    else console.log(`${i+1}. ERROR: ${r.error}`);
  });
})();
