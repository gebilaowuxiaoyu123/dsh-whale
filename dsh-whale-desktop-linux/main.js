'use strict';
/**
 * DSH 小鲸鱼桌面挂件 —— Electron 主进程（自包含 / 本地直连版）
 *
 * 完全本地运行，不依赖 dsh web、也不用打开网页：
 *  - 本地服务（127.0.0.1:3090）自己实现 /dsh-whale/* 全部路由：widget.js、图片、音效都从
 *    本地文件读取；balance.json 直接调 DeepSeek API（读 DEEPSEEK_API_KEY），并本地记账算「今日已用」。
 *  - 无边框、透明、默认不置顶（托盘可开「置顶显示」）的窗口 → 鲸鱼浮在桌面上、可满桌面拖动；
 *    不置顶时普通应用窗口会盖住它，但它仍在桌面图标之上。
 *  - 整窗点击穿透（setIgnoreMouseEvents），仅鲸鱼不透明像素/菜单/气泡接收交互。
 *  - 支持打包成单个 exe（electron-builder portable）；首次运行且未配置 API Key 时自动弹出
 *    配置窗口补齐配置，之后直接显示挂件。
 */
const { app, BrowserWindow, screen, ipcMain, Tray, Menu, Notification } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { startPlugin } = require('./host-shim');

// ============================================================================
// Linux 平台引导（必须在 app ready 之前决定）
// ----------------------------------------------------------------------------
// 以下两条都是 2026-10-02 在本机（Ubuntu 24.04 / GNOME 46 / Wayland / 缩放 2.0）
// 用真实探针实测出来的，不是推测：
//
// 1) `--ozone-platform=x11` 必须作为「命令行参数」传入。
//    在 main.js 里 app.commandLine.appendSwitch() 太晚 —— Chromium 已经选好 Ozone 平台。
//    不强制 XWayland 时会跑原生 Wayland，后果：
//      · 没有 X11 窗口（xwininfo 找不到）→ setShape 不可用
//      · screen.getCursorScreenPoint() 恒返回 (0,0)
//    所以这里用「重启一次自己」的方式把参数补上。
//
// 2) setIgnoreMouseEvents(true, {forward:true}) 在 Linux 上是**空操作**：
//    实测窗口仍收到全部 mousemove，且透明区域的点击**不会穿透**到下层窗口
//    （背景窗 0 次收到点击）→ 一个全屏透明窗会挡住整个桌面的点击。
//    改用 win.setShape(rects)：实测区域外点击可**精确穿透**（背景窗准确收到点击）。
// ============================================================================
const IS_LINUX = process.platform === 'linux';
const OZONE_X11_FLAG = '--ozone-platform=x11';
const MAX_SHAPE_RECTS = 400;   // 上限只作保险丝用；形状宁大勿小（小了会裁掉内容）
const SHAPE_PAD = 30;          // 每个矩形统一外扩（逻辑像素）—— 见 reapplyShape 的说明
const DEBUG_SHAPE = !!process.env.DSHW_DEBUG;

/** 是否需要显式关闭沙箱：AppImage 无法保留 setuid chrome-sandbox，
 *  而 Ubuntu 24.04 默认禁止非特权 user namespace → Chromium 沙箱必然启动失败。 */
function linuxNeedNoSandbox() {
  try {
    const restrict = fs.readFileSync(
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim();
    if (restrict !== '1') return false;                 // 未启用限制 → 沙箱可用
    const sb = path.join(path.dirname(process.execPath), 'chrome-sandbox');
    return (fs.statSync(sb).mode & 0o4000) === 0;       // 无 setuid → 只能靠 userns → 会被拦
  } catch (_e) {
    return false;
  }
}

if (IS_LINUX && !process.argv.includes(OZONE_X11_FLAG)) {
  try {
    const { spawn } = require('child_process');
    const exe = process.env.APPIMAGE || process.execPath;   // AppImage 必须用 APPIMAGE 本体
    const args = process.argv.slice(1)
      .filter((a) => !a.startsWith('--ozone-platform') && a !== '--no-sandbox');
    args.push(OZONE_X11_FLAG);
    // NVIDIA 机器上的预制渲染参数（tools/setup-nvidia.sh 写入 ~/.config/dsh-whale/nvidia.env）。
    // 内核显机器上 DSH_GPU_FLAGS 不存在 → 不追加任何东西，行为与之前一致。
    const gpuFlags = (process.env.DSH_GPU_FLAGS || '').split(/\s+/).filter(Boolean);
    for (const f of gpuFlags) if (!args.includes(f)) args.push(f);
    const noSandbox = linuxNeedNoSandbox();
    if (noSandbox) args.push('--no-sandbox');
    const child = spawn(exe, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DSHW_RELAUNCHED: '1' },
    });
    child.unref();
    console.log(`[dsh-whale] 重启以强制 XWayland：${exe} ${args.join(' ')}` +
      (noSandbox ? '（含 --no-sandbox：本机 userns 受限且无 setuid 沙箱）' : ''));
    app.exit(0);
    process.exit(0);
  } catch (e) {
    console.error('[dsh-whale] 强制 XWayland 失败，将以当前平台继续（可能无法置顶/穿透）：' + e);
  }
}

// 单实例锁：避免第二个实例抢 3090 端口（自启 + 手动启动很容易撞车）
if (!app.requestSingleInstanceLock()) {
  console.log('[dsh-whale] 已有实例在运行，本次退出');
  app.exit(0);
  process.exit(0);
}
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    win.show();
    applyAlwaysOnTop();
  }
});

// ---------- 本地服务端口（支持被占用时回退） ----------
// 3090 是插件的默认端口，但可能被别的程序、或上一次没退干净的实例占用。
// 原来 srv.listen() 不做任何错误处理 —— 端口一被占，整个挂件直接起不来（白屏/无窗口）。
const PORT_CANDIDATES = [3090, 3091, 3092, 3093, 3094, 3095, 3096, 3097, 3098, 0];
let WIDGET_PORT = 3090;

/** 依次尝试候选端口；全被占就让系统随机分配（候选表末尾的 0），保证一定能起来 */
function listenWithFallback(srv, idx = 0) {
  return new Promise((resolve, reject) => {
    const port = PORT_CANDIDATES[Math.min(idx, PORT_CANDIDATES.length - 1)];
    const onErr = (err) => {
      srv.removeListener('error', onErr);
      const retryable = err && (err.code === 'EADDRINUSE' || err.code === 'EACCES');
      if (retryable && idx + 1 < PORT_CANDIDATES.length) {
        console.warn('[dsh-whale] 端口 ' + port + ' 不可用（' + err.code + '），换下一个');
        resolve(listenWithFallback(srv, idx + 1));
        return;
      }
      reject(err);
    };
    srv.once('error', onErr);
    srv.listen(port, '127.0.0.1', () => {
      srv.removeListener('error', onErr);
      const addr = srv.address();
      WIDGET_PORT = (addr && addr.port) || port;
      console.log('[dsh-whale] 本地服务端口 = ' + WIDGET_PORT +
        (port === 3090 ? '' : '（3090 被占用 / 系统分配，已回退）'));
      resolve(WIDGET_PORT);
    });
  });
}
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CRED_FILE = path.join(DSH_HOME, '.credentials.yaml');
const SIZE_FILE = path.join(DSH_HOME, '.dshw-size.json');   // 与插件共用：挂件尺寸/开关配置
// 桌面版自己的窗口行为配置（置顶显示等）。**不能**放进 .dshw-size.json：
// 插件保存设置时是按固定字段整包 PUT 覆盖的，会把这个键抹掉。
const WINDOW_FILE = path.join(DSH_HOME, '.dshw-window.json');
const USAGE_FILE = path.join(DSH_HOME, '.dshw-usage.json'); // 与插件共用：记账账本
const BALANCE_URL = 'https://api.deepseek.com/user/balance';

const WIDGET_JS_FILE = path.join(__dirname, 'widget.js');
const ASSETS_DIR = path.join(__dirname, 'assets');

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin:0; padding:0; width:100%; height:100%; overflow:hidden; background:transparent; }
  /* 供插件前端做「是否处于主聊天界面」自检用的占位节点：不参与布局、不可见、不可交互 */
  #root { position:absolute; top:0; left:0; width:0; height:0; overflow:hidden; }
  #root > textarea { width:0; height:0; opacity:0; border:0; padding:0; margin:0; }
