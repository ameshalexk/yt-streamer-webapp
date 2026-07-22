import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

const TOKEN_FILE = path.join(config.dataDir, "money-dashboard-token");
const CODE_FILE = path.join(config.dataDir, "money-dashboard-code");
const DATA_FILE = path.join(config.dataDir, "money-dashboard.json");
const HISTORY_FILE = path.join(config.dataDir, "money-dashboard-history.jsonl");
const ONE_YEAR = 60 * 60 * 24 * 365;

const seedData = {
  asOf: "2026-05-25 corrected snapshot",
  source: {
    title: "Asset portfolio summary and net worth tracking",
    chatUuid: "f5a0c82c-dbe0-4546-a843-fdbc3308de8e",
    note: "Seeded from the corrected Claude-export snapshot. Update values from statements for exact tracking.",
  },
  assets: [
    { id: "robinhood", name: "Robinhood", category: "Taxable investments", value: 31_000, source: "Manual", lastUpdated: "2026-05-25", note: "Brokerage" },
    { id: "fidelity", name: "Fidelity", category: "Taxable investments", value: 120_000, source: "Manual", lastUpdated: "2026-05-25", note: "Brokerage" },
    { id: "etrade", name: "E*TRADE", category: "Taxable investments", value: 50_000, source: "Manual", lastUpdated: "2026-05-25", note: "Brokerage" },
    { id: "401k", name: "401(k)", category: "Retirement", value: 400_000, source: "Manual", lastUpdated: "2026-05-25", note: "Included in standard net worth" },
    { id: "529", name: "529 plan", category: "Education", value: 32_000, source: "Manual", lastUpdated: "2026-05-25", note: "College savings" },
    { id: "hsa", name: "HSA", category: "Retirement / health", value: 25_000, source: "Manual", lastUpdated: "2026-05-25", note: "Tax-advantaged health savings" },
    { id: "canyon-shore", name: "Canyon Shore", category: "Real estate", value: 270_000, source: "Manual", lastUpdated: "2026-05-25", note: "Home value estimate used in chat" },
    { id: "cypress-path", name: "Cypress Path", category: "Real estate", value: 570_000, source: "Closing disclosure", lastUpdated: "2026-05-25", note: "Purchase price from CD clarification" },
    { id: "tesla", name: "Tesla", category: "Vehicles", value: 40_000, source: "Manual", lastUpdated: "2026-05-25", note: "Offset by Tesla loan" },
    { id: "honda-accord", name: "Honda Accord", category: "Vehicles", value: 15_000, source: "Manual", lastUpdated: "2026-05-25", note: "Estimated vehicle value" },
    { id: "cash", name: "Cash after closing", category: "Cash", value: 24_131, source: "Closing disclosure math", lastUpdated: "2026-05-25", note: "$143K starting cash minus $118,869.25 cash to close" },
  ],
  liabilities: [
    { id: "canyon-shore-mortgage", name: "Canyon Shore mortgage", category: "Mortgage", value: 120_000, source: "Manual", lastUpdated: "2026-05-25", note: "Outstanding mortgage estimate" },
    { id: "cypress-path-mortgage", name: "Cypress Path mortgage", category: "Mortgage", value: 456_000, source: "Closing disclosure", lastUpdated: "2026-05-25", note: "$570K purchase with 20% down" },
    { id: "tesla-loan", name: "Tesla loan", category: "Auto loan", value: 40_000, source: "Manual", lastUpdated: "2026-05-25", note: "Estimated outstanding auto loan" },
  ],
};

const benchmarks = [
  { label: "Census 2023 median wealth, age 35-44", value: 143_700 },
  { label: "Federal Reserve SCF 2022 median net worth, age 35-44", value: 135_600 },
  { label: "Federal Reserve SCF 2022 mean net worth, age 35-44", value: 549_600 },
  { label: "SCF 2022 top-decile median net worth, all families", value: 3_794_600 },
];

const takeaways = [
  "Yes, the 401(k) is included in standard net worth.",
  "Assets are about 2.6x liabilities in this snapshot.",
  "Compared with typical U.S. households in the 35-44 age band, this is well above average.",
  "Best plain-English label from the prior analysis: upper-middle / affluent, not statistically rich yet.",
  "Main practical watchout: liquidity. Much of the wealth is in real estate and retirement accounts.",
];

const disclaimer = "Planning snapshot only. Asset values, taxes, sale costs, penalties, and current balances can change the number.";

function sum(items) {
  return items.reduce((total, item) => total + item.value, 0);
}

