"use strict";

const $ = (selector) => document.querySelector(selector);

const state = {
  data: null,
  draft: null,
  editing: false,
};

function dollars(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Math.round(value || 0));
}

function pct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[char]));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function sum(items) {
  return items.reduce((total, item) => total + Number(item.value || 0), 0);
}

function groupByCategory(items) {
  const grouped = new Map();
  for (const item of items) grouped.set(item.category, (grouped.get(item.category) || 0) + Number(item.value || 0));
  return [...grouped.entries()].map(([category, value]) => ({ category, value })).sort((a, b) => b.value - a.value);
}

function valueById(items, id) {
  return items.find((item) => item.id === id)?.value || 0;
}

function enrichData(data) {
  if (!data) return data;
  if (data.headline) return data;
  const base = state.data || {};
  const assets = data.assets || [];
  const liabilities = data.liabilities || [];
  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const taxableInvestments = assets.filter((item) => item.category === "Taxable investments").reduce((total, item) => total + Number(item.value || 0), 0);
  const cash = assets.find((item) => item.id === "cash")?.value || 0;
  const retirementIncluded = assets.filter((item) => ["401k", "hsa"].includes(item.id)).reduce((total, item) => total + Number(item.value || 0), 0);
  return {
    ...base,
    ...data,
    headline: {
      totalAssets,
      totalLiabilities,
      netWorth: totalAssets - totalLiabilities,
      assetLiabilityRatio: totalLiabilities ? Number((totalAssets / totalLiabilities).toFixed(2)) : 0,
      debtToAssetsPct: totalAssets ? Number(((totalLiabilities / totalAssets) * 100).toFixed(1)) : 0,
      accessibleLiquid: taxableInvestments + cash,
      retirementIncluded,
    },
    assetCategories: groupByCategory(assets),
    liabilityCategories: groupByCategory(liabilities),
    equity: [
      { name: "Canyon Shore equity", value: valueById(assets, "canyon-shore") - valueById(liabilities, "canyon-shore-mortgage"), formula: "Canyon Shore value - Canyon Shore mortgage" },
      { name: "Cypress Path equity", value: valueById(assets, "cypress-path") - valueById(liabilities, "cypress-path-mortgage"), formula: "Cypress Path value - Cypress Path mortgage" },
      { name: "Tesla net equity", value: valueById(assets, "tesla") - valueById(liabilities, "tesla-loan"), formula: "Tesla value - Tesla loan" },
      { name: "Honda equity", value: valueById(assets, "honda-accord"), formula: "Honda value - no listed loan" },
    ],
  };
}