</style>
</head>
<body>
<!-- 插件前端（whale-widget.js）开头有一段页面自检：只在实际的 DSH 主聊天界面（能在 #root 里
     查到 composer 输入区）才挂载挂件，否则不碰 DOM —— 这是为避免干扰 DSH 的 SPA 视图。
     桌面版加载的不是 DSH 页面，因此这里提供一个不可见、不参与布局的等价占位节点让自检通过；
     真正决定挂件外观与行为的是前端自身与其 /dsh-whale/* 接口，不依赖此占位节点。 -->
<div id="root"><textarea readonly aria-hidden="true" tabindex="-1"></textarea></div>
<script src="/dsh-whale/widget.js"></script>
<!-- 桌面版增强层：在不修改 vendored 插件本体的前提下，叠加桌面版特有功能 -->
<script src="/dsh-whale/desktop-enhance.js"></script>
</body>
</html>`;

const FIRST_RUN_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>DSH 小鲸鱼 · 首次配置</title>
<style>
  body { font-family: "Microsoft YaHei", system-ui, sans-serif; background:#f5f7ff; margin:0; padding:24px 28px; color:#203170; }
  h1 { font-size:20px; margin:0 0 6px; }
  p { font-size:13px; color:#536ba9; margin:6px 0 16px; line-height:1.6; }
  label { display:block; font-size:13px; margin:10px 0 4px; font-weight:600; }
  input[type=text] { width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid rgba(32,49,112,.4); border-radius:8px; font-size:13px; }
  .row { display:flex; align-items:center; gap:8px; margin-top:12px; font-size:13px; }
  .btn { width:100%; margin-top:18px; padding:10px; background:#203170; color:#fff; border:none; border-radius:8px; font-size:14px; cursor:pointer; }
  .btn:disabled { opacity:.5; cursor:default; }
  .status { min-height:18px; font-size:12px; margin-top:10px; }
  .ok { color:#1e7d32; } .err { color:#c0392b; }
  .hint { font-size:11px; color:#9fb0d9; margin-top:14px; line-height:1.5; }
</style>
</head>
<body>
  <h1>🐋 DSH 小鲸鱼 · 首次配置</h1>
  <p>这是你第一次运行小鲸鱼桌面挂件。填好下面的 DeepSeek API Key 即可开始，之后随时可在挂件菜单里修改。</p>
  <label>DeepSeek API Key（sk-...）</label>
  <input id="key" type="text" placeholder="sk-..." autocomplete="off" spellcheck="false">
  <div class="row"><input id="auto" type="checkbox" checked> <span>开机自启（登录时自动启动挂件）</span></div>
  <button id="go" class="btn">开始使用</button>
  <div id="status" class="status"></div>
  <div class="hint">配置仅保存在本机：用户目录 \\.dsh\\.credentials.yaml（不会上传到任何地方）。</div>
  <script>
    var btn = document.getElementById('go');
    var key = document.getElementById('key');
    var auto = document.getElementById('auto');
    var status = document.getElementById('status');
    function setStatus(s, cls) { status.textContent = s; status.className = 'status ' + (cls || ''); }
    btn.addEventListener('click', function () {
      var v = key.value.trim();
      if (!v) { setStatus('请先填写 API Key', 'err'); return; }
      btn.disabled = true; setStatus('保存中…');
      fetch('/dsh-whale/apikey', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: v }) })
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (!j || !j.ok) { setStatus('保存失败：' + ((j && j.error) || '未知错误'), 'err'); btn.disabled = false; return; }
          setStatus('API Key 已保存 ✓', 'ok');
          var p = auto.checked
            ? fetch('/dsh-whale/autostart', { method: 'POST' }).then(function (r) { return r.json() })
            : Promise.resolve({ ok: true });
          return p.then(function () {
            setStatus('正在启动挂件…', 'ok');
            return fetch('/dsh-whale/first-run-done', { method: 'POST' });
          });
        })
        .catch(function () { setStatus('网络错误，请重试', 'err'); btn.disabled = false; });
    });
    key.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); btn.click(); } });
  </script>
</body>
</html>`;

// 「更换 API Key」小窗口。为什么单独做一个：挂件菜单里的「密钥/接口」面板对**内置 DeepSeek
// 模型**是死路 —— 插件前端的厂商下拉把内置项排除掉了（`if (apiTemplates[ti].builtin) continue`），
// 而保存时提交的 provider 取自那个下拉，于是必然拿不到 'deepseek' → 保存失败。
// 插件是 vendored 上游原样副本（不改），所以换 key 的入口做在桌面版自己的托盘里。
const KEY_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>DSH 小鲸鱼 · 更换 API Key</title>
<style>
  body { font-family: "Noto Sans CJK SC", "Microsoft YaHei", system-ui, sans-serif; background:#f5f7ff; margin:0; padding:20px 24px; color:#203170; }
  h1 { font-size:18px; margin:0 0 6px; }
  p { font-size:12px; color:#536ba9; margin:6px 0 12px; line-height:1.6; }
  .cur { font-size:12px; background:#e8edff; border-radius:8px; padding:7px 10px; margin:0 0 12px; }
  .cur b { font-family: monospace; }
  label { display:block; font-size:13px; margin:8px 0 4px; font-weight:600; }
  input[type=text], input[type=password] { width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid rgba(32,49,112,.4); border-radius:8px; font-size:13px; font-family: monospace; }
  .row { display:flex; align-items:center; gap:8px; margin-top:8px; font-size:12px; color:#536ba9; }
  .btn { width:100%; margin-top:14px; padding:10px; background:#203170; color:#fff; border:none; border-radius:8px; font-size:14px; cursor:pointer; }
  .btn:disabled { opacity:.5; cursor:default; }
  .btn2 { width:100%; margin-top:8px; padding:8px; background:#e8edff; color:#203170; border:1px solid rgba(32,49,112,.25); border-radius:8px; font-size:12.5px; cursor:pointer; }
  .btn2:disabled { opacity:.5; cursor:default; }
  .status { min-height:18px; font-size:12px; margin-top:8px; }
  .ok { color:#1e7d32; } .err { color:#c0392b; }
  .hint { font-size:11px; color:#9fb0d9; margin-top:10px; line-height:1.5; }
</style>
</head>
<body>
  <h1>🐋 更换 DeepSeek API Key</h1>
  <p>保存后立即生效；按「保存并同步」可让两个桌宠一起用上它，小鲸鱼最晚在下一次刷新（≤ 60 秒，或点一下鲸鱼）用上新令牌。</p>
  <div class="cur" id="cur">状态：读取中…</div>
  <label>新的 API Key（sk-…）</label>
  <input id="key" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false">
  <div class="row"><input id="show" type="checkbox"> <span>显示明文</span></div>
  <button id="go" class="btn">保存并同步到两个桌宠</button>
  <button id="save" class="btn2">只保存到挂件</button>
  <button id="pull" class="btn2">以 Coopanion 为准（拉过来）</button>
  <div id="status" class="status"></div>
  <div class="hint">挂件：用户目录 ~/.dsh/.credentials.yaml　｜　Coopanion：build/data/home/providers/&lt;厂商&gt;/.env（都只在本机）</div>
  <script>
    var el = function (id) { return document.getElementById(id) };
    function setStatus(s, cls) { el('status').textContent = s; el('status').className = 'status ' + (cls || '') }
    function refresh() {
      return fetch('/dsh-whale/key-sync', { cache: 'no-store' }).then(function (r) { return r.json() }).then(function (j) {
        var w = (j.widget && j.widget.masked) || '（未配置）';
        var c = (j.copanion && j.copanion.masked) || '（未配置）';
        var tag = j.inSync ? '<span style="color:#1e7d32">两边一致 ✓</span>' : '<span style="color:#c0392b">两边不一致</span>';
        if (!j.available) tag = '<span style="color:#c0392b">没找到 Coopanion 的 .env</span>';
        el('cur').innerHTML = '挂件：<b>' + w + '</b>　｜　Coopanion：<b>' + c + '</b>　' + tag;
        if (j.lastError) setStatus(j.lastError, 'err');
        return j;
      }).catch(function () { el('cur').textContent = '状态：读取失败' });
    }
    refresh();
    el('show').addEventListener('change', function () { el('key').type = el('show').checked ? 'text' : 'password' });
    function post(url, body) {
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json() });
    }
    function run(btn, label, action) {
      btn.disabled = true; setStatus(label + '…');
      return action().then(function (j) {
        if (!j || !j.ok) { setStatus('失败：' + ((j && (j.lastError || j.error)) || '未知错误'), 'err'); btn.disabled = false; refresh(); return null }
        return refresh().then(function () { return j });
      }).catch(function (e) { setStatus('网络错误：' + e, 'err'); btn.disabled = false; return null });
    }
    function closeSoon() { setTimeout(function () { fetch('/dsh-whale/key-window-done', { method: 'POST' }) }, 700) }
    el('go').addEventListener('click', function () {
      var v = el('key').value.trim();
      if (!v) { setStatus('请先粘贴新的 API Key', 'err'); return }
      if (v.indexOf('sk-') !== 0) { setStatus('格式看起来不对（应以 sk- 开头）', 'err'); return }
      run(el('go'), '保存并同步', function () { return post('/dsh-whale/key-sync/push', { value: v }) }).then(function (j) {
        if (j) { setStatus('两个桌宠都已更新 ✓', 'ok'); closeSoon() }
      });
    });
    el('save').addEventListener('click', function () {
      var v = el('key').value.trim();
      if (!v) { setStatus('请先粘贴新的 API Key', 'err'); return }
      run(el('save'), '保存', function () {
        return fetch('/dsh-whale/apikey', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: v }) }).then(function (r) { return r.json() });
      }).then(function (j) { if (j) { setStatus('已保存到挂件（未同步）', 'ok'); closeSoon() } });
    });
    el('pull').addEventListener('click', function () {
      run(el('pull'), '从 Coopanion 拉取', function () { return post('/dsh-whale/key-sync/pull', {}) }).then(function (j) {
        if (j) setStatus('已把 Coopanion 的 Key 拉到挂件 ✓', 'ok');
      });
    });
    el('key').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); el('go').click() } });
  </script>
</body>
</html>`;

// ---------- 小工具 ----------
function readFileIfExists(p) {
  try { return fs.readFileSync(p); } catch (_e) { return null; }
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_e) { return null; }
}
function writeJson(p, obj) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); } catch (_e) {}
}
// ---------- 「置顶显示」（默认关） ----------
// 关：挂件只是个普通窗口 —— 打开的应用窗口盖在鲸鱼之上，鲸鱼仍在桌面图标之上。
// 开：挂件浮在所有窗口之上（旧行为，看视频/全屏时也会挡在前面）。
// Linux 上窗口类型要跟着一起换：关 → NORMAL，开 → DOCK（DOCK 才能不被 dock 的 intellihide 顶掉）。
function readAlwaysOnTop() {
  const cfg = readJson(WINDOW_FILE) || {};
  return cfg.alwaysOnTop === true;
}
function writeAlwaysOnTop(on) {
  const cfg = readJson(WINDOW_FILE) || {};
  cfg.alwaysOnTop = !!on;
  writeJson(WINDOW_FILE, cfg);
  return cfg.alwaysOnTop;
}
function todayKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}
// 北京时间峰谷判定：工作日高峰 9-12、14-18；周末全天谷价
function isPeakTime() {
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  const day = bj.getUTCDay();
  const hour = bj.getUTCHours();
  if (day === 0 || day === 6) return false;
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}
// 读取 DEEPSEEK_API_KEY：环境变量 > ~/.dsh/.credentials.yaml
function readApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const txt = fs.readFileSync(CRED_FILE, 'utf8');
    const m = txt.match(/^\s*DEEPSEEK_API_KEY\s*:\s*"?([^"\s#]+)"?\s*$/m);
    if (m) return m[1];
  } catch (_e) {}
  return null;
}

// 保存 DEEPSEEK_API_KEY 到 ~/.dsh/.credentials.yaml（保留原结构）
function saveApiKey(value) {
  try {
    const v = String(value == null ? '' : value).trim();
    if (!v) return { ok: false, error: 'key 为空' };
    let txt = '';
    const buf = readFileIfExists(CRED_FILE);
    if (buf) txt = buf.toString('utf8');
    const lineRe = /^[ \t]*DEEPSEEK_API_KEY[ \t]*:[ \t]*[^\r\n]*$/m;
    if (lineRe.test(txt)) {
      txt = txt.replace(lineRe, '  DEEPSEEK_API_KEY: ' + v);
    } else if (/^[ \t]*refs[ \t]*:[ \t]*$/m.test(txt)) {
      txt = txt.replace(/^([ \t]*refs[ \t]*:[ \t]*)$/m, '$1\n  DEEPSEEK_API_KEY: ' + v);
    } else {
      const tail = txt.replace(/\s+$/, '');
      txt = (tail ? tail + '\n\n' : '') + 'version: 1\n\nrefs:\n  DEEPSEEK_API_KEY: ' + v + '\n';
    }
    fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
    fs.writeFileSync(CRED_FILE, txt, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---------- 「同步 API Key」：挂件 ↔ Coopanion 桌宠（**按一下才同步，不按不动**） ----------
// 两个桌宠各存各的令牌：挂件在 ~/.dsh/.credentials.yaml，Coopanion 在
// <Coopanion>/build/data/home/providers/<厂商>/.env（它的 Core 写、我们镜子）。
// 有意做成**显式动作**而不是后台自动同步：在任一边按一下「同步」，两边就都变成同一把 key。
const KEY_SYNC_FILE = path.join(DSH_HOME, '.dshw-key-sync.json');
const COPANION_KEY_NAME = 'DEEPSEEK_API_KEY';

function readKeySync() {
  const cfg = readJson(KEY_SYNC_FILE) || {};
  return { lastSyncAt: cfg.lastSyncAt || null, lastSource: cfg.lastSource || null, lastError: cfg.lastError || null };
}
function writeKeySync(patch) {
  const cfg = readJson(KEY_SYNC_FILE) || {};
  Object.assign(cfg, patch);
  writeJson(KEY_SYNC_FILE, cfg);
  return readKeySync();
}

/** Coopanion 的 provider `.env` 路径：DSHW_COOPANION_ENV 可直接指定，否则按仓库默认布局推断。 */
function coopanionEnvPath() {
  if (process.env.DSHW_COOPANION_ENV) return process.env.DSHW_COOPANION_ENV;
  const root = process.env.DSHW_COOPANION_DIR || path.join(__dirname, '..', 'third-party', 'Coopanion');
  const home = path.join(root, 'build', 'data', 'home');
  let provider = 'deepseek';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'companion', 'config.json'), 'utf8'));
    if (cfg && typeof cfg.activeProvider === 'string' && cfg.activeProvider) provider = cfg.activeProvider;
  } catch (_e) { /* 没装/还没跑过就用默认厂商 */ }
  return path.join(home, 'providers', provider, '.env');
}

