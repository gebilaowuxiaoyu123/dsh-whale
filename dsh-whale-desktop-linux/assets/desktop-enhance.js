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
        { peakWarn: true, leadMinutes: 10, badge: true, fxCurrency: 'USD' },
        readCfg(),
    );
    const FX_CYCLE = ['USD', 'EUR', 'JPY', 'GBP', 'HKD', 'OFF'];

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
          .dshwe-fx {
            position: fixed; z-index: 2147483001;
            padding: 3px 9px; border-radius: 999px;
            background: rgba(24, 30, 48, .86); color: #ffe6a8;
            font: 11px/1.5 system-ui, "Noto Sans CJK SC", sans-serif;
            cursor: pointer; white-space: nowrap; user-select: none;
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
        fxEl.title = '点击切换显示币种（USD → EUR → JPY → GBP → HKD → 关）';
        fxEl.addEventListener('click', () => {
            const i = FX_CYCLE.indexOf(cfg.fxCurrency);
            cfg.fxCurrency = FX_CYCLE[(i + 1) % FX_CYCLE.length];
            writeCfg();
            if (fxEl)
                fxEl.style.display = 'none';      // 先隐藏，避免切换瞬间显示错币种
            tickFx();
            toast('💱 汇率显示：' + (cfg.fxCurrency === 'OFF' ? '已关闭' : cfg.fxCurrency), 3000);
        });
        document.documentElement.appendChild(fxEl);
        return fxEl;
    }

    async function tickFx() {
        const cur = cfg.fxCurrency;
        if (!cur || cur === 'OFF') {
            if (fxEl)
                fxEl.style.display = 'none';
            return;
        }
        const bal = await loadBalance();
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
        const a = anchor();
        el.style.left = Math.max(8, Math.min(window.innerWidth - 240, a.x)) + 'px';
        el.style.top = Math.max(8, a.y - 48) + 'px';
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
        fx: () => ({ currency: cfg.fxCurrency, rate: fxCache, balance: balCache }),
        toast,
    };

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', boot);
    else
        boot();
})();
