'use strict';
/**
 * Linux 专用 preload：把「当前所有可见内容」的矩形清单上报主进程，由主进程调用
 * win.setShape(rects) 实现点击穿透。
 *
 * 为什么 Linux 不能用 Windows 那套：
 *   Windows/macOS 的 setIgnoreMouseEvents(true, {forward:true}) 会把 mousemove 转发进来，
 *   preload 据此逐像素判断「鼠标是否在鲸鱼/面板上」，再动态开关 ignore。
 *   但 Linux 上 forward 是**空操作**（2026-10-02 实机探针实测：整窗仍收全部 mousemove，
 *   且透明区域的点击不会穿透到下层窗口 —— 全屏透明窗会挡住整个桌面的点击）。
 *   实测可行的替代是 win.setShape(rects)：区域外点击可精确穿透。
 *
 * 关键约束（实测确认）：
 *   Electron 在 Linux 的 setShape 设置的是 X11 **ShapeBounding**，它**同时裁剪绘制与输入**
 *   （xwininfo 侧看到 ShapeBounding = 给定矩形，ShapeInput 未设置 → 输入默认跟随 bounding）。
 *   因此：
 *     · 矩形必须覆盖所有可见像素，漏掉的部分会被**裁掉看不见**
 *     · 鲸鱼移动/动效期间形状必须跟得上，否则边缘会被切
 *   本脚本的对策：
 *     · 鲸鱼 = 按 PNG alpha 轮廓做「横向分带」，比整块方形贴合得多
 *     · 检测到鲸鱼刚移动过 → 临时用大 padding（宽松形状，绝不裁切）
 *       静止 250ms 后 → 收紧为小 padding（点击穿透更精确）
 *     · 面板/气泡等其它可见元素按「是否真的画了东西」收集矩形
 */
const { ipcRenderer } = require('electron');

const WHALE_SEL = '.dshwv-img';
const MASK = 610;                 // 插件鲸鱼 PNG 是 610x610
const BANDS = 16;                 // 垂直分带数
const PAD_IDLE = 12;              // 静止时的外扩（逻辑像素）
const PAD_MOVE = 56;              // 运动中的外扩（覆盖跟手滞后，防止裁切）
const MAX_RECTS = 160;
const SEND_INTERVAL = 33;         // 最多约 30fps 上报
const SCAN_INTERVAL = 150;        // 其它元素的重扫间隔
const DEBUG = !!process.env.DSHW_DEBUG;

// ---------------- 鲸鱼轮廓分带（基于 PNG alpha，只算一次） ----------------
let bandCache = null;

function buildBands() {
    const img = document.querySelector(WHALE_SEL);
    if (!img || !img.complete || !img.naturalWidth) return null;
    let ctx;
    try {
        const c = document.createElement('canvas');
        c.width = MASK;
        c.height = MASK;
        ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, MASK, MASK);
    } catch (_e) {
        return null;
    }
    let data;
    try {
        data = ctx.getImageData(0, 0, MASK, MASK).data;
    } catch (_e) {
        return null;   // 跨域/画布受限时退化为整块矩形
    }

    const bands = [];
    const step = 2;
    for (let i = 0; i < BANDS; i++) {
        const y0 = Math.floor((i * MASK) / BANDS);
        const y1 = Math.floor(((i + 1) * MASK) / BANDS);
        let minX = MASK;
        let maxX = -1;
        for (let y = y0; y < y1; y += step) {
            const row = y * MASK * 4;
            for (let x = 0; x < MASK; x += step) {
                if (data[row + x * 4 + 3] > 12) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                }
            }
        }
        if (maxX < 0) continue;
        bands.push({ y0, y1, minX: Math.max(0, minX - 2), maxX: Math.min(MASK - 1, maxX + 2) });
    }
    return bands.length ? bands : null;
}

function whaleRects(pad) {
    const img = document.querySelector(WHALE_SEL);
    if (!img || !img.complete) return null;
    const r = img.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;

    if (!bandCache)
        bandCache = buildBands();
    if (!bandCache) {
        // 退化：整块矩形（宁可少穿透，也不能让鲸鱼被裁掉）
        return [{
            x: Math.round(r.left - pad), y: Math.round(r.top - pad),
            width: Math.round(r.width + pad * 2), height: Math.round(r.height + pad * 2),
        }];
    }

    // 左侧吸附时插件整体镜像（.dshwv-left）→ 需要把 x 反向映射
    const root = document.querySelector('.dshwv-root');
    const mirrored = !!(root && root.classList.contains('dshwv-left'));

    const out = [];
    for (const b of bandCache) {
        let x0;
        let x1;
        if (mirrored) {
            x0 = r.left + ((MASK - b.maxX) / MASK) * r.width;
            x1 = r.left + ((MASK - b.minX) / MASK) * r.width;
        } else {
            x0 = r.left + (b.minX / MASK) * r.width;
            x1 = r.left + (b.maxX / MASK) * r.width;
        }
        const y0 = r.top + (b.y0 / MASK) * r.height;
        const y1 = r.top + (b.y1 / MASK) * r.height;
        out.push({
            x: Math.round(x0 - pad), y: Math.round(y0 - pad),
            width: Math.round(x1 - x0 + pad * 2), height: Math.round(y1 - y0 + pad * 2),
        });
    }
    return out;
}

