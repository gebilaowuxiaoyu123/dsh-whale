'use strict';
/**
 * 渲染进程预加载脚本：判断鼠标是否在挂件可交互区域，实时通知主进程切换「点击穿透」。
 *
 * 判定策略（v0.3.16 起改为通用判定）
 * -----------------------------------------------------------------
 * 插件前端用 CSS 的 pointer-events 表达「哪块能点」：容器一般是 none，真正可交互的元素
 * （鲸鱼、菜单、遮罩、卡片、下拉、输入框…）是 auto。
 * 早期这里硬编码了几个类名（.dshwv-img / .dshwv-menu-btn / .dshwv-menu / .dshwv-bubble），
 * 插件 0.3.16 引入大量新面板（.dshwv-bubmask / .dshwv-bubcard / .dshwv-audiolist …）后，
 * 那些面板整体落在检测范围之外 → 窗口保持整窗穿透 → 现象是「面板按钮全点不动、关不掉」。
 * 现在按 pointer-events 语义通用判定，插件以后新增 UI 也能自动覆盖。
 */
const { ipcRenderer } = require('electron');

let hitCanvas = null;

function rectHit(r, x, y) {
  return r && r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

// 是否命中鲸鱼的不透明像素（镜像插件的 isWhaleHit 逻辑）
function whalePixelHit(x, y) {
  const img = document.querySelector('.dshwv-img');
  if (!img || !img.complete) return false;
  const r = img.getBoundingClientRect();
  if (!r || r.width <= 0 || r.height <= 0) return false;
  if (!rectHit(r, x, y)) return false;
  try {
    if (!hitCanvas) {
      hitCanvas = document.createElement('canvas');
      hitCanvas.width = 610;
      hitCanvas.height = 610;
      hitCanvas.getContext('2d').drawImage(img, 0, 0, 610, 610);
    }
    let lx = ((x - r.left) / r.width) * 610;
    let ly = ((y - r.top) / r.height) * 610;
    const root = document.querySelector('.dshwv-root');
    if (root && root.classList.contains('dshwv-left')) lx = 610 - lx;
    const data = hitCanvas.getContext('2d').getImageData(Math.floor(lx), Math.floor(ly), 1, 1).data;
    return data[3] > 10;
  } catch (_e) {
    return true;
  }
}

/** 通用判定：命中点自身或祖先链上存在 pointer-events:auto 的元素即可交互 */
function hitsInteractiveByPointerEvents(el) {
  let depth = 0;
  for (let node = el; node && node !== document.body && node !== document.documentElement && depth < 24; node = node.parentElement, depth++) {
    let pe = '';
    try {
      pe = window.getComputedStyle(node).pointerEvents;
    } catch (_e) {
      pe = '';
    }
    if (pe === 'auto') return true;
  }
  return false;
}

function isOverInteractive(x, y) {
  let el = null;
  try {
    el = document.elementFromPoint(x, y);
  } catch (_e) {}

  // 1) 鲸鱼本体：按**不透明像素**判定 —— 整张 png 是矩形且大片透明，
  //    不能整块可点，否则会挡住桌面操作（原有手感保持不变）
  if (el && el.classList && el.classList.contains('dshwv-img')) return whalePixelHit(x, y);
  if (whalePixelHit(x, y)) return true;

  // 2) 其余区域：按 CSS pointer-events 语义通用判定
  //    （菜单、遮罩、设置面板、下拉、按钮、输入框…全覆盖）
  return el ? hitsInteractiveByPointerEvents(el) : false;
}

window.addEventListener('mousemove', (e) => {
  ipcRenderer.send('whale-hover', isOverInteractive(e.clientX, e.clientY));
});
