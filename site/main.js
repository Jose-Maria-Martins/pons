// What the watch shows for each example: top label, value, bottom label, ring fill (0 to 1).
const faces = { sleep: ["Sleep", "7:15", "this week", 0.8], ready: ["HRV", "62", "ms, balanced", 0.72], plan: ["Running", "38", "km this week", 0.54] };
const chat = document.getElementById("chat");
function showExample(q) {
  chat.replaceChildren(document.getElementById("t-" + q).content.cloneNode(true));
  const [top, val, bot, fill] = faces[q];
  document.getElementById("w-top").textContent = top;
  document.getElementById("w-val").textContent = val;
  document.getElementById("w-bot").textContent = bot;
  document.getElementById("w-ring").style.strokeDashoffset = 351.9 * (1 - fill);
}

// Accessible tabs: click or arrow keys select; only the selected tab is in the tab order.
function tabs(list, onPick) {
  const all = [...list.querySelectorAll("[role=tab]")];
  const pick = (b) => {
    for (const o of all) { o.setAttribute("aria-selected", o === b); o.tabIndex = o === b ? 0 : -1; }
    onPick(b);
  };
  for (const b of all) {
    b.addEventListener("click", () => pick(b));
    b.addEventListener("keydown", (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const next = all[(all.indexOf(b) + step + all.length) % all.length];
      next.focus(); pick(next);
    });
  }
  return (id) => pick(all.find((b) => (b.dataset.p || b.dataset.q) === id));
}
tabs(document.querySelector(".seg"), (b) => showExample(b.dataset.q));
const pickApp = tabs(document.querySelector(".apps"), (b) => {
  for (const p of document.querySelectorAll(".panel")) p.hidden = p.id !== "p-" + b.dataset.p;
});
tabs(document.querySelector(".times"), (b) => {
  for (const m of document.querySelectorAll(".moment")) m.hidden = m.id !== "m-" + b.dataset.p;
});

// "Add to Claude" opens Claude in a new tab and brings this page to the Claude steps; "Add to ChatGPT" opens the ChatGPT steps.
for (const a of document.querySelectorAll("[data-app]")) {
  a.addEventListener("click", () => {
    pickApp(a.dataset.app);
    document.getElementById("setup").scrollIntoView();
    if (a.target !== "_blank") history.replaceState(null, "", "#setup-" + a.dataset.app);
  });
}
const fromHash = location.hash.match(/^#setup-(claude|chatgpt|gemini|other)$/);
if (fromHash) pickApp(fromHash[1]);

// Copy buttons copy the text just before them: an address, a command or a first question.
for (const b of document.querySelectorAll("[data-copy]")) {
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(b.previousElementSibling.textContent);
    } catch {
      return;
    }
    b.textContent = "Copied";
    setTimeout(() => (b.textContent = "Copy"), 1600);
  });
}

showExample(document.querySelector(".seg [aria-selected=true]").dataset.q);

// The header is clear over the top of the hero photograph, and turns to glass once the page scrolls.
(() => {
  const top = document.querySelector(".top");
  const check = () => top.classList.toggle("on-photo", scrollY < top.offsetHeight);
  addEventListener("scroll", check, { passive: true });
  check();
})();

