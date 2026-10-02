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
 *     · 拖动中（.dshwv-dragging）→ 形状直接放整窗，指针永不跑出输入区，拖动不会中断
 *     · 面板/气泡等其它可见元素按「是否真的画了东西」收集矩形
 *     · 增强层浮层（.dshwe-*）额外走硬保名单（scanOthers 的启发式可能漏判）
 */
const { ipcRenderer, contextBridge } = require('electron');

// 给增强层用的桥：它跑在渲染进程且开启了 contextIsolation，自己 require 不到 electron，
// 所以由 preload 暴露一个最小接口（目前只有「保存抠图结果」）。
try {
    contextBridge.exposeInMainWorld('dshwBridge', {
        saveMatte: (dataUrl) => ipcRenderer.invoke('dshw-save-matte', dataUrl),
    });
} catch (_e) { /* 忽略 */ }


const WHALE_SEL = '.dshwv-img';
const MASK = 610;                 // 插件鲸鱼 PNG 是 610x610
const BANDS = 16;                 // 垂直分带数
const PAD_IDLE = 12;              // 静止时的外扩（逻辑像素）
const PAD_MOVE = 80;              // 运动中的外扩（覆盖跟手滞后，防止裁切）
const MAX_RECTS = 160;            // 其它元素重扫时的软上限（仅用于提前收工，不影响正确性）
const HARD_MAX_RECTS = 400;       // 硬保险丝：与主进程 MAX_SHAPE_RECTS 对齐
const SEND_INTERVAL = 16;         // 最多约 60fps 上报（拖动跟手要求高）
const SCAN_INTERVAL = 150;        // 其它元素的重扫间隔
const DEBUG = !!process.env.DSHW_DEBUG;

// 增强层浮层（desktop-enhance.js）显式纳入形状。
// 它们现在挂在 <body> 内，理论上 scanOthers() 能扫到；但那是「启发式判断有没有画东西」，
// paints() 只要判错就会被 setShape 裁掉 —— 按选择器硬保一份，成本极低。
// 2026-10-02 实机踩坑：浮层先前挂在 <html> 上，而 scanOthers 只遍历 body，
// 结果角标被形状切成半截（截图可见）。
const ENHANCE_SELS = ['.dshwe-toast.on', '.dshwe-badge', '.dshwe-fx', '.dshwe-chart.on', '.dshwe-ctl'];

// 插件自己的气泡/面板：容器不画背景、内容全靠 SVG，属于 paints() 天生判不出的结构。
// 这里按选择器**硬保**一份（只增不减，宁可少穿透也不能少画）。
const PLUGIN_UI_SELS = [
    '.dshwv-pop-open', '.dshwv-pop-open svg', '.dshwv-pop-open path',
    '.dshwv-pop-open ellipse', '.dshwv-pop-open rect',
    '.dshwv-menuview', '.dshwv-usagepanel', '.dshwv-rolelist', '.dshwv-audiolist',
    '.dshwv-custmenu', '.dshwv-qedit', '.dshwv-bubmask',
];

// ---------------- 鲸鱼轮廓分带（基于 PNG alpha，只算一次） ----------------
let bandCache = null;
let maskData = null;   // 缓存的 alpha 掩膜，用于自检「可见像素是否被形状完整覆盖」

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
    maskData = data;

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
    // ⚠️ tagName 大小写坑（2026-10-02 实机定位到「气泡右边缘缺一个缺口」的元凶）：
    //   HTML 文档里内联 `<svg>` 元素的 tagName 是**小写 'svg'**，
    //   而 SVG 子元素也是小写（'path' / 'ellipse'…）。旧代码写的是 'SVG'，永远不成立。
    //   插件的气泡正好是「容器自身不画背景（被 !important 重置为 transparent）+ 内容用 SVG 画」
    //   → 整层都判不出「画了东西」，形状里只剩下几个文字小盒子，
    //   于是气泡右边缘被切掉一块。
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'IMG' || tag === 'CANVAS' || tag === 'VIDEO' || tag === 'SVG')
        return true;
    // SVG 里的图形元素本身就是绘制内容
    if (tag === 'PATH' || tag === 'ELLIPSE' || tag === 'CIRCLE' || tag === 'RECT' ||
        tag === 'POLYGON' || tag === 'POLYLINE' || tag === 'LINE' || tag === 'G' || tag === 'USE')
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
        if (out.length >= HARD_MAX_RECTS) break;
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

// ---------------- 增强层浮层 + 插件气泡面板（硬保名单） ----------------
function rectsForSelectors(sels) {
    const out = [];
    for (const s of sels) {
        let els;
        try {
            els = document.querySelectorAll(s);
        } catch (_e) {
            continue;
        }
        for (const el of els) {
            let r;
            try {
                r = el.getBoundingClientRect();
            } catch (_e) {
                continue;
            }
            if (r.width < 2 || r.height < 2) continue;
            if (r.left > window.innerWidth || r.top > window.innerHeight ||
                r.right < 0 || r.bottom < 0) continue;
            out.push({
                x: Math.round(r.left - 8), y: Math.round(r.top - 8),
                width: Math.round(r.width + 16), height: Math.round(r.height + 16),
            });
        }
    }
    return out;
}

function enhanceRects() {
    return rectsForSelectors(ENHANCE_SELS);
}

function pluginUiRects() {
    return rectsForSelectors(PLUGIN_UI_SELS);
}

