// WAKE — pure core. No DOM, no WebAudio, no Date.now()/Math.random() inside logic paths.
// You are not the ferry. You are its wake — the trailing V of disturbed water.
// The ferry is fixed and honest (it never listens to you). The wake is yours to steer,
// on a delay, and everything it touches happens because you anticipated where it would be.

export const WORLD = { w: 360, h: 640 };

// ---------- deterministic PRNG (mulberry32) ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function lerp(a, b, f) { return a + (b - a) * f; }

// ---------- the fixed morning route ----------
// A closed loop around the harbor. First and last waypoints are identical so the
// ferry's lap seams cleanly for endless mornings.
export const HARBOR_ROUTE = {
  waypoints: [
    { x: 100, y: 470 },
    { x: 150, y: 415 },
    { x: 225, y: 402 },
    { x: 288, y: 428 },
    { x: 310, y: 478 },
    { x: 282, y: 528 },
    { x: 210, y: 548 },
    { x: 138, y: 536 },
    { x: 100, y: 500 },
    { x: 100, y: 470 },
  ],
  speed: 34, // px/sec, constant. The ferry never changes its mind.
};

export function routeLength(route) {
  let len = 0;
  for (let i = 0; i < route.waypoints.length - 1; i++) {
    len += dist(route.waypoints[i], route.waypoints[i + 1]);
  }
  return len;
}

// The ferry's position is a pure function of elapsed time and the route. Same t,
// same route, same answer — always. It loops forever; there is no "end" to the lap.
export function ferryPos(t, route) {
  const total = routeLength(route);
  const speed = route.speed;
  let d = ((t * speed) % total + total) % total;
  const traveled = d;
  const wp = route.waypoints;
  for (let i = 0; i < wp.length - 1; i++) {
    const a = wp[i], b = wp[i + 1];
    const segLen = dist(a, b);
    if (segLen === 0) continue;
    if (d <= segLen || i === wp.length - 2) {
      const f = clamp(d / segLen, 0, 1);
      return {
        x: lerp(a.x, b.x, f),
        y: lerp(a.y, b.y, f),
        heading: Math.atan2(b.y - a.y, b.x - a.x),
        dist: traveled,
      };
    }
    d -= segLen;
  }
  const last = wp[wp.length - 1];
  return { x: last.x, y: last.y, heading: 0, dist: traveled };
}

// distance from a point to the route polyline (for reachability checks)
export function minDistanceToRoute(point, route) {
  const wp = route.waypoints;
  let best = Infinity;
  for (let i = 0; i < wp.length - 1; i++) {
    const a = wp[i], b = wp[i + 1];
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    let t = len2 === 0 ? 0 : ((point.x - a.x) * abx + (point.y - a.y) * aby) / len2;
    t = clamp(t, 0, 1);
    const px = a.x + abx * t, py = a.y + aby * t;
    const d = Math.hypot(point.x - px, point.y - py);
    if (d < best) best = d;
  }
  return best;
}

// ---------- the wake itself ----------
// The wake is not the ferry's shadow — it is a chain of trailing nodes, each one
// anchored to where the ferry WAS, `lag` seconds ago. The player's steer bends the
// whole chain sideways, off the ferry's own centerline, within a hard limit — the
// wake can lean, but it cannot leave the water the ferry actually disturbed.
export const WAKE_NODE_COUNT = 14;
export const WAKE_LAG_STEP = 0.28; // seconds between trailing nodes
export const MAX_STEER_OFFSET = 46; // px, full-lock lateral lean
export const BASE_SIGMA = 24; // px, force falloff radius at width = 1
export const BASE_PULL_SPEED = 130; // px/sec, peak pull speed at width = 1, distance 0

export function wakeNodes(t, route, playerOffset, width) {
  const w = clamp(width, 0.35, 1.6);
  const steer = clamp(playerOffset, -1, 1);
  const nodes = [];
  for (let i = 1; i <= WAKE_NODE_COUNT; i++) {
    const lag = i * WAKE_LAG_STEP;
    const base = ferryPos(t - lag, route);
    const nx = -Math.sin(base.heading), ny = Math.cos(base.heading);
    const ramp = Math.min(1, i / 3); // wake leans in gradually near the stern, not instantly
    const lateral = steer * MAX_STEER_OFFSET * ramp;
    nodes.push({
      x: base.x + nx * lateral,
      y: base.y + ny * lateral,
      baseDist: base.dist,
      lag,
      sigma: BASE_SIGMA * w,
      peak: BASE_PULL_SPEED / w, // width conservation: sharper (smaller w) pulls harder
    });
  }
  return nodes;
}

