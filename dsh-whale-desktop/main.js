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
const { app, BrowserWindow, screen, ipcMain, Tray, Menu } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { startPlugin } = require('./host-shim');

const WIDGET_PORT = 3090; // 本挂件本地服务端口
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
  body { font-family: "Microsoft YaHei", system-ui, sans-serif; background:#f5f7ff; margin:0; padding:20px 24px; color:#203170; }
  h1 { font-size:18px; margin:0 0 6px; }
  p { font-size:12px; color:#536ba9; margin:6px 0 12px; line-height:1.6; }
  .cur { font-size:12px; background:#e8edff; border-radius:8px; padding:7px 10px; margin:0 0 12px; }
  .cur b { font-family: Consolas, monospace; }
  label { display:block; font-size:13px; margin:8px 0 4px; font-weight:600; }
  input[type=text], input[type=password] { width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid rgba(32,49,112,.4); border-radius:8px; font-size:13px; font-family: Consolas, monospace; }
  .row { display:flex; align-items:center; gap:8px; margin-top:8px; font-size:12px; color:#536ba9; }
  .btn { width:100%; margin-top:14px; padding:10px; background:#203170; color:#fff; border:none; border-radius:8px; font-size:14px; cursor:pointer; }
  .btn:disabled { opacity:.5; cursor:default; }
  .status { min-height:18px; font-size:12px; margin-top:8px; }
  .ok { color:#1e7d32; } .err { color:#c0392b; }
  .hint { font-size:11px; color:#9fb0d9; margin-top:10px; line-height:1.5; }
</style>
</head>
<body>
  <h1>🐋 更换 DeepSeek API Key</h1>
  <p>保存后立即生效；小鲸鱼最晚在下一次刷新（≤ 60 秒，或点一下鲸鱼）用上新令牌。</p>
  <div class="cur" id="cur">当前：读取中…</div>
  <label>新的 API Key（sk-…）</label>
  <input id="key" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false">
  <div class="row"><input id="show" type="checkbox"> <span>显示明文</span></div>
  <button id="go" class="btn">保存并关闭</button>
  <div id="status" class="status"></div>
  <div class="hint">保存位置：用户目录 \\.dsh\\.credentials.yaml 里的 DEEPSEEK_API_KEY（只在本机，不会上传）。</div>
  <script>
    var el = function (id) { return document.getElementById(id) };
    fetch('/dsh-whale/apikey', { cache: 'no-store' }).then(function (r) { return r.json() }).then(function (j) {
      el('cur').innerHTML = '当前：<b>' + ((j && j.masked) || '（未配置）') + '</b>' + ((j && j.configured) ? '' : ' <span style="color:#c0392b">还没配过</span>');
    }).catch(function () { el('cur').textContent = '当前：（读取失败）' });
    el('show').addEventListener('change', function () { el('key').type = el('show').checked ? 'text' : 'password' });
    function setStatus(s, cls) { el('status').textContent = s; el('status').className = 'status ' + (cls || '') }
    el('go').addEventListener('click', function () {
      var v = el('key').value.trim();
      if (!v) { setStatus('请先粘贴新的 API Key', 'err'); return }
      if (v.indexOf('sk-') !== 0) { setStatus('格式看起来不对（应以 sk- 开头）', 'err'); return }
      el('go').disabled = true; setStatus('保存中…');
      fetch('/dsh-whale/apikey', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: v }) })
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (!j || !j.ok) { setStatus('保存失败：' + ((j && j.error) || '未知错误'), 'err'); el('go').disabled = false; return }
          setStatus('已保存 ✓', 'ok');
          return fetch('/dsh-whale/key-window-done', { method: 'POST' });
        })
        .catch(function () { setStatus('网络错误，请重试', 'err'); el('go').disabled = false });
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

let win = null;
let firstRunWin = null;
let keyWin = null;
let tray = null;
let quitting = false;

/** API Key 打码显示（只留前缀与后 4 位，用于让用户确认当前用的是哪把）。 */
function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  return s.length > 12 ? s.slice(0, 7) + '******' + s.slice(-4) : '******';
}

/** 系统托盘图标：提供「显示/隐藏、退出」入口（挂件窗口无边框且不进任务栏）。 */
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
    {
      // 关（默认）：应用窗口盖住挂件，挂件仍在桌面图标之上；开：浮在所有窗口之上
      label: '置顶显示',
      type: 'checkbox',
      checked: readAlwaysOnTop(),
      click: (item) => { writeAlwaysOnTop(item.checked); applyAlwaysOnTop(); },
    },
    { type: 'separator' },
    { label: '改 API Key…', click: () => openKeyWindow() },
    { type: 'separator' },
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
    if (p === '/dsh-whale/last-turn.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: 0 }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  srv.listen(WIDGET_PORT, '127.0.0.1');
  return srv;
}

// ---------- 首次运行：自动补齐配置 ----------
function registerAutoStart() {
  try {
    if (!app.isPackaged) return { ok: false, error: '仅打包版本支持开机自启' };
    const exe = process.execPath;
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

/** 换 API Key 的小窗口（托盘入口）；关掉不退出程序。 */
function raiseKeyWindow() {
  if (!keyWin || keyWin.isDestroyed()) return;
  try {
    // 从托盘点进来时我们本来就持有前台权限；但从 HTTP 路由（自检/脚本）打开时
    // Windows 会挡住后台进程抢焦点，窗口会停在别人后面 —— 加一次「瞬时置顶」提上来，
    // 否则用户看到的效果就是「点了没反应」。
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
    height: 390,
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
  } catch (_e) { /* 切换失败不影响使用 */ }
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(readAlwaysOnTop(), 'screen-saver');
  // 整窗默认点击穿透，仅鲸鱼/菜单区域接收交互（由 preload 的 mousemove 实时切换）
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadURL(`http://127.0.0.1:${WIDGET_PORT}/`);
  win.on('closed', () => { win = null; });
  console.log('[dsh-whale] window bounds = ' + JSON.stringify(win.getBounds()));
}

ipcMain.on('whale-hover', (_e, over) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!over, { forward: true });
});

app.whenReady().then(async () => {
  // 先加载插件本体，保证挂件发出的第一个请求就能命中插件路由
  await loadPluginHost();
  startServer();
  createTray();
  // 首次运行：未配置 API Key 时先弹出配置窗口自动补齐，否则直接显示挂件
  if (readApiKey()) createWidgetWindow();
  else createFirstRunWindow();
});

// 挂件常驻托盘：窗口被关闭时不退出，仅通过托盘「退出」显式结束
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});
