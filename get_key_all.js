#!/usr/bin/env node
/**
 * B.AI GET KEY — proses SEMUA akun di bai_accounts.json sekaligus
 * ==============================================================
 * Baca semua akun yang punya cookie dari bai_accounts.json,
 * buat API key untuk masing-masing, output format: keyname|fullkey
 *
 * CARA PAKAI:
 *   node get_key_all.js [jumlah_key_per_akun] [start_index]
 *   contoh:
 *     node get_key_all.js           -> 1 key per akun, semua akun
 *     node get_key_all.js 3         -> 3 key per akun
 *     node get_key_all.js 1 0       -> 1 key per akun, mulai dari akun index 0
 *
 * Output: get_key_all_results.txt (format keyname|fullkey per baris)
 */

const https = require("https");
const fs = require("fs");

const ORIGIN = "https://chat.b.ai";
const ACCOUNT_DB = "bai_accounts.json";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Origin": ORIGIN,
  "Referer": `${ORIGIN}/key`,
};

function req(method, url, body, headers = {}, jar = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request(u, {
      method,
      headers: { ...HEADERS, ...headers },
    }, res => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => {
        const sc = res.headers["set-cookie"];
        if (sc) jar.cookie = sc.map(s => s.split(";")[0]).join("; ");
        resolve({ status: res.statusCode, body: d, jar });
      });
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

async function getKey(cookieStr, name) {
  const jar = { cookie: cookieStr };
  // CSRF
  let csrfToken = "";
  try {
    const csrf = await req("GET", `${ORIGIN}/api/auth/csrf`, undefined, { Cookie: cookieStr }, jar);
    const m = csrf.body.match(/"csrfToken":"([^"]+)"/);
    if (m) csrfToken = m[1];
  } catch(e){}
  const body = JSON.stringify({ "0": { "json": { "group": "default", "name": name } } });
  const r = await req("POST", `${ORIGIN}/trpc/lambda/apiKey.createApiKey?batch=1`, body, {
    "Content-Type": "application/json",
    "Cookie": cookieStr,
    ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
  }, jar);
  const m = r.body.match(/"key":"([^"]+)"/);
  if (!m) return { status: r.status, error: "no-key", raw: r.body.slice(0, 150) };
  const key = m[1];
  return { status: r.status, key, full: !key.includes("...") && !key.includes("*") && key.length === 35 };
}

(async () => {
  const perAccount = parseInt(process.argv[2] || "1", 10);
  const startIdx = parseInt(process.argv[3] || "0", 10);

  if (!fs.existsSync(ACCOUNT_DB)) { console.log(`[!] ${ACCOUNT_DB} tidak ditemukan. Register dulu via bai_register_save_cookie.js`); process.exit(1); }
  const all = JSON.parse(fs.readFileSync(ACCOUNT_DB, "utf-8"));
  const accounts = all.filter((a, i) => i >= startIdx && a.sessionCookie);
  console.log(`[*] ${accounts.length} akun dengan cookie (mulai index ${startIdx}, ${perAccount} key per akun)`);

  const outputLines = [];
  const results = [];

  for (const acc of accounts) {
    const idx = all.indexOf(acc);
    console.log(`\n[*] Akun [${idx}] ${acc.address}...`);
    for (let k = 0; k < perAccount; k++) {
      const name = "kc_" + Date.now().toString(36).slice(-5) + "_" + k;
      const r = await getKey(acc.sessionCookie, name);
      if (r.key && r.full) {
        const line = `${name}|${r.key}`;
        outputLines.push(line);
        console.log(`  🎉 ${line}`);
        acc.apiKeys = [...(acc.apiKeys || []), r.key];
      } else if (r.key) {
        console.log(`  ⚠️ ${name}|${r.key} (MASKED)`);
      } else {
        console.log(`  ❌ ${name}: ${r.error} ${r.status}`);
      }
      results.push({ account: acc.address, name, ...r });
      await new Promise(res => setTimeout(res, 1500));
    }
  }

  // Update apiKeys di bai_accounts.json
  fs.writeFileSync(ACCOUNT_DB, JSON.stringify(all, null, 2));
  fs.writeFileSync("get_key_all_results.txt", outputLines.join("\n") + (outputLines.length ? "\n" : ""));
  fs.writeFileSync("get_key_all_results.json", JSON.stringify(results, null, 2));

  console.log(`\n=== HASIL (${outputLines.length} key) ===`);
  outputLines.forEach(l => console.log(l));
  console.log("\nDisimpan: get_key_all_results.txt (format keyname|fullkey)");
})().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