// wakeField(ferryPath, playerOffset, width) -> forceAt(px, py) -> {fx, fy, mag, dist}
// ferryPath is { t, route }. The returned field pulls anything near it toward the
// nearest trailing node — the wake catches, it does not scatter.
export function wakeField(ferryPath, playerOffset, width) {
  const nodes = wakeNodes(ferryPath.t, ferryPath.route, playerOffset, width);
  return function forceAt(px, py) {
    let best = null, bestD = Infinity, bdx = 0, bdy = 0;
    for (const n of nodes) {
      const dx = n.x - px, dy = n.y - py;
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = n; bdx = dx; bdy = dy; }
    }
    const mag = best.peak * Math.exp(-(bestD * bestD) / (2 * best.sigma * best.sigma));
    const fx = bestD > 1e-6 ? (bdx / bestD) * mag : 0;
    const fy = bestD > 1e-6 ? (bdy / bestD) * mag : 0;
    return { fx, fy, mag, dist: bestD };
  };
}

// applyWake(object, field, dt) -> new object, pulled by the field for one tick.
export function applyWake(object, field, dt) {
  const f = field(object.x, object.y);
  return { ...object, x: object.x + f.fx * dt, y: object.y + f.fy * dt };
}

// ---------- task thresholds ----------
export const CATCH_RADIUS = 26; // px, toy/litter counted as delivered
export const SWAMP_THRESHOLD = 100; // wake mag at the nest above this = swamped
export const ROCK_MIN = 18, ROCK_MAX = 70; // wake mag band that rocks the angler awake
export const ROCK_REQUIRED = 1.2; // seconds sustained in-band

// ---------- tasks ----------
let _taskId = 0;
function nextId() { return `t${_taskId++}`; }

export function makeToyTask(objX, objY, targetX, targetY) {
  return { id: nextId(), type: "toy", objX, objY, targetX, targetY, done: false };
}
export function makeLitterTask(objX, objY, targetX, targetY) {
  return { id: nextId(), type: "litter", objX, objY, targetX, targetY, done: false };
}
export function makeAnglerTask(x, y) {
  return { id: nextId(), type: "angler", x, y, rockedTime: 0, done: false };
}
export function makeSwan(x, y) {
  return { x, y, swamped: false };
}

// resolveTasks(tasks, field, dt) — advances every unresolved task by one tick. Pure.
export function resolveTasks(tasks, field, dt) {
  return tasks.map((task) => {
    if (task.done) return task;
    if (task.type === "toy" || task.type === "litter") {
      const moved = applyWake({ x: task.objX, y: task.objY }, field, dt);
      const d = Math.hypot(moved.x - task.targetX, moved.y - task.targetY);
      const done = d <= CATCH_RADIUS;
      return { ...task, objX: moved.x, objY: moved.y, done };
    }
    if (task.type === "angler") {
      const f = field(task.x, task.y);
      const inBand = f.mag >= ROCK_MIN && f.mag <= ROCK_MAX;
      const rockedTime = task.rockedTime + (inBand ? dt : 0);
      const done = rockedTime >= ROCK_REQUIRED;
      return { ...task, rockedTime, done };
    }
    return task;
  });
}

export function resolveSwan(swan, field) {
  if (swan.swamped) return swan;
  const f = field(swan.x, swan.y);
  return { ...swan, swamped: f.mag > SWAMP_THRESHOLD };
}

// ---------- morning state machine ----------
export function initMorningState(morningDef, route) {
  return {
    t: 0,
    route,
    duration: morningDef.duration,
    tasks: morningDef.tasks.map((t) => ({ ...t })),
    swan: { ...morningDef.swan },
  };
}

// stepMorning — the whole game, one tick. Pure: same inputs, same output.
export function stepMorning(state, playerOffset, width, dt) {
  const t = state.t + dt;
  const field = wakeField({ t, route: state.route }, playerOffset, width);
  const tasks = resolveTasks(state.tasks, field, dt);
  const swan = resolveSwan(state.swan, field);
  return { ...state, t, tasks, swan };
}

export function scoreMorning(state) {
  const deeds = state.tasks.filter((t) => t.done).length;
  const total = state.tasks.length;
  return { deeds, total, swanSafe: !state.swan.swamped };
}

