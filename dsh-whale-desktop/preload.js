'use strict';
/**
 * 渲染进程预加载脚本：像素级命中检测，判断鼠标是否在鲸鱼（不透明像素）/菜单/气泡交互区，
 * 实时通知主进程切换「点击穿透」。与插件 widget 的 isWhaleHit 保持一致。
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

function isOverInteractive(x, y) {
  if (whalePixelHit(x, y)) return true;
  const btn = document.querySelector('.dshwv-menu-btn');
  if (btn && rectHit(btn.getBoundingClientRect(), x, y)) return true;
  const menu = document.querySelector('.dshwv-menu');
  if (menu && menu.classList.contains('dshwv-menu-open') && rectHit(menu.getBoundingClientRect(), x, y)) return true;
  const bubble = document.querySelector('.dshwv-bubble');
  if (bubble && bubble.classList.contains('dshwv-bubble-open') && rectHit(bubble.getBoundingClientRect(), x, y)) return true;
  return false;
}

window.addEventListener('mousemove', (e) => {
  ipcRenderer.send('whale-hover', isOverInteractive(e.clientX, e.clientY));
});
