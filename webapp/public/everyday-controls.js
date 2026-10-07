// Compact shortcuts and storage controls, kept separate from playback logic.
(function (root) {
  "use strict";

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const bytes = (value) => {
    if (value == null || value === "") return "Unavailable";
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return "Unavailable";
    if (number < 1024) return `${number} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let size = number / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
  };

  function init(options = {}) {
    const host = typeof options.container === "string" ? $(options.container) : options.container;
    if (!host) return null;
    const actions = options.actions || {};
    const shortcuts = [
      ["resume", "Resume", "▶", () => {
        if (actions.resume) return actions.resume();
        $("#watch-browse-toggle")?.click();
        $("#ytHistoryTab")?.click();
        const resume = $("#ytHistoryResults [data-act='stream-history']");
        if (resume) resume.click();
        else $("#ytHistoryRefreshBtn")?.click();
      }],
      ["saved", "Favorites", "★", () => actions.saved ? actions.saved() : $("#watch-saved-toggle")?.click()],
      ["browse", "Search / Browse", "⌕", () => actions.browse ? actions.browse() : $("#watch-browse-toggle")?.click()],
      ["downloads", "Downloads", "↓", () => actions.downloads ? actions.downloads() : $("#watch-downloads-toggle")?.click()],
    ];
    const bar = document.createElement("nav");
    bar.className = "everyday-controls";
    bar.setAttribute("aria-label", "Everyday shortcuts");
    for (const [key, label, icon, activate] of shortcuts) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "everyday-control";
      button.dataset.action = key;
      button.setAttribute("aria-label", label);
      const glyph = document.createElement("span");
      glyph.className = "everyday-control-icon";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = icon;
      const text = document.createElement("span");
      text.textContent = label;
      button.append(glyph, text);
      button.addEventListener("click", activate);
      bar.append(button);
    }
    const screen = $("#screen");
    if (screen?.parentElement === host) screen.after(bar);
    else host.prepend(bar);
    return { element: bar, destroy() { bar.remove(); } };
  }

  function createStoragePanel(options = {}) {
    const host = typeof options.container === "string" ? $(options.container) : options.container;
    if (!host) return null;
    const fetcher = options.fetch || root.fetch?.bind(root);
    const confirmAction = options.confirm || root.confirm?.bind(root) || (() => false);
    const panel = document.createElement("section");
    panel.className = "everyday-storage";
    panel.setAttribute("aria-labelledby", "everyday-storage-title");
    const title = document.createElement("h3");
    title.id = "everyday-storage-title";
    title.textContent = "Storage";
    const status = document.createElement("p");
    status.className = "everyday-storage-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const usage = document.createElement("dl");
    usage.className = "everyday-storage-usage";
    const policy = document.createElement("div");
    policy.className = "everyday-storage-policy";
    const policyNote = document.createElement("p");
    policyNote.className = "everyday-storage-policy-note";
    policyNote.textContent = "Only watched processed downloads; original APNE and iCloud files are kept.";
    const enabledLabel = document.createElement("label");
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabledLabel.append(enabled, document.createTextNode(" Allow cleanup of watched downloads"));
    const retentionLabel = document.createElement("label");
    retentionLabel.textContent = "Watched retention (days) ";
    const retention = document.createElement("input");
    retention.type = "number";
    retention.min = "1";
    retention.max = "3650";
    retention.step = "1";
    retention.inputMode = "numeric";
    retentionLabel.append(retention);
    const savePolicy = document.createElement("button");
    savePolicy.type = "button";
    savePolicy.className = "everyday-storage-save";
    savePolicy.textContent = "Save storage policy";
    const cleanup = document.createElement("button");
    cleanup.type = "button";
    cleanup.className = "everyday-storage-cleanup";
    cleanup.textContent = "Review cleanup";
    const preview = document.createElement("ul");
    preview.className = "everyday-storage-preview";
    const downloadsHeading = document.createElement("h4");
    downloadsHeading.textContent = "Processed downloads";
    const downloadsList = document.createElement("ul");
    downloadsList.className = "everyday-storage-downloads";
    panel.append(title, status, usage, policyNote, policy, downloadsHeading, downloadsList);
    policy.append(enabledLabel, retentionLabel, savePolicy, cleanup, preview);
    host.append(panel);

    async function request(path, method = "GET", body) {
      if (!fetcher) throw new Error("Storage service is unavailable");
      const response = await fetcher(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || `Storage request failed (${response.status})`);
      return data;
    }
    function render(data) {
      usage.replaceChildren();
      const values = data?.usage || data || {};
      for (const [label, key] of [["Library", "libraryBytes"], ["Cache", "cacheBytes"], ["Free", "freeBytes"], ["Total", "totalBytes"]]) {
        const dt = document.createElement("dt"); dt.textContent = label;
        const dd = document.createElement("dd"); dd.textContent = bytes(values[key]);
        usage.append(dt, dd);
      }
      const current = data?.policy || {};
      enabled.checked = current.enabled === true;
      enabled.disabled = false;
      enabled.title = "Cleanup is off by default; enable it and save, then review the files before deleting.";
      const days = Number(current.watchedRetentionDays);
      retention.value = Number.isInteger(days) && days > 0 ? String(days) : "30";
      retention.disabled = false;
      savePolicy.disabled = false;
      cleanup.disabled = current.enabled !== true;
      downloadsList.replaceChildren();
      const downloads = Array.isArray(data?.downloads) ? data.downloads : [];
      for (const item of downloads) {
        if (!item || typeof item.id !== "string") continue;
        const row = document.createElement("li");
        row.className = "everyday-storage-download";
        const name = document.createElement("span");
        name.className = "everyday-storage-download-title";
        name.textContent = String(item.title || item.id);
        const detail = document.createElement("span");
        detail.className = "everyday-storage-download-size";
        detail.textContent = `${bytes(item.bytes)}${item.watchedAt ? " · Watched" : " · Not watched"}`;
        const pin = document.createElement("button");
        pin.type = "button";
        pin.className = "everyday-storage-pin";
        pin.textContent = item.pinned === true ? "Unpin" : "Pin";
        pin.setAttribute("aria-pressed", String(item.pinned === true));
        pin.setAttribute("aria-label", `${item.pinned === true ? "Unpin" : "Pin"} ${name.textContent}`);
        const watched = document.createElement("button");
        watched.type = "button";
        watched.className = "everyday-storage-mark-watched";
        watched.textContent = item.watchedAt ? "Watched" : "Mark watched";
        watched.disabled = Boolean(item.watchedAt);
        watched.setAttribute("aria-label", `${item.watchedAt ? "Already watched" : "Mark watched"}: ${name.textContent}`);
        pin.addEventListener("click", async () => {
          pin.disabled = true;
          try {
            await request(`/api/storage/downloads/${encodeURIComponent(item.id)}`, "PATCH", { pinned: item.pinned !== true });
            await refresh();
          } catch (error) { status.textContent = error.message || "Could not update pin."; pin.disabled = false; }
        });
        watched.addEventListener("click", async () => {
          watched.disabled = true;
          try {
            await request(`/api/storage/downloads/${encodeURIComponent(item.id)}/watched`, "POST", { completed: true });
            await refresh();
          } catch (error) { status.textContent = error.message || "Could not mark download watched."; watched.disabled = false; }
        });
        row.append(name, detail, pin, watched);
        downloadsList.append(row);
      }
      status.textContent = "Storage status updated.";
    }
    async function refresh() {
      status.textContent = "Loading storage status…";
      try { render(await request("/api/storage")); }
      catch (error) { status.textContent = error.message || "Could not load storage status."; }
    }
    savePolicy.addEventListener("click", async () => {
      const days = Number(retention.value);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        status.textContent = "Enter a retention period from 1 to 3650 days.";
        retention.focus();
        return;
      }
      savePolicy.disabled = true;
      try {
        await request("/api/storage/policy", "PATCH", { enabled: enabled.checked, watchedRetentionDays: days });
        await refresh();
        status.textContent = "Storage policy saved.";
      } catch (error) { status.textContent = error.message || "Could not save storage policy."; }
      finally { savePolicy.disabled = false; }
    });
    cleanup.addEventListener("click", async () => {
      cleanup.disabled = true;
      preview.replaceChildren();
      status.textContent = "Preparing cleanup preview…";
      try {
        const result = await request("/api/storage/cleanup", "POST", { apply: false });
        const candidates = Array.isArray(result.candidates) ? result.candidates : Array.isArray(result.eligible) ? result.eligible : [];
        if (!candidates.length) {
          const empty = document.createElement("li");
          empty.textContent = "No cleanup candidates.";
          preview.append(empty);
          status.textContent = "Preview ready. Nothing is eligible for cleanup.";
          return;
        }
        for (const item of candidates) {
          const entry = document.createElement("li");
          entry.textContent = `${String(item.title || item.id || "Untitled")} · ${bytes(item.bytes)}`;
          preview.append(entry);
        }
        const ids = candidates.map((item) => item.id);
        const names = candidates.slice(0, 8).map((item) => String(item.title || item.id || "Untitled")).join(", ");
        if (!confirmAction(`Delete ${candidates.length} item(s), reclaiming up to ${bytes(result.reclaimableBytes)}? Candidates: ${names}${candidates.length > 8 ? ", …" : ""}`)) {
          status.textContent = "Cleanup cancelled. Nothing was deleted.";
          return;
        }
        const applied = await request("/api/storage/cleanup", "POST", { apply: true, ids });
        status.textContent = applied.message || `Cleanup complete. Reclaimed ${bytes(applied.reclaimedBytes)}.`;
        await refresh();
        await options.onCleanup?.();
      } catch (error) { status.textContent = error.message || "Cleanup preview failed."; }
      finally { cleanup.disabled = false; }
    });
    void refresh();
    return { element: panel, refresh, destroy() { panel.remove(); } };
  }

  root.EverydayControls = { init, createStoragePanel };
})(window);
