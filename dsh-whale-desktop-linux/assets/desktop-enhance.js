'use strict';
/**
 * DSH 小鲸鱼 · 桌面版增强层（Linux / Windows 通用）
 * ============================================================================
 * 为什么要有这一层：
 *   `dsh-whale-widget/` 是上游插件的**原样 vendored 副本**，直接改它会让「日后 diff 与
 *   追溯上游」失效。所以桌面版特有的功能放在这个独立脚本里，由 main.js 的 PAGE 在插件
 *   脚本之后注入 —— 上游升级插件时不会冲突。
 *
 * 目前已实现（对齐官方 Windows 独立版、插件本体缺失的能力）：
 *   ✅ 峰谷提前预警：进入/离开高峰前 N 分钟提醒（可开关、可配提前量）
 *   ✅ 峰值状态常驻角标：随时能看到「现在是高峰/谷段，还有多久切换」
 *   ✅ 多币种汇率：余额折算成 USD/EUR/JPY/GBP/HKD，点击角标循环切换
 *   ✅ 三态主题：dark / light / glass（auto 跟随系统）
 *   ✅ 多套气泡组：classic / night / sakura / mint（同时作用于插件气泡与增强层浮层）
 *   ✅ 台词轮播：按间隔随机冒一句台词
 *   ✅ 账单图表：近 7 日用量柱状图（余额变化时自动冒一次，也可手动调用）
 *
 * 配置：localStorage['dshwDesktopEnhance']
 *   { peakWarn, leadMinutes, badge, fxCurrency, theme, bubbleSkin,
 *     speechOn, speechMinutes, chartOn, chartSeconds }
 *   也可在控制台执行 window.dshwEnhance.set({leadMinutes: 15}) 调整
 *
 * ⚠️ 浮层必须挂到 <body>：preload 的 scanOthers() 只遍历 body，挂到 <html> 上的元素
 *    不会被计入 setShape 形状，会被裁掉（2026-10-02 实机踩坑，见 mount()）。
 */
