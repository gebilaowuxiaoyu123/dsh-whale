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
  "sync: '随刷新率'", '随刷新率', 'ctl.hz',
]);
check(join(PET, 'web', 'pet-core.js'), '刷新率读数与速度缩放', [
  'readHz', 'SYNC_MIN', 'SYNC_MAX', 'get hz()', 'syncK',
]);
check(join(PET, 'web', 'pet-core.js'), '刷新率相关图标', ['roam_sync', 'hz: icon(']);
check(join(PET, 'src', 'config.ts'), '配置 schema 接受 sync', ["enum: ['free', 'calm', 'off', 'sync']"]);
check(join(ROOT, 'console', 'features', 'pet', 'index.ts'), '控制台「习惯」页有这一项（随刷新率）', ["{ value: 'sync', label: S.roamSync }"]);

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

/* ---------- 4. 「置顶显示」开关 ---------- */
check(join(PET, 'src', 'config.ts'), '配置 schema 有「置顶显示」（默认开，与上游一致）', [
  'alwaysOnTop', '置顶显示', 'alwaysOnTop: true',
]);
check(join(PET, 'src', 'window-host.ts'), '窗口进程命令行带上置顶开关', ['--always-on-top=']);
check(join(PET, 'src', 'world.ts'), '快照把开关广播给页面', ['alwaysOnTop: this.cfg.window.alwaysOnTop === true']);
check(join(PET, 'host', 'electron-main.cjs'), '窗口进程能收开关并实时切换（含 Linux 的 NORMAL 回退）', [
  'pet:alwaysOnTop', 'applyOnTop', '_NET_WM_WINDOW_TYPE_NORMAL', '--always-on-top=',
]);
check(join(PET, 'host', 'preload.cjs'), '页面 preload 暴露 setAlwaysOnTop', ['setAlwaysOnTop']);
check(join(PET, 'web', 'pet-app.js'), '页面收到 prefs 后应用置顶设置', ['host?.setAlwaysOnTop?.(p.alwaysOnTop)']);
check(join(ROOT, 'app', 'main.cjs'), '桌宠子进程把开关透传给 runPetHost', ["alwaysOnTop: arg('always-on-top') !== '0'"]);
check(join(ROOT, 'console', 'features', 'pet', 'index.ts'), '控制台「习惯」页有置顶开关', [
  'alwaysOnTop: `${K}.window.alwaysOnTop`', "ui.checkbox('置顶显示'", 'alwaysOnTopRow,',
]);

/* ---------- 5. 「开始」页上与 DSH 挂件一键同步 Key ---------- */
check(join(ROOT, 'console', 'features', 'home', 'index.ts'), '「开始」页有与挂件同步的按钮', [
  'dsh-whale/key-sync/',
  "const syncKey = ui.button('与 DSH 挂件同步'",
  'keyRow.append(modelField, keyField, modelList, save, syncKey)',
  'syncKey.addEventListener',
]);
check(join(ROOT, 'console', 'features', 'home', 'index.ts'), '按钮一按两边都同步（填了推、留空拉）', [
  "'push' : 'pull'", 'JSON.stringify(typed ? { value: typed } : {})', 'connectVendor(call, vendor, typed',
]);

/* ---------- 6. 悬停按钮「测试刷新率」 ---------- */
check(join(ROOT, 'packages', 'cortico-world-desktop-pet', 'src', 'config.ts'), '配置里认这个动作', [
  "'chat', 'voice', 'roam', 'hz', 'theme', 'sound', 'dress', 'hide'",
]);
check(join(PET, 'web', 'pet-app.js'), '悬停按钮里有它，点一下就跑', [
  'icon: () => ICONS.hz', '横穿桌面来回跑两趟，量出屏幕的刷新率', 'void runHzTest()', 'body.hzScan({ legs: 4 })',
]);
check(join(PET, 'web', 'pet-app.js'), '跑完冒气泡说完成，再慢悠悠回原位', [
  '测试完成 · 屏幕约', '实测 ${r.raw.toFixed(1)} Hz', "openBubble('say'", 'body?.walk(r.x0, false, 0)', 'ctl.holdRoam(30)',
]);
  check(join(PET, 'web', 'pet-core.js'), '测速探针 + 一帧一步 + 段序', [
  'HZ_SCAN_LEGS', 'function probeHz()', 'function snapHz(', 'function stepHzScan(',
  'get scanning()', 'hzPinned',
]);
check(join(ROOT, 'console', 'features', 'pet', 'index.ts'), '控制台「悬停按钮」里能勾它', ["['hz', 'hz']"]);
check(join(ROOT, 'console', 'features', 'pet', 'index.ts'), '「测试刷新率」有标签文案', ["hz: '测试刷新率'"]);

/* ---------- 7. 构建产物跟上没有 ---------- */
{
  const webRoot = join(ROOT, 'build', 'cortico', 'dist', 'web');
  const main = existsSync(webRoot) ? readdirSync(webRoot).find((f) => /^main-.*\.js$/.test(f)) : null;
  ok('控制台页面已构建', !!main, main ? '' : `没找到 ${webRoot}/main-*.js`);
  if (main) {
    // esbuild 默认把非 ASCII 转成 \uXXXX
    const text = readFileSync(join(webRoot, main), 'utf8');
    ok('构建产物里有「随刷新率」', text.includes('\\u968F\\u5237\\u65B0\\u7387') || text.includes('随刷新率'),
      '补丁打了但没重新构建：跑 pnpm --dir <Coopanion> run build:cortico');
    ok('构建产物里有「置顶显示」', text.includes('\\u7F6E\\u9876\\u663E\\u793A') || text.includes('置顶显示'),
      '补丁打了但没重新构建：跑 pnpm --dir <Coopanion> run build:cortico');
    ok('构建产物里有「与 DSH 挂件同步」', text.includes('\\u4E0E DSH \\u6302\\u4EF6\\u540C\\u6B65') || text.includes('与 DSH 挂件同步'),
      '补丁打了但没重新构建：跑 pnpm --dir <Coopanion> run build:cortico');
    ok('构建产物里有挂件同步接口地址', text.includes('127.0.0.1:3090'),
      '补丁打了但没重新构建：跑 pnpm --dir <Coopanion> run build:cortico');
    ok('构建产物里有「测试刷新率」', text.includes('\\u6D4B\\u8BD5\\u5237\\u65B0\\u7387') || text.includes('测试刷新率'),
      '补丁打了但没重新构建：跑 pnpm --dir <Coopanion> run build:cortico');
  }
}
ok('桌宠面板 bundle 已构建', existsSync(join(PET, 'dist', 'console.js')));

/* ---------- 8. 补丁文件与工作区一致 ---------- */
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

/* ---------- 9. 没漏调试插桩 ---------- */
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
