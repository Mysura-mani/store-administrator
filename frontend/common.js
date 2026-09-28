// Shared helpers used by every page.

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
    <div class="brand"><a href="/dashboard.html">Tips<span>Tracker</span></a> <span class="branch-tag">${escapeHtml(session.branchName || session.branchId)}</span></div>
    <div class="nav section-tabs">${tabsHtml}</div>
    <div class="nav">${navHtml}</div>
    <div class="user-pill">
      ${roleBadge}
      ${backToOwnerBtn}
      <button class="btn-secondary" id="logout-btn">Log out</button>
    </div>
  `;

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
