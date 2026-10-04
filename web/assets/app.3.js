// Floss Mini App v2. Vanilla JS, no build step: Cloudflare Pages serves this file as-is.
const tg = window.Telegram?.WebApp;
const LAMPORTS = 1_000_000_000;
const MIN_LOADER_MS = 1900;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (sel, root = document) => root.querySelector(sel);
const h = (html) => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a, n = 4) => (a && a.length > n * 2 + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a ?? "");
const toSol = (lamports) => Number(lamports ?? 0) / LAMPORTS;
const fmt = (v, d = 3) => (v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toLocaleString(undefined, { maximumFractionDigits: d }));
const sol = (lamports, d = 3) => fmt(toSol(lamports), d);
const dur = (s) => {
  s = Math.max(1, s);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};
const ago = (iso) => dur((Date.now() - new Date(iso).getTime()) / 1000);
const until = (iso) => dur((new Date(iso).getTime() - Date.now()) / 1000);
const store = {
  get: (k, d) => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  del: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};
const haptic = (kind = "light") => {
  try {
    if (kind === "ok") tg?.HapticFeedback?.notificationOccurred("success");
    else if (kind === "err") tg?.HapticFeedback?.notificationOccurred("error");
    else if (kind === "select") tg?.HapticFeedback?.selectionChanged();
    else tg?.HapticFeedback?.impactOccurred(kind);
  } catch {}
};