/** 从 `NAME=VALUE` 文本里取一个键（Coopanion 的 .env 就是这么存的）。 */
function parseEnvValue(text, name) {
  const m = String(text || '').match(new RegExp('^\\s*' + name + '\\s*=\\s*"?([^"\\r\\n]*)"?\\s*$', 'm'));
  return m ? m[1].trim() : null;
}
/** 把 `NAME=VALUE` 写回文本（保留其它行；没有就追加）。 */
function upsertEnvValue(text, name, value) {
  const re = new RegExp('^\\s*' + name + '\\s*=.*$', 'm');
  const line = name + '=' + value;
  if (re.test(text)) return text.replace(re, line);
  const tail = String(text || '').replace(/\s*$/, '');
  return (tail ? tail + '\n' : '') + line + '\n';
}

function readCoopanionKey() {
  const file = coopanionEnvPath();
  const buf = readFileIfExists(file);
  if (!buf) return { file, key: null, exists: false };
  return { file, key: parseEnvValue(buf.toString('utf8'), COPANION_KEY_NAME), exists: true };
}
function writeCoopanionKey(key) {
  const { file } = readCoopanionKey();
  const cur = readFileIfExists(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, upsertEnvValue(cur ? cur.toString('utf8') : '', COPANION_KEY_NAME, key), 'utf8');
}

/** 同步状态（给界面与自检看；不含明文令牌）。 */
function keySyncStatus() {
  const st = readKeySync();
  const w = readApiKey();
  const c = readCoopanionKey();
  return {
    ok: true,
    available: c.exists,
    widget: { configured: !!w, masked: maskKey(w) },
    copanion: { configured: !!c.key, masked: maskKey(c.key), env: c.file, exists: c.exists },
    inSync: !!w && !!c.key && w === c.key,
    lastSyncAt: st.lastSyncAt,
    lastSource: st.lastSource,
    lastError: st.lastError,
  };
}

