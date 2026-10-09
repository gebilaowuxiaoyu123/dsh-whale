/**
 * 「测试刷新率」（悬停按钮）的自检。
 *
 * 这个功能的行为全在数学与时序里：先跑到最左，再以「一帧一步」(1 px) 从左到右、右到左共
 * 4 段（两趟来回）横穿桌面，速度由开跑前量到的帧率决定，跑完回话。肉眼看一遍只能看出
 * 「它跑了一趟」，看不出「一帧到底走了几像素」「量到的 Hz 对不对」，所以这里用受控时钟 +
 * 受控 requestAnimationFrame 推进模拟，直接量：
 *
 *   1. 测速：给定 60/120 Hz 的帧节奏，读数要落在 60/120 上（±6% 内归一到真实刷新率）；
 *   2. 起跑：先以常速跑到最左（minX），从那里才开始横穿；
 *   3. 一帧一步：横穿期间一帧就走 1 px（这正是「按桌面刷新率跑」的定义）；
 *   4. 段序：左→右→左→右→左（共 4 段），每段都跑到对边的边界；
 *   5. 速度跟着刷新率走：60 Hz 的屏幕跑完同样 4 段要花两倍时间；
 *   6. 读数写回：「随刷新率」立刻按真实屏幕走，而且不会被页面帧循环（被压到 15/30 fps）拉回去；
 *   7. 收尾与叫停：pet.pace 放开、自家乱动恢复；stopHzScan() 回 ok:false。
 *
 * pet-core 只在 render()/setFigure() 里碰 DOM，模拟本身是纯数学，所以这里不需要 jsdom：
 * 给 createPet 几个空对象当元素即可。performance.now() 与 requestAnimationFrame 都换成受控的。
 *
 * 用法：node tools/coopanion-hzscan-test.mjs
 *   环境变量 COOPANION_DIR 可指向别的 Coopanion 副本。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.COOPANION_DIR || join(HERE, '..', 'third-party', 'Coopanion'));
const CORE = join(ROOT, 'packages', 'cortico-world-desktop-pet', 'web', 'pet-core.js');

if (!existsSync(CORE)) {
  console.log(`[跳过] 没找到 Coopanion 副本：${CORE}`);
  console.log('       先跑 tools/setup-coopanion.ps1（或 .sh）把源码拉下来。');
  process.exit(0);
}

/* ---------- 受控时钟 + 受控 rAF ---------- */
const clock = { ms: 0 };
const rafQueue = [];
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
globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};

const { createPet } = await import(pathToFileURL(CORE).href);

/* ---------- 断言 ---------- */
let passed = 0;
const failures = [];
function ok(what, cond, detail = '') {
  if (cond) { passed++; console.log(`  \u2713 ${what}`); return; }
  failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
  console.log(`  \u2717 ${what}  [${detail}]`);
}

/* ---------- 舞台：一只桌宠 + 一块给定刷新率的"屏幕" ---------- */
const silentSfx = new Proxy({}, { get: () => () => {} });
const W = 800, H = 400, S = .42, floorY = H - 2;

/**
 * 造一只桌宠，并给它一块刷新率为 `hz` 的屏幕：一帧的时钟间隔 = 1000/hz ms，
 * 每帧先把这一帧到点的 rAF 回调跑掉（测速探针就靠这个数帧），再推进桌宠一帧。
 */
function stage(hz) {
  clock.ms = 0;
  rafQueue.length = 0;
  const core = createPet(
    { petG: {}, shadowEl: {}, fxG: {} },
    {
      sfx: silentSfx,
      roam: 'calm',
      startX: W * .5,
      bounds: () => ({ W, H, floorY, S }),
      onEvent: () => {},
      dialogOpen: () => false,
    },
  );
  core.resize();
  const dtMs = 1000 / hz, dtS = dtMs / 1000;
  const track = { legEnds: [], legFrames: [], near: null, minX: Infinity, frames: 0 };

  const frame = () => {
    clock.ms += dtMs;
    for (const cb of rafQueue.splice(0)) cb(clock.ms);
    core.step(dtS);
    track.frames++;
    const x = core.pet.x, b = core.bounds;
    if (x < track.minX) track.minX = x;
    const edge = x < b.minX + 2 ? 'L' : x > b.maxX - 2 ? 'R' : null;
    if (edge && edge !== track.near) { track.legEnds.push(edge); track.legFrames.push(track.frames); }
    track.near = edge;
  };

  return {
    core, dtMs, track,
    frame,
    /** 一直推到 `done()` 为真；每 8 帧让出一次事件循环，好让 hzScan 的 promise 往前走。 */
    async runUntil(done, maxFrames = 400000) {
      for (let i = 0; i < maxFrames; i++) {
        frame();
        if (done()) return true;
        if (i % 8 === 7) await new Promise((r) => setImmediate(r));
      }
      return false;
    },
  };
}

/** 跑一次完整的测试，返回读数与舞台。 */
async function run(hz, { legs = 4, stopAfter = 0 } = {}) {
  const st = stage(hz);
  let res = null, reject = null;
  st.core.hzScan({ legs }).then((r) => { res = r; }, (e) => { reject = e; });
  if (stopAfter) {
    await st.runUntil(() => st.track.frames >= stopAfter);
    st.core.stopHzScan();
  }
  const done = await st.runUntil(() => !!res || !!reject);
  return { st, res, reject, done };
}

