#!/usr/bin/env node
/**
 * dock-zone —— 探测 GNOME(dash-to-dock) 的 Dock 占位，算出给桌宠用的
 *              「地板线 / 禁停区 / 空闲带」。
 * ============================================================================
 * 为什么需要它：
 *   本机 Dock 是**底边居中**的，屏幕左下与右下是纯桌面。桌宠原本贴着屏幕底边
 *   （Coopanion 的 floorGap 在桌宠模式下只有 2px）行走，于是必然压在 Dock 上：
 *     · Dock 弹出来时和桌宠抢同一片像素
 *     · 用户想要的「两个大肥鱼待在 Dock 两侧的空白处」做不到
 *     · 鲸鱼路过 Dock 时会一直待在 Dock 里（点不到 Dock）
 *
 *   所以需要一份「Dock 到底占了哪儿」的统一答案，两个桌宠共用。
 *
 * 支持四种形态：
 *   ① BOTTOM + extend-height=false   底边居中（本机现状）
 *   ② BOTTOM + extend-height=true    底边通栏
 *   ③ LEFT/RIGHT + extend-height=false  侧边栏（垂直居中）
 *   ④ LEFT/RIGHT + extend-height=true   侧边栏（通高）
 *
 * 几何来源优先级（能用精确的就别估）：
 *   1) 覆盖文件 ~/.config/dsh-whale/dock-zone.json   —— 人工兜底，最高优先
 *   2) 显示器 workarea                              —— Dock 常显时会占 workarea，精确
 *   3) dash-to-dock 设置估算                        —— 自动隐藏时不占 workarea，只能估
 *
 * 用法：
 *   node tools/dock-zone.cjs                      # 打印 JSON
 *   node tools/dock-zone.cjs --screen 1560x937    # 指定屏幕（脱离 Electron 时）
 *   node tools/dock-zone.cjs --workarea 0,0,1560,900
 *
 * 作为库：
 *   const { detectDockZone } = require('./tools/dock-zone.cjs');
 *   const z = detectDockZone({ screen: { w, h }, workArea: { x, y, w, h } });
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OVERRIDE_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'dsh-whale', 'dock-zone.json');

const DTD = 'org.gnome.shell.extensions.dash-to-dock';

function gsettingsGet(key, fallback, schema = DTD) {
  try {
    const out = execFileSync('gsettings', ['get', schema, key], { encoding: 'utf8', timeout: 5000 }).trim();
    return out;
  } catch (_e) {
    return fallback;
  }
}
/** gsettings 的字符串带单引号：'BOTTOM' → BOTTOM */
function unq(s) { return String(s || '').replace(/^'|'$/g, ''); }
function truthy(s) { return String(s || '').trim() === 'true'; }

/** gsettings 的数组：['a', 'b'] → ['a','b'] */
function parseArray(s) {
  const m = /\[(.*)\]/s.exec(String(s || ''));
  if (!m) return [];
  return m[1].split(',').map((x) => unq(x.trim())).filter(Boolean);
}

/** 读 dash-to-dock 配置（读不到就返回本机实测过的默认） */
function readDockSettings() {
  const position = unq(gsettingsGet('dock-position', "'BOTTOM'")) || 'BOTTOM';
  return {
    position,
    extendHeight: truthy(gsettingsGet('extend-height', 'false')),
    autohide: truthy(gsettingsGet('autohide', 'true')),
    iconSize: Number(gsettingsGet('dash-max-icon-size', '48')) || 48,
    heightFraction: Number(gsettingsGet('height-fraction', '0.9')) || 0.9,
    favorites: parseArray(gsettingsGet('favorite-apps', '[]', 'org.gnome.shell')).length,
    showAppsButton: truthy(gsettingsGet('show-apps-always-in-the-edge', 'false')),
    available: true,
  };
}

/**
 * 估算 Dock 的像素矩形。
 * dash-to-dock 的每个图标占位 ≈ iconSize × 1.25（图标 + 内边距），
 * 再加上两端的 padding 与运行指示点，最后乘一个安全系数：
 * **宁可估大**，因为估小的后果是桌宠压到 Dock（不可用），估大只是桌宠多让开一点。
 */
