'use strict';
/**
 * DSH 小鲸鱼桌面挂件 —— Electron 主进程（自包含 / 本地直连版）
 *
 * 完全本地运行，不依赖 dsh web、也不用打开网页：
 *  - 本地服务（127.0.0.1:3090）自己实现 /dsh-whale/* 全部路由：widget.js、图片、音效都从
 *    本地文件读取；balance.json 直接调 DeepSeek API（读 DEEPSEEK_API_KEY），并本地记账算「今日已用」。
 *  - 无边框、透明、始终置顶、覆盖整个桌面的窗口 → 鲸鱼浮在桌面上、可满桌面拖动。
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

const WIDGET_PORT = 3090; // 本挂件本地服务端口
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CRED_FILE = path.join(DSH_HOME, '.credentials.yaml');
const SIZE_FILE = path.join(DSH_HOME, '.dshw-size.json');   // 与插件共用：挂件尺寸/开关配置
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
</style>
</head>
<body>
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
let tray = null;
let quitting = false;

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

/** 本地服务：自包含实现 /dsh-whale/* 全部路由（不依赖 dsh web）。 */
function startServer() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1:' + WIDGET_PORT);
    const p = u.pathname;

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
      res.end(JSON.stringify({ ok: true, configured: !!readApiKey() }));
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
        'Exec=' + exe,
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
    alwaysOnTop: true,
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
  win.setAlwaysOnTop(true, 'screen-saver');
  // 整窗默认点击穿透，仅鲸鱼/菜单区域接收交互（由 preload 的 mousemove 实时切换）
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadURL(`http://127.0.0.1:${WIDGET_PORT}/`);
  win.on('closed', () => { win = null; });
  console.log('[dsh-whale] window bounds = ' + JSON.stringify(win.getBounds()));
}

ipcMain.on('whale-hover', (_e, over) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!over, { forward: true });
});

app.whenReady().then(() => {
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
