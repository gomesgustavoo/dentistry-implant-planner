/* main.js — landing behaviour. No dependencies, no build step.
 *
 * Adapted from dicomsegvr.com/main.js. Its block 7 (the pointer-tilt handler for a
 * `.stack` element that no longer exists) is deliberately not carried over; the
 * arch readout below is new.
 */
(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var fine = window.matchMedia("(pointer: fine)").matches;

  /* 1) Scroll reveals — fire once, then stop observing. */
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reduced) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add("is-visible");
        io.unobserve(e.target);
      });
    }, { threshold: 0.15 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("is-visible"); });
  }

  /* 2) Mobile nav drawer.
   *    No `overflow:hidden` scroll-lock on <html>: that is what broke the sticky
   *    nav on dicomsegvr.com, dragging the bar and the drawer off-screen with the
   *    close button unreachable. The scrim handles dismissal instead. */
  var toggle = document.getElementById("navToggle");
  var menu = document.getElementById("navMenu");
  var scrim = document.getElementById("navScrim");

  function setOpen(open) {
    if (!toggle || !menu) return;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    menu.classList.toggle("is-open", open);
    document.documentElement.classList.toggle("nav-open", open);
    if (scrim) scrim.hidden = !open;
  }
  if (toggle) {
    toggle.addEventListener("click", function () {
      setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });
    menu.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });
    if (scrim) scrim.addEventListener("click", function () { setOpen(false); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setOpen(false);
    });
    document.addEventListener("click", function (e) {
      if (toggle.getAttribute("aria-expanded") !== "true") return;
      if (!menu.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
    });
  }

  /* 3) FAQ — single-open, riding the native <details> toggle event rather than
   *    reimplementing disclosure. */
  var faqItems = document.querySelectorAll(".faq__item");
  faqItems.forEach(function (item) {
    item.addEventListener("toggle", function () {
      if (!item.open) return;
      faqItems.forEach(function (other) { if (other !== item) other.open = false; });
    });
  });

  /* 4) Nav hairline. */
  var nav = document.querySelector(".nav");
  function onScroll() {
    if (nav) nav.classList.toggle("is-scrolled", window.scrollY > 8);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* 4b) `#top` IS the sticky header, so a plain fragment jump is unreliable. */
  document.querySelectorAll('a[href="#top"]').forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
      history.replaceState(null, "", window.location.pathname + window.location.search);
    });
  });
  if (window.location.hash === "#top") {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  /* 5) Count-up on the prices. The formatted value is already in the text node, so
   *    no-JS and reduced-motion both show the real number. */
  var counters = document.querySelectorAll("[data-count]");
  function countUp(el) {
    var target = parseFloat(el.getAttribute("data-count"));
    var dec = parseInt(el.getAttribute("data-decimals") || "0", 10);
    var pre = el.getAttribute("data-prefix") || "";
    var suf = el.getAttribute("data-suffix") || "";
    if (reduced || !isFinite(target)) { return; }
    var start = performance.now(), dur = 1100;
    function frame(now) {
      var t = Math.min((now - start) / dur, 1);
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = pre + (target * eased).toFixed(dec) + suf;
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  if ("IntersectionObserver" in window && counters.length) {
    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        countUp(e.target);
        cio.unobserve(e.target);
      });
    }, { threshold: 0.6 });
    counters.forEach(function (el) { cio.observe(el); });
  }

  /* 6) Magnetic primary CTA — fine pointer, motion allowed, RAF-throttled. */
  if (fine && !reduced) {
    document.querySelectorAll(".btn--primary.btn--lg").forEach(function (btn) {
      var queued = false, dx = 0, dy = 0;
      btn.addEventListener("pointermove", function (e) {
        var r = btn.getBoundingClientRect();
        dx = ((e.clientX - (r.left + r.width / 2)) / (r.width / 2)) * 6;
        dy = ((e.clientY - (r.top + r.height / 2)) / (r.height / 2)) * 5;
        if (queued) return;
        queued = true;
        requestAnimationFrame(function () {
          btn.style.transform = "translate(" + dx.toFixed(1) + "px," + (dy - 2).toFixed(1) + "px)";
          queued = false;
        });
      });
      btn.addEventListener("pointerleave", function () { btn.style.transform = ""; });
    });
  }

  /* 7) The FDI arch readout.
   *
   *    Reports what the pipeline actually found for the hovered tooth, from the
   *    data attributes gen-arch.py wrote out of the job's own report.json. Both
   *    pointer and keyboard, because the glyphs are real buttons — and click
   *    latches on touch, where there is no hover. */
  var chart = document.getElementById("archChart");
  var readout = document.getElementById("archReadout");
  var IDLE = "Hover a tooth to see what the segmentation found.";
  var QUADRANT = { 1: "upper right", 2: "upper left", 3: "lower left", 4: "lower right" };
  var POSITION = ["central incisor", "lateral incisor", "canine", "first premolar",
                  "second premolar", "first molar", "second molar", "third molar"];
  var latched = null;

  function describe(btn) {
    var fdi = parseInt(btn.getAttribute("data-fdi"), 10);
    var name = QUADRANT[Math.floor(fdi / 10)] + " " + POSITION[(fdi % 10) - 1];
    if (btn.classList.contains("tooth--absent")) {
      return '<b>' + fdi + '</b> · ' + name +
        ' <span class="r__sep">/</span> <span class="r__absent">no label produced here</span>';
    }
    var vol = btn.getAttribute("data-vol");
    var comp = btn.getAttribute("data-comp");
    var parts = ['<b>' + fdi + '</b> · ' + name];
    if (vol) parts.push('<b>' + vol + '</b> cm³');
    if (comp) parts.push('<b>' + comp + '</b> connected ' + (comp === "1" ? "component" : "components"));
    return parts.join(' <span class="r__sep">/</span> ');
  }

  function show(btn) {
    if (!readout) return;
    readout.innerHTML = btn ? describe(btn) : IDLE;
  }

  if (chart && readout) {
    chart.addEventListener("pointerover", function (e) {
      var btn = e.target.closest(".tooth");
      if (btn && !latched) show(btn);
    });
    chart.addEventListener("pointerleave", function () { if (!latched) show(null); });
    chart.addEventListener("focusin", function (e) {
      var btn = e.target.closest(".tooth");
      if (btn) show(btn);
    });
    chart.addEventListener("click", function (e) {
      var btn = e.target.closest(".tooth");
      if (!btn) return;
      if (latched === btn) {
        latched.classList.remove("is-active");
        latched = null;
        show(null);
        return;
      }
      if (latched) latched.classList.remove("is-active");
      latched = btn;
      btn.classList.add("is-active");
      show(btn);
    });
  }
})();