function groupByCategory(items) {
  const grouped = new Map();
  for (const item of items) {
    grouped.set(item.category, (grouped.get(item.category) || 0) + item.value);
  }
  return [...grouped.entries()]
    .map(([category, value]) => ({ category, value }))
    .sort((a, b) => b.value - a.value);
}

function pct(part, whole) {
  return whole ? Number(((part / whole) * 100).toFixed(1)) : 0;
}

function cloneSeedData() {
  return JSON.parse(JSON.stringify(seedData));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function stableId(prefix, name) {
  const base = String(name || prefix)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${prefix}-${base || crypto.randomBytes(4).toString("hex")}`;
}

function sanitizeItem(item, prefix) {
  const name = String(item?.name || "").trim() || "Unnamed";
  return {
    id: String(item?.id || stableId(prefix, name)).trim(),
    name,
    category: String(item?.category || "Other").trim() || "Other",
    value: normalizeMoney(item?.value),
    source: String(item?.source || "Manual").trim() || "Manual",
    lastUpdated: String(item?.lastUpdated || today()).trim() || today(),
    note: String(item?.note || "").trim(),
  };
}

function normalizeAsOf(value) {
  const raw = String(value || "").trim();
  const date = raw.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  return date || today();
}

function sanitizeTrackedData(input) {
  const base = cloneSeedData();
  const assets = Array.isArray(input?.assets) ? input.assets : base.assets;
  const liabilities = Array.isArray(input?.liabilities) ? input.liabilities : base.liabilities;
  return {
    asOf: normalizeAsOf(input?.asOf || today()),
    source: {
      ...base.source,
      ...(input?.source && typeof input.source === "object" ? input.source : {}),
      note: String(input?.source?.note || "Tracked balances stored locally on this Mac.").trim(),
    },
    assets: assets.map((item) => sanitizeItem(item, "asset")),
    liabilities: liabilities.map((item) => sanitizeItem(item, "liability")),
    updatedAt: input?.updatedAt || new Date().toISOString(),
  };
}

export async function trackedData() {
  try {
    return sanitizeTrackedData(JSON.parse(await fs.readFile(DATA_FILE, "utf8")));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const seeded = sanitizeTrackedData(cloneSeedData());
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(DATA_FILE, `${JSON.stringify(seeded, null, 2)}\n`, { mode: 0o600 });
  await appendHistory(seeded, "seed");
  return seeded;
}

async function appendHistory(data, reason = "update") {
  const totalAssets = sum(data.assets);
  const totalLiabilities = sum(data.liabilities);
  const snapshot = {
    recordedAt: new Date().toISOString(),
    reason,
    asOf: data.asOf,
    totalAssets,
    totalLiabilities,
    netWorth: totalAssets - totalLiabilities,
    assets: data.assets,
    liabilities: data.liabilities,
  };
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.appendFile(HISTORY_FILE, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
}

export async function updateTrackedData(input) {
  const data = sanitizeTrackedData({
    ...(await trackedData()),
    ...input,
    updatedAt: new Date().toISOString(),
    source: {
      ...(await trackedData()).source,
      ...(input?.source && typeof input.source === "object" ? input.source : {}),
      note: "Tracked balances stored locally on this Mac. Update from statements for exact net worth.",
    },
  });
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(DATA_FILE, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await appendHistory(data, "manual-save");
  return data;
}

function valueById(items, id) {
  return items.find((item) => item.id === id)?.value || 0;
}

function equityLines(assets, liabilities) {
  return [
    { name: "Canyon Shore equity", value: valueById(assets, "canyon-shore") - valueById(liabilities, "canyon-shore-mortgage"), formula: "Canyon Shore value - Canyon Shore mortgage" },
    { name: "Cypress Path equity", value: valueById(assets, "cypress-path") - valueById(liabilities, "cypress-path-mortgage"), formula: "Cypress Path value - Cypress Path mortgage" },
    { name: "Tesla net equity", value: valueById(assets, "tesla") - valueById(liabilities, "tesla-loan"), formula: "Tesla value - Tesla loan" },
    { name: "Honda equity", value: valueById(assets, "honda-accord"), formula: "Honda value - no listed loan" },
  ];
}

export async function dashboardData() {
  const data = await trackedData();
  const { assets, liabilities } = data;
  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const netWorth = totalAssets - totalLiabilities;
  const taxableInvestments = assets
    .filter((item) => item.category === "Taxable investments")
    .reduce((total, item) => total + item.value, 0);
  const accessibleLiquid = taxableInvestments + (assets.find((item) => item.name === "Cash after closing")?.value || 0);
  const retirementIncluded = assets
    .filter((item) => ["401(k)", "HSA"].includes(item.name))
    .reduce((total, item) => total + item.value, 0);

  return {
    asOf: data.asOf,
    updatedAt: data.updatedAt,
    dataFile: DATA_FILE,
    source: data.source,
    headline: {
      totalAssets,
      totalLiabilities,
      netWorth,
      assetLiabilityRatio: Number((totalAssets / totalLiabilities).toFixed(2)),
      debtToAssetsPct: pct(totalLiabilities, totalAssets),
      accessibleLiquid,
      retirementIncluded,
    },
    assets,
    liabilities,
    assetCategories: groupByCategory(assets),
    liabilityCategories: groupByCategory(liabilities),
    equity: equityLines(assets, liabilities),
    takeaways,
    benchmarks,
    disclaimer,
  };
}

export async function accessToken() {
  const envToken = String(process.env.MONEY_DASHBOARD_TOKEN || "").trim();
  if (envToken) return { token: envToken, source: "env" };

  try {
    const existing = (await fs.readFile(TOKEN_FILE, "utf8")).trim();
    if (existing.length >= 24) return { token: existing, source: TOKEN_FILE };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  await fs.mkdir(config.dataDir, { recursive: true });
  const token = crypto.randomBytes(32).toString("base64url");
  await fs.writeFile(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  return { token, source: TOKEN_FILE };
}

export async function accessCode() {
  const envCode = String(process.env.MONEY_DASHBOARD_CODE || "").trim();
  if (envCode.length >= 6) return { code: envCode, source: "env" };

  try {
    const existing = (await fs.readFile(CODE_FILE, "utf8")).trim();
    if (existing.length >= 6) return { code: existing, source: CODE_FILE };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  await fs.mkdir(config.dataDir, { recursive: true });
  const code = crypto.randomBytes(5).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  await fs.writeFile(CODE_FILE, `${code}\n`, { mode: 0o600 });
  return { code, source: CODE_FILE };
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cookieToken(req) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "money_dashboard_token") return decodeURIComponent(rest.join("=") || "");
  }
  return "";
}

export async function authorize(req) {
  const { token } = await accessToken();
  const { code } = await accessCode();
  const supplied = String(req.query.token || req.get("x-money-dashboard-token") || cookieToken(req) || "");
  const suppliedCode = String(req.query.code || req.get("x-money-dashboard-code") || "");
  return safeEqual(supplied, token) || safeEqual(suppliedCode, code);
}

export async function authorizeOwnerControl(req) {
  const { token } = await accessToken();
  const { code } = await accessCode();
  const suppliedToken = String(cookieToken(req) || "");
  const suppliedCode = String(req.get("x-yt-streamer-owner-code") || "");
  return safeEqual(suppliedToken, token) || safeEqual(suppliedCode, code);
}

export function setAccessCookie(req, res, token) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "");
  const secure = req.secure || forwardedProto.includes("https");
  const parts = [
    `money_dashboard_token=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${ONE_YEAR}`,
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function sendUnauthorizedPage(res) {
  res.status(401).type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Money dashboard locked</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08111f;color:#e7eefc;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{max-width:520px;padding:28px}
    h1{margin:0 0 10px;font-size:28px}
    p{color:#aab7cc;line-height:1.5}
    form{display:grid;gap:12px;margin-top:20px}
    label{color:#aab7cc;font-size:14px;font-weight:700}
    input{width:100%;height:54px;border:1px solid rgba(255,255,255,.16);border-radius:14px;background:#101d31;color:#fff;font:inherit;font-size:22px;padding:0 14px;letter-spacing:.08em}
    button{height:54px;border:0;border-radius:14px;background:#38d996;color:#06111d;font:inherit;font-weight:900}
    .hint{font-size:13px}
  </style>
</head>
<body>
  <main>
    <h1>Money dashboard locked</h1>
    <p>Enter the private access code generated on this Mac. This browser will be remembered after login.</p>
    <form method="get" autocomplete="off">
      <label for="code">Access code</label>
      <input id="code" name="code" inputmode="text" autocapitalize="none" spellcheck="false" autofocus>
      <button type="submit">Open dashboard</button>
    </form>
    <p class="hint">The code is stored locally in webapp/data/money-dashboard-code.</p>
  </main>
</body>
</html>`);
}
