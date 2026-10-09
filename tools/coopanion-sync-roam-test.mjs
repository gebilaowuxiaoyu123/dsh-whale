/**
 * 「随刷新率」走动模式的自检。
 *
 * 这个模式的行为全在数学里（刷新率读数 → 速度倍率 → 步频），肉眼看几分钟也未必看得出
 * 「步频有没有跟着速度走」，所以用模拟时钟按固定帧间隔推进 pet-core 的模拟，直接量：
 *
 *   1. 刷新率读数：30/60/120/144/240 Hz 的帧间隔要读出对应的 Hz，抖动的 60 Hz 要归一到 60；
 *   2. 长停顿（窗口被挡住、机器卡住）不能被当成低刷新率；
 *   3. 走动速度：随刷新率模式下的巡航速度要正比于刷新率，其它模式不受影响；
 *   4. 不滑步：一个步幅周期走过的距离在各刷新率下必须一致（这正是「动画要调试」的那件事）；
 *   5. 上下限：极慢/极快的屏幕被夹在 0.5× 与 3×。
 *
 * pet-core 只在 `render()`/`setFigure()` 里碰 DOM，模拟本身是纯数学，所以这里不需要 jsdom：
 * 给 createPet 几个空对象当元素即可。`performance.now()` 换成受控时钟。
 *
 * 用法：node tools/coopanion-sync-roam-test.mjs
 *   环境变量 COOPANION_DIR 可指向别的 Coopanion 副本。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.COOPANION_DIR || join(HERE, '..', 'third-party', 'Coopanion'));
const CORE = join(ROOT, 'packages', 'cortico-world-desktop-pet', 'web', 'kit', 'body.js');

if (!existsSync(CORE)) {
  console.log(`[跳过] 没找到 Coopanion 副本：${CORE}`);
  console.log('       先跑 tools/setup-coopanion.ps1（或 .sh）把源码拉下来。');
  process.exit(0);
}

/* ---------- 受控时钟：pet-core 里的 performance.now() 换成它 ---------- */
const clock = { ms: 0 };
const realPerformance = globalThis.performance;
try {
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => clock.ms, timeOrigin: 0, mark() {}, measure() {} },
    configurable: true, writable: true,
  });
} catch (err) {
  console.error(`无法接管 performance.now()，测不了：${err.message}`);
  process.exit(1);
}
if (globalThis.performance.now() !== 0) {
  console.error('接管 performance.now() 失败（读到的不是受控时钟）。');
  process.exit(1);
}

const core = await import(pathToFileURL(CORE).href);
const { createPet, SYNC_MIN, SYNC_MAX } = core;

