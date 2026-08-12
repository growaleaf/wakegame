// WAKE — DOM, input, canvas rendering, WebAudio. Imports the pure core; owns nothing
// the core doesn't already define as truth.
import {
  HARBOR_ROUTE,
  ferryPos,
  wakeNodes,
  wakeField,
  initMorningState,
  stepMorning,
  scoreMorning,
  buildAuthoredMornings,
  layoutEndlessMorning,
  formatShare,
  WORLD,
  SWAMP_THRESHOLD,
  ROCK_MIN,
  ROCK_MAX,
} from "./wake.mjs";

const STORAGE_KEY = "wake_v1";
const SHARE_URL = "http://wakegame.defimagic.io";

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { cleared: [false, false, false, false, false, false, false] };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.cleared) || parsed.cleared.length !== 7) throw new Error("shape");
    return parsed;
  } catch {
    return { cleared: [false, false, false, false, false, false, false] };
  }
}
function saveProgress(p) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch {}
}
let progress = loadProgress();

const MORNINGS = buildAuthoredMornings();

// ---------- DOM ----------
const screens = {
  title: document.getElementById("screen-title"),
  howto: document.getElementById("screen-howto"),
  select: document.getElementById("screen-select"),
  play: document.getElementById("screen-play"),
  result: document.getElementById("screen-result"),
};
let screen = "title";
function showScreen(name) {
  screen = name;
  for (const k in screens) screens[k].classList.toggle("active", k === name);
}

document.getElementById("btn-title-begin").addEventListener("click", () => renderSelect());
document.getElementById("btn-title-howto").addEventListener("click", () => showScreen("howto"));
document.getElementById("btn-howto-back").addEventListener("click", () => showScreen("title"));
document.getElementById("btn-select-back").addEventListener("click", () => showScreen("title"));
document.getElementById("btn-result-continue").addEventListener("click", () => {
  if (mode === "endless") startEndless();
  else renderSelect();
});
document.getElementById("btn-result-share").addEventListener("click", shareResult);

function renderSelect() {
  const list = document.getElementById("select-list");
  list.innerHTML = "";
  MORNINGS.forEach((_, i) => {
    const locked = i > 0 && !progress.cleared[i - 1];
    const btn = document.createElement("button");
    btn.className = "morning-btn" + (locked ? " locked" : "") + (progress.cleared[i] ? " cleared" : "");
    btn.textContent = `Morning ${i + 1}` + (progress.cleared[i] ? " — kind" : locked ? " — quiet still" : "");
    btn.disabled = locked;
    btn.addEventListener("click", () => startMorning(i));
    list.appendChild(btn);
  });
  const endlessBtn = document.createElement("button");
  endlessBtn.className = "morning-btn endless" + (progress.cleared[6] ? "" : " locked");
  endlessBtn.textContent = progress.cleared[6] ? "Endless Route" : "Endless Route — clear all 7 first";
  endlessBtn.disabled = !progress.cleared[6];
  endlessBtn.addEventListener("click", () => startEndless());
  list.appendChild(endlessBtn);
  showScreen("select");
}

// ---------- canvas ----------
const canvas = document.getElementById("harbor");
const ctx = canvas.getContext("2d");
function fitCanvas() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr * (cssW / WORLD.w), 0, 0, dpr * (cssH / WORLD.h), 0, 0);
}
window.addEventListener("resize", fitCanvas);

// ---------- input: drag steers, vertical drag widens/sharpens ----------
let dragging = false, dragStartX = 0, dragStartY = 0;
let targetSteer = 0, targetWidth = 1;
let curSteer = 0, curWidth = 1;
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function localPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
canvas.addEventListener("pointerdown", (e) => {
  if (screen !== "play") return;
  dragging = true;
  const p = localPos(e);
  dragStartX = p.x; dragStartY = p.y;
  canvas.setPointerCapture(e.pointerId);
  ensureAudio();
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const p = localPos(e);
  const dx = p.x - dragStartX, dy = p.y - dragStartY;
  targetSteer = clamp(dx / 60, -1, 1);
  targetWidth = clamp(1 - dy / 110, 0.4, 1.6);
});
function releaseDrag() {
  dragging = false;
  targetSteer = 0;
  targetWidth = 1;
}
canvas.addEventListener("pointerup", releaseDrag);
canvas.addEventListener("pointercancel", releaseDrag);

