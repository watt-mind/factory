(() => {
  const selector = "iframe.diagram-embed";

  const syncFrame = (frame, theme) => {
    try {
      frame.contentDocument?.documentElement.setAttribute("data-theme", theme);
    } catch {
      // Same-origin diagrams are expected; fail quietly if deployment changes.
    }
  };

  const syncAll = () => {
    const theme = document.documentElement.dataset.theme;
    if (!theme) return;
    document.querySelectorAll(selector).forEach((frame) => {
      syncFrame(frame, theme);
      if (!frame.dataset.themeSyncBound) {
        frame.dataset.themeSyncBound = "true";
        frame.addEventListener("load", syncAll);
      }
    });
  };

  new MutationObserver(syncAll).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncAll, { once: true });
  } else {
    syncAll();
  }
})();