// ---- Icons: hand-drawn 24px strokes -----------------------------------------------------------
const I = {
  wallet: '<path d="M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 7l11-3v3"/><circle cx="16" cy="13.5" r="1.4"/>',
  shield: '<path d="M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  gift: '<rect x="3.5" y="9" width="17" height="11" rx="2"/><path d="M12 9v11M3.5 13h17"/><path d="M12 9c-1.5-3-5-3.5-5-1.2C7 9 12 9 12 9s5 0 5-1.2C17 5.5 13.5 6 12 9z"/>',
  sliders: '<path d="M5 6h9M18 6h1M5 12h3M12 12h7M5 18h11"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="17.5" cy="18" r="1.5"/>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  vault: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="12" cy="12" r="3.5"/><path d="M12 8.5V7M12 17v-1.5M15.5 12H17M7 12h1.5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  paste: '<rect x="6" y="4" width="12" height="17" rx="2.5"/><path d="M9 4h6v3H9z"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  percent: '<path d="M19 5L5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  unlink: '<path d="M9 15l6-6"/><path d="M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1"/><path d="M3 3l3 3M18 18l3 3"/>',
  broom: '<path d="M14 4l6 6"/><path d="M17 7l-7 7"/><path d="M10 14l-6 2 2 4 6-2z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3"/><path d="M5 3v5h5M19 21v-5h-5"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2 0-1.6-1.2-1.8-1.2-3 0-1 .8-1.6 1.8-1.6H17a4 4 0 0 0 4-4c0-4-4-7.4-9-7.4z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10" cy="7" r="1.2"/><circle cx="15" cy="7" r="1.2"/>',
  share: '<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 3v12M7 8l5-5 5 5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.7 3 2.5 3.5 5.2"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M9 9.5c0-1 1.3-1.8 3-1.8s3 .8 3 1.8-1.3 1.6-3 2-3 1-3 2 1.3 1.8 3 1.8 3-.8 3-1.8M12 6v1.7M12 16.3V18"/>',
  hourglass: '<path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  plane: '<path d="M21 4L3 11.5l6.5 2L12 20l3.2-4.3L20 19z"/><path d="M9.5 13.5L21 4"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  auto: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17A8.5 8.5 0 0 0 12 3.5z" fill="currentColor"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name] ?? ""}</svg>`;
const logo = `<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="14" y="14" width="14" height="36" rx="7" fill="var(--ink-3)"/><rect x="36" y="14" width="14" height="36" rx="7" fill="var(--ink-3)"/><path d="M5 40 C 15 42, 18 20, 25 22 S 31 42, 35 41 S 39 20, 45 21 S 52 38, 60 24" fill="none" stroke="url(#threadGrad)" stroke-width="5" stroke-linecap="round"/></svg>`;

// ---- Themes -------------------------------------------------------------------------------------
const SKINS = [
  { id: "mint", name: "Mint", a: "#5cffb8", b: "#8ae8ff" },
  { id: "aurora", name: "Aurora", a: "#9b8cff", b: "#ff8ad8" },
  { id: "ember", name: "Ember", a: "#ff9152", b: "#ffd166" },
  { id: "glacier", name: "Glacier", a: "#6cc6ff", b: "#b8f3ff" },
  { id: "noir", name: "Noir", a: "#f4f4f2", b: "#5d636a" },
];
const theme = { skin: store.get("floss.skin", "mint"), mode: store.get("floss.mode", "auto") };

function isDark() {
  if (theme.mode !== "auto") return theme.mode === "dark";
  if (tg?.initData) return tg.colorScheme === "dark";
  return !matchMedia("(prefers-color-scheme: light)").matches;
}

/** Resolves any CSS colour (incl. color-mix/oklch) to #rrggbb, which Telegram's header API requires. */
function cssToHex(cssColor) {
  const probe = document.createElement("i");
  probe.style.color = cssColor;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return "#07090b";
  ctx.fillStyle = resolved;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function applyTheme() {
  const root = document.documentElement;
  root.dataset.skin = theme.skin;
  root.dataset.theme = isDark() ? "dark" : "light";
  const bg = cssToHex("var(--ink-0)");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
  try {
    tg?.setHeaderColor(bg);
    tg?.setBackgroundColor(bg);
    tg?.setBottomBarColor?.(bg);
  } catch {}
}

function setTheme(patch) {
  Object.assign(theme, patch);
  store.set("floss.skin", theme.skin);
  store.set("floss.mode", theme.mode);
  haptic("select");
  applyTheme();
  renderSheet();
}

function openSheet() {
  renderSheet();
  const scrim = $("#scrim");
  const sheet = $("#sheet");
  scrim.hidden = sheet.hidden = false;
  requestAnimationFrame(() => {
    scrim.classList.add("show");
    sheet.classList.add("show");
  });
  haptic("light");
}

function closeSheet() {
  const scrim = $("#scrim");
  const sheet = $("#sheet");
  scrim.classList.remove("show");
  sheet.classList.remove("show");
  setTimeout(() => (scrim.hidden = sheet.hidden = true), 450);
}

function renderSheet() {
  const sheet = $("#sheet");
  sheet.innerHTML = `<div class="grab"></div>
    <div class="label">Theme</div>
    <div class="swatches">${SKINS.map(
      (s) => `<button class="swatch ${s.id === theme.skin ? "on" : ""}" data-skin="${s.id}" aria-label="${s.name}"><i style="background:linear-gradient(135deg, ${s.a}, ${s.b})"></i>${s.name}</button>`,
    ).join("")}</div>
    <div class="seg">${[
      ["auto", "Auto"],
      ["light", "Light"],
      ["dark", "Dark"],
    ]
      .map(([m, label]) => `<button data-mode="${m}" class="${theme.mode === m ? "on" : ""}">${icon(m === "light" ? "sun" : m === "dark" ? "moon" : "auto")}${label}</button>`)
      .join("")}</div>
    ${state.web && state.me ? `<button class="btn ghost wide" id="logout" style="margin-top:14px">${icon("logout")}Log out</button>` : ""}`;
  $("#logout", sheet)?.addEventListener("click", () => {
    store.del(LOGIN_KEY);
    location.replace(location.pathname);
  });
  sheet.querySelectorAll("[data-skin]").forEach((b) => b.addEventListener("click", () => setTheme({ skin: b.dataset.skin })));
  sheet.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setTheme({ mode: b.dataset.mode })));
}

// ---- Toast ------------------------------------------------------------------------------------
let toastTimer;
function toast(text, kind = "ok") {
  const el = $("#toast");
  el.className = `toast ${kind === "err" ? "err" : ""}`;
  el.innerHTML = `${icon(kind === "err" ? "alert" : "check")}<span>${esc(text)}</span>`;
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  haptic(kind === "err" ? "err" : "ok");
}