// The crossing: a suspension bridge drawn in dots, with made-up readings crossing from the watch to the AI.
(() => {
  const box = document.querySelector("#crossing .crossing-in");
  const canvas = box.querySelector("canvas");
  const lane = box.querySelector(".packets");
  const ctx = canvas.getContext("2d");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const readings = [["Sleep", "7 h 41"], ["HRV", "62 ms"], ["Body Battery", "81"], ["Tempo run", "8 km"], ["VO2 max", "51"], ["Resting heart rate", "48"], ["Stress", "68"], ["Training load", "612"]];
  const DECK = 0.6, WATER = 0.8, TOP = 0.1, TRAVEL = 7000, EVERY = 2300;
  let W, H, step, cols, rows, mask, solid, u0, u1, towers, ink, accent;

  // Height of the main cable at u: one sagging span between the towers, a shorter one on each side.
  function cable(u) {
    const span = (a, b, ya, yc, yb) => { const t = (u - a) / (b - a); return (1 - t) * (1 - t) * ya + 2 * t * (1 - t) * yc + t * t * yb; };
    if (u < towers[0]) return span(u0, towers[0], DECK - 0.03, 0.4, TOP);
    if (u > towers[1]) return span(towers[1], u1, TOP, 0.4, DECK - 0.03);
    return span(towers[0], towers[1], TOP, 0.86, TOP);
  }

  function build() {
    W = canvas.clientWidth; H = canvas.clientHeight;
    const narrow = W < 700;
    step = narrow ? 5 : 7;
    [u0, u1] = narrow ? [0.03, 0.97] : [0.17, 0.83];
    towers = narrow ? [0.27, 0.73] : [0.33, 0.67];
    const dpr = devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.floor(W / step); rows = Math.floor(H / step);

    // Draw the bridge at one pixel per dot; each pixel's coverage becomes that dot's strength.
    const m = document.createElement("canvas"); m.width = cols; m.height = rows;
    const g = m.getContext("2d");
    const X = (u) => u * cols, Y = (v) => v * rows;
    const line = (w, x1, y1, x2, y2) => { g.lineWidth = w; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
    line(1.4, X(u0), Y(DECK), X(u1), Y(DECK));
    line(0.7, X(u0) + 1, Y(DECK + 0.045), X(u1) - 1, Y(DECK + 0.045));
    for (const u of towers) {
      line(1, X(u) - 1.5, Y(TOP) - 1, X(u) - 1.5, Y(WATER));
      line(1, X(u) + 1.5, Y(TOP) - 1, X(u) + 1.5, Y(WATER));
      for (const v of [TOP, 0.32, DECK + 0.045]) line(1, X(u) - 1.5, Y(v), X(u) + 1.5, Y(v));
    }
    g.lineWidth = 1.1; g.beginPath();
    for (let c = X(u0), first = true; c <= X(u1); c += 0.25, first = false) {
      if (first) g.moveTo(c, Y(cable(c / cols))); else g.lineTo(c, Y(cable(c / cols)));
    }
    g.stroke();
    for (let c = Math.ceil(X(u0)) + 1; c < X(u1); c += 3) line(0.3, c, Y(cable(c / cols)), c, Y(DECK));
    const px = g.getImageData(0, 0, cols, rows).data;
    mask = new Float32Array(cols * rows);
    for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3] / 255;

    const css = getComputedStyle(document.documentElement);
    ink = css.getPropertyValue("--ink").trim(); accent = css.getPropertyValue("--accent").trim();

    // Everything above the water never moves, so draw it once.
    solid = document.createElement("canvas"); solid.width = W * dpr; solid.height = H * dpr;
    const s = solid.getContext("2d"); s.setTransform(dpr, 0, 0, dpr, 0, 0); s.fillStyle = ink;
    const water = Math.round(WATER * rows);
    for (let y = 0; y <= water; y++) for (let x = 0; x < cols; x++) {
      let a = mask[y * cols + x] * 0.8;
      if (y === water) a = Math.max(a, 0.22 * Math.min(1, x / (cols * 0.12), (cols - x) / (cols * 0.12)));
      if (a > 0.05) dot(s, x, y, a);
    }
  }

  function dot(c, x, y, a) {
    c.globalAlpha = a;
    c.beginPath(); c.arc(x * step + step / 2, y * step + step / 2, step * 0.36 * Math.sqrt(a), 0, 6.283); c.fill();
  }

  const fade = (p) => Math.max(0, Math.min(1, p / 0.08, (1 - p) / 0.08));
  const live = [];
  let next = 0, spawned = 0;
  function spawn(born) {
    const [label, value] = readings[spawned++ % readings.length];
    const el = document.createElement("div");
    el.className = "packet glass";
    el.innerHTML = `<b>${value}</b>${label}`;
    lane.append(el);
    live.push({ el, born });
  }

  function frame(t) {
    if (!next) { for (let k = 2; k >= 0; k--) spawn(t - k * EVERY - 600); next = t + EVERY - 600; }
    if (t >= next) { spawn(t); next += EVERY; }
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(solid, 0, 0, W, H);

    // The reflection shimmers a little in the water.
    ctx.fillStyle = ink;
    const water = Math.round(WATER * rows);
    for (let y = water + 1; y < rows; y++) {
      const shift = still ? 0 : Math.round(Math.sin(t / 650 + y * 0.9) * 0.9);
      const depth = 1 - (y - water) / (rows - water);
      for (let x = 0; x < cols; x++) {
        const sx = x + shift, sy = 2 * water - y;
        const a = sx >= 0 && sx < cols && sy >= 0 ? mask[sy * cols + sx] * 0.34 * depth : 0;
        if (a > 0.04) dot(ctx, x, y, a);
      }
    }

    // Each reading leaves a short accent trail on the deck as it crosses.
    const deck = Math.floor(DECK * rows), chipY = DECK * H - 40;
    ctx.fillStyle = accent;
    for (let i = live.length - 1; i >= 0; i--) {
      const { el, born } = live[i];
      const p = (t - born) / TRAVEL;
      if (p > 1) { el.remove(); live.splice(i, 1); continue; }
      const head = (u0 + (u1 - u0) * p) * cols, f = fade(p);
      for (let k = 0; k < 16; k++) {
        const a = (1 - k / 16) * f;
        dot(ctx, Math.round(head) - k, deck, a);
        dot(ctx, Math.round(head) - k, deck - 1, a * 0.45);
      }
      el.style.opacity = f;
      el.style.transform = `translate(${head * step - el.offsetWidth / 2}px, ${chipY}px)`;
    }
    ctx.globalAlpha = 1;
    if (!still) requestAnimationFrame(frame);
  }

  build();
  if (still) {
    // No motion: show three readings mid-crossing.
    for (const p of [0.22, 0.5, 0.78]) spawn(TRAVEL - p * TRAVEL);
    next = Infinity; frame(TRAVEL);
  } else requestAnimationFrame(frame);

  // Redraw at the new size, or in the new colours when the theme changes.
  const redraw = () => { build(); if (still) frame(TRAVEL); };
  let wait;
  addEventListener("resize", () => { clearTimeout(wait); wait = setTimeout(redraw, 150); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);
  new MutationObserver(redraw).observe(document.documentElement, { attributeFilter: ["data-theme"] });
})();
