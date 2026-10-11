// Coffee-machine loading animation. Self-contained SVG + CSS-driven module
// (same plain-IIFE pattern as login-mascots.js — no framework in this
// project). Public surface: window.CoffeeLoader.mount(container, opts).
//
// Usage:
//   const loader = CoffeeLoader.mount(document.getElementById("slot"));
//   loader.simulate(2400);           // animate 0 -> 100% over 2.4s, then "Brewed!"
//   // ...or drive it from real progress instead of simulating it:
//   loader.setProgress(0.4);         // 40%
//   loader.complete();               // jump straight to the "Brewed!" state
//   loader.destroy();                // tear down (e.g. once real content is ready)
(function () {
  "use strict";

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Cup interior geometry (SVG units) — the liquid rect's y/height are
  // computed against these so "100% full" lines up with the cup's own
  // drawn rim, however the markup below gets tweaked later.
  const CUP_TOP = 181;
  const CUP_BOTTOM = 206;
  const CUP_FILL_RANGE = CUP_BOTTOM - CUP_TOP;

  // Stacked coffee-bag shelf, blurred into the background behind the
  // machine (a shallow-depth-of-field "zoomed into the machine" effect).
  const BAG_COLORS = ["#6b4226", "#8a6a4a", "#c9a979", "#4a3222", "#a97c50", "#6b4226", "#8a6a4a", "#c9a979"];
  let bagsSvg = "";
  for (let i = 0; i < 8; i++) {
    const x = 32 + i * 30;
    const w = 20 + (i % 3) * 2;
    const h = 20 + (i % 2) * 4;
    bagsSvg += `<rect x="${x}" y="${130 - h}" width="${w}" height="${h}" rx="6" fill="${BAG_COLORS[i]}"/>`;
    bagsSvg += `<rect x="${x + w / 2 - 1.5}" y="${130 - h - 4}" width="3" height="6" fill="${BAG_COLORS[i]}"/>`;
  }

  const MARKUP = `
    <svg class="coffee-loader-svg" viewBox="0 0 300 280" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="cl-steel-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#eef0f3"/>
          <stop offset="45%" stop-color="#d4d8dd"/>
          <stop offset="100%" stop-color="#aab1bb"/>
        </linearGradient>
        <linearGradient id="cl-wall-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#f5efe6"/>
          <stop offset="100%" stop-color="#e9ddc9"/>
        </linearGradient>
        <linearGradient id="cl-counter-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#c89a6a"/>
          <stop offset="100%" stop-color="#a97c50"/>
        </linearGradient>
        <linearGradient id="cl-pour-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#5b3a29" stop-opacity="0.2"/>
          <stop offset="50%" stop-color="#3a2418"/>
          <stop offset="100%" stop-color="#3a2418" stop-opacity="0.4"/>
        </linearGradient>
        <linearGradient id="cl-window-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#fffaf0"/>
          <stop offset="100%" stop-color="#ffe6ab"/>
        </linearGradient>
        <radialGradient id="cl-bulb-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#fff3cf" stop-opacity="0.95"/>
          <stop offset="100%" stop-color="#fff3cf" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="cl-ambient-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#ffd98a" stop-opacity="0.5"/>
          <stop offset="100%" stop-color="#ffd98a" stop-opacity="0"/>
        </radialGradient>
        <clipPath id="cl-cup-clip">
          <path d="M129,181 L171,181 L167,206 Q150,212 133,206 Z"/>
        </clipPath>
        <clipPath id="cl-machine-clip">
          <rect x="65" y="74" width="170" height="66" rx="10"/>
        </clipPath>
        <filter id="cl-bg-blur" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3"/>
        </filter>
      </defs>

      <!-- cafe backdrop: sunlit window, pendant lights, a shelf of coffee
           bags and a hanging plant, all softly out of focus behind the
           machine (a shallow-depth-of-field "zoomed into the machine" feel) -->
      <g filter="url(#cl-bg-blur)">
        <rect x="0" y="0" width="300" height="140" fill="url(#cl-wall-grad)"/>

        <!-- window + light rays -->
        <rect x="18" y="10" width="74" height="86" rx="4" fill="url(#cl-window-grad)" stroke="#d8c9a3" stroke-width="3"/>
        <line x1="55" y1="10" x2="55" y2="96" stroke="#f5efe6" stroke-width="3"/>
        <line x1="18" y1="53" x2="92" y2="53" stroke="#f5efe6" stroke-width="3"/>
        <path d="M92,30 L230,75 L92,92 Z" fill="#fff" opacity="0.14"/>
        <path d="M92,55 L250,120 L92,115 Z" fill="#fff" opacity="0.08"/>

        <!-- pendant lights -->
        <line x1="150" y1="0" x2="150" y2="58" stroke="#8a7560" stroke-width="1.5"/>
        <circle cx="150" cy="58" r="15" fill="url(#cl-bulb-glow)"/>
        <circle cx="150" cy="58" r="4" fill="#f5d98c"/>
        <line x1="190" y1="0" x2="190" y2="44" stroke="#8a7560" stroke-width="1.5"/>
        <circle cx="190" cy="44" r="15" fill="url(#cl-bulb-glow)"/>
        <circle cx="190" cy="44" r="4" fill="#f5d98c"/>
        <line x1="226" y1="0" x2="226" y2="64" stroke="#8a7560" stroke-width="1.5"/>
        <circle cx="226" cy="64" r="15" fill="url(#cl-bulb-glow)"/>
        <circle cx="226" cy="64" r="4" fill="#f5d98c"/>

        <!-- hanging plant -->
        <path d="M278,0 C270,22 282,30 274,48" fill="none" stroke="#5a8c5a" stroke-width="2.5" stroke-linecap="round"/>
        <path d="M286,0 C292,20 280,26 286,46" fill="none" stroke="#4a7c4a" stroke-width="2.5" stroke-linecap="round"/>
        <path d="M294,0 C300,24 290,32 296,50" fill="none" stroke="#5a8c5a" stroke-width="2.5" stroke-linecap="round"/>
        <ellipse cx="274" cy="48" rx="4" ry="6" fill="#5a8c5a" transform="rotate(-20 274 48)"/>
        <ellipse cx="286" cy="46" rx="4" ry="6" fill="#4a7c4a" transform="rotate(15 286 46)"/>
        <ellipse cx="296" cy="50" rx="4" ry="6" fill="#5a8c5a" transform="rotate(-10 296 50)"/>

        <!-- shelf of coffee bags -->
        <rect x="20" y="130" width="260" height="5" rx="2" fill="#8a6a4a"/>
        ${bagsSvg}
      </g>
      <rect x="0" y="140" width="300" height="140" fill="url(#cl-counter-grad)"/>
      <rect x="0" y="140" width="300" height="4" fill="#9c7148"/>

      <!-- ambient warm glow behind the machine -->
      <circle class="coffee-loader-glow" cx="150" cy="104" r="95" fill="url(#cl-ambient-glow)"/>

      <!-- machine: wide, landscape espresso-machine silhouette, sharp/in-focus -->
      <ellipse cx="150" cy="142" rx="90" ry="6" fill="#000" opacity="0.1"/>
      <rect x="65" y="74" width="170" height="66" rx="10" fill="url(#cl-steel-grad)" stroke="#9ca3ad" stroke-width="1.5"/>
      <rect x="65" y="74" width="170" height="14" rx="10" fill="#c3c8d0"/>
      <g clip-path="url(#cl-machine-clip)">
        <rect class="coffee-loader-sheen" x="-40" y="74" width="40" height="66" fill="#fff" opacity="0.35" transform="skewX(-18)"/>
      </g>
      <circle cx="90" cy="106" r="6" fill="#8b929c"/><rect x="88.5" y="101" width="3" height="5" rx="1.5" fill="#4a4f57"/>
      <circle cx="112" cy="106" r="6" fill="#8b929c"/><rect x="110.5" y="101" width="3" height="5" rx="1.5" fill="#4a4f57"/>
      <circle class="coffee-loader-light" cx="222" cy="86" r="4" fill="#2563eb"/>
      <text x="178" y="114" text-anchor="middle" class="coffee-loader-badge">HX46</text>

      <!-- group head / spout -->
      <rect x="142" y="136" width="16" height="10" rx="2" fill="#8b929c"/>
      <rect x="146" y="146" width="8" height="10" fill="#5c636d"/>
      <rect x="148" y="156" width="4" height="8" fill="#3f444b"/>

      <!-- pour stream -->
      <rect class="coffee-loader-pour" x="148" y="164" width="4" height="16" fill="url(#cl-pour-grad)"/>

      <!-- steam -->
      <g class="coffee-loader-steam">
        <path class="cl-steam cl-steam-1" d="M130,179 Q126,169 131,161 Q136,153 131,145" fill="none" stroke="#c3c8d0" stroke-width="3" stroke-linecap="round"/>
        <path class="cl-steam cl-steam-2" d="M144,175 Q140,165 145,157 Q150,149 145,141" fill="none" stroke="#c3c8d0" stroke-width="3" stroke-linecap="round"/>
        <path class="cl-steam cl-steam-3" d="M158,179 Q154,169 159,161 Q164,153 159,145" fill="none" stroke="#c3c8d0" stroke-width="3" stroke-linecap="round"/>
        <path class="cl-steam cl-steam-4" d="M171,175 Q167,165 172,157 Q177,149 172,141" fill="none" stroke="#c3c8d0" stroke-width="3" stroke-linecap="round"/>
      </g>

      <!-- cup: small, transparent glass, sits on the counter under the group head -->
      <rect x="116" y="207" width="68" height="7" rx="3" fill="#c3c8d0"/>
      <g clip-path="url(#cl-cup-clip)">
        <rect class="coffee-loader-liquid" x="129" y="206" width="42" height="0" fill="#3a2418"/>
        <g class="coffee-loader-bubbles">
          <circle class="cl-bubble cl-bubble-1" cx="140" cy="201" r="1.8" fill="#6b4530"/>
          <circle class="cl-bubble cl-bubble-2" cx="150" cy="201" r="1.5" fill="#6b4530"/>
          <circle class="cl-bubble cl-bubble-3" cx="160" cy="201" r="1.6" fill="#6b4530"/>
        </g>
      </g>
      <path d="M129,181 L171,181 L167,206 Q150,212 133,206 Z" fill="rgba(180,195,210,0.12)" stroke="#b8bec7" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M136,185 L139,185 L137,201 L135,201 Z" fill="#fff" opacity="0.5"/>
      <path d="M171,191 C186,191 186,205 171,205" fill="none" stroke="#b8bec7" stroke-width="3" stroke-linecap="round"/>

      <!-- completion flourish -->
      <g class="coffee-loader-check" opacity="0">
        <circle cx="150" cy="194" r="19" fill="#16a34a"/>
        <path d="M141,194 L147,200 L159,186" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      </g>

      <!-- status: pinned directly under the cup/saucer, in the SVG itself
           (not an HTML overlay) so it tracks the cup's actual position
           regardless of how "slice" cropping shifts things per viewport. -->
      <rect class="coffee-loader-status-pill" x="90" y="222" width="120" height="27" rx="13.5" fill="#fff" opacity="0.88"/>
      <text class="coffee-loader-status" x="150" y="240" text-anchor="middle"><tspan class="coffee-loader-label">Brewing</tspan><tspan class="coffee-loader-pct"> &hellip;</tspan></text>
    </svg>
  `;

  function mount(container, opts) {
    opts = opts || {};
    container.classList.add("coffee-loader");
    if (opts.fullscreen) container.classList.add("coffee-loader-fullscreen");
    container.innerHTML = MARKUP;

    const liquid = container.querySelector(".coffee-loader-liquid");
    const label = container.querySelector(".coffee-loader-label");
    const pct = container.querySelector(".coffee-loader-pct");
    const check = container.querySelector(".coffee-loader-check");
    const pour = container.querySelector(".coffee-loader-pour");

    let rafId = null;
    let done = false;

    function render(fraction) {
      const f = Math.max(0, Math.min(1, fraction));
      const height = CUP_FILL_RANGE * f + 12; // +12: always covers the cup's rounded bottom
      liquid.setAttribute("y", CUP_BOTTOM - CUP_FILL_RANGE * f);
      liquid.setAttribute("height", height);
      pct.textContent = Math.round(f * 100) + "%";
    }

    function complete() {
      if (done) return;
      done = true;
      if (rafId) cancelAnimationFrame(rafId);
      render(1);
      container.classList.add("is-done");
      pour.style.opacity = "0";
      label.textContent = "Brewed!";
      pct.textContent = "";
      check.style.opacity = "1";
      if (typeof opts.onComplete === "function") opts.onComplete();
    }

    function setProgress(fraction) {
      if (done) return;
      render(fraction);
      if (fraction >= 1) complete();
    }

    // Time-based simulated fill — this app has no real byte-level progress
    // signal to bind to (API calls resolve near-instantly), so "duration" is
    // simply how long the brew animation itself should visibly take.
    function simulate(duration) {
      duration = duration || 2400;
      if (prefersReducedMotion) {
        complete();
        return;
      }
      const start = performance.now();
      function tick(now) {
        const f = (now - start) / duration;
        if (f >= 1) {
          complete();
          return;
        }
        render(f);
        rafId = requestAnimationFrame(tick);
      }
      rafId = requestAnimationFrame(tick);
    }

    render(0);

    function destroy() {
      if (rafId) cancelAnimationFrame(rafId);
      container.classList.remove("coffee-loader", "coffee-loader-fullscreen", "coffee-loader-leaving", "is-done");
      container.innerHTML = "";
    }

    return { setProgress, complete, simulate, destroy };
  }

  window.CoffeeLoader = { mount };
})();
