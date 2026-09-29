// Shared helpers used by every page.

// ---------- theme (light/dark) ----------
// Applied immediately (not on DOMContentLoaded) since common.js itself
// loads near the bottom of every page's body — waiting for any DOM-ready
// event would mean the whole page already painted in the wrong theme first.
const THEME_STORAGE_KEY = "theme";

function applyTheme(theme) {
  if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
}

function isDarkTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark";
}

// Flips the theme, persists the choice, and returns the new value.
function toggleTheme() {
  const next = isDarkTheme() ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch (_) {
    /* private window — the choice just won't survive this page view */
  }
  return next;
}

(function () {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY);
  } catch (_) {
    /* private window — defaults to light */
  }
  applyTheme(stored);
})();

// Wires up an existing icon-only button (from a page's own header markup) as
// the theme toggle. Pages with a fuller nav item (icon + label, e.g. the
// sidebar's "Log out" style) render their own label instead of using this.
function initThemeToggle(btn) {
  if (!btn) return;
  function refresh() {
    const dark = isDarkTheme();
    btn.textContent = dark ? "☀️" : "🌙";
    const label = dark ? "Switch to light mode" : "Switch to dark mode";
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }
  refresh();
  btn.addEventListener("click", () => {
    toggleTheme();
    refresh();
  });
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    /* no body */
  }
  if (!res.ok) {
    // Every dashboard is unusable until the owner has connected a Google
    // Sheet (see backend/server.js's hard gate) — rather than every page
    // handling this error individually, send the browser straight to the
    // one-time setup wizard whenever it shows up, from wherever it shows up.
    if (res.status === 503 && body && body.error === "not_connected" && !window.location.pathname.endsWith("/setup.html")) {
      window.location.href = "/setup.html";
      return new Promise(() => {}); // navigation is already underway — don't also resolve/reject
    }
    // A session that's missing/expired/for the wrong role — e.g. another tab
    // on the same browser logged into a different branch, which replaces the
    // one shared session cookie out from under this tab. Specifically the
    // "not_authenticated" string every requireAuth-style middleware returns,
    // never a wrong-password rejection from an in-context check (elevate
    // admin, change password, ...), which has its own distinct message and
    // must stay inline instead of bouncing the user away from what they were
    // doing.
    if (res.status === 401 && body && body.error === "not_authenticated" && !window.location.pathname.endsWith("/login.html")) {
      window.location.href = "/login.html";
      return new Promise(() => {});
    }
    const err = new Error((body && body.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function requireSession(minRole) {
  try {
    const session = await api("/api/session");
    if (minRole === "admin" && session.role !== "admin") {
      window.location.href = "/dashboard.html";
      return null;
    }
    return session;
  } catch (err) {
    window.location.href = "/login.html";
    return null;
  }
}

// `section` is "tips" or "delivery" — controls which sub-nav links show.
function renderShell(session, activePage, section) {
  const sectionTabs = [
    { href: "/entry.html", label: "Tip Sheet", section: "tips" },
    { href: "/delivery-entry.html", label: "Delivery", section: "delivery" },
  ];

  const subNav = [];
  if (section === "delivery") {
    subNav.push({ href: "/delivery-entry.html", label: "Delivery Payout" });
    subNav.push({ href: "/delivery-history.html", label: "Delivery History" });
  } else if (section === "tips") {
    subNav.push({ href: "/entry.html", label: "New Entry" });
    subNav.push({ href: "/history.html", label: "History" });
  }

  if (session.role === "admin") {
    subNav.push({ href: "/employees.html", label: "Employees" });
    subNav.push({ href: "/drivers.html", label: "Drivers" });
    subNav.push({ href: "/settings.html", label: "Settings" });
  }

  const tabsHtml = sectionTabs
    .map((item) => `<a href="${item.href}" class="${item.section === section ? "active" : ""}">${item.label}</a>`)
    .join("");

  const navHtml = subNav
    .map((item) => `<a href="${item.href}" class="${item.href === activePage ? "active" : ""}">${item.label}</a>`)
    .join("");

  const roleBadge =
    session.role === "admin"
      ? `<span class="badge badge-admin">Admin</span>`
      : `<span class="badge badge-staff">Staff</span><button class="btn-secondary btn-small" id="admin-btn">Admin</button>`;

  const backToOwnerBtn = session.viaOwner
    ? `<button class="btn-secondary" id="back-to-owner-btn">&larr; Back to Owner</button>`
    : "";

  document.getElementById("topbar").innerHTML = `
    <div class="brand"><a href="/dashboard.html">Administration<span>Tracker</span></a> <span class="branch-tag">${escapeHtml(session.branchName || session.branchId)}</span></div>
    <div class="nav section-tabs">${tabsHtml}</div>
    <div class="nav">${navHtml}</div>
    <div class="user-pill">
      ${roleBadge}
      ${backToOwnerBtn}
      <button class="btn-secondary btn-small" id="theme-toggle-btn"></button>
      <button class="btn-secondary" id="logout-btn">Log out</button>
    </div>
  `;

  initThemeToggle(document.getElementById("theme-toggle-btn"));

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    window.location.href = "/login.html";
  });

  const adminBtn = document.getElementById("admin-btn");
  if (adminBtn) adminBtn.addEventListener("click", openAdminPrompt);

  const backBtn = document.getElementById("back-to-owner-btn");
  if (backBtn) {
    backBtn.addEventListener("click", async () => {
      await api("/api/owner/return", { method: "POST" });
      window.location.href = "/owner-dashboard.html";
    });
  }
}

function openAdminPrompt() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-card">
      <h3>Admin access</h3>
      <p class="subtitle">Enter this branch's admin password to unlock employee management and settings.</p>
      <form id="admin-elevate-form">
        <input type="password" id="admin-elevate-password" placeholder="Admin password" autofocus />
        <div class="error-msg" id="admin-elevate-error"></div>
        <div style="display:flex; gap:10px; margin-top:14px">
          <button type="submit" class="btn-primary">Unlock</button>
          <button type="button" class="btn-secondary" id="admin-elevate-cancel">Cancel</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.getElementById("admin-elevate-cancel").addEventListener("click", close);
  document.getElementById("admin-elevate-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("admin-elevate-error");
    errorEl.textContent = "";
    try {
      await api("/api/elevate-admin", {
        method: "POST",
        body: JSON.stringify({ password: document.getElementById("admin-elevate-password").value }),
      });
      window.location.reload();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

// A native confirm() has been observed to silently do nothing in some
// browser setups (it's suppressed/auto-declined with no visible dialog) —
// this in-page replacement always renders something the user can actually
// see and click, using the same modal styling as the rest of the app.
function confirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-card">
        <p style="margin-top:0">${escapeHtml(message)}</p>
        <div style="display:flex; gap:10px; margin-top:14px">
          <button type="button" class="btn-danger" id="confirm-dialog-ok">Confirm</button>
          <button type="button" class="btn-secondary" id="confirm-dialog-cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const finish = (result) => {
      overlay.remove();
      resolve(result);
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(false);
    });
    document.getElementById("confirm-dialog-ok").addEventListener("click", () => finish(true));
    document.getElementById("confirm-dialog-cancel").addEventListener("click", () => finish(false));
  });
}

