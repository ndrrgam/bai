#!/usr/bin/env node
/**
 * B.AI Auto-Get API Key (di LOKAL)
 * =================================
 * Login wallet yang sudah terdaftar di chat.b.ai, buka halaman /key,
 * create API key, dan OTOMATIS tangkap key PENUH dari response createApiKey.
 *
 * Di IP residential / browser manusia, response createApiKey berisi key lengkap
 * (bukan disamarkan seperti di IP data-center / browser otomatis).
 *
 * CARA PAKAI (di LOKAL):
 *   npm i playwright ethers
 *   npx playwright install chromium
 *   node auto_get_key_local.js <jumlah_key>
 *   -> masukkan ADDRESS + PRIVATE KEY wallet yang sudah terdaftar saat diminta
 *
 * Output: semua key penuh -> auto_get_keys.json
 */

const { chromium } = require("playwright");
const { Wallet } = require("ethers");
const fs = require("fs");
const readline = require("readline");

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a.trim()); }));
}

(async () => {
  const count = parseInt(process.argv[2] || "1", 10);
  const address = await ask("Wallet address (sudah terdaftar): ");
  const priv = await ask("Private key: ");
  if (!/^0x/.test(priv)) { console.log("Private key harus diawali 0x"); process.exit(1); }

  const browser = await chromium.launch({ headless: false, args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--window-size=1440,1000"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" });
  const page = await ctx.newPage();

  // Inject mock wallet MetaMask + ethers untuk signing
  await page.addInitScript(async ({ addr, pk }) => {
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
      }, on: () => {}, removeListener: () => {},
    };
    Object.defineProperty(window, "ethereum", { value: provider, configurable: true, writable: true });
    window.ethereumProviders = { MetaMask: provider };
    window.addEventListener("eip6963:requestProvider", (e) => {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "mock", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider } }));
    });
    window.dispatchEvent(new CustomEvent("eip6963:requestProvider"));
  }, { addr: address, priv });

  const keys = [];
  const gotKeys = new Set();

  // Tangkap response createApiKey - ambil key penuh
  ctx.on("response", async res => {
    if (/createApiKey/i.test(res.url())) {
      try {
        const t = await res.text();
        const m = t.match(/"key":"([^"]+)"/);
        if (m) {
          const k = m[1];
          const masked = k.includes("...") || k.includes("*") || k.length !== 35;
          if (!masked && !gotKeys.has(k)) {
            gotKeys.add(k);
            const idm = t.match(/"id":(\d+)/);
            const nm = t.match(/"name":"([^"]+)"/);
            keys.push({ id: idm ? idm[1] : "?", name: nm ? nm[1] : "?", key: k });
            console.log(`\n🎉 KEY PENUH DIDAPAT: ${k}`);
          }
        }
      } catch(e){}
    }
  });

  // Login
  console.log("Login wallet...");
  await page.goto("https://chat.b.ai/chat", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
  await page.waitForTimeout(4000);
  if (await page.getByRole("button", { name: /log in/i }).count()) {
    await page.getByRole("button", { name: /log in/i }).first().click();
    await page.waitForTimeout(2000);
    await page.getByRole("button", { name: /other login methods/i }).first().click();
    await page.waitForTimeout(1500);
    try { const b = page.getByRole("tab", { name: /evm/i }).first(); if (await b.count()) await b.click(); } catch(e){}
    await page.waitForTimeout(1200);
    try { const b = page.getByRole("button", { name: /metamask/i }).first(); if (await b.count()) await b.click(); } catch(e){}
    await page.waitForTimeout(6000);
  }
  console.log("Login done. Buka /key...");
  await page.goto("https://chat.b.ai/key", { waitUntil: "networkidle", timeout: 45000 }).catch(()=>{});
  await page.waitForTimeout(3000);

  // Create beberapa key
  for (let i = 0; i < count; i++) {
    console.log(`\nCreate key #${i+1}...`);
    let found = false;
    for (let s = 0; s < 10; s++) {
      await page.mouse.wheel(0, 700); await page.waitForTimeout(400);
      const btn = page.getByRole("button", { name: /create api key/i }).first();
      if (await btn.count()) { await btn.click(); found = true; break; }
    }
    if (!found) { try { const b = page.locator("text=Create API key").first(); if (await b.count()) await b.click(); found = true; } catch(e){} }
    await page.waitForTimeout(1500);
    try { const input = page.locator("input").last(); await input.fill("auto_" + Date.now().toString(36).slice(-6)); } catch(e){}
    await page.waitForTimeout(800);
    try { const c = page.locator("button:has-text('Confirm')").last(); if (await c.count()) await c.click(); } catch(e){}
    await page.waitForTimeout(4000);
    // reload page agar tombol create API key muncul lagi
    await page.reload({ waitUntil: "networkidle" }).catch(()=>{});
    await page.waitForTimeout(2500);
  }

  console.log("\n============= HASIL KEY =============");
  if (keys.length) {
    keys.forEach(k => console.log(`${k.name} | ${k.id} | ${k.key}`));
    fs.writeFileSync("auto_get_keys.json", JSON.stringify(keys, null, 2));
    console.log(`\nDisimpan ke auto_get_keys.json (${keys.length} key). Semua key siap inject 9Router.`);
  } else {
    console.log("⚠️ Tidak ada key penuh tertangkap. Berarti server tetap menyamarkan key di session ini (anti-bot Playwright).");
    console.log("Solusi: buka chat.b.ai/key manual di browser biasa, create key, copy dari Network -> createApiKey -> Response -> key.");
  }
  await browser.close();
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