// ---------------- 去重：被大矩形完全包住的直接丢掉 ----------------
// 注意：这里**绝不能因为数量上限而丢弃矩形** ——
// 形状漏掉哪块像素，那块就会被 X11 ShapeBounding 直接裁掉（不再只是「少穿透」）。
// 排序后只在「已被更大矩形完整包住」时才丢，数量上限只当保险丝。
function dedupe(rects) {
    const sorted = rects.slice().sort(
        (a, b) => b.width * b.height - a.width * a.height);
    const keep = [];
    for (const r of sorted) {
        if (keep.length >= HARD_MAX_RECTS) break;      // 保险丝（正常远达不到）
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
let lastPad = 0;
let lastWhaleRect = null;
let lastDragState = false;
let pointerDown = false;      // 是否真有鼠标按住（拖动形状的安全网）

function collect() {
    const now = performance.now();
    const img = document.querySelector(WHALE_SEL);
    let key = '';
    if (img) {
        const r = img.getBoundingClientRect();
        key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
        lastWhaleRect = { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    if (key !== lastWhaleKey) {
        lastWhaleKey = key;
        lastMoveAt = now;                  // 鲸鱼位置变了 → 进入「运动模式」
    }

    // 拖动中：形状直接放成整窗。
    // 插件拖拽靠 document 级 pointermove；鲸鱼跟手有延迟，而形状是节流更新的，
    // 快速拖动时指针会瞬间跑到形状外 → Chromium 派发 pointercancel → 拖动中断
    // （用户感受就是「不好在全屏随意拖动」）。拖动期间本就不需要点击穿透，
    // 直接把整窗设为可输入区，拖动就再也不会断。
    // 安全网：必须「有鼠标按住」且「插件自己标记了 dragging」两个条件同时成立，
    // 否则类名万一卡住会让整窗一直吞点击（桌面就点不动了）。
    const dragging = pointerDown && !!document.querySelector('.dshwv-root.dshwv-dragging');
    if (dragging !== lastDragState) {
        lastDragState = dragging;
        lastSendAt = 0;                    // 状态翻转立刻上报，不等节流
    }
    if (dragging) {
        lastPad = 0;
        return [{
            x: 0, y: 0,
            width: Math.max(1, Math.round(window.innerWidth)),
            height: Math.max(1, Math.round(window.innerHeight)),
        }];
    }

    if (now - lastScanAt >= SCAN_INTERVAL) {
        lastScanAt = now;
        otherRects = scanOthers();
    }

    const moving = now - lastMoveAt < 250;
    const pad = moving ? PAD_MOVE : PAD_IDLE;
    lastPad = pad;
    const wr = whaleRects(pad) || [];
    return dedupe(wr.concat(otherRects, enhanceRects(), pluginUiRects()));
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

    if (DEBUG) {
        const wr = lastWhaleRect;
        console.log('[dshw-preload] 上报 ' + rects.length + ' 个矩形  pad=' + lastPad +
            (wr ? '  鲸鱼矩形=' + Math.round(wr.x) + ',' + Math.round(wr.y) + ',' +
                  Math.round(wr.w) + ',' + Math.round(wr.h) : '  鲸鱼未就绪'));
        // 严格自检：统计「不透明像素」是否全部落在上报矩形内。
        // 这是「不会被 setShape 裁掉」的充分条件（setShape 走 X11 ShapeBounding，同时裁剪绘制）
        let opaqueTotal = 0;
        let opaqueMiss = 0;
        if (maskData && wr) {
            const root = document.querySelector('.dshwv-root');
            const mirrored = !!(root && root.classList.contains('dshwv-left'));
            for (let my = 6; my < MASK; my += 20) {
                for (let mx = 6; mx < MASK; mx += 20) {
                    if (maskData[(my * MASK + mx) * 4 + 3] <= 12) continue;
                    opaqueTotal++;
                    const vx = mirrored
                        ? wr.x + ((MASK - mx) / MASK) * wr.w
                        : wr.x + (mx / MASK) * wr.w;
                    const vy = wr.y + (my / MASK) * wr.h;
                    const hit = rects.some((r) =>
                        vx >= r.x && vx < r.x + r.width && vy >= r.y && vy < r.y + r.height);
                    if (!hit) opaqueMiss++;
                }
            }
        }
        // 便于外部脚本校验（同时把严格自检结果带给主进程）
        try {
            require('electron').ipcRenderer.send('whale-debug-shape', {
                whale: wr, pad: lastPad, rects, opaqueTotal, opaqueMiss,
            });
        } catch (_e) { /* 忽略 */ }
    }
    ipcRenderer.send('whale-input-rects', rects);
}

window.addEventListener('DOMContentLoaded', () => {
    // 记录鼠标按住状态：拖动形状只在「按住 + 插件标记 dragging」时才启用
    window.addEventListener('pointerdown', (e) => {
        if (e.button === 0 || e.pointerType !== 'mouse')
            pointerDown = true;
    }, true);
    const clearDown = () => { pointerDown = false; };
    window.addEventListener('pointerup', clearDown, true);
    window.addEventListener('pointercancel', clearDown, true);
    window.addEventListener('blur', clearDown, true);

    // 首帧可能鲸鱼图还没加载完，多试几次
    let tries = 0;
    const boot = setInterval(() => {
        tries++;
        if (document.querySelector(WHALE_SEL) || tries > 60)
            clearInterval(boot);
    }, 250);
    requestAnimationFrame(loop);
});
