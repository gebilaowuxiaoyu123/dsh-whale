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
 *
 * 配置：localStorage['dshwDesktopEnhance']
 *   { peakWarn: true, leadMinutes: 10, badge: true }
 *   也可在控制台执行 window.dshwEnhance.set({leadMinutes: 15}) 调整
 *
 * 后续可在此基础上继续加（见 docs/feature-comparison.md 的路线图）：
 *   多币种汇率、多套气泡组、台词轮播、账单图表、三态主题
 */
(function () {
    const NS = '[dshw-enhance]';
    const CFG_KEY = 'dshwDesktopEnhance';
    const WEEKEND_VALLEY_FROM = Date.UTC(2026, 7, 22, 16, 0, 0);   // 北京时间 2026-08-23 00:00 起周末全天谷价
    const PEAK_WINDOWS = [[9, 12], [14, 18]];                      // 工作日高峰（北京时间）
    const DAY_MIN = 24 * 60;
    const CHECK_MS = 20000;

    const cfg = Object.assign(
        { peakWarn: true, leadMinutes: 10, badge: true },
        readCfg(),
    );

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
          .dshwe-toast {
            position: fixed; z-index: 2147483000; max-width: 300px;
            padding: 10px 14px; border-radius: 12px;
            background: rgba(24, 30, 48, .92); color: #eaf0ff;
            font: 13px/1.6 system-ui, "Noto Sans CJK SC", sans-serif;
            box-shadow: 0 6px 22px rgba(0,0,0,.35);
            pointer-events: none; opacity: 0; transition: opacity .25s ease;
          }
          .dshwe-toast.on { opacity: 1; }
          .dshwe-badge {
            position: fixed; z-index: 2147482999;
            padding: 3px 8px; border-radius: 999px;
            background: rgba(24, 30, 48, .82); color: #cfe0ff;
            font: 11px/1.5 system-ui, "Noto Sans CJK SC", sans-serif;
            pointer-events: none; white-space: nowrap;
          }
        `;
        document.documentElement.appendChild(st);
    }

    /** 鲸鱼当前所在位置，用来把提示贴在鲸鱼上方 */
    function anchor() {
        const img = document.querySelector('.dshwv-img');
        const r = img ? img.getBoundingClientRect() : null;
        if (!r || r.width < 2)
            return { x: window.innerWidth - 260, y: window.innerHeight - 200, w: 200 };
        return { x: r.left, y: r.top, w: r.width };
    }

    function toast(text, ms = 6000) {
        ensureStyles();
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.className = 'dshwe-toast';
            document.documentElement.appendChild(toastEl);
        }
        const a = anchor();
        toastEl.textContent = text;
        toastEl.style.left = Math.max(8, Math.min(window.innerWidth - 300, a.x)) + 'px';
        toastEl.style.top = Math.max(8, a.y - 56) + 'px';
        toastEl.classList.add('on');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => toastEl && toastEl.classList.remove('on'), ms);
        console.log(NS, '提示：' + text);
    }

    function badge(text, color) {
        if (!cfg.badge)
            return;
        ensureStyles();
        if (!bagdeEl) {
            bagdeEl = document.createElement('div');
            bagdeEl.className = 'dshwe-badge';
            document.documentElement.appendChild(bagdeEl);
        }
        const a = anchor();
        bagdeEl.textContent = text;
        bagdeEl.style.color = color;
        bagdeEl.style.left = Math.max(8, Math.min(window.innerWidth - 160, a.x)) + 'px';
        bagdeEl.style.top = Math.max(8, a.y - 26) + 'px';
    }

    function mmss(sec) {
        if (sec < 0)
            return '—';
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
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
    }

    function boot() {
        ensureStyles();
        tick();
        setInterval(tick, CHECK_MS);
        console.log(NS, '增强层已加载（峰谷提前预警 lead=' + cfg.leadMinutes +
            'min, badge=' + cfg.badge + '）');
        toast('✅ 桌面增强层已启用（峰谷提前预警）', 4000);
    }

    // 对外暴露，便于调整配置 / 自测
    window.dshwEnhance = {
        cfg,
        set(patch) { Object.assign(cfg, patch || {}); writeCfg(); tick(); return cfg; },
        state: peakState,
        toast,
    };

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', boot);
    else
        boot();
})();