// ---------- the 7 authored mornings ----------
// Small, generous, hand-placed. Every task sits within reach of the route's lean,
// and the swan nest is always tucked where a careless wide-open wake finds it first —
// the game teaches "go gentle near the nest" by letting you learn it once, softly.
export function buildAuthoredMornings() {
  return [
    { // morning 1 — one toy, learn the pull
      duration: 26,
      tasks: [makeToyTask(150, 380, 118, 452)],
      swan: makeSwan(320, 560),
    },
    { // morning 2 — one drift of litter to the skimmer
      duration: 26,
      tasks: [makeLitterTask(330, 500, 296, 445)],
      swan: makeSwan(60, 560),
    },
    { // morning 3 — toy and litter both waiting
      duration: 34,
      tasks: [
        makeToyTask(150, 380, 118, 452),
        makeLitterTask(330, 500, 296, 445),
      ],
      swan: makeSwan(320, 560),
    },
    { // morning 4 — the grumpy angler needs a gentle rock, not a shove
      duration: 26,
      tasks: [makeAnglerTask(170, 385)],
      swan: makeSwan(320, 560),
    },
    { // morning 5 — a full round: toy, angler, and the nest close enough to matter
      duration: 40,
      tasks: [
        makeToyTask(150, 380, 118, 452),
        makeAnglerTask(255, 392),
      ],
      swan: makeSwan(320, 555),
    },
    { // morning 6 — litter and angler, nest tucked the other way
      duration: 40,
      tasks: [
        makeLitterTask(330, 500, 296, 445),
        makeAnglerTask(170, 385),
      ],
      swan: makeSwan(60, 560),
    },
    { // morning 7 — the full harbor: toy, litter, angler, nest tucked clear of all three
      duration: 52,
      tasks: [
        makeToyTask(150, 380, 118, 452),
        makeLitterTask(330, 500, 296, 445),
        makeAnglerTask(210, 560),
      ],
      swan: makeSwan(270, 380),
    },
  ];
}

// ---------- endless, seeded mornings ----------
// A reach envelope: nothing is ever placed further from the route than the wake can
// lean at its widest reasonable working width, minus a safety margin.
export const REACH_LIMIT = MAX_STEER_OFFSET + BASE_SIGMA * 1.5;

function pickNear(rand, route, minReach, maxReach) {
  // walk to a random point on the route, then step off perpendicular to it
  const total = routeLength(route);
  const targetDist = rand() * total;
  const pseudo = { speed: 1, waypoints: route.waypoints };
  const p = ferryPos(targetDist, pseudo);
  const nx = -Math.sin(p.heading), ny = Math.cos(p.heading);
  const side = rand() < 0.5 ? -1 : 1;
  const off = minReach + rand() * (maxReach - minReach);
  return { x: clamp(p.x + nx * off * side, 12, WORLD.w - 12), y: clamp(p.y + ny * off * side, 12, WORLD.h - 12), anchor: p };
}

export function layoutEndlessMorning(seed, index) {
  const rand = mulberry32((seed * 9301 + index * 49297) >>> 0);
  const route = HARBOR_ROUTE;
  const taskCount = 2 + (index % 3); // 2..4 tasks, cycling with the run
  const tasks = [];
  const kinds = ["toy", "litter", "angler"];
  for (let i = 0; i < taskCount; i++) {
    const kind = kinds[Math.floor(rand() * kinds.length)];
    if (kind === "angler") {
      const spot = pickNear(rand, route, 18, REACH_LIMIT - 8);
      tasks.push(makeAnglerTask(spot.x, spot.y));
    } else {
      const spot = pickNear(rand, route, 20, REACH_LIMIT - 6);
      const target = pickNear(rand, route, 6, REACH_LIMIT - 20);
      const maker = kind === "toy" ? makeToyTask : makeLitterTask;
      tasks.push(maker(spot.x, spot.y, target.x, target.y));
    }
  }
  // swan nest: always placed with real clearance from every task so an idle wake
  // never accidentally swamps it, but close enough to the route to matter
  let swanSpot;
  let tries = 0;
  do {
    swanSpot = pickNear(rand, route, 30, REACH_LIMIT - 10);
    tries++;
  } while (
    tries < 20 &&
    tasks.some((t) => {
      const px = t.x ?? t.objX, py = t.y ?? t.objY;
      return Math.hypot(px - swanSpot.x, py - swanSpot.y) < 40;
    })
  );
  return {
    duration: 24 + taskCount * 10,
    tasks,
    swan: makeSwan(swanSpot.x, swanSpot.y),
  };
}

export function formatShare(morningLabel, deeds, swanSafe, url) {
  const noun = deeds === 1 ? "kindness" : "kindnesses";
  const swanText = swanSafe ? "swans dry" : "swans startled";
  return `\u{1F6A3} WAKE · ${morningLabel} · ${deeds} ${noun}, ${swanText} · ${url}`;
}