function estimateDockRect(s, screen) {
  // 每个图标占位 ≈ iconSize × 1.15（图标本体 + 单元内边距，实测标定）；
  // 再加两端 padding；跑着的应用不在收藏里时 Dock 会变宽，用 RUNNING_FUDGE 补。
  // 最后乘 SAFETY：**宁可估大**。估小的后果是桌宠压在 Dock 上（不可用），
  // 估大只是桌宠多让开几十像素；但也不能无限大，否则空闲带被吃光。
  const RUNNING_FUDGE = 2;
  const n = Math.max(1, s.favorites || 1) + (s.showAppsButton ? 1 : 0) + RUNNING_FUDGE;
  const per = s.iconSize * 1.15;
  const pad = 12;
  const thick = Math.round(s.iconSize + 24);            // Dock 的「厚度」
  const SAFETY = 1.10;

  if (s.position === 'BOTTOM') {
    if (s.extendHeight) {
      return { x: 0, y: screen.h - thick, w: screen.w, h: thick, extended: true };
    }
    const w = Math.round(Math.min(screen.w * 0.9, (n * per + pad * 2) * SAFETY));
    return { x: Math.round((screen.w - w) / 2), y: screen.h - thick, w, h: thick, extended: false };
  }
  // LEFT / RIGHT
  const onLeft = s.position === 'LEFT';
  if (s.extendHeight) {
    return { x: onLeft ? 0 : screen.w - thick, y: 0, w: thick, h: screen.h, extended: true };
  }
  const h = Math.round(Math.min(screen.h * s.heightFraction, (n * per + pad * 2) * SAFETY));
  return { x: onLeft ? 0 : screen.w - thick, y: Math.round((screen.h - h) / 2), w: thick, h, extended: false };
}

/** 把矩形收缩成「区间」，便于后面求禁停/空闲带 */
function clampRect(r, screen) {
  const x0 = Math.max(0, Math.round(r.x));
  const y0 = Math.max(0, Math.round(r.y));
  const x1 = Math.min(screen.w, Math.round(r.x + r.w));
  const y1 = Math.min(screen.h, Math.round(r.y + r.h));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** 从 workarea 反推 Dock 矩形：Dock 常显时 mutter 会把 workarea 切掉那一块 */
function dockFromWorkArea(workArea, screen) {
  if (!workArea) return null;
  const bottom = screen.h - (workArea.y + workArea.h);
  const right = screen.w - (workArea.x + workArea.w);
  const left = workArea.x;
  const TOPBAR = 32;   // GNOME 顶栏，不是 Dock
  const cands = [
    { side: 'BOTTOM', v: bottom },
    { side: 'LEFT', v: left },
    { side: 'RIGHT', v: right },
  ].filter((c) => c.v > 8).sort((a, b) => b.v - a.v);
  if (!cands.length) return null;
  const c = cands[0];
  if (c.side === 'BOTTOM') return { x: 0, y: screen.h - c.v, w: screen.w, h: c.v, extended: true };
  if (c.side === 'LEFT') return { x: 0, y: TOPBAR, w: c.v, h: screen.h - TOPBAR, extended: true };
  return { x: screen.w - c.v, y: TOPBAR, w: c.v, h: screen.h - TOPBAR, extended: true };
}

/**
 * 由 Dock 矩形算出桌宠要用的信息。
 * @param {object} dock     Dock 矩形（CSS px）
 * @param {object} screen   { w, h }
 * @param {object} s        dash-to-dock 设置
 * @param {number} floorGap 桌宠原本离屏幕底边的距离（Coopanion 桌宠模式是 2）
 */
function petPlan(dock, screen, s, floorGap = 2) {
  const baseFloor = screen.h - floorGap;
  // Dock 是否「盖住整条底边」：底边形态 + 通栏，或侧边栏通高（侧边栏通高时两个角都被占）
  const fullBottom = s.position === 'BOTTOM' && s.extendHeight;
  const sidebarAtCorner = s.position !== 'BOTTOM' && dock.y + dock.h >= baseFloor - 1;

  // 地板线：只有底边通栏时必须抬高；其它形态保持原样（底边空出来给桌宠跑）
  const floorY = fullBottom ? Math.max(1, dock.y - 6) : baseFloor;

  // 与地板线相交的禁停 x 区间
  const blockedX = [];
  if (s.position === 'BOTTOM' && !s.extendHeight) blockedX.push([dock.x, dock.x + dock.w]);
  if (fullBottom) blockedX.push([0, screen.w]);                 // 整条底边都是 Dock
  const sideW = dock.w;
  const sideReachesFloor = dock.y + dock.h >= floorY - 1;
  if (sideReachesFloor) {
    if (s.position === 'LEFT') blockedX.push([0, sideW]);
    if (s.position === 'RIGHT') blockedX.push([screen.w - sideW, screen.w]);
  }

  // 合并 + 求空闲带
  blockedX.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const b of blockedX) {
    const last = merged[merged.length - 1];
    if (last && b[0] <= last[1] + 4) last[1] = Math.max(last[1], b[1]);
    else merged.push([b[0], b[1]]);
  }
  const MARGIN = 8;                       // 桌宠身体半宽，别贴着 Dock 边
  const freeX = [];
  let cur = 0;
  for (const [b0, b1] of merged) {
    if (b0 - MARGIN - cur > 24) freeX.push([cur, b0 - MARGIN]);
    cur = Math.max(cur, b1 + MARGIN);
  }
  if (screen.w - cur > 24) freeX.push([cur, screen.w]);
  // 宽的排前面（桌宠优先待在宽敞的地方）
  freeX.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));

  // 极端情况：Dock 太宽，两侧都没地方站了 → 把地板线抬到 Dock 之上，
  // 否则桌宠只能站在 Dock 里（那还不如让它在 Dock 上方走）。
  const widest = freeX.length ? freeX[0][1] - freeX[0][0] : 0;
  let finalFloorY = floorY;
  let raised = fullBottom;
  if (widest < 130) {
    finalFloorY = Math.max(1, dock.y - 6);
    raised = true;
  }

  return {
    floorY: finalFloorY,
    floorRaised: raised,
    // 地板线一旦抬到 Dock 之上，底边就再也没有“禁停区”了（桌宠整个人都在 Dock 上方走）
    blockedX: raised ? [] : merged,
    freeX: raised ? [[0, screen.w]] : freeX,
    gap: floorGap,
  };
}

