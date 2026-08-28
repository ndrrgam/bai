#!/usr/bin/env node
/**
 * B.AI Wallet Auto-Register — FULL BROWSER FLOW (lokal)
 * =====================================================
 * Membuka browser nyata di LOKAL, injeksi mock wallet MetaMask,
 * sampai ke modal Turnstile. Kamu solve Turnstile manual di browser,
 * lalu script lanjut otomatis (klik Continue -> sign -> callback).
 *
 * Keunggulan: semua terjadi dalam SATU browser session nyata di IP-mu,
 * jadi tidak ada masalah binding token/session/IP/fingerprint.
 *
 * CARA PAKAI:
 *   1. npm i playwright
 *   2. npx playwright install chromium   (sekali)
 *   3. node bai_wallet_browser.js
 *   4. Browser terbuka -> script klik otomatis sampai modal turnstile
 *   5. Kamu centang "Verify you are human" di browser
 *   6. Script otomatis klik Continue, sign, dan kirim callback
 *   7. Hasil tampil di console + tersimpan ke bai_wallet_browser_results.json
 *
 * SETIAP akun = wallet baru. Run lagi untuk akun berikutnya.
 */

const { chromium } = require("playwright");
const { Wallet } = require("ethers");
const fs = require("fs");

async function main() {
  const w = Wallet.createRandom();
  console.log(`\n[*] Wallet baru: ${w.address}`);
  console.log(`[*] Private key: ${w.privateKey}`);
  console.log(`[*] Membuka browser (headed). Tunggu sampai modal Turnstile muncul.\n`);

  const browser = await chromium.launch({ headless: false, args: ["--disable-blink-features=AutomationControlled"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // ==== Injeksi mock wallet MetaMask ====
  await page.addInitScript(async ({ addr, pk }) => {
    window.__capturedSign = [];
    window.__mockAddr = addr;
    // Load ethers into page for signing
    window.__loadEthers = () => new Promise((res, rej) => {
      if (window.ethers) return res(window.ethers);
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js";
      s.onload = () => res(window.ethers); s.onerror = rej;
      document.head.appendChild(s);
    });
    window.__pk = pk;
    const provider = {
      isMetaMask: true, _address: addr, chainId: "0x1",
      request: async ({ method, params }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [addr];
        if (method === "personal_sign" || method === "eth_sign") {
          const msg = Array.isArray(params) ? params[0] : params;
          window.__capturedSign.push(msg);
          try {
            const ethers = await window.__loadEthers();
            const sig = await new ethers.Wallet(window.__pk).signMessage(msg);
            return sig;
          } catch (e) { return "0x" + "00".repeat(65); }
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

  // ===== Tangkap request callback & pesan sign =====
  let callbackData = null;
  ctx.on("request", req => {
    if (/callback\/metamask/.test(req.url())) {
      callbackData = { url: req.url(), postData: req.postData() };
      console.log("\n>>> METAMASK CALLBACK DITANGKAP <<<");
      console.log("POST data:", req.postData());
    }
  });
  ctx.on("response", async res => {
    if (/callback\/metamask/.test(res.url())) {
      console.log(">>> CALLBACK RESPONSE:", res.status());
      try { console.log("body:", (await res.text()).slice(0, 300)); } catch (e) {}
    }
  });

  // ===== Navigasi & alur login =====
  await page.goto("https://chat.b.ai/chat", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
  await page.waitForTimeout(4000);
  await page.getByRole("button", { name: /log in/i }).first().click().catch(()=>{});
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: /other login methods/i }).first().click().catch(()=>{});
  await page.waitForTimeout(1500);
  try { const b = page.getByRole("tab", { name: /evm/i }).first(); if (await b.count()) await b.click(); } catch(e){}
  await page.waitForTimeout(1200);
  try { const b = page.getByRole("button", { name: /metamask/i }).first(); if (await b.count()) await b.click(); } catch(e){}

  console.log("\n[*] Menunggu kamu solve Turnstile di browser... (centang 'Verify you are human')\n");

  // ===== Tunggu Continue enable & klik =====
  const continueBtn = page.getByRole("button", { name: /continue/i }).first();
  try {
    await continueBtn.waitFor({ state: "visible", timeout: 30000 });
  } catch(e) {}
  // polling sampai enabled (user solve turnstile)
  for (let i = 0; i < 60; i++) {
    try { if (await continueBtn.isEnabled()) break; } catch(e){}
    await page.waitForTimeout(1000);
  }
  let enabled = false;
  try { enabled = await continueBtn.isEnabled(); } catch(e){}
  console.log("[*] Continue enabled:", enabled);
  if (!enabled) { console.log("[!] Turnstile tidak selesai dalam 60 detik. Cek browser & coba lagi."); await browser.close(); return; }

  await continueBtn.click();
  console.log("[*] Continue diklik. Mock wallet menandatangani pesan otomatis di browser...");
  await page.waitForTimeout(6000);
  await page.screenshot({ path: "bai_wallet_browser_shot.png" }).catch(()=>{});

  console.log("\n=== RINGKASAN ===");
  console.log("Wallet:", w.address);
  console.log("Private key:", w.privateKey);
  console.log("Callback data:", callbackData ? "tertangkap" : "TIDAK tertangkap");
  if (callbackData) console.log("Post data:", callbackData.postData);

  fs.writeFileSync("bai_wallet_browser_results.json", JSON.stringify({
    address: w.address, privateKey: w.privateKey, callback: callbackData,
  }, null, 2));
  console.log("Tersimpan: bai_wallet_browser_results.json");

  await new Promise(r => setTimeout(r, 2000));
  await browser.close();
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