// Same reasoning as confirmDialog() above — native prompt() is unreliable in
// some browser setups. Returns the entered string, or null if cancelled.
function promptDialog(message, { inputType = "text", placeholder = "" } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-card">
        <p style="margin-top:0">${escapeHtml(message)}</p>
        <input type="${escapeHtml(inputType)}" id="prompt-dialog-input" placeholder="${escapeHtml(placeholder)}" />
        <div style="display:flex; gap:10px; margin-top:14px">
          <button type="button" class="btn-primary" id="prompt-dialog-ok">OK</button>
          <button type="button" class="btn-secondary" id="prompt-dialog-cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = document.getElementById("prompt-dialog-input");
    input.focus();
    const finish = (result) => {
      overlay.remove();
      resolve(result);
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(input.value);
    });
    document.getElementById("prompt-dialog-ok").addEventListener("click", () => finish(input.value));
    document.getElementById("prompt-dialog-cancel").addEventListener("click", () => finish(null));
  });
}

function formatMoney(n) {
  return `€${Number(n).toFixed(2)}`;
}

// Every place a value that ultimately came from user input (an employee,
// driver, branch/store name, a delivery note, ...) gets interpolated into an
// innerHTML template string MUST go through this first — otherwise someone
// entering e.g. `<img src=x onerror=...>` as a name stores script that runs
// in whoever views that list next (a classic stored-XSS path).
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Formats a Date using its LOCAL year/month/day (never UTC — toISOString()
// would shift the date back a day in any positive UTC-offset timezone).
function toDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todayStr() {
  return toDateStr(new Date());
}

// ---------- custom dropdown (replaces native <select> popups) ----------
// Wraps a <select> with a button + options panel we render and paint
// ourselves, so opening a dropdown never invokes the browser's native
// popup (see styles.css's ".cdd-*" rules for why). The <select> itself
// stays in the DOM, hidden, as the source of truth — every existing
// `.value` read/write, `.innerHTML` repopulation, and `change` listener
// across the app (entry.html, delivery-entry.html, owner-dashboard.html,
// login.html, ...) keeps working exactly as before, untouched.
function enhanceSelect(select) {
  if (select.dataset.cddEnhanced) return;
  select.dataset.cddEnhanced = "1";

  const wrap = document.createElement("div");
  wrap.className = "cdd-wrap";
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.style.display = "none";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "cdd-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML =
    `<span class="cdd-label"></span>` +
    `<svg class="cdd-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;
  wrap.appendChild(trigger);
  const label = trigger.querySelector(".cdd-label");

  // Appended to <body>, not `wrap` — see the position:fixed note in
  // styles.css on .cdd-panel for why (ancestors like .login-card clip
  // absolutely-positioned descendants via overflow: hidden).
  const panel = document.createElement("div");
  panel.className = "cdd-panel";
  panel.setAttribute("role", "listbox");
  panel.hidden = true;
  document.body.appendChild(panel);

  function refreshLabel() {
    const opt = select.options[select.selectedIndex];
    label.textContent = opt ? opt.textContent : "";
    // Pages disable the underlying <select> directly (e.g. delivery-entry.html
    // locking a submitted entry's fields) — the trigger button is a separate
    // element the click handler already ignores when disabled, but it still
    // needs the matching visual/native-disabled state to look and act the part.
    trigger.disabled = select.disabled;
  }

  function positionPanel() {
    const r = trigger.getBoundingClientRect();
    panel.style.left = `${r.left}px`;
    panel.style.width = `${r.width}px`;
    const spaceBelow = window.innerHeight - r.bottom;
    if (spaceBelow < 200 && r.top > spaceBelow) {
      panel.style.top = "auto";
      panel.style.bottom = `${window.innerHeight - r.top + 4}px`;
      panel.style.maxHeight = `${r.top - 8}px`;
    } else {
      panel.style.bottom = "auto";
      panel.style.top = `${r.bottom + 4}px`;
      panel.style.maxHeight = `${spaceBelow - 8}px`;
    }
  }

  function buildPanel() {
    panel.innerHTML = "";
    Array.from(select.options).forEach((opt) => {
      const item = document.createElement("div");
      item.className = "cdd-option";
      item.textContent = opt.textContent;
      item.setAttribute("role", "option");
      if (opt.value === select.value) item.setAttribute("aria-selected", "true");
      item.addEventListener("click", () => {
        select.value = opt.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        closePanel();
        trigger.focus();
      });
      panel.appendChild(item);
    });
  }

  function openPanel() {
    document.querySelectorAll(".cdd-panel").forEach((p) => {
      if (p !== panel) p.hidden = true;
    });
    buildPanel();
    positionPanel();
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    window.addEventListener("scroll", positionPanel, true);
    window.addEventListener("resize", positionPanel);
    document.addEventListener("mousedown", onOutsideClick, true);
  }

  function closePanel() {
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    window.removeEventListener("scroll", positionPanel, true);
    window.removeEventListener("resize", positionPanel);
    document.removeEventListener("mousedown", onOutsideClick, true);
  }

  function onOutsideClick(e) {
    if (!wrap.contains(e.target) && !panel.contains(e.target)) closePanel();
  }

  trigger.addEventListener("click", () => {
    if (select.disabled) return;
    if (panel.hidden) openPanel();
    else closePanel();
  });
  trigger.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePanel();
  });

  // Existing pages both write `select.value = x` directly (owner-dashboard's
  // filters) and repopulate via `select.innerHTML = "<option>...</option>"`
  // with no explicit `.value =` afterward (login.html's populateSelect()) —
  // covering the former means overriding the native accessor, since setting
  // .value doesn't touch the DOM in a way a MutationObserver would catch.
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  Object.defineProperty(select, "value", {
    configurable: true,
    get() {
      return nativeValue.get.call(select);
    },
    set(v) {
      nativeValue.set.call(select, v);
      refreshLabel();
    },
  });
  new MutationObserver(refreshLabel).observe(select, { childList: true, attributes: true, attributeFilter: ["disabled"] });

  refreshLabel();
}

function enhanceSelectsWithin(root) {
  root.querySelectorAll("select").forEach(enhanceSelect);
}

document.addEventListener("DOMContentLoaded", () => {
  enhanceSelectsWithin(document);
  // Pages add <select> elements after load too (entry.html's per-shift row,
  // delivery-entry.html's per-driver row) — catch those the same way.
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.matches("select")) enhanceSelect(node);
        else enhanceSelectsWithin(node);
      });
    }
  }).observe(document.body, { childList: true, subtree: true });
});

// ---------- cookie notice ----------
// This app only ever sets one cookie — the login session (tips.sid) — which
// is strictly necessary for the site to work at all, so there's nothing to
// opt in or out of. This is an informational notice (not a consent gate)
// pointing to the Cookie Policy; dismissing it never affects login.
(function renderCookieBanner() {
  try {
    if (localStorage.getItem("cookieNoticeDismissed") === "1") return;
  } catch (_) {
    return; // storage unavailable (private window, etc.) — skip rather than nag every load
  }
  document.addEventListener("DOMContentLoaded", () => {
    const banner = document.createElement("div");
    banner.className = "cookie-banner";
    banner.innerHTML = `
      <p>This site uses only the essential cookie needed to keep you signed in. See our <a href="/cookie-policy.html">Cookie Policy</a>.</p>
      <div class="cookie-actions">
        <button type="button" class="btn-primary" id="cookie-banner-ok">Got it</button>
      </div>
    `;
    document.body.appendChild(banner);
    document.getElementById("cookie-banner-ok").addEventListener("click", () => {
      try {
        localStorage.setItem("cookieNoticeDismissed", "1");
      } catch (_) {
        /* ignore */
      }
      banner.remove();
    });
  });
})();

// ---------- idle auto-logout ----------
// A shop terminal left logged in is the actual risk here, not a slow typist —
// so this has to fire from wall-clock idle time, not from a lack of API
// calls (most pages only call the API on load/save, so someone could sit on
// an already-loaded screen for hours without ever accessing the network).
// Skipped entirely on login.html/setup.html, where there's no session to
// time out and nothing to log the user out of.
(function idleAutoLogout() {
  if (window.location.pathname.endsWith("/login.html") || window.location.pathname.endsWith("/setup.html")) return;

  const IDLE_LIMIT_MS = 5 * 60 * 1000;
  const CHECK_INTERVAL_MS = 15 * 1000;
  const STORAGE_KEY = "tt-last-activity";

  let lastLocalActivity = Date.now();

  // Also written to localStorage (shared across every tab on this browser,
  // not just this one) so activity in one tab counts as activity for all of
  // them — otherwise an idle tab would log its shared session out from under
  // a different tab that's actively being used right now.
  function markActivity() {
    lastLocalActivity = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, String(lastLocalActivity));
    } catch (_) {
      /* private window / storage blocked — falls back to per-tab timing only */
    }
  }
  markActivity();

  ["mousemove", "mousedown", "keydown", "wheel", "scroll", "touchstart"].forEach((evt) => {
    document.addEventListener(evt, markActivity, { passive: true });
  });

  let loggedOut = false;
  setInterval(async () => {
    if (loggedOut) return;
    let last = lastLocalActivity;
    try {
      last = Math.max(last, Number(localStorage.getItem(STORAGE_KEY)) || 0);
    } catch (_) {
      /* use in-memory value only */
    }
    if (Date.now() - last < IDLE_LIMIT_MS) return;
    loggedOut = true;
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch (_) {
      /* best-effort — redirect regardless */
    }
    window.location.href = "/login.html?idle=1";
  }, CHECK_INTERVAL_MS);
})();