(function () {
    const NS = '[dshw-enhance]';
    const CFG_KEY = 'dshwDesktopEnhance';
    const WEEKEND_VALLEY_FROM = Date.UTC(2026, 7, 22, 16, 0, 0);   // 北京时间 2026-08-23 00:00 起周末全天谷价
    const PEAK_WINDOWS = [[9, 12], [14, 18]];                      // 工作日高峰（北京时间）
    const DAY_MIN = 24 * 60;
    const CHECK_MS = 20000;

    const cfg = Object.assign(
        {
            peakWarn: true, leadMinutes: 10, badge: true, fxCurrency: 'USD',
            theme: 'dark', bubbleSkin: 'classic', bubbleGroups: null,
            speechOn: true, speechMinutes: 10,
            chartOn: true, chartSeconds: 9, chartMode: 'day',
            moodOn: true, budgetCny: 5,
            matteOn: false, matteUrl: '', matteTolerance: 34,
            ctlBar: true,
        },
        readCfg(),
    );
    const FX_CYCLE = ['USD', 'EUR', 'JPY', 'GBP', 'HKD', 'OFF'];
    const THEMES = ['dark', 'light', 'glass', 'auto'];
    const SKINS = ['classic', 'night', 'sakura', 'mint'];
    // 气泡/角标/控制条/图表的纵向堆叠位置（相对鲸鱼顶部向上偏移）
    const STACK = { fx: 2, badge: 26, ctl: 52, chart: 82 };

    // ---------------- 浮层挂载点 ----------------
    // 必须挂到 <body> 内：preload-linux.js 的 scanOthers() 只遍历 document.body，
    // 挂到 documentElement(<html>) 上的元素不算「可见内容」→ 不进 setShape 形状 → 被裁掉。
    // 现象：角标/气泡只显示落在鲸鱼形状内的那一截（2026-10-02 实机截图确认）。
    function mount(el) {
        (document.body || document.documentElement).appendChild(el);
        return el;
    }

    /**
     * 把浮层放到 (x,y)，并按**实测**尺寸夹进视口，避免贴边时被窗口/形状裁切。
     * 原实现用写死的 160/240/300 估算宽度，贴右边时会把尾巴切掉。
     * opts.above = true 时 y 表示浮层**下边缘**位置（贴鲸鱼上方用）。
     */
    function place(el, x, y, opts) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const M = 8;
        el.classList.remove('wrap');
        el.style.left = M + 'px';
        el.style.top = M + 'px';
        let w = el.offsetWidth;
        if (w > vw - M * 2) {                     // 比视口还宽 → 允许换行，别硬裁
            el.classList.add('wrap');
            el.style.maxWidth = (vw - M * 2) + 'px';
            w = el.offsetWidth;
        }
        const h = el.offsetHeight;
        let left = Math.max(M, Math.min(x, Math.max(M, vw - w - M)));
        let top = (opts && opts.above) ? (y - h) : y;
        top = Math.max(M, Math.min(top, Math.max(M, vh - h - M)));
        el.style.left = Math.round(left) + 'px';
        el.style.top = Math.round(top) + 'px';
        return { left: Math.round(left), top: Math.round(top), w, h };
    }

    function readCfg() {
        try {
            return JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {};
        } catch (_e) {
            return {};
        }
    }

    function writeCfg() {
        try {
            localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
        } catch (_e) { /* 忽略 */ }
    }

    function log(...a) {
        if (cfg.debug)
            console.log(NS, ...a);
    }

    // 状态变化时无条件输出（不受 cfg.debug 影响），便于外部验证
    let lastNotice = '';
    function notice(msg) {
        if (msg === lastNotice)
            return;
        lastNotice = msg;
        console.log(NS, msg);
    }

    // ---------------- 峰谷计算（北京时间，与插件/扩展版口径一致） ----------------
    function bjParts() {
        const d = new Date(Date.now() + 8 * 3600 * 1000);
        return {
            day: d.getUTCDay(),                                   // 0=周日
            mins: d.getUTCHours() * 60 + d.getUTCMinutes(),
            dateKey: d.toISOString().slice(0, 10),
        };
    }

    function isWeekendAllValley() {
        return Date.now() >= WEEKEND_VALLEY_FROM;
    }

    /** @returns {{peak:boolean, secondsToSwitch:number, next:'peak'|'valley'}} */
    function peakState() {
        const { day, mins } = bjParts();
        const weekend = (day === 0 || day === 6) && isWeekendAllValley();
        if (weekend) {
            // 周末全天谷价：下一个高峰是「下一个工作日 9:00」，这里只报谷段
            return { peak: false, secondsToSwitch: -1, next: 'valley' };
        }
        for (const [a, b] of PEAK_WINDOWS) {
            if (mins >= a * 60 && mins < b * 60)
                return { peak: true, secondsToSwitch: (b * 60 - mins) * 60, next: 'valley' };
        }
        // 谷段：找下一个高峰起点
        let nextStart = null;
        for (const [a] of PEAK_WINDOWS) {
            if (a * 60 > mins && (nextStart === null || a * 60 < nextStart))
                nextStart = a * 60;
        }
        if (nextStart === null)
            nextStart = DAY_MIN + PEAK_WINDOWS[0][0] * 60;         // 明天 9:00（相对今天的分钟数）
        return { peak: false, secondsToSwitch: (nextStart - mins) * 60, next: 'peak' };
    }

    // ---------------- 轻量提示 UI（自绘，风格贴近插件气泡） ----------------
    let toastEl = null;
    let bagdeEl = null;

    function ensureStyles() {
        if (document.getElementById('dshw-enhance-style'))
            return;
        const st = document.createElement('style');
        st.id = 'dshw-enhance-style';
        st.textContent = `
          /* ---- 三态主题：dark(默认) / light / glass ---- */
          :root {
            --dshwe-fg: #eaf0ff; --dshwe-dim: #cfe0ff; --dshwe-accent: #ffe6a8;
            --dshwe-bg: rgba(24, 30, 48, .92); --dshwe-bg2: rgba(24, 30, 48, .82);
            --dshwe-line: rgba(255,255,255,.14); --dshwe-blur: none;
          }
          :root[data-dshw-theme="light"] {
            --dshwe-fg: #1e2a44; --dshwe-dim: #40587f; --dshwe-accent: #8a5a00;
            --dshwe-bg: rgba(255,255,255,.95); --dshwe-bg2: rgba(255,255,255,.88);
            --dshwe-line: rgba(20,30,60,.16);
          }
          :root[data-dshw-theme="glass"] {
            --dshwe-fg: #f2f6ff; --dshwe-dim: #d8e4ff;
            --dshwe-bg: rgba(18, 24, 40, .55); --dshwe-bg2: rgba(18, 24, 40, .45);
            --dshwe-blur: blur(16px) saturate(1.4);
          }
          .dshwe-toast, .dshwe-badge, .dshwe-fx, .dshwe-chart {
            font-family: system-ui, "Noto Sans CJK SC", sans-serif;
            box-sizing: border-box;
            backdrop-filter: var(--dshwe-blur);
            -webkit-backdrop-filter: var(--dshwe-blur);
          }
          .dshwe-toast {
            position: fixed; z-index: 2147483000; max-width: min(320px, calc(100vw - 24px));
            padding: 10px 14px; border-radius: 12px;
            background: var(--dshwe-bg); color: var(--dshwe-fg);
            border: 1px solid var(--dshwe-line);
            font-size: 13px; line-height: 1.6;
            box-shadow: 0 6px 22px rgba(0,0,0,.35);
            pointer-events: none; opacity: 0; transition: opacity .25s ease;
          }
          .dshwe-toast.on { opacity: 1; }
          .dshwe-badge {
            position: fixed; z-index: 2147482999;
            padding: 3px 8px; border-radius: 999px;
            background: var(--dshwe-bg2); color: var(--dshwe-dim);
            border: 1px solid var(--dshwe-line);
            font-size: 11px; line-height: 1.5;
            pointer-events: none; white-space: nowrap;
          }
          .dshwe-badge.wrap { white-space: normal; }
          .dshwe-fx {
            position: fixed; z-index: 2147483001;
            padding: 3px 9px; border-radius: 999px;
            background: var(--dshwe-bg2); color: var(--dshwe-accent);
            border: 1px solid var(--dshwe-line);
            font-size: 11px; line-height: 1.5;
            cursor: pointer; white-space: nowrap; user-select: none;
          }
          .dshwe-chart {
            position: fixed; z-index: 2147483002;
            padding: 8px 10px 6px; border-radius: 12px;
            background: var(--dshwe-bg); color: var(--dshwe-fg);
            border: 1px solid var(--dshwe-line);
            font-size: 11px; line-height: 1.4;
            pointer-events: none; display: none; min-width: 168px;
          }
          .dshwe-chart.on { display: block; }
          .dshwe-chart .dshwe-bars {
            display: flex; align-items: flex-end; gap: 3px; height: 42px; margin: 6px 0 2px;
          }
          .dshwe-chart .dshwe-bar {
            width: 10px; border-radius: 2px 2px 0 0;
            background: linear-gradient(180deg, #7cc7ff, #3f7fd6);
          }
          .dshwe-chart .dshwe-bar.hot { background: linear-gradient(180deg, #ffc98a, #e0813f); }
          .dshwe-chart .dshwe-xrow {
            display: flex; gap: 3px; color: var(--dshwe-dim); font-size: 9px;
          }
          .dshwe-chart .dshwe-xrow span { width: 10px; text-align: center; }

          /* ---- 多套气泡组：同时作用于插件气泡与增强层浮层 ---- */
          /* 注意：插件自己重置了 .dshwv-pop 的 background/border（带 !important），
             所以改背景色对它没用；它气泡本体是 SVG，得改 path 的 fill 才看得见。 */
          .dshwv-pop .dshwv-bshape, .dshwv-pop .dshwv-b1, .dshwv-pop .dshwv-b2 {
            transition: fill .2s;
          }
          :root[data-dshw-bubble="night"] .dshwv-pop .dshwv-bshape,
          :root[data-dshw-bubble="night"] .dshwv-pop .dshwv-b1,
          :root[data-dshw-bubble="night"] .dshwv-pop .dshwv-b2 { fill: #141a2a !important; }
          :root[data-dshw-bubble="night"] .dshwv-pop .dshwv-text { color: #dce6ff !important; }
          :root[data-dshw-bubble="sakura"] .dshwv-pop .dshwv-bshape,
          :root[data-dshw-bubble="sakura"] .dshwv-pop .dshwv-b1,
          :root[data-dshw-bubble="sakura"] .dshwv-pop .dshwv-b2 { fill: #3c1e2c !important; }
          :root[data-dshw-bubble="sakura"] .dshwv-pop .dshwv-text { color: #ffe1ec !important; }
          :root[data-dshw-bubble="mint"] .dshwv-pop .dshwv-bshape,
          :root[data-dshw-bubble="mint"] .dshwv-pop .dshwv-b1,
          :root[data-dshw-bubble="mint"] .dshwv-pop .dshwv-b2 { fill: #12302a !important; }
          :root[data-dshw-bubble="mint"] .dshwv-pop .dshwv-text { color: #d6fff0 !important; }
          :root[data-dshw-bubble="night"] .dshwe-toast {
            background: rgba(12,16,28,.95); border-color: rgba(120,160,255,.28); border-radius: 10px;
          }
          :root[data-dshw-bubble="sakura"] .dshwe-toast {
            background: rgba(60,30,44,.94); border-color: rgba(255,170,200,.38); border-radius: 16px;
          }
          :root[data-dshw-bubble="mint"] .dshwe-toast {
            background: rgba(18,44,38,.94); border-color: rgba(140,240,200,.34); border-radius: 16px;
          }

          /* ---- 迷你控制条（气泡组 / 图表口径 / 一键抠图） ---- */
          .dshwe-ctl {
            position: fixed; z-index: 2147483003;
            display: flex; gap: 3px; padding: 3px;
            border-radius: 999px;
            background: var(--dshwe-bg2); border: 1px solid var(--dshwe-line);
            backdrop-filter: var(--dshwe-blur);
            -webkit-backdrop-filter: var(--dshwe-blur);
          }
          .dshwe-ctl button {
            all: unset; cursor: pointer;
            width: 21px; height: 18px; line-height: 18px; text-align: center;
            font-size: 11px; border-radius: 999px; user-select: none;
          }
          .dshwe-ctl button:hover { background: rgba(255,255,255,.16); }
          .dshwe-ctl button:active { background: rgba(255,255,255,.26); }

          /* ---- 心情状态（用滤镜脉冲表达，不动 transform，避免和插件的镜像动画打架） ---- */
          @keyframes dshwe-mood-excited {
            0%,100% { filter: saturate(1.15) brightness(1) }
            45%     { filter: saturate(1.45) brightness(1.14) }
          }
          @keyframes dshwe-mood-angry {
            0%,100% { filter: contrast(1.05) hue-rotate(0deg) }
            50%     { filter: contrast(1.2) hue-rotate(9deg) brightness(.95) }
          }
          @keyframes dshwe-mood-tired {
            0%,100% { filter: brightness(.95) saturate(.9) }
            50%     { filter: brightness(.85) saturate(.78) }
          }
          :root[data-dshw-mood="excited"] .dshwv-img { animation: dshwe-mood-excited 1.2s ease-in-out 3; }
          :root[data-dshw-mood="angry"]   .dshwv-img { animation: dshwe-mood-angry .6s ease-in-out 4; }
          :root[data-dshw-mood="tired"]   .dshwv-img { animation: dshwe-mood-tired 3.2s ease-in-out infinite; }
          :root[data-dshw-mood="happy"]   .dshwv-img { filter: saturate(1.16) brightness(1.05); }
          :root[data-dshw-mood="worried"] .dshwv-img { filter: hue-rotate(-8deg) saturate(.95); }
        `;
        (document.head || document.documentElement).appendChild(st);
    }

    // ---------------- 主题 / 气泡皮肤 ----------------
    function applyTheme() {
        let t = cfg.theme;
        if (t === 'auto') {
            try {
                t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
            } catch (_e) {
                t = 'dark';
            }
        }
        document.documentElement.dataset.dshwTheme = t;
        document.documentElement.dataset.dshwBubble = cfg.bubbleSkin;
    }

    /** 鲸鱼当前所在位置，用来把提示贴在鲸鱼上方 */
    function anchor() {
        const img = document.querySelector('.dshwv-img');
        const r = img ? img.getBoundingClientRect() : null;
        if (!r || r.width < 2)
            return { x: window.innerWidth - 260, y: window.innerHeight - 200, w: 200 };
        return { x: r.left, y: r.top, w: r.width };
    }

    /** 浮动提示：底部贴鲸鱼头顶上方 */
    function toast(text, ms = 6000) {
        ensureStyles();
        // 插件自己的 UI 正开着 → 让位，稍后重试（最多 3 次）
        if (pluginUiBusy() && (toast._retry = (toast._retry || 0) + 1) <= 3) {
            setTimeout(() => toast(text, ms), 6000);
            return;
        }
        toast._retry = 0;
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.className = 'dshwe-toast';
            mount(toastEl);
        }
        toastEl.textContent = text;
        const a = anchor();
        place(toastEl, a.x, Math.round(a.y - 50), { above: true });
        toastEl.classList.add('on');
        toastEl.style.visibility = '';
        clearTimeout(toast._t);
        toast._t = setTimeout(() => toastEl && toastEl.classList.remove('on'), ms);
        console.log(NS, '提示：' + text);
    }

    /** 常驻角标：紧贴鲸鱼头顶上方（汇率角标之上） */
    function badge(text, color) {
        if (!cfg.badge || !overlayAllowed())
            return;
        ensureStyles();
        if (!bagdeEl) {
            bagdeEl = document.createElement('div');
            bagdeEl.className = 'dshwe-badge';
            mount(bagdeEl);
        }
        bagdeEl.textContent = text;
        bagdeEl.style.color = color;
        const a = anchor();
        place(bagdeEl, a.x, Math.round(a.y - 26), { above: true });
    }

    /**
     * 让浮层跟着鲸鱼走。
     * 鲸鱼会浮动/被拖动，而角标只在自己更新时定位一次（可能间隔 20s）——
     * 不校准就会出现「鲸鱼走了、角标留在原地」的错位。
     *
     * 同时负责「与插件自身 UI 避让」：插件的气泡/菜单/面板都出现在鲸鱼**上方**，
     * 与增强层角标是同一块地盘，不避让就会糊在一起
     * （用户实机反馈「泡泡窗口渲染有问题」：截图里插件的「DeepSeek 余额 / 今日已用」
     *   面板与我们的汇率、峰谷角标完全重叠，OCR 都把这几行归成了一个区域）。
     */
    let lastAnchorKey = '';
    function follow() {
        let a;
        try {
            a = anchor();
        } catch (_e) {
            return;
        }
        let busy = false;
        try {
            busy = pluginUiBusy();
        } catch (_e) { /* 忽略 */ }
        const k = Math.round(a.x) + ',' + Math.round(a.y) + (busy ? '|busy' : '');
        if (k === lastAnchorKey)
            return;
        lastAnchorKey = k;
        log('follow: busy=' + busy + ' k=' + k);
        try {
            // 插件自己弹东西 → 我们的浮层让位
            for (const el of [bagdeEl, fxEl, chartEl, ctlEl])
                if (el) el.style.visibility = busy ? 'hidden' : '';
            applyMatteUrl();                 // 插件重设形象图后，把抠图结果补回来
            if (busy)
                return;
            if (bagdeEl && bagdeEl.textContent && cfg.badge)
                place(bagdeEl, a.x, Math.round(a.y - STACK.badge), { above: true });
            if (fxEl && fxEl.textContent && fxEl.style.display !== 'none')
                place(fxEl, a.x, Math.round(a.y - STACK.fx), { above: true });
            if (ctlEl && cfg.ctlBar)
                place(ctlEl, a.x, Math.round(a.y - STACK.ctl), { above: true });
            if (chartEl && chartEl.classList.contains('on'))
                place(chartEl, a.x, Math.round(a.y - STACK.chart), { above: true });
        } catch (_e) { /* 忽略 */ }
    }

    // ---------------- 与插件自身 UI 的避让 ----------------
    const PLUGIN_UI_SELS = [
        '.dshwv-pop-open',                    // 插件自己的气泡（SVG 白底气泡，就画在鲸鱼上方）
        '.dshwv-menu', '.dshwv-rolelist', '.dshwv-audiolist', '.dshwv-usagepanel',
        '.dshwv-custmenu', '.dshwv-qedit', '.dshwv-usage-mask', '.dshwv-audiomask',
        '.dshwv-cropmask', '.dshwv-confirmmask', '.dshwv-snapmask', '.dshwv-bubmask',
        '.dshwv-resmask', '.dshwv-gifmask',
    ];

    /** 元素是否真的可见（且不是 0 尺寸） */
    function shown(el) {
        let cs;
        try {
            cs = getComputedStyle(el);
        } catch (_e) {
            return false;
        }
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05)
            return false;
        const r = el.getBoundingClientRect();
        return r.width >= 40 && r.height >= 30;
    }

    /**
     * 沿祖先链的**有效不透明度**。
     * opacity 是相乘的：父元素 opacity:0 时，子元素再写 opacity:1 也看不见。
     * 插件气泡正是这么隐藏的 —— 容器 .dshwv-text 是 opacity:0，
     * 而它里面的 .dshwv-label / .dshwv-amount 都是 opacity:1（只看自身就会误判成“气泡正在显示”）。
     */
    function effectiveOpacity(el, stopAt) {
        let o = 1;
        let n = el;
        while (n && n !== document.documentElement) {
            let cs;
            try {
                cs = getComputedStyle(n);
            } catch (_e) {
                break;
            }
            const v = parseFloat(cs.opacity);
            if (!isNaN(v))
                o *= v;
            if (o < 0.05)
                return o;
            if (n === stopAt)
                break;
            n = n.parentElement;
        }
        return o;
    }

    /**
     * 插件气泡里是否真有内容。
     * 气泡容器（.dshwv-pop）是**常驻**的，内容用 SVG/绝对定位绘制，
     * 隐藏时靠**祖先 opacity: 0** 淡出 —— 所以必须算有效不透明度，
     * 既不能看容器本身，也不能用 textContent（它不理会 opacity/display）。
     */
    function bubbleShown() {
        const pop = document.querySelector('.dshwv-pop');
        if (!pop || !shown(pop))
            return false;
        for (const el of pop.querySelectorAll('*')) {
            let cs;
            try {
                cs = getComputedStyle(el);
            } catch (_e) {
                continue;
            }
            if (cs.display === 'none' || cs.visibility === 'hidden')
                continue;
            if (effectiveOpacity(el, pop) < 0.06)
                continue;
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4)
                continue;
            const own = Array.from(el.childNodes)
                .filter((n) => n.nodeType === 3)
                .map((n) => n.textContent.trim()).join('').trim();
            if (own)
                return true;
            const bg = cs.backgroundColor;
            if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)')
                return true;
            if (cs.backgroundImage && cs.backgroundImage !== 'none')
                return true;
        }
        return false;
    }

    /** 插件自己的 UI 是否正占着鲸鱼上方那块地方 */
    /** 增强层浮层是否允许显示：插件自己的气泡/面板在显示时先让位 */
    function overlayAllowed() {
        return !pluginUiBusy();
    }

    function pluginUiBusy() {
        for (const s of PLUGIN_UI_SELS) {
            let els;
            try {
                els = document.querySelectorAll(s);
            } catch (_e) {
                continue;
            }
            for (const el of els) {
                if (shown(el))
                    return true;
            }
        }
        return bubbleShown();
    }

    function mmss(sec) {
        if (sec < 0)
            return '—';
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
    }

    // ---------------- 多币种汇率（对齐官方 Windows 独立版） ----------------
    // 余额走插件自己的 /dsh-whale/balance.json（稳定接口，同源）；汇率走开放接口 + 本地缓存
    const FX_TTL = 6 * 3600 * 1000;    // 汇率缓存 6 小时
    const BAL_TTL = 60 * 1000;         // 余额缓存 60 秒
    const SYM = { CNY: '¥', USD: '$', EUR: '€', JPY: '¥', GBP: '£', HKD: 'HK$' };

    let fxEl = null;
    let fxCache = null;
    let balCache = null;
    let fxFetching = false;

    function readCached(key, ttl) {
        try {
            const j = JSON.parse(localStorage.getItem(key) || 'null');
            if (j && j.at && Date.now() - j.at < ttl)
                return j;
        } catch (_e) { /* 忽略 */ }
        return null;
    }

    async function loadFx(base) {
        if (fxFetching)
            return fxCache;
        fxFetching = true;
        try {
            const r = await fetch('https://open.er-api.com/v6/latest/' +
                encodeURIComponent(base), { cache: 'no-store' });
            const j = await r.json();
            if (j && j.rates) {
                fxCache = { base, rates: j.rates, at: Date.now() };
                localStorage.setItem('dshwFx', JSON.stringify(fxCache));
                log('汇率已更新 base=' + base);
                notice('汇率拉取成功 base=' + base + '（' + Object.keys(j.rates).length + ' 种货币）');
            }
        } catch (e) {
            log('汇率获取失败（沿用缓存）: ' + e);
            notice('汇率拉取失败，沿用缓存: ' + e);
            noteError('fx');
        } finally {
            fxFetching = false;
        }
        return fxCache;
    }

    async function loadBalance() {
        const c = readCached('dshwBal', BAL_TTL);
        if (c) {
            balCache = { total: c.total, currency: c.currency, at: c.at };
            return balCache;
        }
        try {
            const r = await fetch('/dsh-whale/balance.json', { cache: 'no-store' });
            const j = await r.json();
            if (j && j.ok && typeof j.totalBalance === 'number') {
                balCache = { total: j.totalBalance, currency: j.currency || 'CNY', at: Date.now() };
                localStorage.setItem('dshwBal', JSON.stringify(balCache));
            }
        } catch (e) {
            log('余额读取失败: ' + e);
            noteError('balance');
        }
        return balCache;
    }

    function ensureFxEl() {
        ensureStyles();
        if (fxEl)
            return fxEl;
        fxEl = document.createElement('div');
        fxEl.className = 'dshwe-fx';
        fxEl.title = '左键切换币种（USD → EUR → JPY → GBP → HKD → 关）｜右键查看近 7 日账单';
        fxEl.addEventListener('click', () => {
            const i = FX_CYCLE.indexOf(cfg.fxCurrency);
            cfg.fxCurrency = FX_CYCLE[(i + 1) % FX_CYCLE.length];
            writeCfg();
            if (fxEl)
                fxEl.style.display = 'none';      // 先隐藏，避免切换瞬间显示错币种
            tickFx();
            toast('💱 汇率显示：' + (cfg.fxCurrency === 'OFF' ? '已关闭' : cfg.fxCurrency), 3000);
        });
        // 右键：手动看一次近 7 日账单图表
        fxEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showChart();
        });
        mount(fxEl);
        return fxEl;
    }

    async function tickFx() {
        const cur = cfg.fxCurrency;
        const bal = await loadBalance();
        // 余额变了（通常刚跑完一轮）→ 冒一次账单图表
        if (bal && typeof bal.total === 'number') {
            if (lastBalSeen !== null && Math.abs(lastBalSeen - bal.total) > 0.001)
                showChart();
            lastBalSeen = bal.total;
        }
        if (!cur || cur === 'OFF') {
            if (fxEl)
                fxEl.style.display = 'none';
            return;
        }
        if (!bal)
            return;

        let rate = 1;
        if (bal.currency !== cur) {
            let c = readCached('dshwFx', FX_TTL) || fxCache;
            if (!c || c.base !== bal.currency)
                c = await loadFx(bal.currency);
            if (!c || !c.rates || typeof c.rates[cur] !== 'number') {
                log('拿不到 ' + bal.currency + '→' + cur + ' 汇率，不显示（避免显示错数据）');
                notice('拿不到 ' + bal.currency + '→' + cur + ' 汇率，暂不显示');
                return;
            }
            rate = c.rates[cur];
        }

        const el = ensureFxEl();
        const digits = cur === 'JPY' ? 0 : 2;
        el.style.display = '';
        el.textContent = '💱 ' + (SYM[bal.currency] || '') + bal.total.toFixed(2) +
            ' ≈ ' + (SYM[cur] || '') + (bal.total * rate).toFixed(digits) + ' ' + cur;
        notice('汇率显示已更新：' + el.textContent);
        if (overlayAllowed()) {
            const a = anchor();
            place(el, a.x, Math.round(a.y - 2), { above: true });
        }
    }

    // ---------------- 账单图表（近 7 日用量柱状图） ----------------
    let chartEl = null;
    let chartHideT = 0;
    let lastBalSeen = null;

    async function loadUsage() {
        try {
            const r = await fetch('/dsh-whale/usage-records.json', { cache: 'no-store' });
            const j = await r.json();
            if (j && j.ok && Array.isArray(j.days7) && j.days7.length)
                return j;
            log('用量数据不可用: ' + (j && j.error));
        } catch (e) {
            log('用量读取失败: ' + e);
        }
        return null;
    }

    function ensureChartEl() {
        ensureStyles();
        if (chartEl)
            return chartEl;
        chartEl = document.createElement('div');
        chartEl.className = 'dshwe-chart';
        mount(chartEl);
        return chartEl;
    }

    async function showChart(seconds) {
        if (!cfg.chartOn)
            return;
        const u = await loadUsage();
        if (!u)
            return;
        const s = buildSeries(u, CHART_MODES.indexOf(cfg.chartMode) >= 0 ? cfg.chartMode : 'day');
        const max = Math.max.apply(null, s.values.concat([0.0001]));
        const total = s.values.reduce((a, b) => a + b, 0);
        let bars = '';
        let xrow = '';
        for (let i = 0; i < s.values.length; i++) {
            const h = Math.max(2, Math.round((s.values[i] / max) * 38));
            bars += '<div class="dshwe-bar' + (i === s.hot ? ' hot' : '') +
                    '" style="height:' + h + 'px"></div>';
            xrow += '<span>' + s.labels[i] + '</span>';
        }
        const el = ensureChartEl();
        el.innerHTML =
            '<div>📊 ' + s.title + '（' + CHART_MODE_NAME[cfg.chartMode] + '）' + s.currency +
            '　共 ' + total.toFixed(2) + '</div>' +
            '<div class="dshwe-bars">' + bars + '</div>' +
            '<div class="dshwe-xrow">' + xrow + '</div>';
        const a = anchor();
        const lift = (toastEl && toastEl.classList.contains('on')) ? toastEl.offsetHeight + 6 : 0;
        el.classList.add('on');
        place(el, a.x, Math.round(a.y - STACK.chart - lift), { above: true });
        clearTimeout(chartHideT);
        chartHideT = setTimeout(() => el.classList.remove('on'),
            (Number(seconds) || cfg.chartSeconds) * 1000);
        if (u.today)
            todaySpend = Number(u.today.total) || 0;
        notice('账单图表已显示（' + s.title + '，峰值 ' + max.toFixed(2) + ' ' + s.currency + '）');
    }

    // ---------------- 台词轮播 ----------------
    const SPEECH = [
        '今天也要好好写代码呀～',
        '记得喝水，别一直盯着屏幕。',
        '余额还够，放心跑～',
        '高峰时段贵三倍，能等就等等。',
        '你这个 bug 一定找得出来的。',
        '要不要先提交一次再改？',
        '深呼吸，然后继续。',
        '我在这儿陪着你呢。',
        '深夜写代码效率高，但也要睡觉。',
        '谷价时段是跑量的好时候！',
        '别忘了给自己留点休息时间。',
        '代码写完就提交，别攒着。',
        '今天的你也辛苦了。',
        '要不要整理一下 TODO？',
    ];
    let speechT = 0;

    function scheduleSpeech() {
        clearTimeout(speechT);
        if (!cfg.speechOn)
            return;
        const ms = Math.max(1, Number(cfg.speechMinutes) || 10) * 60000;
        speechT = setTimeout(() => {
            try {
                if (cfg.speechOn && !(toastEl && toastEl.classList.contains('on')) &&
                    !(chartEl && chartEl.classList.contains('on'))) {
                    toast('🐳 ' + pickLine(), 9000);
                }
            } catch (_e) { /* 忽略 */ }
            scheduleSpeech();
        }, ms);
    }

    // ================= 气泡组（可新建 / 切换 / 删除） =================
    // 内置 4 套预设，用户还能自己加。一组 = 「气泡填充色 + 文字色 + 圆角 + 强调色」，
    // 同时作用于**插件自己的 SVG 气泡**和增强层浮层（插件用 !important 重置了容器背景，
    // 所以必须改 SVG path 的 fill，见上面的注释）。
    const BUILTIN_GROUPS = [
        { id: 'classic', name: '经典', fill: '#ffffff', text: '#1f3a8a', radius: 14, accent: '#ffe6a8' },
        { id: 'night', name: '暗夜', fill: '#141a2a', text: '#dce6ff', radius: 10, accent: '#9ec3ff' },
        { id: 'sakura', name: '樱花', fill: '#3c1e2c', text: '#ffe1ec', radius: 16, accent: '#ffb3d1' },
        { id: 'mint', name: '薄荷', fill: '#12302a', text: '#d6fff0', radius: 16, accent: '#8ef0c8' },
    ];

    function bubbleGroups() {
        const custom = (Array.isArray(cfg.bubbleGroups) ? cfg.bubbleGroups : [])
            .filter((g) => g && g.id && g.fill && g.text);
        const ids = new Set(custom.map((g) => g.id));
        return custom.concat(BUILTIN_GROUPS.filter((g) => !ids.has(g.id)));
    }

    function currentGroup() {
        const list = bubbleGroups();
        return list.find((g) => g.id === cfg.bubbleSkin) || list[0];
    }

    /** 把「当前组」写进一张动态样式表（用户自建的组走这里；内置组另有静态规则） */
    function applyBubbleGroup() {
        const old = document.getElementById('dshwe-group-style');
        if (old) old.remove();
        const g = currentGroup();
        const custom = (Array.isArray(cfg.bubbleGroups) ? cfg.bubbleGroups : [])
            .some((x) => x && x.id === g.id);
        let css = '';
        if (custom) {
            css +=
                `:root[data-dshw-bubble="${g.id}"] .dshwv-pop .dshwv-bshape,\n` +
                `:root[data-dshw-bubble="${g.id}"] .dshwv-pop .dshwv-b1,\n` +
                `:root[data-dshw-bubble="${g.id}"] .dshwv-pop .dshwv-b2 { fill: ${g.fill} !important; }\n` +
                `:root[data-dshw-bubble="${g.id}"] .dshwv-pop .dshwv-text { color: ${g.text} !important; }\n` +
                `:root[data-dshw-bubble="${g.id}"] .dshwe-toast,\n` +
                `:root[data-dshw-bubble="${g.id}"] .dshwe-badge,\n` +
                `:root[data-dshw-bubble="${g.id}"] .dshwe-fx,\n` +
                `:root[data-dshw-bubble="${g.id}"] .dshwe-ctl {\n` +
                `  background: ${g.fill}; color: ${g.text}; border-color: ${g.text}33; }\n`;
        }
        css += `:root[data-dshw-bubble="${g.id}"] .dshwe-toast { border-radius: ${g.radius}px; }\n`;
        if (custom)
            css += `:root[data-dshw-bubble="${g.id}"] .dshwe-fx { color: ${g.accent} !important; }\n`;
        const st = document.createElement('style');
        st.id = 'dshwe-group-style';
        st.textContent = css;
        (document.head || document.documentElement).appendChild(st);
    }

    const bubbleApi = {
        list: () => bubbleGroups().map((g) => ({ id: g.id, name: g.name, custom: !BUILTIN_GROUPS.some((b) => b.id === g.id) })),
        current: () => currentGroup().id,
        use(id) {
            const g = bubbleGroups().find((x) => x.id === id);
            if (!g)
                return { ok: false, error: '没有这个气泡组：' + id };
            cfg.bubbleSkin = id;
            writeCfg();
            applyBubbleGroup();
            applyTheme();
            toast('🎨 气泡组 → 「' + g.name + '」', 3000);
            return { ok: true, id };
        },
        next() {
            const list = bubbleGroups();
            const i = list.findIndex((g) => g.id === cfg.bubbleSkin);
            return bubbleApi.use(list[(i + 1) % list.length].id);
        },
        /** add('我的配色', {fill:'#101820', text:'#ffe9b0', radius:14, accent:'#ffd166'}) */
        add(name, spec) {
            if (!name)
                return { ok: false, error: '需要给气泡组起个名字' };
            const s = spec || {};
            const g = {
                id: 'g' + Date.now().toString(36),
                name: String(name),
                fill: s.fill || '#ffffff',
                text: s.text || '#1f3a8a',
                radius: Number(s.radius) || 14,
                accent: s.accent || '#ffe6a8',
            };
            cfg.bubbleGroups = (Array.isArray(cfg.bubbleGroups) ? cfg.bubbleGroups : []).concat([g]);
            writeCfg();
            applyBubbleGroup();
            return { ok: true, group: g, total: bubbleGroups().length };
        },
        remove(id) {
            const cur = Array.isArray(cfg.bubbleGroups) ? cfg.bubbleGroups : [];
            const next = cur.filter((g) => !g || g.id !== id);
            if (next.length === cur.length)
                return { ok: false, error: '内置组不能删除（只保留自定义组的增删）' };
            cfg.bubbleGroups = next;
            if (cfg.bubbleSkin === id)
                cfg.bubbleSkin = 'classic';
            writeCfg();
            applyBubbleGroup();
            applyTheme();
            return { ok: true, total: bubbleGroups().length };
        },
        clearCustom() {
            cfg.bubbleGroups = [];
            writeCfg();
            applyBubbleGroup();
            return { ok: true };
        },
    };

    // ================= 心情状态机（多状态形象） =================
    // 信号全部来自本地已有数据，不额外发请求：
    //   接口失败 → 烦躁    长时间没交互 → 困了     高峰时段 → 心疼
    //   刚被摸/拖 → 兴奋   今日花费超预算 → 心疼   谷价且余额够 → 开心
    // 表现形式：气质 emoji + 台词池 + 形象滤镜/脉冲动效（只动 filter，不动 transform，
    // 避免和插件自己的镜像 transform 打架而把鲸鱼翻转坏掉）。
    const MOODS = {
        normal: {
            emoji: '🐳', name: '平常',
            lines: ['今天也要好好写代码呀～', '我在这儿陪着你呢。', '要不要整理一下 TODO？'],
        },
        happy: {
            emoji: '😊', name: '开心',
            lines: ['余额还够，放心跑～', '今天状态不错嘛！', '嘿嘿，陪着你的感觉真好。', '谷价时段是跑量的好时候！'],
        },
        excited: {
            emoji: '🤩', name: '兴奋',
            lines: ['哇！被摸到了！', '再来一次！再来一次！', '今天干劲十足！'],
        },
        worried: {
            emoji: '😰', name: '心疼',
            lines: ['现在是高峰，贵三倍哦…', '预算要撑住啊。', '轻轻用，别跑太多～'],
        },
        tired: {
            emoji: '😪', name: '困了',
            lines: ['好困…你也要休息哦。', '我先眯一会儿…', '夜深了，明天再战？', '记得喝水，别一直盯着屏幕。'],
        },
        angry: {
            emoji: '😤', name: '烦躁',
            lines: ['接口又抽风了…', '哼！重试一下就好。', '别慌，先看看网络。'],
        },
    };
    let mood = 'normal';
    let moodAt = 0;
    let lastInteractAt = Date.now();
    let lastErrAt = 0;
    let todaySpend = 0;
    let spendAt = 0;

    function noteInteract() {
        lastInteractAt = Date.now();
    }

    function noteError(where) {
        lastErrAt = Date.now();
        log('记一次失败（影响心情）：' + where);
    }

    function computeMood() {
        const now = Date.now();
        if (!cfg.moodOn)
            return 'normal';
        if (now - lastErrAt < 90 * 1000) return 'angry';
        if (now - lastInteractAt > 8 * 60 * 1000) return 'tired';
        if (todaySpend > (Number(cfg.budgetCny) || 5)) return 'worried';
        if (peakState().peak) return 'worried';
        if (now - lastInteractAt < 25 * 1000) return 'excited';
        return 'happy';
    }

    function pickLine() {
        const m = MOODS[mood] || MOODS.normal;
        const pool = (m.lines && m.lines.length) ? m.lines : SPEECH;
        return pool[Math.floor(Math.random() * pool.length)];
    }

    function applyMood() {
        const next = computeMood();
        const changed = next !== mood;
        mood = next;
        const m = MOODS[mood] || MOODS.normal;
        document.documentElement.dataset.dshwMood = mood;
        if (changed) {
            moodAt = Date.now();
            notice('心情 → ' + m.name + ' ' + m.emoji);
            if (cfg.speechOn && overlayAllowed())
                toast(m.emoji + ' ' + pickLine(), 6000);
        }
        return mood;
    }

    async function maybeRefreshSpend() {
        if (Date.now() - spendAt < 60 * 1000)
            return;
        spendAt = Date.now();
        const u = await loadUsage();
        if (u && u.today)
            todaySpend = Number(u.today.total) || 0;
    }

    // ================= 离线一键抠图 =================
    // 为什么自研而不是上 BiRefNet + onnxruntime：
    //   官方那条线用 BiRefNet，模型上百 MB、还要背一个推理运行时 —— 对一个桌面挂件来说
    //   包体和启动代价都不划算（路线图里也标了「暂不建议」）。
    //   这里用**边界泛洪 + 羽化**，纯浏览器端、零依赖、离线：
    //     · 从四条边界往里长，只吃掉「与当前像素颜色接近」的邻居（连通域）
    //       → 渐变背景也能吃掉，而角色内部与背景同色的区域不会被误删
    //     · 对 alpha 做一次 3x3 均值当羽化，边缘不会有硬锯齿
    //   对「纯色 / 渐变背景」的立绘效果好；复杂背景仍建议用插件自带的裁剪框。
    const MATTE_MAX = 1024;

    function floodMatte(d, w, h, tol) {
        const tol2 = tol * tol * 3;
        const isBg = new Uint8Array(w * h);
        const stack = [];
        const seed = (x, y) => {
            const p = y * w + x;
            if (!isBg[p]) { isBg[p] = 1; stack.push(p); }
        };
        for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
        for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
        let removed = 0;
        while (stack.length) {
            const p = stack.pop();
            removed++;
            const x = p % w;
            const y = (p - x) / w;
            const i = p * 4;
            const r = d[i], g = d[i + 1], b = d[i + 2];
            for (let k = 0; k < 4; k++) {
                const nx = x + (k === 0 ? -1 : (k === 1 ? 1 : 0));
                const ny = y + (k === 2 ? -1 : (k === 3 ? 1 : 0));
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                const q = ny * w + nx;
                if (isBg[q]) continue;
                const j = q * 4;
                // 半透明像素不参与泛洪（避免把羽化过的旧抠图越抠越多）
                if (d[j + 3] < 200) continue;
                const dr = d[j] - r, dg = d[j + 1] - g, db = d[j + 2] - b;
                if (dr * dr + dg * dg + db * db <= tol2) { isBg[q] = 1; stack.push(q); }
            }
        }
        for (let p = 0; p < w * h; p++)
            if (isBg[p]) d[p * 4 + 3] = 0;
        return removed;
    }

    function featherAlpha(d, w, h, radius) {
        const src = new Uint8Array(w * h);
        for (let p = 0; p < w * h; p++) src[p] = d[p * 4 + 3];
        const r = radius || 1;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let sum = 0, n = 0;
                for (let dy = -r; dy <= r; dy++) {
                    const ny = y + dy;
                    if (ny < 0 || ny >= h) continue;
                    for (let dx = -r; dx <= r; dx++) {
                        const nx = x + dx;
                        if (nx < 0 || nx >= w) continue;
                        sum += src[ny * w + nx];
                        n++;
                    }
                }
                d[(y * w + x) * 4 + 3] = Math.round(sum / n);
            }
        }
    }

    async function autoMatte() {
        const img = document.querySelector('.dshwv-img');
        if (!img)
            return { ok: false, error: '还没找到挂件形象图' };
        const url = img.currentSrc || img.src;
        let bmp;
        try {
            const r = await fetch(url, { cache: 'no-store' });
            bmp = await createImageBitmap(await r.blob());
        } catch (e) {
            return { ok: false, error: '取形象图失败：' + e };
        }
        const scale = Math.min(1, MATTE_MAX / Math.max(bmp.width, bmp.height));
        const cw = Math.max(1, Math.round(bmp.width * scale));
        const ch = Math.max(1, Math.round(bmp.height * scale));
        const c = document.createElement('canvas');
        c.width = cw;
        c.height = ch;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0, cw, ch);
        let im;
        try {
            im = ctx.getImageData(0, 0, cw, ch);
        } catch (e) {
            return { ok: false, error: '画布读不出来（跨域限制）' };
        }
        const removed = floodMatte(im.data, cw, ch, Number(cfg.matteTolerance) || 34);
        featherAlpha(im.data, cw, ch, 1);
        ctx.putImageData(im, 0, 0);
        return {
            ok: true, dataUrl: c.toDataURL('image/png'),
            width: cw, height: ch, removed,
            ratio: +(removed / (cw * ch)).toFixed(3),
        };
    }

    function applyMatteUrl() {
        const img = document.querySelector('.dshwv-img');
        if (!img)
            return;
        if (cfg.matteOn && cfg.matteUrl) {
            if (!img.dataset.dshwOrigSrc)
                img.dataset.dshwOrigSrc = img.getAttribute('src') || '';
            if (img.getAttribute('src') !== cfg.matteUrl)
                img.setAttribute('src', cfg.matteUrl);
        } else if (img.dataset.dshwOrigSrc) {
            if (img.getAttribute('src') !== img.dataset.dshwOrigSrc)
                img.setAttribute('src', img.dataset.dshwOrigSrc);
            delete img.dataset.dshwOrigSrc;
        }
    }

    async function runMatte() {
        const bridge = window.dshwBridge;
        if (!bridge || !bridge.saveMatte) {
            toast('✂️ 当前形态不支持抠图（缺少 IPC 桥）', 6000);
            return { ok: false, error: 'no bridge' };
        }
        toast('✂️ 正在抠图…', 4000);
        const r = await autoMatte();
        if (!r.ok) {
            toast('✂️ 抠图失败：' + r.error, 6000);
            noteError('matte');
            return r;
        }
        const saved = await bridge.saveMatte(r.dataUrl);
        if (!saved || !saved.ok) {
            toast('✂️ 结果保存失败：' + ((saved && saved.error) || '未知'), 6000);
            return { ok: false, error: (saved && saved.error) || 'save failed' };
        }
        cfg.matteOn = true;
        cfg.matteUrl = saved.url;
        writeCfg();
        applyMatteUrl();
        toast('✂️ 抠图完成：背景占 ' + Math.round(r.ratio * 100) + '%，已应用', 6000);
        notice('抠图完成 ' + r.width + 'x' + r.height + '，背景占比 ' + r.ratio);
        return { ...r, url: saved.url };
    }

    function resetMatte() {
        cfg.matteOn = false;
        writeCfg();
        applyMatteUrl();
        toast('✂️ 已恢复原始形象图', 4000);
        return { ok: true };
    }

    // ================= 账单图表：时 / 天 / 月 三种口径 =================
    const CHART_MODES = ['hour', 'day', 'month'];
    const CHART_MODE_NAME = { hour: '时', day: '天', month: '月' };

    function buildSeries(u, mode) {
        const cur = u.total7Currency || 'CNY';
        if (mode === 'hour') {
            const today = (u.today && u.today.date) || '';
            const buckets = new Array(12).fill(0);
            const evs = (u.all && Array.isArray(u.all.events)) ? u.all.events : [];
            for (const e of evs) {
                if (!e || e.day !== today) continue;
                const t = new Date(Number(e.ts) || 0);
                const bh = Math.floor(t.getHours() / 2);
                if (bh >= 0 && bh < 12) buckets[bh] += Number(e.cost) || 0;
            }
            return {
                title: '今日按 2 小时', currency: cur,
                labels: buckets.map((_, i) => (i === 0 ? '0' : String(i * 2))),
                values: buckets, hot: 11,
            };
        }
        if (mode === 'month') {
            const days = (u.all && Array.isArray(u.all.days)) ? u.all.days : [];
            const map = new Map();
            for (const d of days) {
                const k = String((d && d.date) || '').slice(0, 7);
                if (!k) continue;
                map.set(k, (map.get(k) || 0) + (Number(d.total) || 0));
            }
            const keys = Array.from(map.keys()).sort().slice(-6);
            return {
                title: '近 6 个月', currency: cur,
                labels: keys.map((k) => k.slice(5)),
                values: keys.map((k) => map.get(k)), hot: keys.length - 1,
            };
        }
        const days = (u.days7 || []).slice().reverse();
        return {
            title: '近 7 日', currency: cur,
            labels: days.map((d) => String(d.date).slice(8)),
            values: days.map((d) => Number(d.total) || 0),
            hot: days.findIndex((d) => d.date === ((u.today && u.today.date) || '')),
        };
    }

    // ================= Dock 适配（DSH 小鲸鱼也要和 Dock 相安无事） =================
    /* 为什么要做：
     *   鲸鱼默认待在屏幕左下角，Dock 是「底边居中」时两者正好互不打扰（Dock 左边就是空白）。
     *   但 dash-to-dock 还能切成「底边通栏」和「左/右侧边栏」，那时鲸鱼会压在 Dock 上，
     *   或者反过来把 Dock 的可点区域盖掉。
     * 怎么做：
     *   不改插件本体（它是 vendored 的，而且拖拽时会自己写内联 inset），
     *   只给 .dshwv-root 叠一个 translate。量位置时先把 transform 清掉得到「自然位置」，
     *   再算与 Dock 矩形的冲突，最后挪到最近的空闲处 —— 优先原地抬高，其次挪进 freeX 空闲带。
     *   形状上报用的是 getBoundingClientRect，会自动跟着 transform 走，所以点击穿透依旧精确。
     */
    let dockZoneV = null;
    let dockOffsetV = { x: 0, y: 0 };
    const DOCK_M = 10;             // 与 Dock 之间留的余量（逻辑像素）
    // 0 = 完全贴屏幕底。用户明确要求「鲸鱼不要留缝」（原来 6 会空出 12 物理像素，
    // 在高分屏上看得见一条黑边）。窗口底边本身就等于屏幕底边，所以贴 innerHeight 即可。
    const BOTTOM_M = 0;

    function dockRootEl() { return document.querySelector('.dshwv-root'); }
    /**
     * 真正代表「鲸鱼看得见的部分」的元素。
     * 不能用根元素量位置：.dshwv-root 是个 175x175 的方框（含大量空白），
     * 而鲸鱼本体 .dshwv-img 只有 104 高，用根元素对齐底部会让它整个掉出窗口外。
     */
    function dockWhaleEl() { return document.querySelector('.dshwv-img') || dockRootEl(); }

    /**
     * 量出「插件自己摆的」位置。
     * 注意：**不能动 style.transform** —— 插件用它做动画，踩了会互相干扰
     * （实测偏移会在 -6 和 +75 之间乱跳）。我们的偏移走独立的 translate 属性，
     * 所以这里只清 translate 就能拿到干净的自然位置。
     */
    function dockNaturalRect(root) {
        const had = root.style.translate;
        root.style.translate = '';
        const r = root.getBoundingClientRect();
        root.style.translate = had;
        return r;
    }

    const rectHits = (a, b, m) => !(a.x + a.w + m <= b.x || a.x - m >= b.x + b.w
        || a.y + a.h + m <= b.y || a.y - m >= b.y + b.h);

    /**
     * 算出鲸鱼该放在哪：**先贴屏幕底**（用户要的就是「在下面那块空白里」），
     * 再避开 Dock —— 底边居中的 Dock 靠横向让进空闲带，底边通栏/侧边栏才抬高。
     * 插件自己那套定位只保证「贴在窗口底边」，窗口一改尺寸它就偏了，
     * 所以这里由我们统一摆位，不依赖插件。
     */
    function computeDockOffset() {
        const root = dockRootEl();
        if (!root) return { x: 0, y: 0 };
        // 用根元素量：鲸鱼本体 .dshwv-img 的底边与根元素底边重合（实测都是 937），
        // 而根元素的矩形不受图片加载状态影响，更稳定。
        const r = dockNaturalRect(root);
        const z = dockZoneV;
        const dock = (z && z.found && z.dock) ? z.dock : null;

        // ① 纵向：先想着贴屏幕底
        const dy = Math.round((innerHeight - BOTTOM_M) - r.bottom);
        const rect = { x: r.x, y: r.y + dy, w: r.width, h: r.height };
        if (!dock) return { x: 0, y: dy };            // 没有 Dock 信息：贴底就完事
        if (!rectHits(rect, dock, DOCK_M)) return { x: 0, y: dy };

        const bands = (z.freeX || []).filter(([a, b]) => b - a >= r.width + 2 * DOCK_M);
        // ② 底边居中的 Dock：横向那一段被占了，把鲸鱼挪到它旁边的空闲带（保持贴底）
        if (z.position === 'BOTTOM') {
            for (const [a] of bands) {
                const dx = Math.round(a + DOCK_M - r.left);
                if (!rectHits({ x: r.x + dx, y: rect.y, w: r.width, h: r.height }, dock, DOCK_M))
                    return { x: dx, y: dy };
            }
        }
        // ③ 侧边栏：横向让开（纵向仍贴底）。
        //    必须**逐个候选校验**：zone.freeX 只按「地板线」算，而鲸鱼有 175px 高，
        //    贴着底边时会撞到侧边栏的下端（实测左侧边栏就是这样差 19px 重叠）。
        if (z.position === 'LEFT' || z.position === 'RIGHT') {
            // 直接把鲸鱼挪到侧边栏的外侧（比 zone.freeX 更可靠：
            // freeX 只按地板线算，而鲸鱼有 175px 高，贴底时会撞到侧边栏下端）
            const dx = z.position === 'LEFT'
                ? Math.round(dock.x + dock.w + DOCK_M - r.left)
                : Math.round(dock.x - DOCK_M - r.width - r.left);
            if (!rectHits({ x: r.x + dx, y: r.y + dy, w: r.width, h: r.height }, dock, DOCK_M)
                && r.x + dx >= -2 && r.x + dx + r.width <= innerWidth + 2)
                return { x: dx, y: dy };
        }
        // ④ 兜底：把鲸鱼**顶边**放到 Dock 底边之下（侧边栏挡住左下角的情况）
        const below = Math.round(dock.y + dock.h + DOCK_M - r.top);
        if (below > 0 && !rectHits({ x: r.x, y: r.y + below, w: r.width, h: r.height }, dock, DOCK_M)
            && r.y + below + r.height <= innerHeight + 8)
            return { x: 0, y: below };
        // ⑤ 实在让不开（底边通栏 / 空闲带太窄）：抬到 Dock 之上
        return { x: 0, y: Math.round(dock.y - DOCK_M - r.bottom) };
    }

    function applyDockOffset() {
        const root = dockRootEl();
        if (!root) return;
        dockOffsetV = computeDockOffset();
        const css = (dockOffsetV.x || dockOffsetV.y)
            ? `${dockOffsetV.x}px ${dockOffsetV.y}px` : '';
        if (root.style.translate !== css) root.style.translate = css;   // 没变就不写，省一次样式重算
    }

    // 测试钩子：直接注入 Dock 占位来验证四种形态（改真实 Dock 设置会动到你的桌面）
    window.dshwDock = {
        setZone(z) { dockZoneV = z; applyDockOffset(); return dockOffsetV; },
        get zone() { return dockZoneV; },
        get offset() { return dockOffsetV; },
        recompute() { applyDockOffset(); return dockOffsetV; },
    };

    if (window.dshwBridge && window.dshwBridge.onDockZone) {
        window.dshwBridge.onDockZone((z) => { dockZoneV = z; applyDockOffset(); });
        Promise.resolve(window.dshwBridge.dockZone())
            .then((z) => { dockZoneV = z; applyDockOffset(); })
            .catch(() => { /* 拿不到 Dock 信息也不影响挂件 */ });
    }
    addEventListener('resize', () => applyDockOffset());
    // 插件拖拽会改内联 inset；低频复核一次，避免拖完又被 Dock 叠上
    setInterval(applyDockOffset, 1500);

    // ================= 迷你控制条 =================
    let ctlEl = null;

    function ensureCtlEl() {
        ensureStyles();
        if (ctlEl)
            return ctlEl;
        ctlEl = document.createElement('div');
        ctlEl.className = 'dshwe-ctl';
        const mk = (label, title, fn) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.title = title;
            b.addEventListener('click', (ev) => {
                try { ev.stopPropagation(); ev.preventDefault(); } catch (_e) { /* 忽略 */ }
                fn();
            });
            ctlEl.appendChild(b);
        };
        mk('🎨', '切换气泡组（也可 dshwEnhance.bubble.add/use/remove 自定义）', () => bubbleApi.next());
        mk('📊', '切换账单口径：时 → 天 → 月', () => {
            const i = CHART_MODES.indexOf(cfg.chartMode);
            cfg.chartMode = CHART_MODES[(i + 1) % CHART_MODES.length];
            writeCfg();
            showChart(12);
        });
        mk('✂️', '一键抠图：去掉形象图背景（离线，点第二次恢复原图）', () => {
            if (cfg.matteOn) resetMatte();
            else runMatte();
        });
        // 顺带把另一个桌宠（Live2D 鲸鱼娘）的开关放在手边：平时不用去翻托盘菜单。
        // 走 preload 的 dshwBridge → 主进程 → tools/petctl.sh，与桌面图标/自启同一套入口。
        mk('🐋', 'Live2D 鲸鱼娘桌宠：开 / 关', async () => {
            const r = await (window.dshwBridge && window.dshwBridge.petToggle
                ? window.dshwBridge.petToggle('live2d')
                : Promise.resolve({ ok: false, error: 'dshwBridge 不可用' }));
            toast(r && r.ok ? '已切换 Live2D 鲸鱼娘' : ('切换失败：' + ((r && r.error) || '未知')));
        });
        mount(ctlEl);
        return ctlEl;
    }

    // ---------------- 主循环 ----------------
    let warnedKey = '';

    function tick() {
        try {
            const s = peakState();
            // 常驻角标
            const me = (MOODS[mood] || MOODS.normal).emoji;
            if (s.secondsToSwitch >= 0)
                badge(
                    me + ' ' + (s.peak ? '⛰ 高峰 ' : '🌙 谷价 ') +
                    mmss(s.secondsToSwitch) + ' 后切换',
                    s.peak ? '#ffd7a8' : '#a8e6c8',
                );
            else
                badge(me + ' 🌙 谷价（周末）', '#a8e6c8');

            // 提前预警：距切换 ≤ leadMinutes 时提示一次
            if (cfg.peakWarn && s.secondsToSwitch >= 0 &&
                s.secondsToSwitch <= cfg.leadMinutes * 60) {
                const key = `${bjParts().dateKey}:${s.next}:${Math.floor(s.secondsToSwitch / 60)}`;
                if (key !== warnedKey) {
                    warnedKey = key;
                    if (s.next === 'peak')
                        toast(`⛰ 还有 ${Math.ceil(s.secondsToSwitch / 60)} 分钟进入高峰，` +
                              '需要跑量的话趁现在～', 9000);
                    else
                        toast(`🌙 还有 ${Math.ceil(s.secondsToSwitch / 60)} 分钟转入谷价，` +
                              '可以再等等～', 9000);
                }
            }
        } catch (e) {
            console.log(NS, 'tick 出错: ' + e);
        }
        tickFx();          // 多币种汇率（异步，内部有缓存，不会频繁请求）
        applyMood();       // 心情状态机
        maybeRefreshSpend();
    }

    function boot() {
        ensureStyles();
        applyTheme();
        applyBubbleGroup();
        applyMatteUrl();
        ensureCtlEl();
        tick();
        setInterval(tick, CHECK_MS);
        setInterval(follow, 200);          // 浮层跟随鲸鱼
        scheduleSpeech();
        // 交互信号（拖 / 点 / 摸）→ 心情；只在我们自己的窗口收到时计
        window.addEventListener('pointerdown', noteInteract, true);
        window.addEventListener('pointermove', (e) => { if (e.buttons) noteInteract(); }, true);
        console.log(NS, '增强层已加载（心情=' + cfg.moodOn + ', 气泡组=' + currentGroup().name +
            ', 色调=' + cfg.theme + ', 图表=' + cfg.chartMode +
            ', 台词=' + (cfg.speechOn ? cfg.speechMinutes + 'min' : '关') +
            ', 拍图=' + (cfg.matteOn ? '已应用' : '未启用') + '）');
        toast('✅ 桌面增强层已就绪（点鲸鱼旁的 🎨 📊 ✂️ 可以切换）', 5000);
        if (cfg.chartOn)
            setTimeout(() => showChart(), 3000);
    }

    // 对外暴露，便于调配置 / 自测 / 二次开发
    window.dshwEnhance = {
        cfg,
        set(patch) {
            Object.assign(cfg, patch || {});
            writeCfg();
            applyTheme();
            applyBubbleGroup();
            applyMatteUrl();
            scheduleSpeech();
            tick();
            return cfg;
        },
        state: peakState,
        fx: () => ({ currency: cfg.fxCurrency, rate: fxCache, balance: balCache }),
        theme(t) {
            if (THEMES.indexOf(t) >= 0) cfg.theme = t;
            writeCfg();
            applyTheme();
            return cfg.theme;
        },
        skin(s) {
            return bubbleApi.use(s);
        },
        /** 气泡组：list() / use(id) / next() / add(name,{fill,text,radius,accent}) / remove(id) */
        bubble: bubbleApi,
        /** 心情：查看当前状态与今日花费 */
        mood: () => ({
            mood,
            name: (MOODS[mood] || MOODS.normal).name,
            emoji: (MOODS[mood] || MOODS.normal).emoji,
            spend: todaySpend,
            budget: Number(cfg.budgetCny) || 5,
            since: moodAt,
            pool: Object.keys(MOODS),
        }),
        /** 手动摸一下（会影响心情） */
        pet: () => { noteInteract(); return applyMood(); },
        /** 图表口径：hour | day | month */
        setChartMode(m) {
            if (CHART_MODES.indexOf(m) >= 0) {
                cfg.chartMode = m;
                writeCfg();
            }
            return cfg.chartMode;
        },
        chart: (s) => showChart(s),
        usage: () => loadUsage(),
        /** 一键抠图（算 + 落盘 + 应用）；传 'off' 则恢复原图 */
        matte: (mode) => (mode === 'off' ? resetMatte() : runMatte()),
        /** 只算不应用，返回尺寸与背景占比，便于自测 */
        mattePreview: () => autoMatte(),
        busy: () => pluginUiBusy(),
        follow,
        toast,
    };

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', boot);
    else
        boot();
})();