// ---------- audio (synthesized only) ----------
let actx = null;
function ensureAudio() {
  if (actx) return;
  try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
}
function tone(freqStart, freqEnd, dur, type, gainPeak) {
  if (!actx) return;
  const t0 = actx.currentTime;
  const osc = actx.createOscillator();
  const gain = actx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freqStart, t0);
  osc.frequency.linearRampToValueAtTime(freqEnd, t0 + dur);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(gainPeak, t0 + dur * 0.25);
  gain.gain.linearRampToValueAtTime(0, t0 + dur);
  osc.connect(gain).connect(actx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}
const sfxDeed = () => tone(660, 920, 0.28, "sine", 0.09);
const sfxSwamp = () => tone(220, 120, 0.5, "triangle", 0.07);
const sfxAngler = () => tone(300, 460, 0.35, "sine", 0.08);

// ---------- morning state ----------
let mode = "authored"; // or "endless"
let morningIndex = 0;
let endlessSeed = 1;
let endlessStep = 0;
let morningState = null;
let morningLabel = "";
let lastNow = null;
let running = false;
let doneFlags = new Map(); // task id -> was done last tick (for sfx edge)
let anglerBandFlags = new Map();
let swanWasSafe = true;
let sessionKindness = 0;
let sessionAllSwansSafe = true;

function startMorning(i) {
  morningIndex = i;
  mode = "authored";
  morningLabel = `morning ${i + 1}`;
  beginState(MORNINGS[i]);
}
function startEndless() {
  mode = "endless";
  if (endlessStep === 0) endlessSeed = (Date.now() % 100000) + 1;
  morningLabel = `endless · route ${endlessStep + 1}`;
  beginState(layoutEndlessMorning(endlessSeed, endlessStep));
}
function beginState(def) {
  morningState = initMorningState(def, HARBOR_ROUTE);
  doneFlags = new Map(morningState.tasks.map((t) => [t.id, false]));
  anglerBandFlags = new Map();
  swanWasSafe = true;
  showScreen("play");
  fitCanvas();
  lastNow = null;
  running = true;
  requestAnimationFrame(tick);
}

function endMorning() {
  running = false;
  const score = scoreMorning(morningState);
  if (mode === "authored") {
    if (score.deeds === score.total && score.swanSafe) {
      progress.cleared[morningIndex] = true;
      saveProgress(progress);
    }
  } else {
    endlessStep++;
  }
  sessionKindness += score.deeds;
  if (!score.swanSafe) sessionAllSwansSafe = false;
  renderResult(score);
}

function renderResult(score) {
  document.getElementById("result-title").textContent =
    score.deeds === score.total && score.swanSafe ? "A good morning." : "The harbor keeps turning.";
  document.getElementById("result-detail").textContent =
    `${score.deeds} of ${score.total} kindnesses done · swans ${score.swanSafe ? "stayed dry" : "were startled"}.`;
  const label = mode === "authored" ? `morning ${morningIndex + 1}` : `endless · route ${endlessStep}`;
  document.getElementById("result-share-text").textContent =
    formatShare(label, sessionKindness, sessionAllSwansSafe, SHARE_URL);
  const cont = document.getElementById("btn-result-continue");
  if (mode === "authored" && morningIndex < 6) {
    cont.textContent = progress.cleared[morningIndex] ? "Next morning" : "Try again";
    cont.onclick = () => (progress.cleared[morningIndex] ? startMorning(morningIndex + 1) : startMorning(morningIndex));
  } else if (mode === "authored") {
    cont.textContent = "Back to mornings";
    cont.onclick = () => renderSelect();
  } else {
    cont.textContent = "Keep going";
    cont.onclick = () => startEndless();
  }
  showScreen("result");
}

function shareResult() {
  const text = document.getElementById("result-share-text").textContent;
  if (navigator.share) {
    navigator.share({ text }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {});
    const btn = document.getElementById("btn-result-share");
    const original = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = original), 1400);
  }
}

