(() => {
  "use strict";

  const tab = document.getElementById("teslaRemotePlayTab");
  if (!tab) return;

  fetch("/api/tesla-remote-play/status", { credentials: "same-origin", cache: "no-store" })
    .then((response) => response.ok ? response.json() : null)
    .then((status) => {
      if (status?.available === true) tab.hidden = false;
    })
    .catch(() => {});

  document.addEventListener("click", (event) => {
    if (!event.target.closest("#teslaRemotePlayTab")) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const ui = document.documentElement.dataset.ui === "new" ? "new" : "classic";
    const returnTo = `/?mode=browse&ui=${ui}`;
    window.location.assign(`/tesla-remote-play/?returnTo=${encodeURIComponent(returnTo)}`);
  }, true);
})();
