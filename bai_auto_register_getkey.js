#!/usr/bin/env node
/**
 * B.AI AUTO: REGISTER WALLET + GET API KEY — satu proses (lokal)
 * ==============================================================
 * Satu script, satu browser session:
 *   1. Generate wallet baru
 *   2. Login wallet baru (mock MetaMask). Kalau baru (perlu Turnstile),
 *      kamu solve manual di browser.
 *   3. Callback SUCCESS -> akun terdaftar + session cookie
 *   4. Buka /key -> Create API key
 *   5. TANGKAP key PENUH dari response createApiKey
 *   6. Simpan wallet + private key + API key ke bai_auto_results.json
 *
 * CARA PAKAI (lokal):
 *   npm i playwright ethers
 *   npx playwright install chromium
 *   node bai_auto_register_getkey.js
 *
 * Output: bai_auto_results.json  (array: address, privateKey, apiKey, apiAccessToken)
 */

const { chromium } = require("playwright");
const { Wallet } = require("ethers");
const fs = require("fs");

async function main() {
  const w = Wallet.createRandom();
  const name = "auto_" + Date.now().toString(36).slice(-6);
  console.log(`\n[*] Wallet baru: ${w.address}`);
  console.log(`[*] Private key: ${w.privateKey}`);
  console.log(`[*] Key name  : ${name}`);
  console.log(`[*] Membuka browser. Kalau muncul modal Turnstile, centang 'Verify you are human'.\n`);

  const browser = await chromium.launch({ headless: false, args: ["--disable-blink-features=AutomationControlled", "--window-size=1440,1000"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();

  // ==== Injeksi mock wallet MetaMask ====
  await page.addInitScript(async ({ addr, pk }) => {
    // Anti-detection minimal & aman (jangan spoof berlebihan — bisa bikin Turnstile error)
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.__pk = pk;
    window.__loadEthers = () => new Promise((res, rej) => {
      if (window.ethers) return res(window.ethers);
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js";
      s.onload = () => res(window.ethers); s.onerror = rej;
      document.head.appendChild(s);
    });
    const provider = {
      isMetaMask: true, _address: addr, chainId: "0x1",
      request: async ({ method, params }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [addr];
        if (method === "personal_sign" || method === "eth_sign") {
          const msg = Array.isArray(params) ? params[0] : params;
          try { const e = await window.__loadEthers(); return await new e.Wallet(window.__pk).signMessage(msg); }
          catch (e) { return "0x" + "00".repeat(65); }
        }
        if (method === "eth_chainId") return "0x1";
        if (method === "wallet_switchEthereumChain") return null;
        return null;
      },
      on: () => {}, removeListener: () => {},
    };
    Object.defineProperty(window, "ethereum", { value: provider, configurable: true, writable: true });
    window.ethereumProviders = { MetaMask: provider };
    window.addEventListener("eip6963:requestProvider", (e) => {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "mock", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider } }));
    });
    window.dispatchEvent(new CustomEvent("eip6963:requestProvider"));
  }, { addr: w.address, pk: w.privateKey });

  // ==== Tangkap callback + createApiKey response ====
  let callbackData = null, apiAccessToken = null, fullKey = null, createResp = null;
  ctx.on("request", req => {
    if (/callback\/metamask/.test(req.url())) callbackData = { url: req.url(), postData: req.postData() };
  });
  ctx.on("response", async res => {
    const u = res.url();
    try {
      const t = await res.text();
      if (/callback\/metamask/.test(u)) {
        try { const j = JSON.parse(t); apiAccessToken = j.apiAccessToken || null; } catch(e){}
      }
      if (/createApiKey/i.test(u)) {
        createResp = { status: res.status(), body: t };
        const m = t.match(/"key":"([^"]+)"/);
        if (m && !m[1].includes("...") && !m[1].includes("*") && m[1].length === 35) fullKey = m[1];
      }
    } catch(e){}
  });

  // ==== LOGIN wallet baru ====
  await page.goto("https://chat.b.ai/chat", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
  await page.waitForTimeout(4000);
  await page.getByRole("button", { name: /log in/i }).first().click().catch(()=>{});
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: /other login methods/i }).first().click().catch(()=>{});
  await page.waitForTimeout(1500);
  try { const b = page.getByRole("tab", { name: /evm/i }).first(); if (await b.count()) await b.click(); } catch(e){}
  await page.waitForTimeout(1200);
  try { const b = page.getByRole("button", { name: /metamask/i }).first(); if (await b.count()) await b.click(); } catch(e){}

  console.log("[*] Kalau ada modal Turnstile, centang 'Verify you are human' di browser...\n");

  // Tunggu Continue enable (user solve turnstile) atau langsung login kalau sudah terdaftar
  const continueBtn = page.getByRole("button", { name: /continue/i }).first();
  try { await continueBtn.waitFor({ state: "visible", timeout: 20000 }); } catch(e){}
  let enabled = false;
  for (let i = 0; i < 60; i++) {
    try { enabled = await continueBtn.isEnabled(); if (enabled) break; } catch(e){}
    // Deteksi error "verification failed" di halaman
    const bodyTxt = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 400) : "").catch(()=>"");
    if (/verification failed|verification error|failed/i.test(bodyTxt)) {
      console.log("[!] Halaman menampilkan error verifikasi. Teks:", JSON.stringify(bodyTxt.slice(0, 200)));
      break;
    }
    await page.waitForTimeout(1000);
  }
  try { enabled = await continueBtn.isEnabled(); } catch(e){}
  if (enabled) { await continueBtn.click(); console.log("[*] Continue diklik. Menunggu login..."); }
  await page.waitForTimeout(6000);
  console.log("[*] Status login. URL:", page.url());

  // ==== GET API KEY via fetch langsung dari page (pakai session cookie) ====
  // Setelah login, session cookie (__Secure-authjs.session-token) sudah ada di browser.
  // Panggil tRPC apiKey.createApiKey langsung dari dalam page — cookie otomatis terkirim,
  // tidak perlu navigasi ke /key (yang bermasalah). 
  await page.waitForTimeout(3000);
  console.log("[*] Panggil apiKey.createApiKey langsung (pakai session cookie)...");

  let keyResp = null;
  try {
    keyResp = await page.evaluate(async (keyName) => {
      const r = await fetch("https://chat.b.ai/trpc/lambda/apiKey.createApiKey?batch=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "0": { "json": { "group": "default", "name": keyName } } }),
      });
      const text = await r.text();
      return { status: r.status, body: text };
    }, name);
  } catch(e) { console.log("[!] fetch createApiKey error:", e.message); }
  createResp = keyResp ? { status: keyResp.status, body: keyResp.body } : null;
  if (keyResp) {
    console.log("[*] createApiKey status:", keyResp.status);
    const m = keyResp.body.match(/"key":"([^"]+)"/);
    if (m && !m[1].includes("...") && !m[1].includes("*") && m[1].length === 35) fullKey = m[1];
  }

  if (!fullKey && keyResp && keyResp.body) {
    // coba juga lewat navigasi /key sebagai fallback
    console.log("[*] Key belum penuh via fetch. Coba lewat halaman /key...");
    await page.goto("https://chat.b.ai/key", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(()=>{});
    await page.waitForTimeout(4000);
    let created = false;
    for (let s = 0; s < 10; s++) {
      await page.mouse.wheel(0, 700); await page.waitForTimeout(400);
      const btn = page.getByRole("button", { name: /create api key/i }).first();
      if (await btn.count()) { await btn.click(); created = true; break; }
    }
    if (!created) { try { const b = page.locator("text=Create API key").first(); if (await b.count()) await b.click(); created = true; } catch(e){} }
    await page.waitForTimeout(1500);
    try { const input = page.locator("input").last(); await input.fill(name); } catch(e){}
    await page.waitForTimeout(800);
    try { const c = page.locator("button:has-text('Confirm')").last(); if (await c.count()) await c.click(); } catch(e){}
    await page.waitForTimeout(4500);
  }

  // ==== OUTPUT ====
  console.log("\n=============== HASIL ===============");
  console.log("Wallet       :", w.address);
  console.log("Private key  :", w.privateKey);
  console.log("Registered   :", callbackData ? "callback dikirim" : "?");
  console.log("apiAccessToken:", apiAccessToken ? "YES (session UI, bukan sk- key)" : "tidak");
  if (fullKey) {
    console.log("🎉 API KEY PENUH:", fullKey);
  } else {
    console.log("⚠️ API key TIDAK penuh tertangkap.");
    console.log("   createApiKey response:", createResp ? createResp.body.slice(0, 200) : "(tidak ada)");
    console.log("   Kemungkinan server menyamarkan key di session otomatis.");
  }

  const result = { address: w.address, privateKey: w.privateKey, apiAccessToken, apiKey: fullKey, createApiKeyResponse: createResp ? createResp.body : null };
  const all = fs.existsSync("bai_auto_results.json") ? JSON.parse(fs.readFileSync("bai_auto_results.json", "utf-8")) : [];
  all.push(result);
  fs.writeFileSync("bai_auto_results.json", JSON.stringify(all, null, 2));
  console.log("\nTersimpan ke bai_auto_results.json");

  await new Promise(r => setTimeout(r, 1500));
  await browser.close();
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