// ---------------- 其它可见元素（面板 / 气泡 / 飘字等） ----------------
function paints(el, cs) {
    const tag = el.tagName;
    if (tag === 'IMG' || tag === 'CANVAS' || tag === 'VIDEO' || tag === 'SVG')
        return true;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    const bg = cs.backgroundColor || '';
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return true;
    if (cs.boxShadow && cs.boxShadow !== 'none') return true;
    if (parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0 ||
        parseFloat(cs.borderRightWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0)
        return true;
    for (const n of el.childNodes) {
        if (n.nodeType === 3 && n.textContent && n.textContent.trim()) return true;
    }
    return false;
}

function scanOthers() {
    const out = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nodes;
    try {
        nodes = document.body.querySelectorAll('*');
    } catch (_e) {
        return out;
    }
    for (const el of nodes) {
        if (out.length >= MAX_RECTS * 2) break;
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'HEAD') continue;
        if (el.classList && el.classList.contains('dshwv-img')) continue;  // 鲸鱼单独处理
        let r;
        try {
            r = el.getBoundingClientRect();
        } catch (_e) {
            continue;
        }
        if (r.width < 2 || r.height < 2) continue;
        if (r.left > vw || r.top > vh || r.right < 0 || r.bottom < 0) continue;
        let cs;
        try {
            cs = window.getComputedStyle(el);
        } catch (_e) {
            continue;
        }
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        if (!paints(el, cs)) continue;
        out.push({
            x: Math.round(r.left - 6), y: Math.round(r.top - 6),
            width: Math.round(r.width + 12), height: Math.round(r.height + 12),
        });
    }
    return out;
}

// ---------------- 去重：被大矩形完全包住的直接丢掉 ----------------
function dedupe(rects) {
    const sorted = rects.slice().sort(
        (a, b) => b.width * b.height - a.width * a.height);
    const keep = [];
    for (const r of sorted) {
        if (keep.length >= MAX_RECTS) break;
        const covered = keep.some((k) =>
            r.x >= k.x && r.y >= k.y &&
            r.x + r.width <= k.x + k.width &&
            r.y + r.height <= k.y + k.height);
        if (!covered) keep.push(r);
    }
    return keep;
}

// ---------------- 主循环 ----------------
let lastWhaleKey = '';
let lastMoveAt = 0;
let lastSendAt = 0;
let lastScanAt = 0;
let otherRects = [];
let lastSentKey = '';

function collect() {
    const now = performance.now();
    const img = document.querySelector(WHALE_SEL);
    let key = '';
    if (img) {
        const r = img.getBoundingClientRect();
        key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    }
    if (key !== lastWhaleKey) {
        lastWhaleKey = key;
        lastMoveAt = now;                  // 鲸鱼位置变了 → 进入「运动模式」
    }

    if (now - lastScanAt >= SCAN_INTERVAL) {
        lastScanAt = now;
        otherRects = scanOthers();
    }

    const moving = now - lastMoveAt < 250;
    const pad = moving ? PAD_MOVE : PAD_IDLE;
    const wr = whaleRects(pad) || [];
    return dedupe(wr.concat(otherRects));
}

function loop() {
    requestAnimationFrame(loop);
    let rects;
    try {
        rects = collect();
    } catch (e) {
        if (DEBUG) console.log('[dshw-preload] collect err: ' + e);
        return;
    }
    if (!rects.length) return;

    const now = performance.now();
    const key = rects.map((r) => `${r.x},${r.y},${r.width},${r.height}`).join(';');
    if (key === lastSentKey) return;
    if (now - lastSendAt < SEND_INTERVAL) return;
    lastSentKey = key;
    lastSendAt = now;

    if (DEBUG) console.log(`[dshw-preload] 上报 ${rects.length} 个矩形（pad=${key ? '' : ''}）`);
    ipcRenderer.send('whale-input-rects', rects);
}

window.addEventListener('DOMContentLoaded', () => {
    // 首帧可能鲸鱼图还没加载完，多试几次
    let tries = 0;
    const boot = setInterval(() => {
        tries++;
        if (document.querySelector(WHALE_SEL) || tries > 60)
            clearInterval(boot);
    }, 250);
    requestAnimationFrame(loop);
});