/* ---------- 1. 120 Hz：整趟跑完 ---------- */
console.log('[1] 120 Hz 的屏幕：跑到最左 → 4 段横穿 → 回话');
const a = await run(120);
{
  const { st, res } = a;
  const b = st.core.bounds, span = b.maxX - b.minX;
  ok('测试跑完并回话（ok:true）', !!res && res.ok === true, JSON.stringify(res));
  ok('读数归一到 120 Hz', res?.hz === 120, String(res?.hz));
  ok('实测值就在 120 附近（±2 Hz）', Math.abs((res?.raw ?? 0) - 120) <= 2, (res?.raw ?? 0).toFixed(2));
  ok('段数 = 4（两趟来回）', res?.legs === 4, String(res?.legs));
  // 到最左那一下也算一次边界到达：后面才是四个段头（左→右→左→右→左）
  ok('段序 = 到最左 → 右 → 左 → 右 → 左', st.track.legEnds.join('') === 'LRLRL', st.track.legEnds.join(''));
  ok('先跑到最左才开始横穿', Math.abs(st.track.minX - b.minX) <= 2,
    `${st.track.minX.toFixed(1)} vs ${b.minX.toFixed(1)}`);
  ok('4 段共走满 4 个来回的路程（±1%）', Math.abs((res?.px ?? 0) - 4 * span) <= 4 * span * .01,
    `${res?.px} vs ${(4 * span).toFixed(1)}`);
  // 第 3 段（左→右）正好是一个屏宽：帧数应与像素数一样多 → 一帧一步。
  // 用中间这段量：第一段前面还等着测速读数，会多出几帧空档。
  const legFrames = st.track.legFrames[2] - st.track.legFrames[1];
  ok('一帧一步：中间那段的帧数 ≈ 该段的像素数', Math.abs(legFrames - span) <= 5,
    `${legFrames} 帧 vs ${span.toFixed(1)} px`);
  ok('用时 ≈ 路程 ÷ 刷新率（±3%）',
    !!res && Math.abs(res.ms - (res.px / res.raw) * 1000) / res.ms < .03,
    res ? `${(res.ms / 1000).toFixed(2)} s` : '—');
}

/* ---------- 2. 60 Hz：同样 4 段要花两倍时间 ---------- */
console.log('\n[2] 60 Hz 的屏幕：速度减半，用时翻倍');
const c = await run(60);
{
  const { st, res } = c;
  const b = st.core.bounds, span = b.maxX - b.minX;
  ok('读数归一到 60 Hz', res?.hz === 60, String(res?.hz));
  ok('实测值就在 60 附近（±2 Hz）', Math.abs((res?.raw ?? 0) - 60) <= 2, (res?.raw ?? 0).toFixed(2));
  ok('段序同样是到最左 → 右 → 左 → 右 → 左', st.track.legEnds.join('') === 'LRLRL', st.track.legEnds.join(''));
  const legFrames = st.track.legFrames[2] - st.track.legFrames[1];
  ok('一帧一步：帧数仍 ≈ 像素数', Math.abs(legFrames - span) <= 5, `${legFrames} 帧 vs ${span.toFixed(1)} px`);
  ok('同样的 4 段，用时约是 120 Hz 的两倍（±10%）',
    !!a.res && !!res && Math.abs(res.ms / a.res.ms - 2) <= .2,
    a.res && res ? `${(a.res.ms / 1000).toFixed(2)} s → ${(res.ms / 1000).toFixed(2)} s` : '—');
}

/* ---------- 3. 收尾：读数写回、速度与自家乱动放开 ---------- */
console.log('\n[3] 收尾');
{
  const st = a.st;
  ok('速度放开（pet.pace = 0）', st.core.pet.pace === 0, String(st.core.pet.pace));
  ok('读数写回 ctl.hz（「随刷新率」立刻按真实屏幕走）', st.core.hz === 120, String(st.core.hz));
  // 再跑一会儿：页面帧循环只有 30/15 fps，量出来的"帧率"不是屏幕的，不能把读数拉回去
  await st.runUntil(() => st.track.frames >= 0, 60);
  ok('继续跑 60 帧后读数仍是 120（没被页面帧循环拉回去）', st.core.hz === 120, String(st.core.hz));
}

/* ---------- 4. 叫停 ---------- */
console.log('\n[4] 跑到一半叫停');
{
  const { st, res } = await run(120, { stopAfter: 400 });
  ok('叫停后回 ok:false', !!res && res.ok === false, JSON.stringify(res));
  ok('原因是 cancelled', res?.reason === 'cancelled', String(res?.reason));
  ok('速度同样放开（pet.pace = 0）', st.core.pet.pace === 0, String(st.core.pet.pace));
}

/* ---------- 收尾 ---------- */
if (failures.length) {
  console.log(`\n\u2717 ${failures.length} 项没通过（共 ${passed + failures.length} 项）：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`\n\u2713 全部 ${passed} 项断言通过 —— 先跑到最左、一帧一步横穿两趟、读数与用时都对得上`);