/**
 * 【按一下两边都同步】把 `value`（没传就用挂件当前存的那把）**同时**写进两边。
 */
function syncKeyToBoth(value) {
  const key = String(value || '').trim() || readApiKey() || '';
  if (!key) { writeKeySync({ lastError: '两边都没有 key，没东西可同步' }); return keySyncStatus(); }
  saveApiKey(key);
  const c = readCoopanionKey();
  if (!c.exists) { writeKeySync({ lastError: '找不到 Coopanion 的 .env：' + c.file }); return keySyncStatus(); }
  writeCoopanionKey(key);
  writeKeySync({ lastSyncAt: Date.now(), lastSource: 'widget', lastError: null });
  return keySyncStatus();
}

/** 反方向：把 Coopanion 已存的那把拉到挂件（两边归一）。 */
function syncKeyFromCoopanion() {
  const c = readCoopanionKey();
  if (!c.exists) { writeKeySync({ lastError: '找不到 Coopanion 的 .env：' + c.file }); return keySyncStatus(); }
  if (!c.key) { writeKeySync({ lastError: 'Coopanion 那边还没配 key' }); return keySyncStatus(); }
  saveApiKey(c.key);
  writeKeySync({ lastSyncAt: Date.now(), lastSource: 'copanion', lastError: null });
  return keySyncStatus();
}

let win = null;
let firstRunWin = null;
let keyWin = null;
let tray = null;
let quitting = false;

/** 系统托盘图标：提供「显示/隐藏、退出」入口（挂件窗口无边框且不进任务栏）。 */
/**
 * 控制「另一个桌宠」（Live2D 鲸鱼娘）—— 统一走 tools/petctl.sh，不重复实现一套启停逻辑。
 * 为什么用绝对路径候选而不是 __dirname：DSH 挂件以 AppImage 运行，解包目录是
 * /tmp/appimage_extracted_xxx，在那个目录里找不到仓库的 tools/。
 */
function resolvePetctl() {
  const cands = [
    process.env.DSHW_PETCTL,
    path.join(os.homedir(), 'dsh-whale', 'tools', 'petctl.sh'),
    '/home/wukai/dsh-whale/tools/petctl.sh',
  ].filter(Boolean);
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (_e) { /* 忽略 */ }
  }
  return '';
}

function petctlRun(args) {
  const bin = resolvePetctl();
  if (!bin) return Promise.resolve({ ok: false, error: 'petctl.sh 未找到（可用 DSHW_PETCTL 指定路径）' });
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('bash', [bin, ...args], { timeout: 90000 }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim();
      if (err) resolve({ ok: false, error: String(stderr || err.message).slice(0, 200), out });
      else resolve({ ok: true, out });
    });
  });
}

// 渲染进程（增强层）通过 preload 的 dshwBridge 调这两个。
// 注意：petctl 的 status 是**全局**子命令（petctl status），单目标分支只认
// start/stop/restart/toggle —— 传 ['live2d','status'] 会被当成用法错误。
ipcMain.handle('dshw-pet-toggle', async (_e, which) => petctlRun([String(which || 'live2d'), 'toggle']));
ipcMain.handle('dshw-pet-status', async () => petctlRun(['status']));

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'whale.png');
  try {
    tray = new Tray(iconPath);
  } catch (_e) {
    tray = null;
    return;
  }
  tray.setToolTip('DSH 小鲸鱼桌面挂件');
  const menu = Menu.buildFromTemplate([
    {
      label: '显示/隐藏挂件',
      click: () => {
        if (!win || win.isDestroyed()) createWidgetWindow();
        else if (win.isVisible()) win.hide();
        else win.show();
      },
    },
    { type: 'separator' },
    {
      // 关（默认）：应用窗口盖住挂件，挂件仍在桌面图标之上；开：浮在所有窗口之上
      label: '置顶显示',
      type: 'checkbox',
      checked: readAlwaysOnTop(),
      click: (item) => { writeAlwaysOnTop(item.checked); applyAlwaysOnTop(); },
    },
    { type: 'separator' },
    {
      // 与 L2 桌宠（Coopanion 鲸鱼娘）是同一个仓库里的两个独立应用，这里只做“开关”这一个动作
      label: 'Live2D 鲸鱼娘（开 / 关）',
      click: async () => {
        const r = await petctlRun(['live2d', 'toggle']);
        if (!r.ok && Notification.isSupported()) {
          new Notification({ title: '切换 Live2D 桌宠失败', body: r.error || '' }).show();
        }
      },
    },
    { type: 'separator' },
    { type: 'separator' },
    { label: '改 API Key…', click: () => openKeyWindow() },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => {
    if (!win || win.isDestroyed()) createWidgetWindow();
    else if (win.isVisible()) win.hide();
    else win.show();
  });
}

// ---------- 记账：小鲸鱼记账模式（余额差值本地记账） ----------
// 账本 ~/.dsh/.dshw-usage.json 与 DSH 网页版插件（dsh-whale-widget）**共用同一本账**，
// 因此这里的数据格式与语义和插件 lib/accounting.mjs 保持一致：
//   { accounting: { version:1, active, books:{ "<scope>-<币种>": { currency, days:{...}, lastAt } } } }
// 同时继续维护旧版兼容字段（date/lastBalance/todayUsage/history），供旧 UI 与插件读取。
// 注意：切勿整体重建账本对象 —— 那会丢掉插件写入的 accounting.books 历史（跨天/换 key 场景）。
const ACCOUNTING_VERSION = 1;
const MONEY_SCALE = 100000000; // 8 位小数定点记账，避免浮点误差

// 账本日期一律按北京时间（与插件 beijingDay 对齐）
function beijingDay(t) {
  const d = new Date(Number(t == null ? Date.now() : t) + 8 * 3600000);
  return d.toISOString().slice(0, 10);
}
function moneyUnits(v) {
  const n = Number(v);
  const units = Math.round(n * MONEY_SCALE);
  if (!Number.isFinite(n) || !Number.isSafeInteger(units)) throw new Error('金额无效或超出可记账范围');
  return units;
}
// 账户标识：与插件一致 —— sha256(API key) 前 24 位十六进制。同一把 key 即同一本账。
function ledgerScope(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 24);
}
function observedUnits(row) {
  const c = row.correction;
  return c ? c.amountUnits + row.debitUnits - c.debitUnits : row.debitUnits;
}
// 记录一次余额观测（原地修改 ledger），返回「今日已用」金额
function observeBalance(ledger, snapshot) {
  const at = Number(snapshot.at == null ? Date.now() : snapshot.at);
  const day = beijingDay(at);
  const units = moneyUnits(snapshot.balance);
  const currency = String(snapshot.currency || 'CNY').toUpperCase();
  const context = String(snapshot.scope) + '-' + currency;

  let a = ledger.accounting;
  if (!a || a.version !== ACCOUNTING_VERSION) {
    // 旧格式账本：历史数值缺少可信的充值信息，保留到 legacyHistory 供参考，并开启新的观测窗口
    a = ledger.accounting = {
      version: ACCOUNTING_VERSION, active: context, books: {}, migratedAt: at,
      legacyHistory: Object.assign({}, ledger.history || {}),
    };
  }
  if (!a.books) a.books = {};
  let book = a.books[context];
  if (!book) book = a.books[context] = { currency: currency, days: {} };
  if (!book.days) book.days = {};
  // 忽略重复 / 乱序样本（含迟到的昨天样本）
  if (book.lastAt != null && at <= book.lastAt) {
    return Number(ledger.todayUsage || 0);
  }
  a.active = context;

  let row = book.days[day];
  if (!row) {
    row = book.days[day] = {
      day: day, firstAt: at, lastAt: at, openingUnits: units, lastUnits: units,
      debitUnits: 0, creditUnits: 0, revision: 0, correction: null,
    };
  } else {
    const delta = row.lastUnits - units;
    if (delta > 0) row.debitUnits += delta;
    if (delta < 0) row.creditUnits -= delta;
    row.lastUnits = units;
    row.lastAt = at;
  }
  book.lastAt = at;
  book.currency = currency;

  // 兼容字段：旧 UI / 插件的老设置写入器仍会读这些键
  const amount = observedUnits(row) / MONEY_SCALE;
  ledger.date = day;
  ledger.dayStart = row.openingUnits / MONEY_SCALE;
  ledger.lastBalance = row.lastUnits / MONEY_SCALE;
  ledger.lastCurrency = currency;
  ledger.todayUsage = amount;
  if (!ledger.history) ledger.history = {};
  ledger.history[day] = amount;
  return amount;
}