/* ---------- 断言 ---------- */
let passed = 0;
const failures = [];
function ok(what, cond, detail = '') {
  if (cond) { passed++; return; }
  failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

/* ---------- 造一只桌宠，用固定的帧节奏推进模拟 ---------- */
/** 什么都不做的音效：模拟不碰 Web Audio。 */
const silentSfx = new Proxy({}, { get: () => () => {} });

const W = 800, H = 400, S = .42;
const floorY = H - 2;

/**
 * 按 `frameMs` 的节奏跑 `frames` 帧。
 * `walkTo` 给了就先让它走起来（朝 `walkTo` 的像素位置），返回量到的巡航速度与每步位移。
 */
function simulate({ frameMs, frames, roam = 'sync', jitter = 0, stallAt = null, stallMs = 0, walkTo = null, run = false }) {
  clock.ms = 0;
  const pet = createPet(
    { petG: {}, shadowEl: {}, fxG: {} },
    {
      sfx: silentSfx,
      roam,
      startX: 720,
      bounds: () => ({ W, H, floorY, S }),
      onEvent: () => {},
      dialogOpen: () => false,
    },
  );
  pet.resize();
  if (walkTo != null) pet.walkTo(walkTo, run, 'test');

  // 巡航段的取窗口（秒）：跳过起步加速，也走在到站之前
  const from = .6, to = 1.6;
  let xFrom = null, phFrom = null, xTo = null, phTo = null, t = 0;

  for (let i = 0; i < frames; i++) {
    let gap = frameMs * (1 + (jitter ? (Math.random() * 2 - 1) * jitter : 0));
    if (stallAt != null && i === stallAt) gap = stallMs;
    clock.ms += gap;
    t += gap / 1000;
    pet.step(gap / 1000);
    if (xFrom === null && t >= from) { xFrom = pet.pet.x; phFrom = pet.pet.phase; }
    if (walkTo != null && xTo === null && t >= to) { xTo = pet.pet.x; phTo = pet.pet.phase; }
  }

  const out = { hz: pet.hz, x: pet.pet.x, phase: pet.pet.phase, t };
  if (xTo !== null && xFrom !== null) {
    const secs = to - from;
    out.speed = Math.abs(xTo - xFrom) / secs;
    const cycles = Math.abs(phTo - phFrom) / (2 * Math.PI);
    out.perCycle = cycles > .5 ? Math.abs(xTo - xFrom) / cycles : null;
  }
  return out;
}

/* ---------- 1. 刷新率读数 ---------- */
const rates = [30, 60, 75, 120, 144, 240];
console.log('刷新率读数：');
for (const rate of rates) {
  const r = simulate({ frameMs: 1000 / rate, frames: 1400 });
  const err = Math.abs(r.hz - rate) / rate;
  console.log(`  ${String(rate).padStart(3)} Hz → 读到 ${r.hz.toFixed(2)} Hz（误差 ${(err * 100).toFixed(2)}%）`);
  ok(`${rate}Hz 的读数`, err <= .03, `读到 ${r.hz.toFixed(2)}`);
}

// 抖动的 60 Hz 要归一到 60，而不是读出 57 或 63
{
  const r = simulate({ frameMs: 1000 / 60, frames: 1400, jitter: .15 });
  console.log(`  抖动 60 Hz → 读到 ${r.hz.toFixed(2)} Hz`);
  ok('抖动的 60Hz 归一到 60', Math.abs(r.hz - 60) <= 1.2, `读到 ${r.hz.toFixed(2)}`);
}

/* ---------- 2. 长停顿不算低刷新率 ---------- */
{
  const r = simulate({ frameMs: 1000 / 144, frames: 1400, stallAt: 1200, stallMs: 1500 });
  console.log(`  144 Hz 中途卡 1.5 秒 → 读到 ${r.hz.toFixed(2)} Hz`);
  ok('卡顿不拉低刷新率', Math.abs(r.hz - 144) <= 4, `读到 ${r.hz.toFixed(2)}`);
}

/* ---------- 3. 走动速度正比于刷新率 ---------- */
const walkRates = [30, 60, 120, 144, 240];
const walks = {};
for (const rate of walkRates) {
  walks[rate] = simulate({ frameMs: 1000 / rate, frames: Math.round(rate * 2), walkTo: 60 });
}
const base60 = walks[60].speed;

console.log('\n「随刷新率」走动速度（朝左走 660 px 的巡航段）：');
const speeds = {};
for (const rate of walkRates) {
  const r = walks[rate];
  speeds[rate] = r.speed;
  const pct = (r.speed / base60 - 1) * 100;
  console.log(`  ${String(rate).padStart(3)} Hz → ${r.speed.toFixed(1).padStart(6)} px/s  (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% vs 60Hz)`);
}
for (const rate of walkRates) {
  const want = Math.min(Math.max(rate / 60, SYNC_MIN), SYNC_MAX);
  const got = speeds[rate] / base60;
  ok(`${rate}Hz 的速度倍率`, Math.abs(got - want) <= want * .06, `期望 ${want.toFixed(2)}×，实得 ${got.toFixed(2)}×`);
}

/* ---------- 4. 不滑步：每步幅周期的位移一致 ---------- */
console.log('\n每个步幅周期走过的距离（各刷新率应一致）：');
const perCycle = {};
for (const rate of walkRates) {
  const r = walks[rate];
  perCycle[rate] = r.perCycle;
  console.log(`  ${String(rate).padStart(3)} Hz → ${r.perCycle === null ? 'n/a' : `${r.perCycle.toFixed(2)} px/周期`}`);
}
{
  const vals = walkRates.map((r) => perCycle[r]).filter((v) => v !== null);
  ok('各刷新率都量到步幅', vals.length === walkRates.length, `量到 ${vals.length}/${walkRates.length}`);
  if (vals.length) {
    const lo = Math.min(...vals), hi = Math.max(...vals);
    ok('不同刷新率下每步位移一致（不滑步）', hi - lo <= lo * .06, `${lo.toFixed(2)} ~ ${hi.toFixed(2)} px，差 ${(hi - lo).toFixed(2)}`);
  }
}

/* ---------- 5. 其它模式不受刷新率影响 ---------- */
{
  const a = simulate({ frameMs: 1000 / 60, frames: 120, roam: 'calm', walkTo: 60 });
  const b = simulate({ frameMs: 1000 / 144, frames: 288, roam: 'calm', walkTo: 60 });
  console.log(`\n非随刷新率模式（多待着）：60 Hz ${a.speed.toFixed(1)} px/s vs 144 Hz ${b.speed.toFixed(1)} px/s`);
  ok('别的模式速度与刷新率无关', Math.abs(a.speed - b.speed) <= a.speed * .03, `${a.speed.toFixed(2)} vs ${b.speed.toFixed(2)}`);
  const off = simulate({ frameMs: 1000 / 144, frames: 288, roam: 'off', walkTo: 60 });
  ok('不乱动模式速度不变', Math.abs(off.speed - a.speed) <= a.speed * .03, `${off.speed.toFixed(2)} vs ${a.speed.toFixed(2)}`);
}

/* ---------- 6. 上下限 ---------- */
{
  const slow = simulate({ frameMs: 1000 / 20, frames: 60, walkTo: 60 });
  const fast = simulate({ frameMs: 1000 / 360, frames: 800, walkTo: 60 });
  const base = simulate({ frameMs: 1000 / 60, frames: 180, walkTo: 60 });
  const kSlow = slow.speed / base.speed, kFast = fast.speed / base.speed;
  console.log(`\n上限/下限：20 Hz → ${kSlow.toFixed(2)}×（下限 ${SYNC_MIN}），360 Hz → ${kFast.toFixed(2)}×（上限 ${SYNC_MAX}）`);
  ok('极慢屏幕夹在 0.5×', Math.abs(kSlow - SYNC_MIN) <= .06, `实得 ${kSlow.toFixed(3)}`);
  ok('极快屏幕夹在 3×', Math.abs(kFast - SYNC_MAX) <= .2, `实得 ${kFast.toFixed(3)}`);
}

/* ---------- 收尾 ---------- */
Object.defineProperty(globalThis, 'performance', { value: realPerformance, configurable: true, writable: true });

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 项没通过（共 ${passed + failures.length} 项）：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 项断言通过`);