// ---------- the loop ----------
function step(now) {
  if (lastNow == null) lastNow = now;
  const dt = clamp((now - lastNow) / 1000, 0, 0.05);
  lastNow = now;
  const smooth = 1 - Math.exp(-dt * 8);
  curSteer += (targetSteer - curSteer) * smooth;
  curWidth += (targetWidth - curWidth) * smooth;
  if (!morningState) return;

  const prevSwan = morningState.swan.swamped;
  morningState = stepMorning(morningState, curSteer, curWidth, dt);

  for (const t of morningState.tasks) {
    const was = doneFlags.get(t.id);
    if (t.done && !was) { sfxDeed(); doneFlags.set(t.id, true); }
    if (t.type === "angler" && !t.done) {
      // gentle confirmation tone the first time it enters the rocking band
      const field = wakeField({ t: morningState.t, route: morningState.route }, curSteer, curWidth);
      const mag = field(t.x, t.y).mag;
      const inBand = mag >= ROCK_MIN && mag <= ROCK_MAX;
      if (inBand && !anglerBandFlags.get(t.id)) { sfxAngler(); anglerBandFlags.set(t.id, true); }
      if (!inBand) anglerBandFlags.set(t.id, false);
    }
  }
  if (morningState.swan.swamped && !prevSwan) sfxSwamp();

  render();

  if (morningState.t >= morningState.duration) endMorning();
}
function tick(now) {
  step(now);
  if (running) requestAnimationFrame(tick);
}

// ---------- rendering ----------
const PALETTE = {
  skyTop: "#f6c9b8",
  skyBottom: "#8a5b73",
  waterTop: "#3a2f52",
  waterBottom: "#161226",
  route: "rgba(255, 226, 200, 0.16)",
  ferryHull: "#2c2338",
  lantern: "#ffcf8a",
  wake: "rgba(255, 214, 170, ALPHA)",
  toy: "#f2a765",
  toyTarget: "#e8d9c0",
  litter: "#7c7566",
  litterTarget: "#c9d6d2",
  angler: "#4a3a52",
  anglerLine: "#d9c9a8",
  nest: "#6b4f3a",
  swan: "#f4ece0",
  danger: "rgba(214, 92, 74, ALPHA)",
};

function render() {
  const w = WORLD.w, h = WORLD.h;
  ctx.clearRect(0, 0, w, h);

  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.55);
  sky.addColorStop(0, PALETTE.skyTop);
  sky.addColorStop(1, PALETTE.skyBottom);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h * 0.55);

  const water = ctx.createLinearGradient(0, h * 0.3, 0, h);
  water.addColorStop(0, PALETTE.waterTop);
  water.addColorStop(1, PALETTE.waterBottom);
  ctx.fillStyle = water;
  ctx.fillRect(0, h * 0.3, w, h * 0.7);

  if (!morningState) return;
  const route = morningState.route;

  // faint route guide
  ctx.strokeStyle = PALETTE.route;
  ctx.lineWidth = 2;
  ctx.setLineDash([3, 7]);
  ctx.beginPath();
  route.waypoints.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.stroke();
  ctx.setLineDash([]);

  // swan danger ring (anticipation, not punishment — shows the threat before it lands)
  const field = wakeField({ t: morningState.t, route }, curSteer, curWidth);
  const swan = morningState.swan;
  if (!swan.swamped) {
    const mag = field(swan.x, swan.y).mag;
    const ratio = clamp(mag / SWAMP_THRESHOLD, 0, 1);
    ctx.fillStyle = PALETTE.danger.replace("ALPHA", String(0.06 + ratio * 0.22));
    ctx.beginPath();
    ctx.arc(swan.x, swan.y, 26 + ratio * 10, 0, Math.PI * 2);
    ctx.fill();
  }
  drawNest(swan);

  // wake trail
  const nodes = wakeNodes(morningState.t, route, curSteer, curWidth);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const alpha = 0.28 * (1 - i / nodes.length);
    ctx.fillStyle = PALETTE.wake.replace("ALPHA", String(alpha));
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.sigma * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }

  // tasks
  for (const t of morningState.tasks) {
    if (t.type === "toy") drawToy(t);
    else if (t.type === "litter") drawLitter(t);
    else if (t.type === "angler") drawAngler(t);
  }

  // ferry
  const ferry = ferryPos(morningState.t, route);
  drawFerry(ferry);

  drawHud();
}