/** 主入口：给几何 + 设置 → 结论 */
function detectDockZone(opts = {}) {
  const screen = { w: Math.round(opts.screen?.w || 0), h: Math.round(opts.screen?.h || 0) };
  if (!screen.w || !screen.h) throw new Error('detectDockZone 需要 screen.{w,h}');

  // 1) 人工覆盖文件优先
  try {
    if (fs.existsSync(OVERRIDE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
      if (raw && raw.dock && Number.isFinite(raw.dock.w)) {
        const s = { ...readDockSettings(), ...(raw.settings || {}) };
        const dock = clampRect(raw.dock, screen);
        return {
          found: true, source: 'override', screen,
          position: s.position, extendHeight: !!s.extendHeight, autohide: !!s.autohide,
          dock, ...petPlan(dock, screen, s, opts.floorGap ?? 2),
          note: '来自覆盖文件 ' + OVERRIDE_FILE,
        };
      }
    }
  } catch (e) {
    // 覆盖文件坏了不能把桌宠搞挂，退回自动探测
    console.error('[dock-zone] 覆盖文件解析失败，改为自动探测：' + e.message);
  }

  const s = readDockSettings();
  let dock = null, source = 'estimate', note = '';
  if (!s.autohide) {
    const wa = dockFromWorkArea(opts.workArea, screen);
    if (wa) { dock = clampRect(wa, screen); source = 'workarea'; note = 'Dock 常显，由 workarea 精确反推'; }
  }
  if (!dock) {
    dock = clampRect(estimateDockRect(s, screen), screen);
    note = 'Dock 自动隐藏时不占 workarea，按 dash-to-dock 设置估算（已留安全余量）';
  }

  return {
    found: true, source, screen,
    position: s.position, extendHeight: !!s.extendHeight, autohide: !!s.autohide,
    dock, ...petPlan(dock, screen, s, opts.floorGap ?? 2),
    note,
  };
}

module.exports = { detectDockZone, readDockSettings, estimateDockRect, petPlan, OVERRIDE_FILE };

/* ------------------------------- CLI ------------------------------- */
function parsePair(str, def) {
  if (!str) return def;
  const m = /^(\d+)[x,](\d+)$/.exec(String(str).replace(/x/g, 'x'));
  if (!m) return def;
  return { w: Number(m[1]), h: Number(m[2]) };
}
if (require.main === module) {
  const argv = process.argv.slice(2);
  const argOf = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : '';
  };
  let screen = parsePair(argOf('--screen'), null);
  if (!screen) {
    // 没给就试着从 xrandr 猜（注意：那是物理像素，缩放 2 的时候要除以 2）
    try {
      const out = execFileSync('xrandr', ['--current'], { encoding: 'utf8', timeout: 5000 });
      const m = /(\d+)x(\d+)\+0\+0/.exec(out);
      if (m) screen = { w: Number(m[1]), h: Number(m[2]) };
    } catch (_e) { /* 忽略 */ }
  }
  if (!screen) {
    console.error('用法：node tools/dock-zone.cjs --screen 1560x937 [--workarea 0,0,1560,900]');
    process.exit(2);
  }
  let workArea = null;
  const wa = argOf('--workarea');
  if (wa) {
    const p = wa.split(',').map(Number);
    if (p.length === 4 && p.every(Number.isFinite)) workArea = { x: p[0], y: p[1], w: p[2], h: p[3] };
  }
  const z = detectDockZone({ screen, workArea });
  console.log(JSON.stringify(z, null, 2));
}