async function api(path, options = {}) {
  const response = await fetch(`${path}${options.query || location.search}`, {
    credentials: "same-origin",
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || "Dashboard locked");
  return data;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function loadDashboard() {
  return api("/api/money-dashboard");
}

async function saveDashboard(payload) {
  return api("/api/money-dashboard", { method: "POST", body: payload });
}

function activeData() {
  return state.editing ? state.draft : state.data;
}

function renderSummary(data) {
  const h = data.headline;
  const cards = [
    ["Net worth", dollars(h.netWorth), "Assets minus liabilities", "primary"],
    ["Total assets", dollars(h.totalAssets), "Includes 401(k), homes, cars, cash, investments", ""],
    ["Total liabilities", dollars(h.totalLiabilities), `${pct(h.debtToAssetsPct)} debt-to-assets`, "warning"],
    ["Accessible liquid", dollars(h.accessibleLiquid), "Cash plus taxable brokerage; excludes retirement/home equity", ""],
  ];

  $("#summaryGrid").innerHTML = cards.map(([label, value, caption, cls]) => `
    <article class="card ${cls}">
      <p class="label">${esc(label)}</p>
      <p class="value">${esc(value)}</p>
      <p class="caption">${esc(caption)}</p>
    </article>
  `).join("");
}

function renderBars(selector, items, total, debt = false) {
  const max = Math.max(...items.map((item) => item.value), 1);
  $(selector).classList.toggle("debt", debt);
  $(selector).innerHTML = items.map((item) => `
    <div class="bar-row">
      <div class="bar-meta">
        <strong>${esc(item.category)}</strong>
        <span>${dollars(item.value)} · ${pct((item.value / total) * 100)}</span>
      </div>
      <div class="bar-track" aria-hidden="true">
        <div class="bar-fill" style="width:${Math.max(3, (item.value / max) * 100)}%"></div>
      </div>
    </div>
  `).join("");
}

function readDraftInputs() {
  if (!state.editing || !state.draft) return;
  for (const kind of ["assets", "liabilities"]) {
    state.draft[kind] = [...document.querySelectorAll(`[data-kind="${kind}"]`)].map((row) => ({
      id: row.dataset.id,
      name: row.querySelector("[data-field='name']").value.trim() || "Unnamed",
      category: row.querySelector("[data-field='category']").value.trim() || "Other",
      value: Number(row.querySelector("[data-field='value']").value || 0),
      source: row.querySelector("[data-field='source']").value.trim() || "Manual",
      lastUpdated: row.querySelector("[data-field='lastUpdated']").value || $("#asOfInput").value || today(),
      note: row.querySelector("[data-field='note']").value.trim(),
    }));
  }
  state.draft.asOf = $("#asOfInput").value || today();
}

function renderRows(selector, items, kind) {
  if (!state.editing) {
    $(selector).innerHTML = items.map((item) => `
      <tr>
        <td><strong>${esc(item.name)}</strong><span>${esc(item.note)}</span></td>
        <td>${esc(item.category)}<br><span>${esc(item.source || "Manual")} · ${esc(item.lastUpdated || "")}</span></td>
        <td class="money">${dollars(item.value)}</td>
        <td class="edit-only-cell"></td>
      </tr>
    `).join("");
    return;
  }

  $(selector).innerHTML = items.map((item) => `
    <tr data-kind="${esc(kind)}" data-id="${esc(item.id)}">
      <td>
        <div class="edit-grid">
          <input class="edit-input" data-field="name" value="${esc(item.name)}" placeholder="Name">
          <input class="edit-input" data-field="note" value="${esc(item.note)}" placeholder="Note">
        </div>
      </td>
      <td>
        <div class="edit-grid">
          <input class="edit-input" data-field="category" value="${esc(item.category)}" placeholder="Category">
          <input class="edit-input" data-field="source" value="${esc(item.source || "Manual")}" placeholder="Source">
          <input class="edit-input" data-field="lastUpdated" type="date" value="${esc(item.lastUpdated || activeData().asOf || today())}">
        </div>
      </td>
      <td class="money">
        <input class="edit-input edit-money" data-field="value" type="number" step="1" value="${esc(item.value)}">
      </td>
      <td class="edit-only-cell"><button class="row-action" type="button" data-remove="${esc(kind)}" data-id="${esc(item.id)}">×</button></td>
    </tr>
  `).join("");
}

function renderMiniList(selector, items, noteKey = "formula") {
  $(selector).innerHTML = items.map((item) => `
    <div class="mini-item">
      <div class="mini-top">
        <div class="mini-name">${esc(item.name || item.label)}</div>
        <div class="mini-value">${dollars(item.value)}</div>
      </div>
      <p class="mini-note">${esc(item[noteKey] || "")}</p>
    </div>
  `).join("");
}

function renderBenchmarks(data) {
  const netWorth = data.headline.netWorth;
  $("#benchmarkList").innerHTML = data.benchmarks.map((item) => {
    const multiple = item.value ? `${(netWorth / item.value).toFixed(1)}x this snapshot` : "";
    return `
      <div class="mini-item">
        <div class="mini-top">
          <div class="mini-name">${esc(item.label)}</div>
          <div class="mini-value">${dollars(item.value)}</div>
        </div>
        <p class="mini-note">Your tracked snapshot is about ${esc(multiple)}.</p>
      </div>
    `;
  }).join("");
}

function setEditing(editing) {
  state.editing = editing;
  document.body.classList.toggle("editing", editing);
  $("#editBtn").hidden = editing;
  $("#saveBtn").hidden = !editing;
  $("#cancelBtn").hidden = !editing;
  $("#addAssetBtn").hidden = !editing;
  $("#addLiabilityBtn").hidden = !editing;
  $("#trackerPanel").hidden = !editing;
  if (editing) {
    state.draft = clone(state.data);
    $("#asOfInput").value = state.draft.asOf && /^\d{4}-\d{2}-\d{2}$/.test(state.draft.asOf) ? state.draft.asOf : today();
  } else {
    state.draft = null;
  }
  render(activeData() || state.data);
}

function addRow(kind) {
  readDraftInputs();
  const singular = kind === "assets" ? "asset" : "liability";
  state.draft[kind].push({
    id: newId(singular),
    name: "",
    category: kind === "assets" ? "Other asset" : "Other liability",
    value: 0,
    source: "Manual",
    lastUpdated: $("#asOfInput").value || today(),
    note: "",
  });
  render(state.draft);
}

function removeRow(kind, id) {
  readDraftInputs();
  state.draft[kind] = state.draft[kind].filter((item) => item.id !== id);
  render(state.draft);
}

function render(data) {
  data = enrichData(data);
  if (!data) return;
  const h = data.headline;
  document.title = `${dollars(h.netWorth)} Net Worth Dashboard`;
  $("#asOf").textContent = data.asOf;
  $("#sourceLine").textContent = `${data.source.title} · ${data.source.note}`;
  $("#editBtn").hidden = state.editing;
  renderSummary(data);

  $("#mathPanel").hidden = false;
  $("#netWorthMath").textContent = `${dollars(h.totalAssets)} - ${dollars(h.totalLiabilities)} = ${dollars(h.netWorth)}`;
  $("#netWorthNote").textContent = `Asset/liability ratio: ${h.assetLiabilityRatio}x. Retirement included: ${dollars(h.retirementIncluded)}.`;

  $("#trackerNote").textContent = `Data file: ${data.dataFile || "local private JSON"}. Saving appends a history snapshot.`;
  $("#assetTotal").textContent = dollars(h.totalAssets);
  $("#liabilityTotal").textContent = dollars(h.totalLiabilities);
  renderBars("#assetBars", data.assetCategories, h.totalAssets);
  renderBars("#liabilityBars", data.liabilityCategories, h.totalLiabilities, true);

  renderRows("#assetRows", data.assets, "assets");
  renderRows("#liabilityRows", data.liabilities, "liabilities");
  renderMiniList("#equityList", data.equity);
  renderBenchmarks(data);

  $("#takeaways").innerHTML = data.takeaways.map((item) => `<li>${esc(item)}</li>`).join("");
  $("#disclaimer").textContent = data.disclaimer;
}

$("#editBtn").addEventListener("click", () => setEditing(true));
$("#cancelBtn").addEventListener("click", () => setEditing(false));
$("#addAssetBtn").addEventListener("click", () => addRow("assets"));
$("#addLiabilityBtn").addEventListener("click", () => addRow("liabilities"));
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove]");
  if (!button) return;
  removeRow(button.dataset.remove, button.dataset.id);
});

$("#saveBtn").addEventListener("click", async () => {
  try {
    readDraftInputs();
    $("#saveBtn").disabled = true;
    $("#saveBtn").textContent = "Saving…";
    state.data = await saveDashboard({
      asOf: state.draft.asOf,
      assets: state.draft.assets,
      liabilities: state.draft.liabilities,
    });
    state.editing = false;
    state.draft = null;
    document.body.classList.remove("editing");
    $("#saveBtn").disabled = false;
    $("#saveBtn").textContent = "Save snapshot";
    render(state.data);
    setEditing(false);
  } catch (err) {
    $("#saveBtn").disabled = false;
    $("#saveBtn").textContent = "Save snapshot";
    alert(err.message || "Save failed");
  }
});

loadDashboard()
  .then((data) => {
    state.data = data;
    render(data);
  })
  .catch((err) => {
    $("#lockPanel").hidden = false;
    $("#lockPanel p").textContent = err.message || "Dashboard locked";
  });
