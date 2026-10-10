// Interactive bird/owl mascots perched on the login card's top edge.
// Built as plain SVG + GSAP (no framework in this project) around a small
// shared state machine with an explicit priority order — the login form
// below drives transitions and a lower-priority reaction is never allowed
// to clobber a higher-priority one that's still active:
//   loginSuccess > loginError > passwordVisible > passwordTyping
//   > passwordFocused > accountFocused > cursorTracking > idle
// Public surface used by login.html: window.LoginMascots.on*(...).

(function () {
  "use strict";

  if (typeof gsap === "undefined") {
    // GSAP failed to load (offline CDN, blocked script, ...) — the login
    // form must keep working without this purely decorative layer.
    window.LoginMascots = {
      onAccountFocus() {}, onAccountChange() {}, onPasswordFocus() {}, onPasswordBlur() {},
      onPasswordTyping() {}, onPasswordVisibility() {}, onLoginError() {}, onLoginSuccess() {},
      onDayToNight() {}, onNightToDay() {},
    };
    return;
  }

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // GSAP tweens do NOT auto-cancel each other by default (overwrite:false
  // out of the box) — without this, firing pose A then quickly pose B on
  // the same element (e.g. a blur immediately followed by a click) left
  // both tweens running at once, each frame's render fighting over the
  // same rotation/position, so the later pose visually never stuck. This
  // makes every new tween on a given element+property cleanly replace
  // whatever was already animating it — the single authoritative-controller
  // guarantee every animated part needs.
  gsap.defaults({ overwrite: "auto" });

  // How many characters "fill" the password field for gaze purposes — not
  // a real limit, just the span the eyes sweep left-to-right across.
  const READ_SPAN = 20;
  // length -> -1 (start of field) .. +1 (end of field), continuous.
  function readPosition(length) {
    return clamp((length / READ_SPAN) * 2 - 1, -1, 1);
  }

  // ---------- SVG templates ----------
  // Original flat-illustration characters (own designs/colors) — not
  // modeled on any existing mascot or brand. Eyes sized generously (and
  // kept well clear of each other / the head's edge) since they're the
  // main expressive surface.
  function birdSvg(palette) {
    return `
      <g class="bird-tail">
        <path d="M20,74 L3,60 L3,86 Z" fill="${palette.dark}"/>
      </g>
      <g class="bird-wing bird-wing-left">
        <path d="M46,56 C19,57 12,80 29,95 C40,83 46,68 46,56 Z" fill="${palette.mid}"/>
      </g>
      <g class="bird-wing bird-wing-right">
        <path d="M74,56 C101,57 108,80 91,95 C80,83 74,68 74,56 Z" fill="${palette.mid}"/>
      </g>
      <g class="bird-body">
        <ellipse cx="60" cy="70" rx="35" ry="31" fill="${palette.base}"/>
      </g>
      <g class="bird-head">
        <ellipse cx="60" cy="38" rx="28" ry="26" fill="${palette.base}"/>
        <path class="bird-beak" d="M59,44 L75,50 L59,57 Z" fill="${palette.beak}"/>
        <g class="bird-eye bird-eye-left">
          <circle class="bird-eyeball bird-eyeball-left" cx="45" cy="34" r="11.5" fill="#fff"/>
          <g class="bird-pupil bird-pupil-left"><circle cx="45" cy="34" r="5.3" fill="#1a1611"/></g>
          <path class="bird-eyelid-closed bird-eyelid-closed-left" d="M35.5,34 Q45,27 54.5,34" fill="none" stroke="#1a1611" stroke-width="3.4" stroke-linecap="round" opacity="0"/>
        </g>
        <g class="bird-eye bird-eye-right">
          <circle class="bird-eyeball bird-eyeball-right" cx="74" cy="34" r="11.5" fill="#fff"/>
          <g class="bird-pupil bird-pupil-right"><circle cx="74" cy="34" r="5.3" fill="#1a1611"/></g>
          <path class="bird-eyelid-closed bird-eyelid-closed-right" d="M64.5,34 Q74,27 83.5,34" fill="none" stroke="#1a1611" stroke-width="3.4" stroke-linecap="round" opacity="0"/>
        </g>
      </g>`;
  }

  function owlSvg() {
    return `
      <g class="owl-feet">
        <ellipse cx="62" cy="140" rx="11" ry="5" fill="#caa46a"/>
        <ellipse cx="98" cy="140" rx="11" ry="5" fill="#caa46a"/>
      </g>
      <g class="owl-wing owl-wing-left">
        <path d="M58,68 C18,68 11,112 35,135 C50,118 58,92 58,68 Z" fill="#7a5a3a"/>
      </g>
      <g class="owl-wing owl-wing-right">
        <path d="M102,68 C142,68 149,112 125,135 C110,118 102,92 102,68 Z" fill="#7a5a3a"/>
      </g>
      <g class="owl-body">
        <ellipse cx="80" cy="96" rx="47" ry="42" fill="#9c7a4e"/>
      </g>
      <g class="owl-head">
        <path class="owl-ear owl-ear-left" d="M44,36 L34,10 L58,29 Z" fill="#9c7a4e"/>
        <path class="owl-ear owl-ear-right" d="M116,36 L126,10 L102,29 Z" fill="#9c7a4e"/>
        <circle cx="80" cy="50" r="44" fill="#b3906a"/>
        <path class="owl-beak" d="M80,60 L68,73 L92,73 Z" fill="#e8a23a"/>
        <g class="owl-eye owl-eye-left">
          <circle class="owl-eyeball owl-eyeball-left" cx="58" cy="47" r="20" fill="#fff"/>
          <g class="owl-pupil owl-pupil-left"><circle cx="58" cy="47" r="9.8" fill="#201708"/></g>
          <path class="owl-eyelid-closed owl-eyelid-closed-left" d="M40,47 Q58,34 76,47" fill="none" stroke="#201708" stroke-width="5.5" stroke-linecap="round" opacity="0"/>
        </g>
        <g class="owl-eye owl-eye-right">
          <circle class="owl-eyeball owl-eyeball-right" cx="102" cy="47" r="20" fill="#fff"/>
          <g class="owl-pupil owl-pupil-right"><circle cx="102" cy="47" r="9.8" fill="#201708"/></g>
          <path class="owl-eyelid-closed owl-eyelid-closed-right" d="M84,47 Q102,34 120,47" fill="none" stroke="#201708" stroke-width="5.5" stroke-linecap="round" opacity="0"/>
        </g>
      </g>`;
  }

  const BIRD_PALETTES = [
    { base: "#f2b84a", mid: "#e0a23a", dark: "#b97e28", beak: "#e2672f" },
    { base: "#7fc2c9", mid: "#5fa6ae", dark: "#3f7d84", beak: "#e2672f" },
    { base: "#e98fa0", mid: "#d06f82", dark: "#a84c5e", beak: "#e2672f" },
  ];
  // Tiny per-bird personality offset so three birds reading the same
  // password position never look mechanically identical.
  const BIRD_GAZE_OFFSET = [-1.3, 0, 1.3];
  const BIRD_KEY_DELAY = [0, 0.03, 0.06];
  const BIRD_BLINK_RANGE = [[3000, 7000], [4000, 8000], [3000, 9000]];

  // ---------- shared mouse target ----------
  const pointer = { x: window.innerWidth / 2, y: window.innerHeight * 0.3, active: false };
  window.addEventListener("pointermove", (e) => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.active = true; });

  // ---------- Bird ----------
  class Bird {
    constructor(root, index) {
      this.root = root;
      this.index = index;
      this.head = root.querySelector(".bird-head");
      this.pupils = root.querySelectorAll(".bird-pupil-left, .bird-pupil-right");
      this.pupilL = root.querySelector(".bird-pupil-left");
      this.pupilR = root.querySelector(".bird-pupil-right");
      this.eyeballs = root.querySelectorAll(".bird-eyeball-left, .bird-eyeball-right");
      this.eyeballL = root.querySelector(".bird-eyeball-left");
      this.eyeballR = root.querySelector(".bird-eyeball-right");
      this.eyelidPaths = root.querySelectorAll(".bird-eyelid-closed-left, .bird-eyelid-closed-right");
      this.eyelidPathL = root.querySelector(".bird-eyelid-closed-left");
      this.eyelidPathR = root.querySelector(".bird-eyelid-closed-right");
      this.eyeGroups = root.querySelectorAll(".bird-eye-left, .bird-eye-right");
      this.wingL = root.querySelector(".bird-wing-left");
      this.wingR = root.querySelector(".bird-wing-right");
      this.tail = root.querySelector(".bird-tail");
      this.lookEnabled = true;
      this.curX = 0;
      this.curY = 0;
      if (!prefersReducedMotion) {
        this._scheduleBlink();
        this._breathe();
        this._tailSway();
      }
    }

    // Proper cartoon closed-eye: the white eyeball + pupil fade out while a
    // curved stroke "eyelid" fades in — a closed eye still reads as an eye
    // (⌒), never a blank patch of face. `side` is "both", "left" or
    // "right" (the latter two for a one-eyed wink).
    closeEyes(side = "both", duration = 0.18) {
      const eyeballs = side === "both" ? this.eyeballs : [side === "left" ? this.eyeballL : this.eyeballR];
      const pupils = side === "both" ? this.pupils : [side === "left" ? this.pupilL : this.pupilR];
      const lids = side === "both" ? this.eyelidPaths : [side === "left" ? this.eyelidPathL : this.eyelidPathR];
      // A tween that's still waiting out its own `delay` doesn't register
      // as "owning" its property for auto-overwrite purposes yet — so a
      // slow in-flight openEyes() (e.g. from a blur firing right before
      // this) could silently coexist with this closeEyes() and fight it
      // once that delay elapses. Killing outright guarantees a clean start.
      gsap.killTweensOf([...eyeballs, ...pupils, ...lids]);
      gsap.to(eyeballs, { opacity: 0, duration: duration * 0.5, ease: "power1.in" });
      gsap.to(pupils, { opacity: 0, duration: duration * 0.4, ease: "power1.in" });
      gsap.to(lids, { opacity: 1, duration: duration * 0.55, delay: duration * 0.35, ease: "power1.out" });
    }
    openEyes(side = "both", duration = 0.18) {
      const eyeballs = side === "both" ? this.eyeballs : [side === "left" ? this.eyeballL : this.eyeballR];
      const pupils = side === "both" ? this.pupils : [side === "left" ? this.pupilL : this.pupilR];
      const lids = side === "both" ? this.eyelidPaths : [side === "left" ? this.eyelidPathL : this.eyelidPathR];
      gsap.killTweensOf([...eyeballs, ...pupils, ...lids]);
      gsap.to(lids, { opacity: 0, duration: duration * 0.4, ease: "power1.in" });
      gsap.to(eyeballs, { opacity: 1, duration: duration * 0.55, delay: duration * 0.25, ease: "power1.out" });
      gsap.to(pupils, { opacity: 1, duration: duration * 0.45, delay: duration * 0.35, ease: "power1.out" });
    }

    _scheduleBlink() {
      const [lo, hi] = BIRD_BLINK_RANGE[this.index] || [3000, 7000];
      const delay = lo + Math.random() * (hi - lo);
      this._blinkTimer = setTimeout(() => {
        if (this.lookEnabled) {
          // Readable but fast: close ~90ms, hold ~50ms, open ~110ms.
          this.closeEyes("both", 0.09);
          gsap.delayedCall(0.14, () => this.openEyes("both", 0.11));
        }
        this._scheduleBlink();
      }, delay);
    }

    _breathe() {
      gsap.to(this.root, { scaleY: 1.016, scaleX: 0.99, duration: 2 + Math.random(), yoyo: true, repeat: -1, ease: "sine.inOut", transformOrigin: "50% 100%" });
    }

    _tailSway() {
      gsap.to(this.tail, { rotation: 6, duration: 2.6 + Math.random(), yoyo: true, repeat: -1, ease: "sine.inOut", transformOrigin: "100% 50%" });
    }

    // Called every frame while lookEnabled — eyes carry most of the motion,
    // the head only a supporting fraction, the body essentially none.
    lookAt(nx, ny, leanBack) {
      if (!this.lookEnabled) return;
      this.curX += (nx - this.curX) * 0.1;
      this.curY += (ny - this.curY) * 0.08;
      gsap.set(this.pupils, { x: this.curX * 5, y: this.curY * 3.6 });
      gsap.set(this.head, { rotation: this.curX * 6, transformOrigin: "50% 100%" });
      gsap.set(this.root, { y: leanBack || 0 });
    }

    killIdle() {
      clearTimeout(this._blinkTimer);
    }

    toIdle(duration = 0.6) {
      this.lookEnabled = true;
      gsap.to(this.wingL, { rotation: 0, x: 0, y: 0, scale: 1, duration, ease: "back.out(1.4)", transformOrigin: "100% 0%" });
      gsap.to(this.wingR, { rotation: 0, x: 0, y: 0, scale: 1, duration, ease: "back.out(1.4)", transformOrigin: "0% 0%" });
      this.openEyes("both", duration);
      gsap.to(this.head, { rotation: 0, y: 0, scale: 1, duration, ease: "sine.inOut", transformOrigin: "50% 100%" });
      gsap.to(this.pupils, { x: 0, y: 0, duration });
      gsap.to(this.root, { y: 0, duration });
      this.curX = 0; this.curY = 0;
    }

    lookDownAtAccount(lean) {
      this.lookEnabled = false;
      this.openEyes("both", 0.3);
      gsap.to(this.pupils, { y: 4, x: 0, duration: 0.45, ease: "sine.out" });
      gsap.to(this.head, {
        rotation: 0,
        y: lean ? 4 : 1.5,
        scale: lean ? 1.04 : 1,
        duration: 0.45,
        ease: "sine.out",
        transformOrigin: "50% 100%",
      });
    }

    curiousTilt() {
      gsap.fromTo(this.head, { rotation: "+=0" }, { rotation: "+=7", duration: 0.18, yoyo: true, repeat: 1, ease: "sine.inOut", transformOrigin: "50% 100%" });
    }

    // Password field focused/typing, HIDDEN (dots). Eyes stay fully open
    // and keep reading the password position left->right as `length`
    // grows — a tiny per-bird offset keeps three birds reading the same
    // spot from looking mechanically synced. `keyDelay` staggers the
    // per-keystroke reaction a few ms apart. Eye-closing is reserved for
    // the moment the password actually becomes visible (strongAvert()).
    watchPassword(length, keyDelay) {
      this.lookEnabled = false;
      const nx = readPosition(length);
      const targetX = clamp(nx * 4.6 + BIRD_GAZE_OFFSET[this.index], -6, 6);
      const run = () => {
        this.openEyes("both", 0.2);
        gsap.to(this.pupils, { x: targetX, y: 4, duration: 0.17, ease: "power2.out" });
        gsap.to(this.head, { rotation: nx * 4, duration: 0.2, ease: "sine.out", transformOrigin: "50% 100%" });
        gsap.to(this.wingL, { rotation: 0, x: 0, y: 0, duration: 0.3, ease: "sine.out", transformOrigin: "100% 0%" });
        gsap.to(this.wingR, { rotation: 0, x: 0, y: 0, duration: 0.3, ease: "sine.out", transformOrigin: "0% 0%" });
        // The 1px "dip" micro-reaction — quick down-and-back, independent
        // of the held rotation above (different property, same element).
        gsap.to(this.head, { y: "+=1", duration: 0.08, yoyo: true, repeat: 1, ease: "sine.inOut" });
      };
      if (keyDelay) gsap.delayedCall(keyDelay, run); else run();
    }

    // Password visibility turned ON — the privacy reaction, one bird at a
    // time: "away" turns its head but keeps its eyes open; "cover" shuts
    // its eyes (proper curved lids) AND raises its wings; "wingShield"
    // turns away AND shuts its eyes. Called after the shared freeze/widen
    // beat.
    strongAvert(variant) {
      this.lookEnabled = false;
      if (variant === "away") {
        gsap.to(this.head, { rotation: -62, x: -4, duration: 0.3, ease: "power3.out", transformOrigin: "50% 100%" });
      } else if (variant === "cover") {
        this.closeEyes("both", 0.16);
        gsap.to(this.wingL, { rotation: 100, x: 14, y: -22, duration: 0.26, ease: "back.out(2.2)", transformOrigin: "100% 0%" });
        gsap.to(this.wingR, { rotation: -100, x: -14, y: -22, duration: 0.26, ease: "back.out(2.2)", transformOrigin: "0% 0%" });
      } else if (variant === "wingShield") {
        this.closeEyes("both", 0.16);
        gsap.to(this.head, { rotation: 54, duration: 0.3, ease: "power3.out", transformOrigin: "50% 100%" });
        gsap.to(this.wingR, { rotation: -70, x: -14, y: -10, duration: 0.28, ease: "back.out(1.8)", transformOrigin: "0% 0%" });
      }
    }

    // Password visibility turned back OFF — cautious return, eyes finding
    // the current password position again (not a fixed neutral spot).
    cautiousReturn(length) {
      this.lookEnabled = false;
      this.openEyes("both", 0.3);
      gsap.to(this.wingL, { rotation: 0, x: 0, y: 0, duration: 0.4, ease: "sine.out", transformOrigin: "100% 0%" });
      gsap.to(this.wingR, { rotation: 0, x: 0, y: 0, duration: 0.4, ease: "sine.out", transformOrigin: "0% 0%" });
      gsap.to(this.head, { rotation: 0, duration: 0.4, ease: "sine.inOut", transformOrigin: "50% 100%" });
      gsap.delayedCall(0.22, () => this.watchPassword(length));
    }

    errorTilt(dir) {
      this.lookEnabled = false;
      this.openEyes("both", 0.2);
      gsap.to(this.head, { rotation: dir * 13, duration: 0.3, ease: "sine.out", transformOrigin: "50% 100%" });
    }

    // Glances toward a sibling bird (used for bird 2's "what's going on?"
    // reaction during a login error) — `dir` is -1/1 for left/right.
    glanceAt(dir) {
      this.lookEnabled = false;
      this.openEyes("both", 0.2);
      gsap.to(this.pupils, { x: dir * 4.5, y: 0.5, duration: 0.25, ease: "sine.out" });
      gsap.to(this.head, { rotation: dir * 10, duration: 0.25, ease: "sine.out", transformOrigin: "50% 100%" });
    }

    settleLookingAtForm() {
      gsap.to(this.pupils, { x: 0, y: 3, duration: 0.3, ease: "sine.out" });
      gsap.to(this.head, { rotation: 0, duration: 0.3, ease: "sine.out", transformOrigin: "50% 100%" });
    }

    happy() {
      this.lookEnabled = false;
      this.openEyes("both", 0.12);
      const tl = gsap.timeline();
      tl.to(this.head, { rotation: 0, duration: 0.12 }, 0)
        .to(this.pupils, { x: 0, y: 0, duration: 0.12 }, 0)
        .to([this.wingL], { rotation: -60, duration: 0.13, transformOrigin: "100% 0%" }, 0.04)
        .to([this.wingR], { rotation: 60, duration: 0.13, transformOrigin: "0% 0%" }, 0.04)
        .to([this.wingL], { rotation: 0, duration: 0.13, transformOrigin: "100% 0%" }, 0.2)
        .to([this.wingR], { rotation: 0, duration: 0.13, transformOrigin: "0% 0%" }, 0.2)
        .to(this.root, { y: -13, duration: 0.13, ease: "power1.out" }, 0.09)
        .to(this.root, { y: 0, duration: 0.18, ease: "bounce.out" }, 0.22);
    }

    flyAway(direction) {
      this.killIdle();
      this.lookEnabled = false;
      const tl = gsap.timeline();
      tl.to(this.pupils, { y: -4, duration: 0.2 }, 0)
        .to(this.head, { rotation: -8, duration: 0.2, transformOrigin: "50% 100%" }, 0)
        .to([this.wingL], { rotation: -40, duration: 0.18, transformOrigin: "100% 0%" }, 0.1)
        .to([this.wingR], { rotation: 40, duration: 0.18, transformOrigin: "0% 0%" }, 0.1)
        .to([this.wingL], { rotation: -10, duration: 0.1, yoyo: true, repeat: 3, transformOrigin: "100% 0%" }, 0.28)
        .to([this.wingR], { rotation: 10, duration: 0.1, yoyo: true, repeat: 3, transformOrigin: "0% 0%" }, 0.28)
        .to(this.root, {
          x: direction.x,
          y: direction.y,
          rotation: direction.rot,
          opacity: 0,
          scale: 0.6,
          duration: 0.85,
          ease: "power1.in",
        }, 0.32);
      return tl;
    }

    flyIn(from, toDelay) {
      gsap.set(this.root, { x: from.x, y: from.y, opacity: 0, scale: 0.6, rotation: from.rot || 0 });
      gsap.to([this.wingL], { rotation: -10, duration: 0.12, yoyo: true, repeat: -1, transformOrigin: "100% 0%" });
      gsap.to([this.wingR], { rotation: 10, duration: 0.12, yoyo: true, repeat: -1, transformOrigin: "0% 0%" });
      const tl = gsap.timeline({ delay: toDelay });
      tl.to(this.root, { x: 0, y: -10, rotation: 0, opacity: 1, scale: 1, duration: 0.75, ease: "power2.out" })
        .add(() => { gsap.killTweensOf([this.wingL, this.wingR]); })
        .to(this.root, { y: 4, duration: 0.09, ease: "power1.in" })
        .to(this.root, { y: 0, duration: 0.16, ease: "bounce.out" })
        .add(() => {
          this.toIdle(0.3);
          if (!prefersReducedMotion) { this._scheduleBlink(); this._breathe(); this._tailSway(); }
        });
      return tl;
    }

    // Reduced-motion fallback — no flight path, just a quick settle fade.
    settleOut() {
      this.killIdle();
      this.lookEnabled = false;
      gsap.to(this.root, { opacity: 0, duration: 0.25 });
    }
    settleIn(delay) {
      gsap.set(this.root, { opacity: 0, x: 0, y: 0, scale: 1, rotation: 0 });
      gsap.to(this.root, { opacity: 1, duration: 0.3, delay, onComplete: () => { this.toIdle(0.2); if (!prefersReducedMotion) { this._scheduleBlink(); this._breathe(); this._tailSway(); } } });
    }
  }

  // ---------- Owl ----------
  // Same mechanics as Bird, but larger gaze range, slower/more deliberate
  // easing, and no per-sibling personality offset (there's only one).
  class Owl {
    constructor(root) {
      this.root = root;
      this.head = root.querySelector(".owl-head");
      this.pupils = root.querySelectorAll(".owl-pupil-left, .owl-pupil-right");
      this.eyeballs = root.querySelectorAll(".owl-eyeball-left, .owl-eyeball-right");
      this.eyelidPaths = root.querySelectorAll(".owl-eyelid-closed-left, .owl-eyelid-closed-right");
      this.eyeGroups = root.querySelectorAll(".owl-eye-left, .owl-eye-right");
      this.wingL = root.querySelector(".owl-wing-left");
      this.wingR = root.querySelector(".owl-wing-right");
      this.lookEnabled = true;
      this.curX = 0;
      this.curY = 0;
    }

    // Proper cartoon closed-eye, scaled up for the owl's larger eyes: the
    // white eyeball + pupil fade out while a thick curved "eyelid" stroke
    // fades in — a closed eye still reads as an eye, never a blank patch.
    closeEyes(duration = 0.2) {
      // See Bird.closeEyes() for why this kill is necessary: a tween still
      // waiting out its own delay isn't yet "overwritable" by auto-overwrite.
      gsap.killTweensOf([...this.eyeballs, ...this.pupils, ...this.eyelidPaths]);
      gsap.to(this.eyeballs, { opacity: 0, duration: duration * 0.5, ease: "power1.in" });
      gsap.to(this.pupils, { opacity: 0, duration: duration * 0.4, ease: "power1.in" });
      gsap.to(this.eyelidPaths, { opacity: 1, duration: duration * 0.55, delay: duration * 0.35, ease: "power1.out" });
    }
    openEyes(duration = 0.2) {
      gsap.killTweensOf([...this.eyeballs, ...this.pupils, ...this.eyelidPaths]);
      gsap.to(this.eyelidPaths, { opacity: 0, duration: duration * 0.4, ease: "power1.in" });
      gsap.to(this.eyeballs, { opacity: 1, duration: duration * 0.55, delay: duration * 0.25, ease: "power1.out" });
      gsap.to(this.pupils, { opacity: 1, duration: duration * 0.45, delay: duration * 0.35, ease: "power1.out" });
    }

    _scheduleBlink() {
      const delay = 3200 + Math.random() * 4200;
      this._blinkTimer = setTimeout(() => {
        if (this.lookEnabled) {
          this.closeEyes(0.1);
          gsap.delayedCall(0.16, () => this.openEyes(0.12));
        }
        this._scheduleBlink();
      }, delay);
    }
    _breathe() {
      gsap.to(this.root, { scaleY: 1.014, scaleX: 0.992, duration: 2.6, yoyo: true, repeat: -1, ease: "sine.inOut", transformOrigin: "50% 100%" });
    }
    killIdle() { clearTimeout(this._blinkTimer); }

    lookAt(nx, ny) {
      if (!this.lookEnabled) return;
      // Slower lerp than the birds — calm, deliberate, not twitchy.
      this.curX += (nx - this.curX) * 0.07;
      this.curY += (ny - this.curY) * 0.06;
      gsap.set(this.pupils, { x: this.curX * 7, y: this.curY * 5 });
      gsap.set(this.head, { rotation: this.curX * 13, transformOrigin: "50% 100%" });
    }

    toIdle(duration = 0.6) {
      this.lookEnabled = true;
      this.openEyes(duration);
      gsap.to(this.head, { rotation: 0, duration, ease: "sine.inOut", transformOrigin: "50% 100%" });
      gsap.to([this.wingL, this.wingR], { rotation: 0, duration });
      gsap.to(this.pupils, { x: 0, y: 0, duration });
    }

    lookDownAtAccount() {
      this.lookEnabled = false;
      this.openEyes(0.3);
      gsap.to(this.pupils, { y: 6, duration: 0.5, ease: "sine.out" });
      gsap.to(this.head, { rotation: 7, y: 2, duration: 0.5, ease: "sine.out", transformOrigin: "50% 100%" });
    }

    curiousTilt() {
      gsap.fromTo(this.head, { rotation: "+=0" }, { rotation: "+=9", duration: 0.2, yoyo: true, repeat: 1, ease: "sine.inOut", transformOrigin: "50% 100%" });
    }

    // Password field focused/typing, HIDDEN (dots). Eyes stay fully open
    // and read the password position left->right, same as the birds —
    // scaled up for the owl's much larger eyes, plus a touch of head
    // rotation. Eye-closing is reserved for dramaticAvert() below.
    watchPassword(length) {
      this.lookEnabled = false;
      this.openEyes(0.2);
      const nx = readPosition(length);
      gsap.to(this.pupils, { x: nx * 8.5, y: 5, duration: 0.2, ease: "power2.out" });
      gsap.to(this.head, { rotation: nx * 6, duration: 0.22, ease: "sine.out", transformOrigin: "50% 100%" });
      gsap.to([this.wingL, this.wingR], { rotation: 0, duration: 0.3 });
      gsap.to(this.head, { y: "+=1", duration: 0.09, yoyo: true, repeat: 1, ease: "sine.inOut" });
    }

    // Password visibility turned ON — wide-eyed realization beat, then
    // eyes shut (proper curved lids) and a dramatic, deliberate head
    // rotation away. Holds while visible.
    dramaticAvert() {
      this.lookEnabled = false;
      this.openEyes(0.05);
      gsap.to(this.pupils, { x: 0, y: 5, duration: 0.1, ease: "power1.out" });
      gsap.to(this.eyeGroups, { scale: 1.2, duration: 0.1, yoyo: true, repeat: 1, transformOrigin: "50% 50%" });
      gsap.delayedCall(0.25, () => {
        this.closeEyes(0.2);
        gsap.to(this.head, { rotation: -105, duration: 0.6, ease: "power3.out", transformOrigin: "50% 100%" });
      });
    }

    // Password visibility turned back OFF — waits, cautiously rotates
    // back, then resumes reading at the current length (watchPassword()
    // reopens the eyes as part of that).
    cautiousReturn(length) {
      this.lookEnabled = false;
      gsap.delayedCall(0.12, () => {
        gsap.to(this.head, { rotation: 0, duration: 0.45, ease: "sine.inOut", transformOrigin: "50% 100%" });
        gsap.delayedCall(0.3, () => this.watchPassword(length));
      });
    }

    confusedBlink() {
      this.lookEnabled = false;
      this.openEyes(0.3);
      gsap.to(this.head, { rotation: -26, duration: 0.35, ease: "back.out(1.6)", transformOrigin: "50% 100%" });
      // Two readable blinks after the tilt settles.
      gsap.delayedCall(0.3, () => {
        this.closeEyes(0.09);
        gsap.delayedCall(0.14, () => {
          this.openEyes(0.11);
          gsap.delayedCall(0.2, () => {
            this.closeEyes(0.09);
            gsap.delayedCall(0.14, () => this.openEyes(0.11));
          });
        });
      });
    }

    happy() {
      this.lookEnabled = false;
      this.openEyes(0.15);
      const tl = gsap.timeline();
      tl.to(this.head, { rotation: 0, duration: 0.15 }, 0)
        .to(this.pupils, { x: 0, y: 0, duration: 0.15 }, 0)
        .to(this.wingL, { rotation: -55, duration: 0.15, transformOrigin: "100% 0%" }, 0.05)
        .to(this.wingR, { rotation: 55, duration: 0.15, transformOrigin: "0% 0%" }, 0.05)
        .to(this.wingL, { rotation: 0, duration: 0.17, transformOrigin: "100% 0%" }, 0.24)
        .to(this.wingR, { rotation: 0, duration: 0.17, transformOrigin: "0% 0%" }, 0.24)
        .to(this.root, { y: -15, duration: 0.15, ease: "power1.out" }, 0.09)
        .to(this.root, { y: 0, duration: 0.2, ease: "bounce.out" }, 0.26);
    }

    lookAtMoon() {
      this.lookEnabled = false;
      gsap.to(this.pupils, { x: 6, y: -5, duration: 0.3 });
      gsap.to(this.head, { rotation: 10, duration: 0.3, ease: "sine.out", transformOrigin: "50% 100%" });
    }

    flyAway() {
      this.killIdle();
      this.lookEnabled = false;
      const tl = gsap.timeline();
      tl.to([this.wingL], { rotation: -45, duration: 0.22, transformOrigin: "100% 0%" }, 0)
        .to([this.wingR], { rotation: 45, duration: 0.22, transformOrigin: "0% 0%" }, 0)
        .to([this.wingL], { rotation: -14, duration: 0.11, yoyo: true, repeat: 3, transformOrigin: "100% 0%" }, 0.24)
        .to([this.wingR], { rotation: 14, duration: 0.11, yoyo: true, repeat: 3, transformOrigin: "0% 0%" }, 0.24)
        .to(this.root, { x: 160, y: -260, rotation: 18, opacity: 0, scale: 0.5, duration: 0.95, ease: "power1.in" }, 0.4);
      return tl;
    }

    flyIn() {
      gsap.set(this.root, { x: 170, y: -240, rotation: -14, opacity: 0, scale: 0.55 });
      gsap.to([this.wingL], { rotation: -12, duration: 0.13, yoyo: true, repeat: -1, transformOrigin: "100% 0%" });
      gsap.to([this.wingR], { rotation: 12, duration: 0.13, yoyo: true, repeat: -1, transformOrigin: "0% 0%" });
      const tl = gsap.timeline({ delay: 0.5 });
      tl.to(this.root, { x: 0, y: -12, rotation: 0, opacity: 1, scale: 1, duration: 0.85, ease: "power2.out" })
        .add(() => gsap.killTweensOf([this.wingL, this.wingR]))
        .to(this.root, { y: 5, duration: 0.1, ease: "power1.in" })
        .to(this.root, { y: 0, duration: 0.18, ease: "bounce.out" })
        .add(() => {
          this.toIdle(0.3);
          if (!prefersReducedMotion) { this._scheduleBlink(); this._breathe(); }
        });
      return tl;
    }

    settleOut() {
      this.killIdle();
      this.lookEnabled = false;
      gsap.to(this.root, { opacity: 0, duration: 0.25 });
    }
    settleIn() {
      gsap.set(this.root, { opacity: 0, x: 0, y: 0, scale: 1, rotation: 0 });
      gsap.to(this.root, { opacity: 1, duration: 0.3, onComplete: () => { this.toIdle(0.2); if (!prefersReducedMotion) { this._scheduleBlink(); this._breathe(); } } });
    }
  }

  // ---------- assembly ----------
  const perch = document.getElementById("mascot-perch");
  const birds = [];
  let owl = null;
  let nightMode = false;
  let lastPasswordLength = 0;

  BIRD_PALETTES.forEach((palette, i) => {
    const wrap = document.createElement("div");
    wrap.className = "mascot-bird-wrap mascot-bird-wrap-" + i;
    wrap.innerHTML = `<svg class="mascot-bird" viewBox="0 0 120 110">${birdSvg(palette)}</svg>`;
    perch.appendChild(wrap);
    birds.push(new Bird(wrap, i));
  });

  const owlWrap = document.createElement("div");
  owlWrap.className = "mascot-owl-wrap";
  owlWrap.innerHTML = `<svg class="mascot-owl" viewBox="0 0 160 150">${owlSvg()}</svg>`;
  owlWrap.style.opacity = "0";
  owlWrap.style.pointerEvents = "none";
  perch.appendChild(owlWrap);
  owl = new Owl(owlWrap);

  // ---------- explicit priority gate ----------
  // A lower-priority call is simply dropped while a higher-priority state
  // is active, so e.g. the idle cursor-tracking loop (which only ever runs
  // while a character's own `lookEnabled` is true — and every posed state
  // above turns that off) can never stomp a password reaction mid-flight.
  const PRIORITY = {
    idle: 0,
    cursorTracking: 1,
    accountFocused: 2,
    passwordFocused: 3,
    passwordTyping: 4,
    passwordVisible: 5,
    loginError: 6,
    loginSuccess: 7,
  };
  let currentState = "idle";
  let currentPriority = PRIORITY.idle;
  function trySetState(name) {
    const p = PRIORITY[name];
    if (p < currentPriority) return false;
    currentPriority = p;
    currentState = name;
    return true;
  }
  function forceSetState(name) {
    currentPriority = PRIORITY[name];
    currentState = name;
  }

  // ---------- shared cursor-tracking loop (single authoritative writer of
  // pupil/head transforms while idle — every posed state above disables it
  // per-character via lookEnabled, so nothing else touches these properties
  // at the same time) ----------
  if (!prefersReducedMotion) {
    (function trackLoop() {
      if (!document.hidden && pointer.active) {
        birds.forEach((b) => {
          if (!b.lookEnabled || nightMode) return;
          const r = b.root.getBoundingClientRect();
          const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.35;
          const dist = Math.hypot(pointer.x - cx, pointer.y - cy);
          const nx = clamp((pointer.x - cx) / 260, -1, 1);
          const ny = clamp((pointer.y - cy) / 260, -1, 1);
          // Subtle lean-back only when the cursor gets right on top of it —
          // never a "flee", just a couple of pixels of recoil.
          const leanBack = dist < 45 ? -clamp((45 - dist) / 45, 0, 1) * 3 : 0;
          b.lookAt(nx, ny, leanBack);
        });
        if (owl.lookEnabled && nightMode) {
          const r = owl.root.getBoundingClientRect();
          const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.35;
          const nx = clamp((pointer.x - cx) / 300, -1, 1);
          const ny = clamp((pointer.y - cy) / 300, -1, 1);
          owl.lookAt(nx, ny);
        }
      }
      requestAnimationFrame(trackLoop);
    })();

    // Occasional, rare, asynchronous "life" — one bird glances at a
    // neighbor, only while genuinely idle. Never synchronized, never
    // frequent enough to feel twitchy.
    (function glanceLoop() {
      const delay = 8000 + Math.random() * 9000;
      setTimeout(() => {
        if (currentState === "idle" && !nightMode && !document.hidden) {
          const i = Math.floor(Math.random() * 3);
          const neighbor = birds[i === 2 ? 1 : i + 1];
          const bird = birds[i];
          if (bird.lookEnabled && neighbor) {
            const br = bird.root.getBoundingClientRect();
            const nr = neighbor.root.getBoundingClientRect();
            const dx = clamp((nr.left - br.left) / 120, -1, 1);
            gsap.to(bird, { curX: dx, duration: 0.5, ease: "sine.inOut", onUpdate: () => gsap.set(bird.pupils, { x: bird.curX * 5 }) });
            gsap.to(bird.head, { rotation: dx * 6, duration: 0.5, ease: "sine.inOut", transformOrigin: "50% 100%" });
          }
        }
        glanceLoop();
      }, delay);
    })();
  }

  // ---------- public API ----------
  window.LoginMascots = {
    onAccountFocus() {
      if (!trySetState("accountFocused")) return;
      if (nightMode) { owl.lookDownAtAccount(); return; }
      birds[0].lookDownAtAccount(false);
      birds[1].lookDownAtAccount(true);
      birds[2].lookDownAtAccount(false);
    },
    onAccountChange() {
      if (currentPriority > PRIORITY.accountFocused) return;
      if (nightMode) { owl.curiousTilt(); return; }
      birds.forEach((b) => b.curiousTilt());
    },
    onPasswordFocus() {
      lastPasswordLength = 0;
      if (!trySetState("passwordFocused")) return;
      if (nightMode) { owl.watchPassword(0); return; }
      birds.forEach((b) => b.watchPassword(0));
    },
    onPasswordTyping(length) {
      const delta = length - lastPasswordLength;
      lastPasswordLength = length;
      if (!trySetState("passwordTyping")) return;
      if (nightMode) { owl.watchPassword(length); return; }
      // Staggered per-bird so the reaction reads as three individuals
      // noticing in quick succession, not one synchronized flinch.
      birds.forEach((b) => b.watchPassword(length, BIRD_KEY_DELAY[b.index]));
    },
    onPasswordVisibility(visible) {
      if (visible) {
        if (!trySetState("passwordVisible")) return;
        if (nightMode) { owl.dramaticAvert(); return; }
        // The punchline: a brief shared freeze with wide eyes — "wait,
        // we can see it now" — THEN each bird's exaggerated reaction.
        birds.forEach((b) => {
          gsap.to(b.eyeGroups, { scale: 1.22, duration: 0.09, transformOrigin: "50% 50%" });
        });
        gsap.delayedCall(0.13, () => {
          birds[0].strongAvert("away");
          birds[1].strongAvert("cover");
          birds[2].strongAvert("wingShield");
          birds.forEach((b) => gsap.to(b.eyeGroups, { scale: 1, duration: 0.2 }));
        });
      } else {
        // An explicit downgrade the user just triggered — drop straight to
        // the passwordFocused tier rather than going through trySetState,
        // which would reject moving to a lower tier while passwordVisible
        // is still technically "current".
        forceSetState("passwordFocused");
        if (nightMode) { owl.cautiousReturn(lastPasswordLength); return; }
        birds.forEach((b) => b.cautiousReturn(lastPasswordLength));
      }
    },
    onPasswordBlur() {
      // Leaving the field resets to idle, but must never cut off an
      // error/success sequence that's still playing.
      if (currentPriority >= PRIORITY.loginError) return;
      forceSetState("idle");
      if (nightMode) { owl.toIdle(0.6); return; }
      birds.forEach((b) => b.toIdle(0.7));
    },
    onLoginError() {
      trySetState("loginError");
      if (nightMode) {
        owl.confusedBlink();
      } else {
        birds[0].errorTilt(-1);
        birds[1].glanceAt(-1);
        birds[2].errorTilt(1);
        gsap.delayedCall(0.5, () => { if (currentState === "loginError") birds.forEach((b) => b.settleLookingAtForm()); });
      }
      gsap.delayedCall(1.4, () => {
        if (currentState !== "loginError") return;
        forceSetState("idle");
        if (nightMode) owl.toIdle(0.5); else birds.forEach((b) => b.toIdle(0.5));
      });
    },
    onLoginSuccess() {
      // Always wins immediately — the form is about to navigate away.
      forceSetState("loginSuccess");
      if (nightMode) owl.happy(); else birds.forEach((b) => b.happy());
    },
    onDayToNight() {
      if (nightMode) return;
      nightMode = true;
      forceSetState("idle");
      owlWrap.style.pointerEvents = "auto";
      if (prefersReducedMotion) {
        birds.forEach((b) => b.settleOut());
        gsap.delayedCall(0.3, () => owl.settleIn());
        return;
      }
      const dirs = [
        { x: -120, y: -260, rot: -20 },
        { x: 10, y: -300, rot: 0 },
        { x: 130, y: -250, rot: 20 },
      ];
      birds.forEach((b, i) => b.flyAway(dirs[i]));
      gsap.to(owlWrap, { opacity: 1, duration: 0.01, delay: 0.9 });
      gsap.delayedCall(0.9, () => owl.flyIn());
    },
    onNightToDay() {
      if (!nightMode) return;
      forceSetState("idle");
      if (prefersReducedMotion) {
        owl.settleOut();
        gsap.delayedCall(0.3, () => { owlWrap.style.opacity = "0"; owlWrap.style.pointerEvents = "none"; });
        birds.forEach((b, i) => b.settleIn(0.35 + i * 0.06));
        gsap.delayedCall(0.8, () => { nightMode = false; });
        return;
      }
      owl.lookAtMoon();
      gsap.delayedCall(0.25, () => {
        owl.flyAway();
        gsap.delayedCall(0.9, () => { owlWrap.style.opacity = "0"; owlWrap.style.pointerEvents = "none"; });
      });
      const froms = [
        { x: -140, y: -240, rot: -16 },
        { x: 0, y: -280, rot: 0 },
        { x: 140, y: -240, rot: 16 },
      ];
      birds.forEach((b, i) => b.flyIn(froms[i], 0.6 + i * 0.08));
      gsap.delayedCall(2, () => { nightMode = false; });
    },
  };
})();