// ---- Count-up numbers -------------------------------------------------------------------------
function countUp(root) {
  root.querySelectorAll("[data-count]").forEach((el) => {
    const target = Number(el.dataset.count);
    const digits = Number(el.dataset.digits ?? 3);
    if (reduceMotion || !Number.isFinite(target) || target === 0) {
      el.textContent = fmt(target, digits);
      return;
    }
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 1100);
      const eased = 1 - Math.pow(1 - t, 4);
      el.textContent = fmt(target * eased, digits);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// ---- API --------------------------------------------------------------------------------------
// Inside Telegram: Mini App initData. On the website: the signed "Log in with Telegram" payload.
const LOGIN_KEY = "floss.login";
function authHeader() {
  if (tg?.initData) return `tma ${tg.initData}`;
  const login = store.get(LOGIN_KEY, "");
  return login ? `tglogin ${login}` : "";
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { "content-type": "application/json", authorization: authHeader(), ...(opts.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

// ---- State + routing --------------------------------------------------------------------------
const state = { me: null, tab: "home", scan: null, scanInput: "", audit: null, web: !tg?.initData, pub: null };
const TABS = ["home", "scan", "earn", "rules", "log"];
const TAB_ICONS = { home: "wallet", scan: "shield", earn: "gift", rules: "sliders", log: "pulse" };

function setupNav() {
  const nav = $("#nav");
  nav.hidden = false;
  document.body.classList.add("has-nav");
  nav.querySelectorAll("button").forEach((b) => {
    // Labels show on the desktop side rail; phones get the icon-only bottom bar.
    b.innerHTML = `${icon(TAB_ICONS[b.dataset.tab])}<span>${esc(b.getAttribute("aria-label"))}</span>`;
    b.addEventListener("click", () => go(b.dataset.tab));
  });
  addEventListener("resize", movePill);
  movePill();
}

/** Slides the highlight under the active tab. Works for the bottom bar and the side rail. */
function movePill() {
  const btn = $(`#nav button[data-tab="${state.tab}"]`);
  const pill = $("#navPill");
  if (!btn || !pill) return;
  pill.style.width = `${btn.offsetWidth}px`;
  pill.style.height = `${btn.offsetHeight}px`;
  pill.style.transform = `translate(${btn.offsetLeft - pill.offsetLeft}px, ${btn.offsetTop - pill.offsetTop}px)`;
}

function go(tab) {
  if (!TABS.includes(tab)) return;
  if (tab !== state.tab) haptic("select");
  state.tab = tab;
  movePill();
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  render();
  if (tab === "log") loadAudit();
  window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
}

function render() {
  const app = $("#app");
  app.innerHTML = "";
  app.append(topBar());
  const view = { home: homeView, scan: scanView, earn: earnView, rules: rulesView, log: logView }[state.tab]();
  view.classList.add("enter");
  app.append(view);
  countUp(view);
}

function topBar() {
  const paused = state.me?.paused;
  const bar = h(`<header class="top">
    <div class="brand">${logo}<span>floss</span></div>
    <div class="top-r">
      <span class="chip"><i class="dot ${paused ? "off" : ""}"></i>${paused ? "paused" : "auto"}</span>
      <button class="round" id="themeBtn" aria-label="Theme">${icon("palette")}</button>
    </div>
  </header>`);
  $("#themeBtn", bar).addEventListener("click", openSheet);
  return bar;
}

// ---- Home ---------------------------------------------------------------------------------------
function ring(progress) {
  const r = 31;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, progress));
  return `<div class="ring"><svg viewBox="0 0 78 78"><circle class="track" cx="39" cy="39" r="${r}"/><circle class="val" cx="39" cy="39" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c}" data-target="${c * (1 - p)}"/></svg><b>${Math.round(p * 100)}%</b></div>`;
}

function homeView() {
  const me = state.me;
  const sessions = me.sessions.filter((s) => s.status !== "PURGED");
  const total = sessions.reduce((sum, s) => sum + Number(s.balanceLamports ?? 0), 0);
  const threshold = me.rules.profitAbsolute.enabled ? Number(me.rules.profitAbsolute.thresholdLamports) : null;

  const wrap = h(`<section></section>`);
  wrap.append(
    h(`<div class="glass hero">
      <i class="live-border"></i>
      <div class="label">in sessions</div>
      <div class="big"><span data-count="${toSol(total)}">0</span><small>SOL</small></div>
      <div class="stats">
        <div class="stat"><div class="label">swept</div><b data-count="${toSol(me.stats.sweptLamports)}">0</b></div>
        <div class="stat"><div class="label">earned</div><b class="accent" data-count="${toSol(me.referral.earnedLamports)}" data-digits="4">0</b></div>
      </div>
      <div class="vault-row">
        <span class="flow"></span>
        ${me.vault ? `<button class="vault-pill" id="vaultCopy">${icon("vault")}<span>${esc(short(me.vault.address, 4))}</span></button>` : `<span class="vault-pill">${icon("vault")}<span>no vault</span></span>`}
      </div>
      ${me.vault?.pendingAddress ? `<div class="pending">→ ${esc(short(me.vault.pendingAddress))} · ${esc(until(me.vault.pendingEffectiveAt))}</div>` : ""}
    </div>`),
  );

  wrap.append(h(`<div class="sec"><h2>Sessions</h2><span class="count">${sessions.length}</span></div>`));

  if (sessions.length === 0) {
    const empty = h(`<div class="glass empty">
      <svg viewBox="0 0 140 84" aria-hidden="true"><rect x="38" y="12" width="24" height="62" rx="12" fill="url(#capGrad)" stroke="url(#capEdge)"/><rect x="78" y="12" width="24" height="62" rx="12" fill="url(#capGrad)" stroke="url(#capEdge)"/><path d="M6 64 C 26 66, 34 26, 50 28 S 62 64, 70 62 S 80 24, 90 26 S 108 58, 134 30" fill="none" stroke="url(#threadGrad)" stroke-width="4" stroke-linecap="round" stroke-dasharray="7 8"/></svg>
      <button class="cmd" id="cmdCopy">/session new ${icon("copy")}</button>
    </div>`);
    $("#cmdCopy", empty).addEventListener("click", () => copy("/session new"));
    wrap.append(empty);
    return wrap;
  }

  const cards = h(`<div class="cards"></div>`);
  for (const s of sessions) {
    const bal = Number(s.balanceLamports ?? 0);
    const float = Number(s.floatLamports ?? 0);
    const progress = threshold ? (bal - float) / threshold : 0;
    const live = s.status === "ACTIVE" && !me.paused;
    const card = h(`<article class="glass card ${progress >= 1 ? "ready" : ""}">
      <div>
        <div class="name"><i class="dot ${live ? "" : s.status === "PAUSED" || me.paused ? "off" : "dead"}"></i>${esc(s.label)}</div>
        <div class="bal"><span data-count="${toSol(bal)}">0</span><small>SOL</small></div>
        <button class="addr">${esc(short(s.address, 5))}${icon("copy")}</button>
      </div>
      ${ring(progress)}
      <div class="actions">
        <button class="btn primary" data-act="floss">${icon("spark")}Floss</button>
        <button class="btn ghost" data-act="preview">${icon("eye")}Preview</button>
      </div>
    </article>`);
    card.querySelector('[data-act="floss"]').addEventListener("click", (e) => floss(s, false, e.currentTarget));
    card.querySelector('[data-act="preview"]').addEventListener("click", (e) => floss(s, true, e.currentTarget));
    card.querySelector(".addr").addEventListener("click", () => copy(s.address));
    cards.append(card);
  }
  wrap.append(cards);

  $("#vaultCopy", wrap)?.addEventListener("click", () => copy(me.vault.address));
  requestAnimationFrame(() =>
    requestAnimationFrame(() => wrap.querySelectorAll(".ring .val").forEach((c) => (c.style.strokeDashoffset = c.dataset.target))),
  );
  return wrap;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast(short(text, 10));
  }
}

async function floss(session, dryRun, btn) {
  btn.classList.add("busy");
  btn.disabled = true;
  haptic("medium");
  try {
    await api("/floss", { method: "POST", body: JSON.stringify({ sessionId: session.id, mode: "profit", dryRun }) });
    toast(dryRun ? "Preview sent to chat" : "Flossing · result in chat");
  } catch (err) {
    toast(err.message, "err");
  } finally {
    btn.classList.remove("busy");
    btn.disabled = false;
  }
}

// ---- Scan ---------------------------------------------------------------------------------------
const LEVEL_COLOR = { LOW: "var(--good)", MEDIUM: "var(--amber)", HIGH: "var(--coral)", CRITICAL: "var(--coral)" };

function gauge(score, level) {
  const len = Math.PI * 92;
  const off = len * (1 - Math.min(100, score) / 100);
  return `<div class="gauge">
    <svg viewBox="0 0 230 124"><path class="arc-track" d="M23 114 A92 92 0 0 1 207 114"/><path class="arc" d="M23 114 A92 92 0 0 1 207 114" stroke="${LEVEL_COLOR[level]}" style="color:${LEVEL_COLOR[level]}" stroke-dasharray="${len}" stroke-dashoffset="${len}" data-target="${off}"/></svg>
    <div class="score" data-count="${score}" data-digits="0">0</div>
    <span class="level lv-${level}">${level}</span>
  </div>`;
}

function scanView() {
  const wrap = h(`<section>
    <div class="sec"><h2>Scan</h2><span class="count">mint · tx · link</span></div>
    <label class="glass field">
      <input id="scanInput" placeholder="Paste address or link" autocomplete="off" spellcheck="false" value="${esc(state.scanInput)}">
      <button class="icon-btn" id="pasteBtn" type="button" aria-label="Paste">${icon("paste")}</button>
    </label>
    <button class="btn primary wide scan-go" id="scanBtn">${icon("shield")}Scan</button>
    <div id="scanOut"></div>
  </section>`);
  const input = $("#scanInput", wrap);
  input.addEventListener("input", () => (state.scanInput = input.value));
  input.addEventListener("keydown", (e) => e.key === "Enter" && runScan(wrap));
  $("#pasteBtn", wrap).addEventListener("click", async () => {
    try {
      input.value = state.scanInput = (await navigator.clipboard.readText()).trim();
      haptic("light");
    } catch {
      input.focus();
    }
  });
  $("#scanBtn", wrap).addEventListener("click", () => runScan(wrap));
  if (state.scan) $("#scanOut", wrap).append(scanResult(state.scan));
  return wrap;
}

async function runScan(wrap, fresh = false) {
  const q = $("#scanInput", wrap).value.trim();
  if (!q) return $("#scanInput", wrap).focus();
  const btn = $("#scanBtn", wrap);
  const out = $("#scanOut", wrap);
  btn.disabled = true;
  btn.classList.add("busy");
  out.innerHTML = `<div class="sk" style="height:280px;margin-top:16px"></div>`;
  haptic("medium");
  try {
    state.scan = await api(`/scan?q=${encodeURIComponent(q)}${fresh ? "&fresh=1" : ""}`);
    out.innerHTML = "";
    const el = scanResult(state.scan);
    out.append(el);
    countUp(el);
    haptic(state.scan.report.level === "LOW" ? "ok" : "err");
  } catch (err) {
    out.innerHTML = "";
    toast(err.message, "err");
  } finally {
    btn.disabled = false;
    btn.classList.remove("busy");
  }
}

function scanResult({ report, cached, ageMs }) {
  const tags = [];
  if (report.mint) {
    tags.push(report.mint.knownAs ?? short(report.target));
    tags.push(report.mint.program);
  } else tags.push("transaction");
  if (report.simulation?.ran) tags.push(report.simulation.ok ? "sim ✓" : "sim ✗");
  if (report.simulation?.probe) tags.push(`tax ${(report.simulation.probe.effectiveTaxBps / 100).toFixed(1)}%`);
  if (cached) tags.push(`cached ${Math.round(ageMs / 1000)}s`);

  const el = h(`<div class="glass result">
    ${gauge(report.score, report.level)}
    <div class="meta">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}${cached ? `<button class="tag" id="freshBtn">fresh</button>` : ""}</div>
    <div class="findings">${report.findings
      .filter((f) => f.severity !== "info" || report.findings.length < 4)
      .map((f) => `<button class="finding sev-${esc(f.severity)}"><i></i><span class="t">${esc(f.title)}</span>${icon("chev")}<span class="d">${esc(f.detail)}</span></button>`)
      .join("")}</div>
  </div>`);
  el.querySelectorAll(".finding").forEach((f) => f.addEventListener("click", () => f.classList.toggle("open")));
  el.querySelectorAll(".finding > svg").forEach((s) => s.classList.add("chev"));
  $("#freshBtn", el)?.addEventListener("click", () => runScan(document, true));
  requestAnimationFrame(() => requestAnimationFrame(() => el.querySelectorAll(".arc").forEach((a) => (a.style.strokeDashoffset = a.dataset.target))));
  return el;
}

// ---- Earn (referrals) ---------------------------------------------------------------------------
function earnView() {
  const { referral, fees } = state.me;
  const sharePct = fees.referralShareBps / 100;
  const feePct = fees.bps / 100;
  const wrap = h(`<section>
    <div class="sec"><h2>Earn</h2><span class="count">${sharePct}% of fees</span></div>
    <div class="glass earn-hero">
      <i class="live-border"></i>
      <div class="label">earned</div>
      <div class="big"><span data-count="${toSol(referral.earnedLamports)}" data-digits="4">0</span><small>SOL</small></div>
      <div class="split">
        <div class="split-bar"><i class="p"></i><i class="r"></i></div>
        <div class="split-legend"><span>${feePct}% fee</span><span><b>${sharePct}%</b> → you</span></div>
      </div>
    </div>
    <div class="glass link-card">
      <span>${esc(referral.link ? referral.link.replace("https://", "") : referral.code)}</span>
      <button class="icon-btn" id="refCopy" aria-label="Copy link">${icon("copy")}</button>
      <button class="btn primary" id="refShare" style="height:44px">${icon("share")}Share</button>
    </div>
    <div class="tiles">
      <div class="glass tile">${icon("users")}<b data-count="${referral.invited}" data-digits="0">0</b><span>invited</span></div>
      <div class="glass tile">${icon("coin")}<b data-count="${toSol(referral.earnedLamports)}" data-digits="4">0</b><span>paid</span></div>
      <div class="glass tile">${icon("hourglass")}<b data-count="${toSol(referral.owedLamports)}" data-digits="4">0</b><span>pending</span></div>
    </div>
  </section>`);
  const link = referral.link ?? referral.code;
  $("#refCopy", wrap).addEventListener("click", () => copy(link));
  $("#refShare", wrap).addEventListener("click", () => {
    haptic("medium");
    const url = `https://t.me/share/url?url=${encodeURIComponent(link)}`;
    if (tg?.openTelegramLink) tg.openTelegramLink(url);
    else if (navigator.share) navigator.share({ url: link }).catch(() => undefined);
    else copy(link);
  });
  return wrap;
}

// ---- Rules --------------------------------------------------------------------------------------
const STEPS = {
  PROFIT_ABSOLUTE: [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 10, 25],
  PROFIT_PERCENT: [10, 25, 50, 75, 100, 200, 500],
  IDLE_TIMEOUT: [30, 60, 180, 360, 720, 1440, 2880, 10080],
};
const fmtIdle = (m) => (m >= 1440 ? `${m / 1440}d` : m >= 60 ? `${m / 60}h` : `${m}m`);
const saveTimers = {};

function rulesView() {
  const r = state.me.rules;
  const rows = [
    { kind: "PROFIT_ABSOLUTE", ico: "trend", t: "Profit", on: r.profitAbsolute.enabled, val: Number(r.profitAbsolute.thresholdLamports) / LAMPORTS, fmt: (v) => `+${v} SOL` },
    { kind: "PROFIT_PERCENT", ico: "percent", t: "Gain", on: r.profitPercent.enabled, val: r.profitPercent.bps / 100, fmt: (v) => `+${v}%` },
    { kind: "IDLE_TIMEOUT", ico: "clock", t: "Idle", on: r.idle.enabled, val: r.idle.minutes, fmt: fmtIdle },
    { kind: "REVOKE_ON_SIGHT", ico: "unlink", t: "Revoke", on: r.revokeOnSight },
    { kind: "CLOSE_EMPTY", ico: "broom", t: "Close empty", on: r.closeEmpty.enabled },
  ];
  const fees = state.me.fees;
  const wrap = h(`<section>
    <div class="sec"><h2>Auto</h2><span class="count">sweep rules</span></div>
    <div class="rules"></div>
    ${fees.enabled ? `<div class="fee-note"><span class="tag">fee ${fees.bps / 100}%</span><span class="tag">referrers ${fees.referralShareBps / 100}%</span></div>` : ""}
  </section>`);
  const list = $(".rules", wrap);
  for (const row of rows) {
    const steps = STEPS[row.kind];
    const el = h(`<div class="glass rule">
      <span class="ico">${icon(row.ico)}</span>
      <div>
        <div class="t">${row.t}</div>
        ${steps ? `<div class="stepper"><button data-d="-1" aria-label="Less">−</button><span>${row.fmt(row.val)}</span><button data-d="1" aria-label="More">+</button></div>` : ""}
      </div>
      <button class="switch ${row.on ? "on" : ""}" role="switch" aria-checked="${row.on}" aria-label="${row.t}"></button>
    </div>`);
    const sw = $(".switch", el);
    sw.addEventListener("click", () => {
      row.on = !row.on;
      sw.classList.toggle("on", row.on);
      sw.setAttribute("aria-checked", String(row.on));
      haptic("select");
      saveRule(row);
    });
    if (steps) {
      el.querySelectorAll(".stepper button").forEach((b) =>
        b.addEventListener("click", () => {
          const i = steps.findIndex((s) => s >= row.val);
          const cur = i === -1 ? steps.length - 1 : i;
          row.val = steps[Math.max(0, Math.min(steps.length - 1, cur + Number(b.dataset.d)))];
          $(".stepper span", el).textContent = row.fmt(row.val);
          haptic("select");
          if (row.on) saveRule(row);
        }),
      );
    }
    list.append(el);
  }
  return wrap;
}

function saveRule(row) {
  clearTimeout(saveTimers[row.kind]);
  saveTimers[row.kind] = setTimeout(async () => {
    try {
      const next = await api("/rules", { method: "POST", body: JSON.stringify({ kind: row.kind, enabled: row.on, value: row.val === undefined ? undefined : String(row.val) }) });
      state.me = next;
      toast("Saved");
    } catch (err) {
      toast(err.message, "err");
    }
  }, 500);
}

// ---- Log ----------------------------------------------------------------------------------------
const ACTIONS = {
  FLOSS: ["spark", "Floss"],
  AUTO_FLOSS: ["spark", "Auto floss"],
  SESSION_END_FLOSS: ["spark", "End floss"],
  SCAN: ["shield", "Scan"],
  SESSION_CREATED: ["plus", "New session"],
  KEY_EXPORTED: ["key", "Key export"],
  KEY_PURGED: ["trash", "Key purged"],
  COLD_WALLET_SET: ["vault", "Vault set"],
  COLD_WALLET_PENDING: ["vault", "Vault change"],
  COLD_WALLET_ACTIVATED: ["vault", "Vault live"],
  COLD_WALLET_CANCELLED: ["vault", "Change cancelled"],
  RULE_SET: ["sliders", "Rule"],
  FLOAT_SET: ["sliders", "Float"],
  PAUSE_ALL: ["clock", "Paused"],
  RESUME_ALL: ["clock", "Resumed"],
  REFERRED: ["gift", "Joined via friend"],
};

async function loadAudit() {
  try {
    state.audit = await api("/audit");
    if (state.tab === "log") render();
  } catch (err) {
    toast(err.message, "err");
  }
}

function logView() {
  const wrap = h(`<section><div class="sec"><h2>Activity</h2><button class="round" id="logRefresh" aria-label="Refresh">${icon("refresh")}</button></div></section>`);
  $("#logRefresh", wrap).addEventListener("click", () => {
    haptic("light");
    loadAudit();
  });
  if (!state.audit) {
    wrap.append(h(`<div class="sk" style="height:240px"></div>`));
    return wrap;
  }
  if (state.audit.length === 0) {
    wrap.append(h(`<div class="glass empty"><span class="label">quiet so far</span></div>`));
    return wrap;
  }
  const list = h(`<div class="log"></div>`);
  for (const r of state.audit) {
    const [ic, label] = ACTIONS[r.action] ?? ["pulse", r.action.toLowerCase().replace(/_/g, " ")];
    list.append(
      h(`<div class="glass row ${esc(r.status)}">
        <span class="ico">${icon(ic)}</span>
        <div><div class="t">${esc(label)}</div><div class="s">${esc(r.status.toLowerCase())} · ${esc(ago(r.createdAt))}</div></div>
        <span class="amt">${r.lamports && Number(r.lamports) > 0 ? `+${sol(r.lamports, 4)}` : ""}</span>
      </div>`),
    );
  }
  wrap.append(list);
  return wrap;
}

// ---- Website (outside Telegram) ------------------------------------------------------------------
const FEATURES = [
  ["trend", "Auto-sweep"],
  ["unlink", "Revoke"],
  ["broom", "Reclaim rent"],
  ["shield", "Pre-flight scan"],
];

/** Logged-out website: what Floss is, live network totals, and Telegram login. */
function landingView(notice) {
  const pub = state.pub ?? { bot: null, stats: null };
  const st = pub.stats;
  const bot = pub.bot;
  const view = h(`<section class="landing">
    <div class="land-hero enter">
      <div class="land-mark">${logo}</div>
      <h1>Floss your<br><span class="grad-text">wallet.</span></h1>
      <p>Burner wallets that sweep profit to cold storage on their own.</p>
    </div>
    <div class="land-side enter">
    <div class="feat">${FEATURES.map(([i, t]) => `<div class="glass feat-i">${icon(i)}<span>${t}</span></div>`).join("")}</div>
    ${notice ? `<div class="glass notice">${icon("alert")}<span>${esc(notice)}</span></div>` : ""}
    <div class="glass login">
      <div class="label">dashboard</div>
      <div id="tgLogin" class="tg-login">${bot ? "" : `<span class="muted">Bot not connected yet</span>`}</div>
      ${bot ? `<a class="btn ghost wide" href="https://t.me/${encodeURIComponent(bot)}" target="_blank" rel="noopener">${icon("plane")}Open @${esc(bot)}</a>` : ""}
    </div>
    ${
      st && st.users > 0
        ? `<div class="tiles">
            <div class="glass tile">${icon("users")}<b data-count="${st.users}" data-digits="0">0</b><span>users</span></div>
            <div class="glass tile">${icon("wallet")}<b data-count="${st.wallets}" data-digits="0">0</b><span>wallets</span></div>
            <div class="glass tile">${icon("coin")}<b data-count="${toSol(st.sweptLamports)}" data-digits="2">0</b><span>SOL swept</span></div>
          </div>`
        : ""
    }
    </div>
  </section>`);
  if (bot) {
    // Redirect flow (no inline callback, so the CSP needs no unsafe-eval): Telegram sends the
    // signed login back to this page as query parameters, which boot() picks up.
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.dataset.telegramLogin = bot;
    s.dataset.size = "large";
    s.dataset.radius = "14";
    s.dataset.authUrl = `${location.origin}/`;
    s.dataset.requestAccess = "write";
    $("#tgLogin", view).append(s);
  }
  return view;
}

function showLanding(notice) {
  const app = $("#app");
  app.innerHTML = "";
  const bar = topBar();
  $(".chip", bar)?.remove();
  app.append(bar, landingView(notice));
  countUp(app);
}

// ---- Boot ---------------------------------------------------------------------------------------
function gate(message) {
  const app = $("#app");
  app.innerHTML = "";
  app.append(h(`<div class="gate enter"><div class="brand" style="justify-content:center">${logo}<span>floss</span></div><h1>${esc(message)}</h1></div>`));
}

/** Telegram's login redirect lands here as ?id=...&hash=...; keep it and clean the address bar. */
function captureLogin() {
  const q = new URLSearchParams(location.search);
  if (!q.has("hash") || !q.has("id") || !q.has("auth_date")) return;
  store.set(LOGIN_KEY, q.toString());
  history.replaceState(null, "", location.pathname);
}

async function boot() {
  const started = Date.now();
  tg?.ready();
  tg?.expand();
  applyTheme();
  tg?.onEvent?.("themeChanged", () => theme.mode === "auto" && applyTheme());
  matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => theme.mode === "auto" && applyTheme());
  $("#scrim").addEventListener("click", closeSheet);

  let error = null;
  let landing = false;
  let notice = null;
  if (state.web) captureLogin();
  if (tg?.initData || store.get(LOGIN_KEY, "")) {
    try {
      state.me = await api("/me");
    } catch (err) {
      if (!state.web) error = err.message;
      else {
        // Expired/invalid login: forget it. Not registered yet: say how to fix it.
        if (err.status === 401) store.del(LOGIN_KEY);
        landing = true;
        notice = err.status === 401 ? "Login expired. Log in again." : err.message;
      }
    }
  } else landing = true;
  if (landing) state.pub = await api("/public").catch(() => null);

  $("#progress").classList.add("full");
  const wait = Math.max(0, MIN_LOADER_MS - (Date.now() - started));
  setTimeout(() => {
    if (error) gate(error);
    else if (landing) showLanding(notice);
    else {
      setupNav();
      render();
    }
    $("#loader").classList.add("done");
    setTimeout(() => $("#loader").remove(), 900);
  }, wait);
}

boot();
