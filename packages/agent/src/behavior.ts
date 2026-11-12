// Behavioral biometrics — passively summarize interaction into aggregates (never raw events).
// The SERVER scores humanness from these; automation that spoofs the environment still moves like
// a machine (dead-straight paths, constant timing, teleporting cursor, static motion sensor).

export interface BehaviorSummary {
  observed: boolean;
  durationMs: number;
  mouse: { moves: number; pathLen: number; displacement: number; straightness: number | null;
           avgSpeed: number; speedVar: number; maxJump: number; tremor: boolean };
  keys: { count: number; avgInterval: number; intervalVar: number; minInterval: number; backspaces: number };
  touch: { count: number; moves: number };
  scroll: { count: number };
  motion: { samples: number; accelVar: number };
  clicks: { count: number };
  // Events the page received with isTrusted === false (dispatched by script, not the browser's
  // input pipeline). A count only.
  untrusted: number;
  // Opt-in (Prynt.load({ behaviorTiming: true })): key hold durations and mouse event cadence.
  // Aggregates only — never keys, positions or raw timestamps.
  timing?: { keyHolds: number; holdMedian: number; holdsUnder10ms: number; moveEvents: number; zeroDtMoves: number };
}

export interface BehaviorTracker {
  summary(): BehaviorSummary;
  stop(): void;
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
}

const CAP = 600;
const push = (arr: number[], v: number): void => { if (arr.length < CAP) arr.push(v); };

export function startBehavior(timing = false): BehaviorTracker {
  const noop: BehaviorTracker = {
    stop() { /* nothing */ },
    summary() {
      return {
        observed: false, durationMs: 0,
        mouse: { moves: 0, pathLen: 0, displacement: 0, straightness: null, avgSpeed: 0, speedVar: 0, maxJump: 0, tremor: false },
        keys: { count: 0, avgInterval: 0, intervalVar: 0, minInterval: 0, backspaces: 0 },
        touch: { count: 0, moves: 0 }, scroll: { count: 0 }, motion: { samples: 0, accelVar: 0 }, clicks: { count: 0 },
        untrusted: 0,
      };
    },
  };
  if (typeof window === 'undefined' || typeof document === 'undefined') return noop;

  const t0 = Date.now();
  const speeds: number[] = [];
  const intervals: number[] = [];
  const accel: number[] = [];
  let moves = 0, pathLen = 0, maxJump = 0, smallMoves = 0;
  let firstX = 0, firstY = 0, lastX = 0, lastY = 0, lastT = 0, haveFirst = false;
  let keyCount = 0, backspaces = 0, lastKeyT = 0;
  let touchCount = 0, touchMoves = 0, scrolls = 0, clicks = 0, motionSamples = 0;
  let untrusted = 0, zeroDtMoves = 0, moveEvents = 0;
  const holds: number[] = [];
  const downAt: Record<string, number> = {};
  const now = (): number => { try { return performance.now(); } catch { return Date.now(); } };
  let lastMovePerf = -1;
  const trust = (e: Event): void => { if (e.isTrusted === false) untrusted++; };

  const onMove = (e: MouseEvent): void => {
    trust(e);
    if (timing) {
      const t = now(); moveEvents++;
      if (lastMovePerf >= 0 && t - lastMovePerf < 0.5) zeroDtMoves++;
      lastMovePerf = t;
    }
    const now_ = Date.now();
    if (!haveFirst) { firstX = e.clientX; firstY = e.clientY; haveFirst = true; }
    else {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      const dist = Math.hypot(dx, dy);
      const dt = Math.max(1, now_ - lastT);
      pathLen += dist; moves++;
      push(speeds, dist / dt);
      if (dist > maxJump) maxJump = dist;
      if (dist > 0 && dist < 2) smallMoves++;
    }
    lastX = e.clientX; lastY = e.clientY; lastT = now_;
  };
  const onKey = (e: KeyboardEvent): void => {
    trust(e);
    const t = Date.now();
    if (lastKeyT) push(intervals, t - lastKeyT);
    lastKeyT = t; keyCount++;
    if (timing && !e.repeat) downAt[e.code || e.key || '?'] = now();
    if (e.key === 'Backspace' || e.key === 'Delete') backspaces++;
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    const k = e.code || e.key || '?';
    if (timing && downAt[k] !== undefined) { push(holds, now() - downAt[k]); delete downAt[k]; }
  };
  const onTouchStart = (e: TouchEvent): void => { trust(e); touchCount++; };
  const onTouchMove = (): void => { touchMoves++; };
  const onScroll = (): void => { scrolls++; };
  const onClick = (e: MouseEvent): void => { trust(e); clicks++; };
  const onMotion = (e: DeviceMotionEvent): void => {
    const a = e.accelerationIncludingGravity || e.acceleration;
    if (a) { push(accel, Math.hypot(a.x || 0, a.y || 0, a.z || 0)); motionSamples++; }
  };

  const opts: AddEventListenerOptions = { passive: true, capture: true };
  const add = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void): void => {
    try { window.addEventListener(type, fn, opts); } catch { /* ignore */ }
  };
  add('mousemove', onMove);
  add('keydown', onKey);
  add('keyup', onKeyUp);
  add('touchstart', onTouchStart);
  add('touchmove', onTouchMove);
  add('scroll', onScroll);
  add('click', onClick);
  add('devicemotion', onMotion);

  const stop = (): void => {
    window.removeEventListener('mousemove', onMove, opts);
    window.removeEventListener('keydown', onKey, opts);
    window.removeEventListener('keyup', onKeyUp, opts);
    window.removeEventListener('touchstart', onTouchStart, opts);
    window.removeEventListener('touchmove', onTouchMove, opts);
    window.removeEventListener('scroll', onScroll, opts);
    window.removeEventListener('click', onClick, opts);
    window.removeEventListener('devicemotion', onMotion, opts);
  };

  return {
    stop,
    summary(): BehaviorSummary {
      const displacement = haveFirst ? Math.hypot(lastX - firstX, lastY - firstY) : 0;
      const avgSpeed = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
      const avgInterval = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
      return {
        observed: moves > 0 || keyCount > 0 || touchCount > 0 || clicks > 0 || scrolls > 0,
        durationMs: Date.now() - t0,
        mouse: {
          moves, pathLen: Math.round(pathLen), displacement: Math.round(displacement),
          straightness: displacement > 1 ? Math.round((pathLen / displacement) * 100) / 100 : null,
          avgSpeed: Math.round(avgSpeed * 1000) / 1000, speedVar: Math.round(variance(speeds) * 1000) / 1000,
          maxJump: Math.round(maxJump), tremor: smallMoves > 0,
        },
        keys: {
          count: keyCount, avgInterval: Math.round(avgInterval),
          intervalVar: Math.round(variance(intervals)),
          minInterval: intervals.length ? Math.min(...intervals) : 0, backspaces,
        },
        touch: { count: touchCount, moves: touchMoves },
        scroll: { count: scrolls },
        motion: { samples: motionSamples, accelVar: Math.round(variance(accel) * 1000) / 1000 },
        clicks: { count: clicks },
        untrusted,
        ...(timing ? { timing: (() => {
          const sorted = holds.slice().sort((a, b) => a - b);
          const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
          return { keyHolds: holds.length, holdMedian: Math.round(med * 10) / 10,
                   holdsUnder10ms: holds.filter((h) => h < 10).length, moveEvents, zeroDtMoves };
        })() } : {}),
      };
    },
  };
}