function drawNest(swan) {
  ctx.fillStyle = PALETTE.nest;
  ctx.beginPath();
  ctx.ellipse(swan.x, swan.y, 16, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = swan.swamped ? "rgba(244,236,224,0.35)" : PALETTE.swan;
  ctx.beginPath();
  ctx.ellipse(swan.x - 5, swan.y - 3, 5, 3.4, 0, 0, Math.PI * 2);
  ctx.ellipse(swan.x + 5, swan.y - 2, 4.4, 3, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawToy(t) {
  if (!t.done) {
    ctx.fillStyle = PALETTE.toyTarget;
    ctx.beginPath(); ctx.arc(t.targetX, t.targetY, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = PALETTE.toy;
    ctx.beginPath(); ctx.arc(t.objX, t.objY, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath(); ctx.arc(t.objX + 2, t.objY - 2, 1.4, 0, Math.PI * 2); ctx.fill();
  }
}
function drawLitter(t) {
  if (!t.done) {
    ctx.fillStyle = PALETTE.litterTarget;
    ctx.beginPath(); ctx.arc(t.targetX, t.targetY, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = PALETTE.litter;
    ctx.save();
    ctx.translate(t.objX, t.objY);
    ctx.rotate(0.4);
    ctx.fillRect(-6, -3, 12, 6);
    ctx.restore();
  }
}
function drawAngler(t) {
  ctx.fillStyle = PALETTE.angler;
  ctx.beginPath();
  ctx.ellipse(t.x, t.y, 11, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  const wobble = t.done ? 0 : Math.sin(morningState.t * 3) * (t.rockedTime > 0 ? 6 : 2);
  ctx.strokeStyle = PALETTE.anglerLine;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(t.x + 8, t.y - 3);
  ctx.lineTo(t.x + 18 + wobble * 0.3, t.y - 14 + wobble);
  ctx.stroke();
  if (t.done) {
    ctx.fillStyle = "rgba(255,207,138,0.85)";
    ctx.beginPath(); ctx.arc(t.x, t.y - 16, 3, 0, Math.PI * 2); ctx.fill();
  }
}
function drawFerry(ferry) {
  ctx.save();
  ctx.translate(ferry.x, ferry.y);
  ctx.rotate(ferry.heading);
  ctx.fillStyle = PALETTE.ferryHull;
  ctx.beginPath();
  ctx.moveTo(14, 0); ctx.lineTo(-10, -7); ctx.lineTo(-10, 7); ctx.closePath();
  ctx.fill();
  ctx.fillStyle = PALETTE.lantern;
  ctx.beginPath(); ctx.arc(-2, 0, 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawHud() {
  const remaining = Math.max(0, morningState.duration - morningState.t);
  const s = scoreMorning(morningState);
  ctx.fillStyle = "rgba(255,240,225,0.92)";
  ctx.font = "13px Georgia, serif";
  ctx.textBaseline = "top";
  ctx.fillText(morningLabel, 12, 10);
  ctx.textAlign = "right";
  ctx.fillText(`${s.deeds}/${s.total} kindnesses`, WORLD.w - 12, 10);
  ctx.textAlign = "left";
  ctx.fillText(`${Math.ceil(remaining)}s`, 12, 28);
  ctx.textAlign = "left";
}

// ---------- dev hook ----------
if (new URLSearchParams(location.search).get("dev") === "1") {
  window.__g = {
    getScreen: () => screen,
    goTitle: () => showScreen("title"),
    goHowTo: () => showScreen("howto"),
    goSelect: () => renderSelect(),
    startMorning: (i) => startMorning(i),
    startEndless: () => startEndless(),
    setSteer: (v) => { targetSteer = clamp(v, -1, 1); curSteer = targetSteer; },
    setWidth: (v) => { targetWidth = clamp(v, 0.35, 1.6); curWidth = targetWidth; },
    stepFrames: (n, dtSeconds = 1 / 20) => {
      for (let i = 0; i < n; i++) {
        const now = (lastNow ?? 0) + dtSeconds * 1000;
        step(now);
      }
    },
    getState: () => (morningState ? JSON.parse(JSON.stringify(morningState)) : null),
    getScore: () => (morningState ? scoreMorning(morningState) : null),
    getProgress: () => JSON.parse(JSON.stringify(progress)),
    resetProgress: () => { progress = { cleared: [false, false, false, false, false, false, false] }; saveProgress(progress); },
    forceEnd: () => endMorning(),
  };
}

showScreen("title");
