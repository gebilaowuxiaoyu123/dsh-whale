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
            theme: 'dark', bubbleSkin: 'classic',
            speechOn: true, speechMinutes: 10,
            chartOn: true, chartSeconds: 9,
        },
        readCfg(),
    );
    const FX_CYCLE = ['USD', 'EUR', 'JPY', 'GBP', 'HKD', 'OFF'];
    const THEMES = ['dark', 'light', 'glass', 'auto'];
    const SKINS = ['classic', 'night', 'sakura', 'mint'];

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
            // 插件自己弹东西 → 我们的角标让位
            for (const el of [bagdeEl, fxEl, chartEl])
                if (el) el.style.visibility = busy ? 'hidden' : '';
            if (busy)
                return;
            if (bagdeEl && bagdeEl.textContent && cfg.badge)
                place(bagdeEl, a.x, Math.round(a.y - 26), { above: true });
            if (fxEl && fxEl.textContent && fxEl.style.display !== 'none')
                place(fxEl, a.x, Math.round(a.y - 2), { above: true });
            if (chartEl && chartEl.classList.contains('on'))
                place(chartEl, a.x, Math.round(a.y - 50), { above: true });
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
        const cur7 = u.total7Currency || 'CNY';
        const days = u.days7.slice().reverse();        // 旧 → 新（最右边是今天）
        const tot = days.map((d) => Number(d.total) || 0);
        const max = Math.max.apply(null, tot.concat([0.0001]));
        const today = (u.today && u.today.date) || '';
        let bars = '';
        let xrow = '';
        for (const d of days) {
            const v = Number(d.total) || 0;
            const h = Math.max(2, Math.round((v / max) * 38));
            bars += '<div class="dshwe-bar' + (d.date === today ? ' hot' : '') +
                    '" style="height:' + h + 'px"></div>';
            xrow += '<span>' + String(d.date).slice(8) + '</span>';
        }
        const el = ensureChartEl();
        el.innerHTML =
            '<div>📊 近 7 日用量 ' + cur7 + '　共 ' +
            (Number(u.total7) || 0).toFixed(2) + '</div>' +
            '<div class="dshwe-bars">' + bars + '</div>' +
            '<div class="dshwe-xrow">' + xrow + '</div>';
        const a = anchor();
        const lift = (toastEl && toastEl.classList.contains('on')) ? toastEl.offsetHeight + 6 : 0;
        el.classList.add('on');
        place(el, a.x, Math.round(a.y - 50 - lift), { above: true });
        clearTimeout(chartHideT);
        chartHideT = setTimeout(() => el.classList.remove('on'),
            (Number(seconds) || cfg.chartSeconds) * 1000);
        notice('账单图表已显示（近 7 日，峰值 ' + max.toFixed(2) + ' ' + cur7 + '）');
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
                    toast('🐳 ' + SPEECH[Math.floor(Math.random() * SPEECH.length)], 9000);
                }
            } catch (_e) { /* 忽略 */ }
            scheduleSpeech();
        }, ms);
    }

    // ---------------- 主循环 ----------------
    let warnedKey = '';

    function tick() {
        try {
            const s = peakState();
            // 常驻角标
            if (s.secondsToSwitch >= 0)
                badge(
                    (s.peak ? '⛰ 高峰 ' : '🌙 谷价 ') +
                    mmss(s.secondsToSwitch) + ' 后切换',
                    s.peak ? '#ffd7a8' : '#a8e6c8',
                );
            else
                badge('🌙 谷价（周末）', '#a8e6c8');

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
    }

    function boot() {
        ensureStyles();
        applyTheme();
        tick();
        setInterval(tick, CHECK_MS);
        setInterval(follow, 200);          // 浮层跟随鲸鱼
        scheduleSpeech();
        console.log(NS, '增强层已加载（峰谷预警 lead=' + cfg.leadMinutes + 'min, badge=' + cfg.badge +
            ', theme=' + cfg.theme + ', bubble=' + cfg.bubbleSkin +
            ', 台词=' + (cfg.speechOn ? cfg.speechMinutes + 'min' : '关') +
            ', 图表=' + cfg.chartOn + '）');
        toast('✅ 桌面增强层已启用（峰谷预警 · 汇率 · 台词 · 账单图表）', 4000);
        // 启动速览：近 7 日账单（也相当于“开机看一眼花了多少”）
        if (cfg.chartOn)
            setTimeout(() => showChart(), 3000);
    }

    // 对外暴露，便于调整配置 / 自测
    window.dshwEnhance = {
        cfg,
        set(patch) {
            Object.assign(cfg, patch || {});
            writeCfg();
            applyTheme();
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
            if (SKINS.indexOf(s) >= 0) cfg.bubbleSkin = s;
            writeCfg();
            applyTheme();
            return cfg.bubbleSkin;
        },
        chart: (s) => showChart(s),
        usage: () => loadUsage(),
        busy: () => pluginUiBusy(),
        follow,
        toast,
    };

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', boot);
    else
        boot();
})();
