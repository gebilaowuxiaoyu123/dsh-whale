/**
 * Coopanion 桌宠改造的自检：源码补丁是否打上、构建产物是否跟上。
 *
 * 这个仓库不改 Coopanion 的原码入库（AGPL，见 docs/coopanion-integration.md），改造以
 * `patches/coopanion/0001-dsh-pet-features.patch` 的形式保存，由 tools/setup-coopanion.*
 * 在安装/更新时打上去。于是有两个容易悄悄坏掉的地方：
 *
 *   1. 补丁没打（或只打了一半）—— 界面上少个按钮、少个走动模式；
 *   2. 补丁打了但**没重新构建** —— 前端文件是按请求实时读的，改了立刻生效；可控制台页面
 *      是打包产物（build/cortico/dist/web/main-*.js），不重构就看不到「随刷新率」。
 *
 * 顺带检查补丁文件本身跟工作区是否一致（不一致说明有人改了源码却没更新补丁），
 * 以及有没有把调试插桩漏在源码里。
 *
 * 用法：node tools/coopanion-feature-test.mjs
 *   环境变量 COOPANION_DIR 可指向别的副本。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const ROOT = resolve(process.env.COOPANION_DIR || join(REPO, 'third-party', 'Coopanion'));
const PET = join(ROOT, 'packages', 'cortico-world-desktop-pet');
const PATCH = join(REPO, 'patches', 'coopanion', '0001-dsh-pet-features.patch');

if (!existsSync(join(ROOT, 'package.json'))) {
  console.log(`[跳过] 没找到 Coopanion 副本：${ROOT}`);
  console.log('       先跑 tools/setup-coopanion.ps1（或 .sh）把源码拉下来。');
  process.exit(0);
}

let passed = 0;
const failures = [];
function ok(what, cond, detail = '') {
  if (cond) { passed++; return; }
  failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}
/** 文件里有没有这些片段；返回缺失的片段。 */
function missing(file, needles) {
  if (!existsSync(file)) return [`文件不存在：${file}`];
  const text = readFileSync(file, 'utf8');
  return needles.filter((n) => !text.includes(n));
}
function check(file, label, needles) {
  const gone = missing(file, needles);
  ok(label, gone.length === 0, gone.length ? `缺 ${gone.map((g) => JSON.stringify(g.slice(0, 60))).join('、')}` : '');
}

/* ---------- 1. 聊天气泡里的调试入口按钮 ---------- */
check(join(PET, 'web', 'pet-app.js'), '气泡：输入框左边的小齿轮按钮', [
  'b-cfg', "action: 'settings'", 'consoleKey', '打开设置(本地调试界面)',
]);
check(join(PET, 'web', 'pet.css'), '气泡：齿轮按钮的样式', ['.b-own button.b-cfg']);

/* ---------- 2. 「随刷新率」走动模式 ---------- */
check(join(PET, 'web', 'pet-app.js'), '走动模式列表里有 sync', [
  "ROAM_ORDER = ['off', 'calm', 'free', 'sync']", '随刷新率', 'ctl.hz',
]);
check(join(PET, 'web', 'pet-core.js'), '刷新率读数与速度缩放', [
  'readHz', 'SYNC_MIN', 'SYNC_MAX', 'roam_sync', 'get hz()', 'syncK',
]);
check(join(PET, 'src', 'config.ts'), '配置 schema 接受 sync', ["enum: ['free', 'calm', 'off', 'sync']"]);
check(join(ROOT, 'console', 'features', 'pet', 'index.ts'), '控制台「习惯」页有这一项', ['roamSync']);

/* ---------- 3. 开机自启（不弹调试界面） ---------- */
check(join(ROOT, 'app', 'main.cjs'), '自启开关与 --background', [
  '--set-autostart=', 'const BACKGROUND =', 'CORTICO_START_BACKGROUND', 'const START_ARGS =',
]);
{
  const text = readFileSync(join(ROOT, 'app', 'main.cjs'), 'utf8');
  ok('托盘里的开机自启不再限定打包版', !text.includes('enabled: app.isPackaged'));
}
check(join(ROOT, 'core', 'companion.ts'), '--background 时不自己打开设置窗', [
  "process.env.CORTICO_START_BACKGROUND === '1'", 'if (!BACKGROUND)',
]);

/* ---------- 4. 构建产物跟上没有 ---------- */
{
  const webRoot = join(ROOT, 'build', 'cortico', 'dist', 'web');
  const main = existsSync(webRoot) ? readdirSync(webRoot).find((f) => /^main-.*\.js$/.test(f)) : null;
  ok('控制台页面已构建', !!main, main ? '' : `没找到 ${webRoot}/main-*.js`);
  if (main) {
    // esbuild 默认把非 ASCII 转成 \uXXXX
    const text = readFileSync(join(webRoot, main), 'utf8');
    ok('构建产物里有「随刷新率」', text.includes('\\u968F\\u5237\\u65B0\\u7387') || text.includes('随刷新率'),
      '补丁打了但没重新构建：跑 pnpm --dir <Coopanion> run build:cortico');
  }
}
ok('桌宠面板 bundle 已构建', existsSync(join(PET, 'dist', 'console.js')));

/* ---------- 5. 补丁文件与工作区一致 ---------- */
{
  ok('补丁文件存在', existsSync(PATCH), PATCH);
  if (existsSync(PATCH)) {
    const onDisk = readFileSync(PATCH, 'utf8').replace(/\r\n/g, '\n');
    let now = '';
    try {
      now = execFileSync('git', ['-C', ROOT, 'diff', '--no-color'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
      now = null;
    }
    const norm = (s) => (s ?? '').replace(/\r\n/g, '\n');
    if (now === null) {
      ok('能读到工作区 diff', false, 'git 不可用或这里不是 git 仓库');
    } else if (now.trim() === '') {
      ok('补丁已应用', false, '工作区是干净的 —— 补丁没打上');
    } else {
      ok('补丁文件与工作区一致', norm(onDisk) === norm(now),
        '源码改了但补丁没更新：git -C <Coopanion> diff --no-color --output=' + PATCH);
    }
  }
}

/* ---------- 6. 没漏调试插桩 ---------- */
{
  const roots = ['app', 'core', 'console', join('packages', 'cortico-world-desktop-pet', 'src'), join('packages', 'cortico-world-desktop-pet', 'web')];
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(cjs|mjs|js|ts)$/.test(e.name)) continue;
      const text = readFileSync(p, 'utf8');
      if (text.includes('dsh-debug')) hits.push(p.replace(ROOT, ''));
    }
  };
  for (const r of roots) if (existsSync(join(ROOT, r))) walk(join(ROOT, r));
  ok('源码里没有遗留的调试插桩', hits.length === 0, hits.join('、'));
}

/* ---------- 收尾 ---------- */
if (failures.length) {
  console.log(`✗ ${failures.length} 项没通过（共 ${passed + failures.length} 项）：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 项断言通过 —— 补丁已应用，构建产物已跟上`);