function fetchBalancePayload() {
  return new Promise((resolve) => {
    const key = readApiKey();
    if (!key) return resolve({ ok: false, code: 'NO_KEY', error: '未配置 DEEPSEEK_API_KEY' });
    let attempt = 0;
    const tryFetch = () => {
      attempt++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      fetch(BALANCE_URL, { headers: { Authorization: 'Bearer ' + key }, signal: ctrl.signal })
        .then((res) => { clearTimeout(timer); if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then((j) => {
          const info = j && j.balance_infos && j.balance_infos[0];
          const total = Number(info && info.total_balance);
          const currency = (info && info.currency) || 'CNY';
          if (!isFinite(total)) throw new Error('balance parse failed');
          // 与 DSH 插件共用账本：统一走 observeBalance（格式/语义对齐 accounting.mjs）
          const ledger = readJson(USAGE_FILE) || {};
          let todayUsage;
          try {
            todayUsage = observeBalance(ledger, { balance: total, currency, scope: ledgerScope(key), at: Date.now() });
          } catch (_e) {
            todayUsage = Number(ledger.todayUsage || 0); // 记账异常不影响余额显示
          }
          writeJson(USAGE_FILE, ledger);
          resolve({
            ok: true, totalBalance: total, currency, updatedAt: new Date().toISOString(),
            todayUsage: todayUsage, isPeak: isPeakTime(), usageMode: 'ledger',
          });
        })
        .catch((err) => {
          clearTimeout(timer);
          if (attempt < 2) { setTimeout(tryFetch, 500); return; }
          resolve({ ok: false, code: 'BALANCE_ERR', error: String((err && err.message) || err) });
        });
    };
    tryFetch();
  });
}

function sendFile(res, filePath, contentType, cache = 'no-store') {
  const buf = readFileIfExists(filePath);
  if (!buf) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cache, 'Content-Length': String(buf.length) });
  res.end(buf);
}

// ---------- 插件宿主：直接运行 vendored 的 DSH 插件本体 ----------
// 桌面版与网页版插件共用同一份实现（dsh-whale-widget/lib/index.js），因此：
//   · 功能完全一致：余额/记账/多厂商额度/自定义角色·音效·泡泡图/余额校正…（23 条路由）；
//   · 插件目录是唯一实现来源，以后更新插件桌面版自动同步，不必再逐条适配路由。
// 插件加载失败时**自动回退**到下面本文件内置的路由实现，保证挂件始终可用。
let pluginHost = null;
let pluginLoadPromise = null;

function loadPluginHost() {
  if (pluginLoadPromise) return pluginLoadPromise;
  pluginLoadPromise = startPlugin({
    appDir: __dirname,
    resourcesPath: process.resourcesPath,
    dshHome: DSH_HOME,
    credFile: CRED_FILE,
    logger: console,
  })
    .then((r) => {
      if (r.ok) {
        pluginHost = r.host;
        console.log('[dsh-whale] 已加载插件本体：' + r.entry + '（路由 ' + r.host.routes.size + ' 条）');
      } else {
        console.warn('[dsh-whale] 插件本体加载失败，已回退内置路由实现：' + r.error);
      }
      return r;
    })
    .catch((err) => {
      console.warn('[dsh-whale] 插件本体加载异常，已回退内置路由实现：' + String((err && err.message) || err));
      return { ok: false, error: String(err) };
    });
  return pluginLoadPromise;
}

/** 本地服务：自包含实现 /dsh-whale/* 全部路由（不依赖 dsh web）。 */
// ---------- 增强层：抠图结果的落盘 + 路由 ----------
// 增强层在渲染进程里把「一键抠图」算完（dataURL），通过 preload 暴露的 IPC 送过来落盘，
// 再由本地服务提供出去 —— 这样重启后仍然生效，也不用把大图塞进 localStorage。
let mattedFile = null;
function mattedPath() {
  if (!mattedFile) mattedFile = path.join(app.getPath('userData'), 'dshw-matted.png');
  return mattedFile;
}

ipcMain.handle('dshw-save-matte', async (_e, dataUrl) => {
  try {
    const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
    if (!m) return { ok: false, error: 'bad data url' };
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length < 100) return { ok: false, error: 'too small' };
    fs.writeFileSync(mattedPath(), buf);
    console.log('[dsh-whale] 抠图结果已保存（' + buf.length + ' 字节）');
    return { ok: true, url: '/dsh-whale/matted.png?v=' + Date.now(), bytes: buf.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

function startServer() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1:' + WIDGET_PORT);
    const p = u.pathname;

    // 插件本体优先接管 /dsh-whale/*：未命中的路径再走本文件内置实现
    // （内置部分保留桌面版特有路由：/setup、/dsh-whale/apikey、autostart、first-run-done）
    if (pluginHost) {
      const pluginRoute = pluginHost.routes.get(p);
      if (pluginRoute) {
        Promise.resolve()
          .then(() => pluginRoute.handler(req, res))
          .catch((err) => {
            console.warn('[dsh-whale] 插件路由 ' + p + ' 处理失败: ' + String((err && err.message) || err));
            try {
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('internal error');
              }
            } catch (_e) {}
          });
        return;
      }
    }

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (p === '/dsh-whale/widget.js') {
      const buf = readFileIfExists(WIDGET_JS_FILE);
      if (buf) { res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(buf); }
      else { res.writeHead(404); res.end('missing widget.js'); }
      return;
    }
    if (p === '/dsh-whale/desktop-enhance.js') {
      sendFile(res, path.join(ASSETS_DIR, 'desktop-enhance.js'),
        'application/javascript; charset=utf-8');
      return;
    }
    if (p === '/dsh-whale/image.png') { sendFile(res, path.join(ASSETS_DIR, 'DSniang1.png'), 'image/png'); return; }
    if (p === '/dsh-whale/rua.gif') { sendFile(res, path.join(ASSETS_DIR, 'rua.gif'), 'image/gif'); return; }
    if (p === '/dsh-whale/sound/press.mp3' || p === '/dsh-whale/sound/release.mp3') {
      const set = u.searchParams.get('set') === 'fx1' ? 'fx1' : 'duck';
      const name = p.endsWith('press.mp3')
        ? (set === 'fx1' ? 'D1.mp3' : 'Ya1.mp3')
        : (set === 'fx1' ? 'D2.mp3' : 'Ya2.mp3');
      sendFile(res, path.join(ASSETS_DIR, name), 'audio/mpeg');
      return;
    }
    if (p === '/dsh-whale/balance.json') {
      fetchBalancePayload().then((payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      });
      return;
    }
    if (p === '/dsh-whale/size.json') {
      if (req.method === 'PUT') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
        req.on('end', () => { try { writeJson(SIZE_FILE, JSON.parse(body)); } catch (_e) {} res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
        return;
      }
      const cfg = readJson(SIZE_FILE) || {};
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(cfg));
      return;
    }
    if (p === '/dsh-whale/always-on-top') {
      if (req.method === 'PUT') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
        req.on('end', () => {
          let val = readAlwaysOnTop();
          try { val = !!JSON.parse(body).value; } catch (_e) { /* 非法载荷保持原值 */ }
          writeAlwaysOnTop(val);
          applyAlwaysOnTop();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: true, value: readAlwaysOnTop() }));
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, value: readAlwaysOnTop() }));
      return;
    }
    // 跨源预检：Coopanion 控制台（127.0.0.1:17788）要调这里的 key-sync 接口
    if (req.method === 'OPTIONS' && p.indexOf('/dsh-whale/key-sync') === 0) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }
    if (p === '/dsh-whale/key-sync' || p === '/dsh-whale/key-sync/push' || p === '/dsh-whale/key-sync/pull') {
      // 两个桌宠的 key 同步：GET 看状态；push 把 key 写进两边；pull 以 Coopanion 为准
      const json = (code, obj) => {
        res.writeHead(code, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end(JSON.stringify(obj));
      };
      if (p === '/dsh-whale/key-sync') {
        if (req.method !== 'GET') { json(405, { ok: false, error: 'method not allowed' }); return; }
        json(200, keySyncStatus());
        return;
      }
      if (req.method !== 'POST') { json(405, { ok: false, error: 'method not allowed' }); return; }
      let sbody = '';
      req.on('data', (c) => { sbody += c; if (sbody.length > 65536) req.destroy(); });
      req.on('end', () => {
        let value = '';
        try { value = String((JSON.parse(sbody || '{}') || {}).value || ''); } catch (_e) { /* 空体就是「用现有那把」 */ }
        try {
          json(200, p === '/dsh-whale/key-sync/pull' ? syncKeyFromCoopanion() : syncKeyToBoth(value));
        } catch (e) {
          json(500, { ok: false, error: String((e && e.message) || e), lastError: String((e && e.message) || e) });
        }
      });
      return;
    }
    if (p === '/dsh-whale/apikey') {
      if (req.method === 'PUT') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
        req.on('end', () => {
          let val = '';
          try { val = (JSON.parse(body) || {}).value || ''; } catch (_e) {}
          const r = saveApiKey(val);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(r));
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, configured: !!readApiKey(), masked: maskKey(readApiKey()) }));
      return;
    }
    if (p === '/key') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(KEY_PAGE);
      return;
    }
    if (p === '/dsh-whale/open-key-window' || p === '/dsh-whale/key-window-done') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
        return;
      }
      // 一个开窗、一个关窗：都是桌面版自己的入口，给自动化和截图用
      if (p === '/dsh-whale/open-key-window') openKeyWindow();
      else doneKeyWindow();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (p === '/setup') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIRST_RUN_PAGE);
      return;
    }
    if (p === '/dsh-whale/autostart') {
      if (req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(registerAutoStart()));
        return;
      }
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
      return;
    }
    if (p === '/dsh-whale/first-run-done') {
      if (req.method === 'POST') {
        doneFirstRun();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
      return;
    }
    if (p === '/dsh-whale/matted.png') {
      // 一键抠图的结果（由增强层算好 → IPC 落盘 → 在这里提供）
      try {
        const b = fs.readFileSync(mattedPath());
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
          'Content-Length': String(b.length),
        });
        res.end(b);
      } catch (_e) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('no matte');
      }
      return;
    }
    if (p === '/dsh-whale/last-turn.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: 0 }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  return listenWithFallback(srv);
}

// ---------- 首次运行：自动补齐配置 ----------
function registerAutoStart() {
  try {
    if (!app.isPackaged) return { ok: false, error: '仅打包版本支持开机自启' };
    // AppImage 下 process.execPath 是 /tmp/.mount_xxxx/... 临时挂载点，重启后必然失效，
    // 必须优先用 APPIMAGE（AppImage 运行时自己设置的环境变量）
    const exe = process.env.APPIMAGE || process.execPath;
    // .desktop 的 Exec 转义规则：只对 ", `, $, \\ 做转义
    const q = (s) => '"' + String(s).replace(/(["\\$`])/g, '\\$1') + '"';
    if (process.platform === 'linux') {
      // Linux: XDG autostart（~/.config/autostart/*.desktop）
      const autostartDir = path.join(os.homedir(), '.config', 'autostart');
      fs.mkdirSync(autostartDir, { recursive: true });
      const desktopFile = path.join(autostartDir, 'dsh-whale-widget.desktop');
      const content = [
        '[Desktop Entry]',
        'Type=Application',
        'Name=DSH Whale Widget',
        'Comment=DeepSeek 余额小鲸鱼桌面挂件',
        // 自启也要带上 --ozone-platform=x11，否则开机后跑原生 Wayland：无置顶、无穿透
        'Exec=' + q(exe) + ' --ozone-platform=x11' +
          (linuxNeedNoSandbox() ? ' --no-sandbox' : ''),
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
      ].join('\n') + '\n';
      fs.writeFileSync(desktopFile, content, 'utf8');
      return { ok: true };
    }
    // Windows: Startup 文件夹快捷方式
    const startupDir = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const lnk = path.join(startupDir, 'DSH Whale Widget.lnk');
    const ps = "$ws=New-Object -ComObject WScript.Shell;$s=$ws.CreateShortcut('" + lnk + "');$s.TargetPath='" + exe + "';$s.WorkingDirectory='" + path.dirname(exe) + "';$s.Save()";
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'ignore', timeout: 20000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function createFirstRunWindow() {
  firstRunWin = new BrowserWindow({
    width: 470,
    height: 430,
    resizable: false,
    autoHideMenuBar: true,
    title: 'DSH 小鲸鱼 · 首次配置',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  firstRunWin.loadURL(`http://127.0.0.1:${WIDGET_PORT}/setup`);
  firstRunWin.on('closed', () => { firstRunWin = null; if (!win && !quitting) app.quit(); });
}

function doneFirstRun() {
  if (firstRunWin && !firstRunWin.isDestroyed()) firstRunWin.close();
  firstRunWin = null;
  createWidgetWindow();
}

/** API Key 打码显示（只留前缀与后 4 位，用于让用户确认当前用的是哪把）。 */
function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  return s.length > 12 ? s.slice(0, 7) + '******' + s.slice(-4) : '******';
}

/** 换 API Key 的小窗口（托盘入口）；关掉不退出程序。 */
function raiseKeyWindow() {
  if (!keyWin || keyWin.isDestroyed()) return;
  try {
    // 焦点被别的窗口占着时（X11/Wayland），把窗口提到最前，别让用户以为按钮没反应
    keyWin.setAlwaysOnTop(true);
    keyWin.show();
    keyWin.focus();
    keyWin.setAlwaysOnTop(false);
  } catch (_e) { /* 提不上来也不影响保存 */ }
}

function openKeyWindow() {
  if (keyWin && !keyWin.isDestroyed()) { raiseKeyWindow(); return; }
  keyWin = new BrowserWindow({
    width: 470,
    height: 480,
    resizable: false,
    autoHideMenuBar: true,
    title: 'DSH 小鲸鱼 · 更换 API Key',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  keyWin.once('ready-to-show', () => raiseKeyWindow());
  keyWin.on('closed', () => { keyWin = null; });
  keyWin.loadURL(`http://127.0.0.1:${WIDGET_PORT}/key`);
}

function doneKeyWindow() {
  if (keyWin && !keyWin.isDestroyed()) keyWin.close();
  keyWin = null;
}

/** 把「置顶显示」应用到当前挂件窗口（托盘开关、HTTP 路由都会调它）。 */
function applyAlwaysOnTop() {
  if (!win || win.isDestroyed()) return;
  const on = readAlwaysOnTop();
  try {
    if (on) win.setAlwaysOnTop(true, 'screen-saver');
    else win.setAlwaysOnTop(false);
    if (IS_LINUX) win.setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: true });
  } catch (_e) { /* 切换失败不影响使用 */ }
  if (IS_LINUX) applyLinuxOverlayHints();
  console.log('[dsh-whale] 置顶显示 = ' + on);
}

function createWidgetWindow() {
  // 覆盖整个桌面：所有显示器的可用区域合并，让鲸鱼可以满桌面拖动
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  const left = Math.min(...areas.map((a) => a.x));
  const top = Math.min(...areas.map((a) => a.y));
  const right = Math.max(...areas.map((a) => a.x + a.width));
  const bottom = Math.max(...areas.map((a) => a.y + a.height));

  win = new BrowserWindow({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: readAlwaysOnTop(),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    title: 'DSH Whale Desktop',
    webPreferences: {
      // Linux 用专用 preload：forward 在 Linux 失效，改由它上报「可见矩形」给 setShape
      preload: path.join(__dirname, IS_LINUX ? 'preload-linux.js' : 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(readAlwaysOnTop(), 'screen-saver');
  winW = right - left;
  winH = bottom - top;
  lastShapeKey = '';
  if (IS_LINUX) {
    // Linux 不调用 setIgnoreMouseEvents：实测在 Linux 上它是空操作，还会让透明窗挡住整个桌面。
    // 先保持整窗可交互（保证一定看得见、点得到），等 preload 上报矩形后用 setShape 精确收窄。
    win.setIgnoreMouseEvents(false);
    // 让 Shell 把我们当成「覆盖层」而不是「占满桌面的普通应用程序窗口」
    win.setSkipTaskbar(true);
    try { win.setVisibleOnAllWorkspaces(readAlwaysOnTop(), { visibleOnFullScreen: true }); } catch (_e) {}
  } else {
    // Windows / macOS：官方支持的 forward 逐像素方案（由 preload 的 mousemove 实时切换）
    win.setIgnoreMouseEvents(true, { forward: true });
  }
  if (process.env.DSHW_DEBUG) {
    // 便于验证注入的增强层/preload 是否真的跑起来（渲染进程 console 转发到主进程）
    win.webContents.on('console-message', (...args) => {
      const d = args[1];
      const msg = (d && typeof d === 'object' && 'message' in d) ? d.message : args[2];
      if (typeof msg === 'string' &&
          (msg.includes('[dshw-enhance]') || msg.includes('[dshw-preload]')))
        console.log('[renderer] ' + msg);
    });
  }
  win.loadURL(`http://127.0.0.1:${WIDGET_PORT}/`);
  win.on('closed', () => { win = null; });
  if (IS_LINUX) {
    // 窗口显示后再改类型（Mutter 在映射时会读 _NET_WM_WINDOW_TYPE，
    // 晚到的修改不一定会重新生效，所以必要时来一次 hide→show 强制重读）
    win.once('ready-to-show', () => {
      setTimeout(() => applyLinuxOverlayHints(), 300);
    });
  }
  console.log('[dsh-whale] window bounds = ' + JSON.stringify(win.getBounds()) +
    (IS_LINUX ? `  [linux/setShape 模式, winH=${winH}]` : '  [forward 模式]'));
}

// ---------- Linux：把窗口伪装成 dock 类型的覆盖层 ----------
// 为什么必须这么做（2026-10-02 实机取证）：
//   本机 dock 在底部，且 autohide=true / intellihide=true / intellihide-mode=ALL_WINDOWS ——
//   语义就是「只要有窗口压到 dock 区域，dock 就自动隐藏」。
//   而我们的窗口是**普通类型**、全屏置顶的窗口（_NET_WM_WINDOW_TYPE_NORMAL），于是：
//     · dock 被它一直顶掉 —— 开机不显示、关掉所有窗口也不回来（点一下桌面才恢复）
//     · ding（桌面图标）把它当成遮挡窗口，桌面图标的刷新/交互也跟着不正常
//   改成 _NET_WM_WINDOW_TYPE_DOCK 之后：
//     · dash-to-dock 的 intellihide 必须忽略 dock 类型窗口（否则它自己也会把自己藏起来）
//     · dock 类型天然位于普通窗口之上，不进任务栏也不进概览，也不抢焦点
//     · Shell 不再把它当作「一个占满桌面的普通应用窗口」
//   注意：只改**窗口类型**；_NET_WM_STATE 留给 Electron 自己管，避免两边打架。
//
//   「置顶显示」关着的时候反而**不能**用 DOCK —— dock 类型天然在普通窗口之上，
//   会让挂件又盖住应用窗口。此时用 NORMAL，代价是本机 autohide dock 可能被这个
//   铺满工作区的窗口顶掉（介意就把「置顶显示」打开）。
function applyLinuxOverlayHints() {
  if (!IS_LINUX || !win || win.isDestroyed()) return;
  const on = readAlwaysOnTop();
  let xid = 0;
  try {
    const h = win.getNativeWindowHandle();
    xid = h.length >= 8 ? Number(h.readBigUInt64LE(0)) : h.readUInt32LE(0);
  } catch (_e) {
    return;
  }
  if (!xid) return;
  const id = '0x' + xid.toString(16);
  let execFile;
  try {
    execFile = require('child_process').execFile;
  } catch (_e) {
    return;
  }
  const q = (args, cb) => execFile('xprop', args, (err, out) => cb && cb(err, out));
  const type = on ? '_NET_WM_WINDOW_TYPE_DOCK' : '_NET_WM_WINDOW_TYPE_NORMAL';
  const setType = () => q(['-id', id, '-f', '_NET_WM_WINDOW_TYPE', '32a',
    '-set', '_NET_WM_WINDOW_TYPE', type]);
  setType();
  // 确认是否生效；没生效就 hide→show 一次强制 Mutter 重读
  setTimeout(() => {
    q(['-id', id, '_NET_WM_WINDOW_TYPE'], (err, out) => {
      const got = String(out || '');
      const ok = !err && (on ? /DOCK/.test(got) : /NORMAL/.test(got));
      if (ok) {
        console.log(on
          ? '[dsh-whale] 窗口类型已设为 DOCK（置顶：dock 的 intellihide 会忽略我们）'
          : '[dsh-whale] 窗口类型已设为 NORMAL（不置顶：普通应用窗口会盖住挂件）');
        return;
      }
      try {
        if (!win || win.isDestroyed()) return;
        win.hide();
        setType();
        setTimeout(() => {
          try { if (win && !win.isDestroyed()) win.show(); } catch (_e) {}
        }, 120);
        console.log('[dsh-whale] 窗口类型需重映射，已 hide→show 重新应用');
      } catch (_e) { /* 忽略 */ }
    });
  }, 900);
}

// ---------- 点击穿透：Linux 用 setShape，Windows/macOS 用官方 forward ----------
let winW = 0;
let winH = 0;
let lastShapeKey = '';
let shapeWarned = false;
let domRects = [];        // preload 上报的「可见矩形」（DOM 启发式结果）

// ---------- 像素兜底形状 ----------
// 为什么必须有这一层：
//   `setShape` 在 Linux 上走 X11 **ShapeBounding**，它**同时裁剪绘制与输入** ——
//   形状漏掉哪块像素，那块就**直接被裁掉看不见**。
//   而 preload 上报的矩形是「DOM 启发式」推断的：
//     · paints() 判断某元素"有没有画东西"会漏（比如插件的气泡是用 SVG 画的，
//       元素自身 background 是 transparent、又没有直接文本子节点 → 被判为没画东西）
//     · 元素的阴影 / 伪元素 / 溢出内容会超出自己的盒模型
//     · 数量上限（MAX_RECTS / MAX_SHAPE_RECTS）会直接截断
//   任何一条命中，用户看到的就是「泡泡被切掉一块」。
//
//   所以这里再加一层**从页面真实渲染结果反推**的形状：抓一帧 → 找不透明像素 →
//   合并成矩形。它只做**并集**（只增不减），因此永远不会把形状缩到比 DOM 结果更小，
//   原理上不可能造成新的裁切；最坏情况只是"少一点点点击穿透"。
const PIXEL_SCALE = 4;          // 降采样倍数（4 逻辑像素一格，够用且快）
const PIXEL_INTERVAL = 400;     // 反推间隔 ms
const PIXEL_ALPHA = 8;          // 不透明阈值（0-255）
const PIXEL_PAD = 10;           // 每块外扩，宁大勿小
let pixelRects = [];
let pixelTimer = null;
let pixelBusy = false;
let pixelStat = '';
let pixelEmpty = 0;          // 连续空帧计数
let pixelDisabled = false;   // 该平台抓不到内容 → 自动退避（不再白耗 CPU）

/** 取第 y 行所有不透明连续段（相邻段间隔 ≤ gap 的合并，减少矩形数） */
function runsOfRow(bmp, w, y, alphaMin, gap) {
  const runs = [];
  let x = 0;
  while (x < w) {
    if (bmp[(y * w + x) * 4 + 3] <= alphaMin) { x++; continue; }
    const x0 = x;
    while (x < w && bmp[(y * w + x) * 4 + 3] > alphaMin) x++;
    const x1 = x - 1;
    const last = runs[runs.length - 1];
    if (last && x0 - last[1] <= gap) last[1] = x1;
    else runs.push([x0, x1]);
  }
  return runs;
}

/** 位图 → 矩形（逐行扫描 + 相邻行同段纵向合并成带） */
function rectsFromImage(image) {
  const size = image.getSize();
  const w = size.width;
  const h = size.height;
  if (!w || !h) return [];
  const bmp = image.toBitmap();
  let bands = [];
  for (let y = 0; y < h; y++) {
    const runs = runsOfRow(bmp, w, y, PIXEL_ALPHA, 3);
    const next = [];
    for (const [x0, x1] of runs) {
      let hit = null;
      for (const b of bands) {
        if (b.y1 === y && x0 <= b.x1 + 3 && x1 >= b.x0 - 3) { hit = b; break; }
      }
      if (hit) {
        hit.y1 = y + 1;
        hit.x0 = Math.min(hit.x0, x0);
        hit.x1 = Math.max(hit.x1, x1);
        next.push(hit);
      } else {
        next.push({ y0: y, y1: y + 1, x0, x1 });
      }
    }
    bands = next;
  }
  return bands.map((b) => ({
    x: b.x0 * PIXEL_SCALE,
    y: b.y0 * PIXEL_SCALE,
    width: (b.x1 - b.x0 + 1) * PIXEL_SCALE,
    height: (b.y1 - b.y0) * PIXEL_SCALE,
  }));
}

async function refreshPixelShape() {
  if (pixelBusy || pixelDisabled || !IS_LINUX || !win || win.isDestroyed()) return;
  pixelBusy = true;
  try {
    const img = await win.webContents.capturePage();
    if (!img || img.isEmpty()) return;
    const full = img.getSize();
    const small = img.resize({ width: Math.max(1, Math.round(full.width / PIXEL_SCALE)) });
    const rects = rectsFromImage(small);
    if (!rects.length) {
      // 透明窗口在本机（Wayland + XWayland 透明窗）capturePage 会拿到**全透明帧**，
      // 这条路就走不通。连续几帧都空就直接关掉，避免每 400ms 白扫一遍位图。
      if (++pixelEmpty >= 3 && !pixelDisabled) {
        pixelDisabled = true;
        if (DEBUG_SHAPE) console.log('[dsh-whale] capturePage 拿不到内容 → 像素兜底已停用（只靠 DOM 上报）');
      }
      return;
    }
    pixelEmpty = 0;
    pixelRects = rects.map((r) => ({
      x: Math.max(0, r.x - PIXEL_PAD),
      y: Math.max(0, r.y - PIXEL_PAD),
      width: r.width + PIXEL_PAD * 2,
      height: r.height + PIXEL_PAD * 2,
    }));
    if (DEBUG_SHAPE) {
      const area = (a) => a.reduce((s, r) => s + r.width * r.height, 0);
      const msg = `[dsh-whale] 像素兜底形状：${pixelRects.length} 块，面积 ${area(pixelRects)}` +
        `（DOM 上报 ${domRects.length} 块 / 面积 ${area(domRects)}）`;
      if (msg !== pixelStat) {
        pixelStat = msg;
        console.log(msg);
      }
    }
    lastShapeKey = '';        // 强制重算
    reapplyShape();
  } catch (_e) {
    /* 忽略：抓帧失败就用 DOM 结果 */
  } finally {
    pixelBusy = false;
  }
}

function startPixelShape() {
  if (pixelTimer || !IS_LINUX) return;
  pixelTimer = setInterval(refreshPixelShape, PIXEL_INTERVAL);
  if (pixelTimer.unref) pixelTimer.unref();
}

/** 两个矩形集合取并集：丢掉被更大矩形完全包住的（保持形状紧凑） */
function unionRects(a, b) {
  const sorted = a.concat(b).sort((p, q) => q.width * q.height - p.width * p.height);
  const keep = [];
  for (const r of sorted) {
    const covered = keep.some((k) =>
      r.x >= k.x && r.y >= k.y &&
      r.x + r.width <= k.x + k.width && r.y + r.height <= k.y + k.height);
    if (!covered) keep.push(r);
  }
  return keep;
}

/** Linux：把「当前所有可见内容的矩形」交给 X11 形状 —— 区域内可点、区域外点击精确穿透 */
function applyInputShape(rects) {
  domRects = Array.isArray(rects) ? rects : [];
  startPixelShape();
  reapplyShape();
}

function reapplyShape() {
  if (!IS_LINUX || !win || win.isDestroyed() || !winW || !winH) return;
  const merged = unionRects(domRects, pixelRects);
  if (!merged.length) return;

  const out = [];
  for (const r of merged) {
    if (!r) continue;
    // ⚠️ 形状宁大勿小（2026-10-02 实机对拍定位）：
    //   setShape 走 X11 ShapeBounding，**同时裁剪绘制** —— 矩形比实际内容小一点点，
    //   那一点就被直接切掉（实机表现为插件气泡右侧被切掉约 30px、圆角变成直角）。
    //   而矩形来源是各元素的盒模型 / 凸包近似，天然比真实绘制范围小。
    //   所以统一外扩 SHAPE_PAD：多出来的部分只是"少一点点点击穿透"，
    //   少掉的却是"内容被切"—— 两害相权取其轻。
    let x = Math.round(r.x) - SHAPE_PAD;
    let y = Math.round(r.y) - SHAPE_PAD;
    let w = Math.round(r.width) + SHAPE_PAD * 2;
    let h = Math.round(r.height) + SHAPE_PAD * 2;
    if (w < 1 || h < 1) continue;
    if (x + w < 0 || y + h < 0 || x > winW || y > winH) continue;
    x = Math.max(0, x); y = Math.max(0, y);
    out.push({
      x, y,
      width: Math.min(Math.max(w, 0), winW - x),
      height: Math.min(Math.max(h, 0), winH - y),
    });
    if (out.length >= MAX_SHAPE_RECTS) break;
  }
  if (!out.length) return;

  // 形状没变就不重复调用（X11 每次 setShape 都要重算一遍形状）
  const key = out.map((r) => `${r.x},${r.y},${r.width},${r.height}`).join(';');
  if (key === lastShapeKey) return;
  lastShapeKey = key;

  try {
    win.setShape(out);
    // ⚠️ 关键修复（2026-10-02 实机对拍定位）：
    //   setShape 扩大窗口的 X11 形状后，**新纳入的那部分区域 Chromium 从来没绘制过**，
    //   在透明窗上就会露出合成器的“空白底色” —— 实机表现为气泡/鲸鱼旁边一块**白块**
    //   （用 Page.captureScreenshot 的页面真实渲染 vs xwd 抓的窗口实际像素对拍出来的：
    //    页面那一块是透明背景，窗口那一块是白的）。
    //   强制把整窗标记为脏区重绘一遍，透明处会被重新画成 alpha=0，白块消失。
    try {
      win.webContents.invalidate();
    } catch (_e) { /* 忽略 */ }
  } catch (e) {
    if (!shapeWarned) {
      shapeWarned = true;
      console.error('[dsh-whale] setShape 失败，退回「整窗可交互」（点击不会穿透，但功能可用）：' + e);
    }
  }
}

// Windows / macOS：forward 逐像素方案（preload 用 mousemove 通知是否悬停在可交互区）
ipcMain.on('whale-hover', (_e, over) => {
  if (IS_LINUX || !win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(!over, { forward: true });
});

// Linux：preload 上报「当前所有可见内容」的矩形，主进程交给 setShape
ipcMain.on('whale-input-rects', (_e, rects) => applyInputShape(rects));

// 自检（仅 DSHW_DEBUG 时 preload 会上报）：形状是否完整覆盖鲸鱼包围盒。
// setShape 走的是 X11 ShapeBounding，会**同时裁剪绘制** —— 覆盖不全鲸鱼就会被切掉。
ipcMain.on('whale-debug-shape', (_e, info) => {
  try {
    if (!info || !info.whale || !Array.isArray(info.rects))
      return;
    const w = info.whale;
    let miss = 0;
    let total = 0;
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 10; j++) {
        const x = w.x + ((i + 0.5) * w.w) / 20;
        const y = w.y + ((j + 0.5) * w.h) / 10;
        total++;
        const hit = info.rects.some((r) =>
          x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
        if (!hit) miss++;
      }
    }
    const pct = (100 * (total - miss)) / total;
    const oTotal = info.opaqueTotal || 0;
    const oMiss = info.opaqueMiss || 0;
    const oPct = oTotal ? (100 * (oTotal - oMiss)) / oTotal : null;
    console.log(`[dsh-whale][自检] 包围盒覆盖 ${pct.toFixed(1)}%（漏 ${miss}/${total}）` +
      ` | 不透明像素覆盖 ${oPct === null ? 'n/a' : oPct.toFixed(1) + '%'}（漏 ${oMiss}/${oTotal}）` +
      ` | pad=${info.pad} 矩形数=${info.rects.length}`);
    if (oTotal && oMiss === 0)
      console.log('[dsh-whale][自检] ✅ 所有可见像素都在形状内 → 不会被裁切');
  } catch (e) { /* 忽略 */ }
});

app.whenReady().then(async () => {
  // 先加载插件本体，保证挂件发出的第一个请求就能命中插件路由
  await loadPluginHost();
  // 等端口就绪再开窗口：URL 里用的是 WIDGET_PORT，回退后的端口才能被用上
  await startServer();
  createTray();
  // 首次运行：未配置 API Key 时先弹出配置窗口自动补齐，否则直接显示挂件
  if (readApiKey()) createWidgetWindow();
  else createFirstRunWindow();
});

// 挂件常驻托盘：窗口被关闭时不退出，仅通过托盘「退出」显式结束
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});
