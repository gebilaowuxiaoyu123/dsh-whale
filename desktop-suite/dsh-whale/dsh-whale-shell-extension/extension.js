// DSH Whale Widget —— GNOME Shell 扩展版（Wayland 桌面悬浮小鲸鱼）v30
// 交互：左键按住=跟随鼠标走、松开=贴边停靠；左键短按(无移动)=摸摸头；右键=菜单
// v30: 动画流畅度——拖动跟手 60fps(16ms)、数字滚动 60fps+文本去重、气泡尾随去抖动
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// GJS 的 `Uint8Array.toString()` 已弃用：旧行为把字节按 UTF-8 解释成字符串（能用），
// 但未来版本会变成逗号分隔的数字串 → 会**静默**读不到凭据/账本/余额。
// 统一用 TextDecoder 显式解码（GJS 1.78+ / GNOME 45+ 均提供）。
const UTF8_DECODER = new TextDecoder('utf-8');
function decodeBytes(bytes) {
    if (bytes == null)
        return '';
    if (typeof bytes === 'string')
        return bytes;
    return UTF8_DECODER.decode(bytes);
}

const CRED_FILE = `${GLib.get_home_dir()}/.dsh/.credentials.yaml`;
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const PEAK_MODES = ['default', 'liangwen', 'qiangqiang'];

// —— 令牌模式：DeepSeek 平台用量接口峰谷定价(元/百万token；[空闲,高峰]) ——
const TOKEN_PEAK_HOURS = [[9, 12], [14, 18]];
const TOKEN_BASE_PRICE = {hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0]};
const TOKEN_PRO_PRICE = {hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0]};
const TOKEN_PRICING = {
    'deepseek-v4-flash-vision-exp': TOKEN_BASE_PRICE,
    'deepseek-v4-flash': TOKEN_BASE_PRICE,
    'deepseek-v4-pro': TOKEN_PRO_PRICE,
    'deepseek-chat': TOKEN_BASE_PRICE,
    'deepseek-reasoner': TOKEN_BASE_PRICE,
    _default: TOKEN_BASE_PRICE,
};
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000); // = 北京时间 2026-08-23 00:00

function priceFor(model) {
    const m = String(model || '').toLowerCase();
    for (const key of Object.keys(TOKEN_PRICING)) {
        if (key === '_default')
            continue;
        if (m.indexOf(key) !== -1)
            return TOKEN_PRICING[key];
    }
    return TOKEN_PRICING._default;
}

// bucket time 为 epoch 秒 → 转北京时刻判高峰/低谷；2026-08-23 起周末全天谷价
function isPeakTimeSec(timeSec) {
    if (!isFinite(Number(timeSec)))
        return false;
    const n = Number(timeSec);
    const bj = new Date(n * 1000 + 8 * 3600 * 1000);
    if (n >= WEEKEND_VALLEY_FROM_SEC) {
        const dow = bj.getUTCDay();
        if (dow === 0 || dow === 6)
            return false;
    }
    const hour = bj.getUTCHours();
    for (const [s, e] of TOKEN_PEAK_HOURS) {
        if (hour >= s && hour < e)
            return true;
    }
    return false;
}

const PEAK_TXT = {
    default: ['⚡ 高峰时段，注意用量哦', '⚡ 现在是高峰计费，先省着点~'],
    liangwen: ['⚡ 梁文峰 · 现在是高峰', '⚡ 梁文峰，烧钱快哦'],
    qiangqiang: ['⚡ !?峰峰!? 高峰哦', '⚡ 峰峰时段来咯'],
};
const OFF_TXT = {
    default: ['🌙 低谷时段，放心大胆用', '🌙 现在是低谷价，很适合跑任务~'],
    liangwen: ['🌙 梁文谷 · 现在是低谷', '🌙 梁文谷，随便用啦'],
    qiangqiang: ['🌙 !?谷谷!? 低谷哦', '🌙 谷谷时段，超划算'],
};
const CUTE_LINES = [
    '呜…我的余额呢 (´･_･`)',
    '要…要抱抱吗 (,,•﹏•,,)',
    '摸鱼被我逮到啦！',
    '今天也要一起加油鸭！',
    '你敲代码的样子真帅~',
    'DeepSeek 天下第一！',
    '哼，不许偷看我的小肚子！',
    '已经盯着你很久了哦~',
    '让我康康你的余额…',
    '辛苦啦，歇一会儿吧~',
    '检测到你在认真工作 (盯~)',
    '小心烧 token 哦~',
    '诶嘿，今天想聊点什么？',
    '戳一下就会动，好耶！',
    '我是一只会看余额的小鲸鱼~',
    '呜…手指不要乱戳我啦',
    '今天也要元气满满哦！',
];
const TROLL_LINES = [
    '又在偷偷调大模型了吧？',
    '哼，烧钱冠军非你莫属',
    'token 自由？我看是余额自由…',
    '再这么跑下去，我要报警了！',
    '大烧货，今天又烧了多少？',
];
const PEAK_MODE_LABEL = {default: '默认', liangwen: '梁文峰谷', qiangqiang: '!?强强?!'};
const SFX_THEMES = {
    default: {label: '默认', pick: 'Ya1.mp3', drop: 'Ya2.mp3', pet: 'Ya1.mp3'},
    bell: {label: '叮咚', pick: 'sfx_bell_pick.mp3', drop: 'sfx_bell_drop.mp3', pet: 'sfx_bell_pick.mp3'},
    low: {label: '低沉', pick: 'sfx_low_pick.mp3', drop: 'sfx_low_drop.mp3', pet: 'sfx_low_pick.mp3'},
    soft: {label: '柔和', pick: 'sfx_soft_pick.mp3', drop: 'sfx_soft_drop.mp3', pet: 'sfx_soft_pick.mp3'},
    pop: {label: '活泼', pick: 'sfx_pop_pick.mp3', drop: 'sfx_pop_drop.mp3', pet: 'sfx_pop_pick.mp3'},
    chirp: {label: '清脆', pick: 'sfx_chirp_pick.mp3', drop: 'sfx_chirp_drop.mp3', pet: 'sfx_chirp_pick.mp3'},
};

// —— 音频播放器回退链（A7）——
// 原实现把 `/usr/bin/pw-play` 写死：本机实测**没有 paplay**（Ubuntu 24.04 只装 PipeWire），
// 换一台只有 PulseAudio 或只有 ALSA 的机器就直接没声音；而且 spawn 失败是**静默**的，
// 用户只会觉得「音效坏了，也没什么提示」。
// 这里按能力探测一次并缓存；播放失败自动换下一个，全都没有就明确报一次日志。
const SFX_PLAYERS = [
    {bin: 'pw-play', args: (v, p) => ['--volume', v.toFixed(2), p]},
    {bin: 'paplay', args: (v, p) => ['--volume', String(Math.round(v * 65536)), p]},
    {bin: 'ffplay', args: (v, p) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(Math.round(v * 100)), p]},
    {bin: 'mpv', args: (v, p) => ['--no-video', '--really-quiet', '--volume=' + Math.round(v * 100), p]},
    {bin: 'gst-play-1.0', args: (v, p) => ['--quiet', p]},
];

/** 从 startIdx 起找第一个真实存在的播放器；找不到返回 null */
function pickSfxPlayer(startIdx) {
    for (let i = Math.max(0, startIdx); i < SFX_PLAYERS.length; i++) {
        let p = null;
        try {
            p = GLib.find_program_in_path(SFX_PLAYERS[i].bin);
        } catch (_e) {
            p = null;
        }
        if (p)
            return {idx: i, path: p, args: SFX_PLAYERS[i].args, name: SFX_PLAYERS[i].bin};
    }
    return null;
}
const PET_LINES = [
    '呜哇！被摸头了… 好舒服 (〃ω〃)',
    '再…再摸一下也可以哦~',
    '嘿嘿，摸头会变聪明的！',
    '蹭蹭~ 今天也想被表扬！',
    '被摸得晕乎乎的了… (>ω<)',
    '这就是摸摸头的滋味吗…',
    '呐，再摸摸肚子那里~',
    '哼…才不是因为开心才蹭你的！',
];
const FX_SYMS = [
    ['♫', '#8fb7ff'], ['♪', '#8fb7ff'],
    ['♥', '#ff9ecb'], ['✦', '#ffe08a'], ['☆', '#fff4d6'],
];

const BTN_STYLE = 'background-color: transparent; color: #eaf1ff;' +
    'border-radius: 8px; padding: 8px 14px; font-size: 13px; font-weight: 500;';
const BTN_HOVER = 'background-color: rgba(255,255,255,0.12); color: #ffffff;' +
    'border-radius: 8px; padding: 8px 14px; font-size: 13px; font-weight: 500;';

export default class DshWhaleWidget extends Extension {
    enable() {
        this._apiKey = null;
        this._bub = null;
        this._bubTimer = 0;
        this._bubTick = 0;
        this._menu = null;
        this._whaleScale = 1;
        this._mirror = 1;
        this._hold = null;
        this._followTimer = 0;
        this._captureId = 0;
        this._lastMoveAt = 0;
        this._breathing = false;
        this._breathTimer = 0;
        this._peakMode = 'default';
        this._soundOn = true;
        this._bubbleOn = true;
        this._sfxTheme = 'default';
        this._vol = 1;
        this._lastBal = null;
        this._fxTimer = 0;
        this._lastFxAt = 0;
        this._menuPos = null;
        this._snap = {h: -1, v: 1};   // 贴边状态：h/v = -1 贴左/上, 1 贴右/下, 0 不吸附
        this._autoOn = true;          // 60s 自动刷新余额
        this._autoTimer = 0;
        this._fetching = false;
        this._usage = null;           // 今日已用账本
        this._animT = 0;              // 余额数字滚动动画定时器
        this._usageMode = 'ledger';   // 今日已用：ledger(记账) / token(令牌精确)
        this._platformToken = null;
        this._tokenToday = {amount: null, at: 0};
        this._tokenFetching = false;
        this._loadPrefs();
        this._readKey();
        this._loadLedger();
        this._buildWhale();
        this._placeInitial();
        this._captureId = global.stage.connect('captured-event', (s, ev) => this._onCaptured(ev));
        // A3/A4：触屏支持（触控屏笔记本 / 平板模式）——按住能拖、长按当右键
        this._touchId = this._whale.connect('touch-event', (a, ev) => this._onTouch(a, ev));
        // A6：锁屏降级 —— 锁屏时隐藏并停掉定时器（省电，也不会出现在锁屏界面上）
        this._suspended = false;
        this._sessionConn = Main.sessionMode.connect('updated', () => this._onSessionMode());
        // 显示器热插拔 / 工作区变化（分辨率、缩放、任务栏变化）：把鲸鱼夹回合法范围，
        // 避免它停在已消失的显示器坐标上而“不见了”（A1）
        this._geomConns = [
            {
                obj: Main.layoutManager,
                id: Main.layoutManager.connect('monitors-changed', () => this._onGeometryChanged()),
            },
            {
                obj: global.display,
                id: global.display.connect('workareas-changed', () => this._onGeometryChanged()),
            },
        ];
        this._breathTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => this._tryBreath());
        this._fxTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3200, () => this._tryIdleFx());
        this._autoTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60000, () => this._autoTick());
        if (this._autoOn)
            this._fetchBalance(true, false);   // 启动即静默对齐一次余额缓存
    }

    disable() {
        this._hold = null;
        if (this._lpTimer) {
            GLib.source_remove(this._lpTimer);
            this._lpTimer = 0;
        }
        if (this._sessionConn) {
            try { Main.sessionMode.disconnect(this._sessionConn); } catch (e) { /* 忽略 */ }
            this._sessionConn = 0;
        }
        if (this._touchId && this._whale) {
            try { this._whale.disconnect(this._touchId); } catch (e) { /* 忽略 */ }
            this._touchId = 0;
        }
        if (this._geomConns) {
            for (const c of this._geomConns) {
                try {
                    if (c && c.obj && c.id)
                        c.obj.disconnect(c.id);
                } catch (e) { /* 忽略 */ }
            }
            this._geomConns = null;
        }
        if (this._followTimer) {
            GLib.source_remove(this._followTimer);
            this._followTimer = 0;
        }
        if (this._captureId) {
            global.stage.disconnect(this._captureId);
            this._captureId = 0;
        }
        if (this._breathTimer) {
            GLib.source_remove(this._breathTimer);
            this._breathTimer = 0;
        }
        if (this._fxTimer) {
            GLib.source_remove(this._fxTimer);
            this._fxTimer = 0;
        }
        if (this._autoTimer) {
            GLib.source_remove(this._autoTimer);
            this._autoTimer = 0;
        }
        if (this._bubTimer)
            clearTimeout(this._bubTimer);
        if (this._bubTick) {
            GLib.source_remove(this._bubTick);
            this._bubTick = 0;
        }
        if (this._animT) {
            GLib.source_remove(this._animT);
            this._animT = 0;
        }
        if (this._bub)
            this._bub.destroy();
        this._bub = null;
        if (this._tail)
            this._tail.destroy();
        this._tail = null;
        this._closeMenu();
        if (this._whale) {
            const parent = this._whale.get_parent();
            if (parent)
                parent.remove_child(this._whale);
            this._whale.destroy();
        }
        this._whale = null;
    }

    _assetPath(name) {
        const filePath = decodeURIComponent(import.meta.url.replace(/^file:\/\//, ''));
        const dir = filePath.slice(0, filePath.lastIndexOf('/'));
        return `${dir}/assets/${name}`;
    }

    _pick(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    }

    // 按权重从多个句组中抽一组，再随机取一句
    _pickWeighted(groups) {
        let tot = 0;
        for (const [, w] of groups)
            tot += w;
        let r = Math.random() * tot;
        for (const [arr, w] of groups) {
            if (r < w)
                return this._pick(arr);
            r -= w;
        }
        return this._pick(groups[0][0]);
    }

    _isPeak() {
        const bj = new Date(Date.now() + 8 * 3600 * 1000);
        const day = bj.getUTCDay();
        const hour = bj.getUTCHours();
        if (day === 0 || day === 6)
            return false;
        return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
    }

    /** 主屏工作区：首次摆放与「回到左下角」的基准 */
    _primaryWorkArea() {
        const lm = Main.layoutManager;
        const mono = lm.primaryMonitor
            || (Array.isArray(lm.monitors) && lm.monitors[0])
            || null;
        if (mono && mono.workArea)
            return mono.workArea;
        try {
            const idx = global.display.get_primary_monitor();
            const g = global.display.get_monitor_geometry(idx);
            return {x: g.x, y: g.y, width: g.width, height: g.height};
        } catch (e) {
            return {x: 0, y: 0, width: 1920, height: 1080};
        }
    }

    /** 点 (x,y) 所在显示器的工作区；不落在任何显示器内（拔屏/多屏间空隙）时回落主屏 */
    _workAreaFor(x, y) {
        try {
            const lm = Main.layoutManager;
            const monitors = lm.monitors;
            if (Array.isArray(monitors) && monitors.length > 1) {
                for (const m of monitors) {
                    if (x >= m.x && x < m.x + m.width &&
                        y >= m.y && y < m.y + m.height) {
                        const wa = lm.getWorkAreaForMonitor(m.index);
                        if (wa && wa.width > 0 && wa.height > 0)
                            return wa;
                        return {x: m.x, y: m.y, width: m.width, height: m.height};
                    }
                }
            }
        } catch (e) {
            log(`[dsh-whale] workAreaFor err: ${e}`);
        }
        return this._primaryWorkArea();
    }

    /** 鲸鱼当前所在显示器的工作区：吸附 / 气泡 / 菜单都以它为准（多显示器） */
    _workArea() {
        if (!this._whale)
            return this._primaryWorkArea();
        const [nw, nh] = this._whale.get_size();
        return this._workAreaFor(this._whale.get_x() + nw / 2,
                                 this._whale.get_y() + nh / 2);
    }

    _buildWhale() {
        const asset = this._assetPath('dshw.png');
        const icon = new St.Icon({
            gicon: Gio.FileIcon.new(Gio.File.new_for_path(asset)),
            icon_size: 220,
            reactive: true,
            track_hover: true,
        });
        icon.set_pivot_point(0.5, 0.5);
        icon.connect('button-press-event', (a, ev) => this._onPress(a, ev));
        icon.connect('button-release-event', () => this._endHold());
        icon.connect('scroll-event', (a, ev) => this._onScroll(a, ev));
        this._w = 220;
        this._h = 220;
        this._img = icon;
        this._whale = icon;
        Main.uiGroup.add_child(this._whale);
        Main.uiGroup.set_child_above_sibling(this._whale, null);
    }

    _placeInitial() {
        const wa = this._primaryWorkArea();
        const nw = Math.round(this._w * this._whaleScale);
        const nh = Math.round(this._h * this._whaleScale);
        const x = wa.x;
        const y = wa.y + wa.height - nh;
        this._whale.set_position(x, y);
        this._snap = {h: -1, v: 1};   // 默认贴左下角
        this._mirror = -1;
        this._img.set_scale(this._mirror, 1);
    }

    _readKey() {
        this._apiKey = null;
        this._platformToken = null;
        try {
            const [ok, data] = GLib.file_get_contents(CRED_FILE);
            if (ok) {
                const s = decodeBytes(data);
                const m = s.match(/DEEPSEEK_API_KEY\s*:\s*"?([^\s"#]+)"?/);
                if (m)
                    this._apiKey = m[1];
                const m2 = s.match(/DEEPSEEK_PLATFORM_TOKEN\s*:\s*"?([^\s"#]+)"?/);
                if (m2)
                    this._platformToken = String(m2[1]).replace(/^Bearer\s+/i, '');
            }
        } catch (e) {
            log(`[dsh-whale] cred read failed: ${e}`);
        }
    }

    // —— 偏好持久化(~/.cache/dsh-whale/prefs.json) ——
    _prefsFile() {
        const d = `${GLib.get_home_dir()}/.cache/dsh-whale`;
        try {
            GLib.mkdir_with_parents(d, 0o755);
        } catch (e) { /* 忽略 */ }
        return `${d}/prefs.json`;
    }

    _loadPrefs() {
        let raw = null;
        try {
            const [ok, data] = GLib.file_get_contents(this._prefsFile());
            if (ok && data && data.length)
                raw = decodeBytes(data);
        } catch (e) {
            raw = null;
        }
        if (raw === null)
            return;
        let j = null;
        try {
            j = JSON.parse(raw);
        } catch (e) {
            // A9：偏好文件坏了，不能让插件变成「已配置却读不到」的玄学状态 ——
            // 备份成 prefs.json.bad，从默认值继续跑，并明确报一次（用户可自行恢复）。
            try { logError(e, '[dsh-whale] 偏好文件解析失败，已备份为 prefs.json.bad 并使用默认值'); } catch (_e2) {}
            try { GLib.file_set_contents(this._prefsFile() + '.bad', raw); } catch (_e3) {}
            return;
        }
        if (!j || typeof j !== 'object')
            return;
        const num = (v, lo, hi, dflt) => (typeof v === 'number' && isFinite(v)) ? Math.max(lo, Math.min(hi, v)) : dflt;
        try {
            if (j.sfxTheme && SFX_THEMES[j.sfxTheme])
                this._sfxTheme = j.sfxTheme;
            this._vol = num(j.vol, 0, 1, this._vol);
            if (typeof j.soundOn === 'boolean')
                this._soundOn = j.soundOn;
            if (typeof j.bubbleOn === 'boolean')
                this._bubbleOn = j.bubbleOn;
            if (PEAK_MODES.includes(j.peakMode))
                this._peakMode = j.peakMode;
            if (typeof j.autoOn === 'boolean')
                this._autoOn = j.autoOn;
            if (j.usageMode === 'token' || j.usageMode === 'ledger')
                this._usageMode = j.usageMode;
            // 数值类字段统一夹紧：手改配置写出 NaN / 负值不会再把界面搞崩
            const ws = num(j.whaleScale, 0.4, 3, null);
            if (ws !== null)
                this._whaleScale = ws;
            const bs = num(j.bubbleSec, 2, 120, null);
            if (bs !== null)
                this._bubbleSec = bs;
        } catch (e) {
            try { logError(e, '[dsh-whale] 偏好应用失败（已忽略出错项）'); } catch (_e4) {}
        }
    }

    _savePrefs() {
        try {
            const j = {
                sfxTheme: this._sfxTheme,
                vol: this._vol,
                soundOn: this._soundOn,
                bubbleOn: this._bubbleOn,
                peakMode: this._peakMode,
                autoOn: this._autoOn,
                usageMode: this._usageMode,
            };
            GLib.file_set_contents(this._prefsFile(), JSON.stringify(j));
        } catch (e) { /* 忽略 */ }
    }

    // —— 今日已用·小鲸鱼记账(兼容上游 dsh-web 账本 ~/.dsh/.dshw-usage.json) ——
    _ledgerFile() {
        return `${GLib.get_home_dir()}/.dsh/.dshw-usage.json`;
    }

    _bjDate() {   // 北京时间日期 YYYY-MM-DD
        return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    }

    _loadLedger() {
        try {
            const [ok, data] = GLib.file_get_contents(this._ledgerFile());
            if (ok && data && data.length) {
                const j = JSON.parse(decodeBytes(data));
                if (j && typeof j === 'object' && Array.isArray(j.history))
                    this._usage = j;
            }
        } catch (e) { /* 忽略 */ }
    }

    _saveLedger() {
        try {
            GLib.file_set_contents(this._ledgerFile(), JSON.stringify(this._usage || {}));
        } catch (e) { /* 忽略 */ }
    }

    // 余额下降差值=今日已用；跨天归档保留30天；币种变化只重置基准(防多币种虚记)
    _ledgerObserve(total, cur) {
        try {
            const today = this._bjDate();
            const u = this._usage || {history: []};
            if (!Array.isArray(u.history))
                u.history = [];
            if (u.date && u.date !== today) {        // 跨天：归档清零
                if (Number(u.todayUsage || 0) > 0.0001)
                    u.history.push({date: u.date, usage: Number(u.todayUsage || 0)});
                if (u.history.length > 30)
                    u.history = u.history.slice(-30);
                u.date = today;
                u.todayUsage = 0;
                u.lastBalance = null;
                u.lastCurrency = null;
            }
            if (!u.date)
                u.date = today;
            const t = Number(total);
            const lb = u.lastBalance;
            if (lb !== null && lb !== undefined && u.lastCurrency === cur) {
                const diff = Number(lb) - t;
                if (diff > 0.0001) {                 // 仅余额下降记作消耗
                    u.todayUsage = Math.round(((Number(u.todayUsage) || 0) + diff) * 10000) / 10000;
                }
            }
            u.lastBalance = t;                       // 币种切换时这里自然只重置基准
            u.lastCurrency = cur;
            this._usage = u;
            this._saveLedger();
        } catch (e) { /* 忽略 */ }
    }

    _todayUsage() {   // 今日已用金额(今日有效)
        try {
            const u = this._usage || {};
            if (!u.date || u.date !== this._bjDate())
                return 0;
            return Number(u.todayUsage) || 0;
        } catch (e) {
            return 0;
        }
    }

    // —— 统一缩放/镜像 ——
    _easeScale(mul, dur, mode) {
        this._img.ease({
            scale_x: this._mirror * this._whaleScale * mul,
            scale_y: this._whaleScale * mul,
            duration: dur || 160,
            mode: mode || Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _setMirror(m) {
        if (this._mirror === m)
            return;
        this._mirror = m;
        this._easeScale(1, 150, Clutter.AnimationMode.EASE_OUT_QUAD);
    }

    // kind: pick(拿起)/drop(放下)/pet(摸摸头) —— 按当前音色主题播放，并套用音量
    _playSound(kind) {
        if (!this._soundOn)
            return;
        if (this._sfxDead)
            return;
        try {
            const th = SFX_THEMES[this._sfxTheme] || SFX_THEMES.default;
            const file = th[kind] || SFX_THEMES.default[kind] || 'Ya1.mp3';
            const p = this._assetPath(file);
            const v = Math.max(0, Math.min(1, this._vol || 1));
            if (!this._sfxArgs) {
                const f = pickSfxPlayer((this._sfxIdx || -1) + 1);
                if (!f) {
                    this._sfxDead = true;
                    log('[dsh-whale] 未找到任何可用音频播放器（已试 ' +
                        SFX_PLAYERS.map(x => x.bin).join(' / ') + '），音效改为静音');
                    return;
                }
                this._sfxIdx = f.idx;
                this._sfxPath = f.path;
                this._sfxArgs = f.args;
                log('[dsh-whale] 音效播放器 = ' + f.name + '（' + f.path + '）');
            }
            GLib.spawn_async(null, [this._sfxPath].concat(this._sfxArgs(v, p)), null,
                GLib.SpawnFlags.SEARCH_PATH |
                GLib.SpawnFlags.STDOUT_TO_DEV_NULL |
                GLib.SpawnFlags.STDERR_TO_DEV_NULL, null);
        } catch (e) {
            // 这个播放器实际用不了 → 丢掉，下次自动试下一个
            this._sfxArgs = null;
        }
    }

    _tryBreath() {
        if (this._hold || this._breathing || this._menu || !this._whale)
            return GLib.SOURCE_CONTINUE;
        if (Date.now() - (this._lastMoveAt || 0) < 1600)
            return GLib.SOURCE_CONTINUE;
        this._breathing = true;
        const baseY = this._whale.get_y();
        this._whale.ease({
            y: baseY - 6,
            duration: 650,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            onComplete: () => {
                this._breathing = false;
                if (this._whale && !this._hold && !this._menu)
                    this._whale.ease({y: baseY, duration: 650, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD});
            },
        });
        return GLib.SOURCE_CONTINUE;
    }

    // —— 飘动特效：从鲸鱼头顶升起一个小符号再淡出(营造 gif 动图感) ——
    _fxSymbol(ch, dx) {
        try {
            const col = (FX_SYMS.find(s => s[0] === ch) || FX_SYMS[0])[1];
            const n = new St.Label({text: ch, style: `color:${col}; font-size:22px; font-weight:700;`});
            Main.uiGroup.add_child(n);
            const [wx, wy] = this._whale.get_position();
            const [ww] = this._whale.get_size();
            const x0 = Math.round(wx + ww / 2 + (dx || 0) - 8);
            const y0 = Math.round(wy + 6);
            n.set_position(x0, y0);
            n.set_opacity(0);
            n.ease({
                opacity: 255, y: y0 - 16, duration: 170,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (!n)
                        return;
                    n.ease({
                        opacity: 0, y: y0 - 92, duration: 760,
                        mode: Clutter.AnimationMode.EASE_IN_QUAD,
                        onComplete: () => n.destroy(),
                    });
                },
            });
        } catch (e) { /* 忽略 */ }
    }

    // 眨眼：整体 y 向快速压缩一下(模拟闭眼)再恢复
    _blink() {
        try {
            const s = this._img;
            if (!s)
                return;
            const sy = s.get_scale_y();
            s.ease({
                scale_y: sy * 0.94, duration: 90, mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    if (s)
                        s.ease({scale_y: sy, duration: 110, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                },
            });
        } catch (e) { /* 忽略 */ }
    }

    // 静置时随机来点小动作：飘音符/爱心、眨眼、偶尔双音符 —— 像 gif 在动
    _tryIdleFx() {
        if (!this._whale || this._hold || this._menu)
            return GLib.SOURCE_CONTINUE;
        if (this._breathing || Date.now() - (this._lastMoveAt || 0) < 2000)
            return GLib.SOURCE_CONTINUE;
        if (Date.now() - this._lastFxAt < 6500)
            return GLib.SOURCE_CONTINUE;
        this._lastFxAt = Date.now();
        const r = Math.random();
        try {
            const [ww] = this._whale.get_size();
            if (r < 0.34) {
                this._fxSymbol(FX_SYMS[Math.floor(Math.random() * FX_SYMS.length)][0],
                    (Math.random() - 0.5) * ww * 0.5);
            } else if (r < 0.52) {
                this._blink();
            } else if (r < 0.62) {
                this._fxSymbol('♫', -ww / 6);
                this._fxSymbol('♪', ww / 6);
            }
        } catch (e) { /* 忽略 */ }
        return GLib.SOURCE_CONTINUE;
    }

    // ============ 交互 ============
    // A8：跟随定时器的间隔跟着屏幕刷新率走（60Hz→16ms / 120Hz→8ms，夹在 8~20ms）
    _frameMs() {
        try {
            let idx = null;
            if (this._whale && global.display.get_monitor_index_for_actor)
                idx = global.display.get_monitor_index_for_actor(this._whale);
            if (idx === null || idx === undefined)
                idx = global.display.get_primary_monitor();
            const hz = global.display.get_monitor_refresh_rate(idx) || 60;
            return Math.max(8, Math.min(20, Math.round(1000 / hz)));
        } catch (e) {
            return 16;
        }
    }

    // A6：锁屏降级
    _onSessionMode() {
        let locked = false;
        try {
            locked = !!Main.sessionMode.isLocked;
        } catch (e) {
            locked = false;
        }
        if (locked === this._suspended)
            return;
        this._suspended = locked;
        if (locked) {
            this._hold = null;
            if (this._followTimer) { GLib.source_remove(this._followTimer); this._followTimer = 0; }
            if (this._breathTimer) { GLib.source_remove(this._breathTimer); this._breathTimer = 0; }
            if (this._fxTimer) { GLib.source_remove(this._fxTimer); this._fxTimer = 0; }
            if (this._lpTimer) { GLib.source_remove(this._lpTimer); this._lpTimer = 0; }
            try { this._whale.hide(); } catch (e) { /* 忽略 */ }
        } else {
            try { this._whale.show(); } catch (e) { /* 忽略 */ }
            if (!this._breathTimer)
                this._breathTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => this._tryBreath());
            if (!this._fxTimer)
                this._fxTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3200, () => this._tryIdleFx());
        }
    }

    // A3/A4：触屏——按住拖、长按（550ms）当右键唤出菜单
    _onTouch(a, ev) {
        const t = ev.type();
        if (t === Clutter.EventType.TOUCH_BEGIN) {
            if (this._menu)
                this._closeMenu();
            const [px, py] = ev.get_coords();
            const [wx, wy] = this._whale.get_position();
            this._hold = {sx: px, sy: py, moved: false, ox: wx - px, oy: wy - py, touch: true};
            this._playSound('pick');
            this._easeScale(0.93, 90, Clutter.AnimationMode.EASE_OUT_QUAD);
            if (!this._followTimer)
                this._followTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._frameMs(), () => this._followTick());
            if (this._lpTimer)
                GLib.source_remove(this._lpTimer);
            this._lpTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 550, () => {
                this._lpTimer = 0;
                const h = this._hold;
                if (h && !h.moved) {
                    this._hold = null;
                    this._openMenu(px, py);
                    this._touchMenuAt = Date.now();
                }
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_STOP;
        }
        if (t === Clutter.EventType.TOUCH_END || t === Clutter.EventType.TOUCH_CANCEL) {
            if (this._lpTimer) { GLib.source_remove(this._lpTimer); this._lpTimer = 0; }
            // 长按刚唤出菜单：这次抬手不要再当成点击
            if (this._touchMenuAt && Date.now() - this._touchMenuAt < 1200) {
                this._touchMenuAt = 0;
                return Clutter.EVENT_STOP;
            }
            if (this._hold)
                this._endHold();
            return Clutter.EVENT_STOP;
        }
        // TOUCH_UPDATE 不用管：位置由 _followTick 从 global.get_pointer() 取
        return Clutter.EVENT_PROPAGATE;
    }

    _onPress(a, ev) {
        if (this._menu)
            this._closeMenu();
        if (ev.get_button() === 3) {       // 右键 → 菜单
            const [mx, my] = ev.get_coords();
            this._openMenu(mx, my);
            return Clutter.EVENT_STOP;
        }
        if (ev.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = ev.get_coords();
        // 抓取偏移：保持鼠标在鲸鱼身上的相对落点，避免临界点布局翻转造成的抖动
        const [wx, wy] = this._whale.get_position();
        this._hold = {sx: px, sy: py, moved: false, ox: wx - px, oy: wy - py};
        this._playSound('pick');
        this._easeScale(0.93, 90, Clutter.AnimationMode.EASE_OUT_QUAD);
        if (!this._followTimer)
            // A8：跟随屏幕刷新率（60Hz→16ms / 120Hz→8ms）
            this._followTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._frameMs(), () => this._followTick());
        return Clutter.EVENT_STOP;
    }

    _onCaptured(ev) {
        if (!this._hold)
            return Clutter.EVENT_PROPAGATE;
        if (ev.type() === Clutter.EventType.BUTTON_RELEASE && ev.get_button() === 1)
            this._endHold();
        return Clutter.EVENT_PROPAGATE;
    }

    _followTick() {
        const h = this._hold;
        if (!h)
            return GLib.SOURCE_REMOVE;
        try {
            const [mx, my] = global.get_pointer();
            if (Math.abs(mx - h.sx) > 5 || Math.abs(my - h.sy) > 5)
                h.moved = true;
            // 边界以「指针所在显示器」为准：这样才能从主屏拖到外接屏（A2）
            const wa = this._workAreaFor(mx, my);
            const nw = Math.round(this._w * this._whaleScale);
            const nh = Math.round(this._h * this._whaleScale);
            // 跟随：位置 = 鼠标 + 按下时偏移，仅做边界 clamp（单调、无临界翻转 → 不再抖动）
            let tx = mx + h.ox;
            let ty = my + h.oy;
            tx = Math.max(wa.x, Math.min(wa.x + wa.width - nw, tx));
            ty = Math.max(wa.y, Math.min(wa.y + wa.height - nh, ty));
            const rx = Math.round(tx);
            const ry = Math.round(ty);
            if (this._whale.get_x() !== rx || this._whale.get_y() !== ry)
                this._whale.set_position(rx, ry);
            this._lastMoveAt = Date.now();
            // 翻转由鲸鱼所在半屏决定：左半翻转朝右、右半原图朝左（看屏幕内）
            const cx = rx + nw / 2;
            this._setMirror(cx < wa.x + wa.width / 2 ? -1 : 1);
        } catch (e) {
            log(`[dsh-whale] follow err: ${e}`);
        }
        return GLib.SOURCE_CONTINUE;
    }

    _endHold() {
        if (!this._hold)
            return;
        const moved = this._hold.moved;
        this._hold = null;
        if (this._followTimer) {
            GLib.source_remove(this._followTimer);
            this._followTimer = 0;
        }
        this._lastMoveAt = Date.now();
        if (!moved) {                     // 未拖动 = 摸摸头互动
            this._easeScale(1, 220, Clutter.AnimationMode.EASE_OUT_BACK);
            this._petHead();
            return;
        }
        this._settle();
        this._playSound('drop');
        this._easeScale(1, 220, Clutter.AnimationMode.EASE_OUT_BACK);
    }

    _petHead() {
        try {
            this._playSound('pet');
            const wa = this._workArea();
            const wy = this._whale.get_y();
            const [ww] = this._whale.get_size();
            // 开心小跳 ×3（向上 14px，被屏幕内边界约束）
            const y0 = Math.max(wa.y, wy);
            let n = 0;
            const hop = () => {
                if (!this._whale || this._hold)
                    return;
                n += 1;
                this._whale.ease({
                    y: n % 2 ? y0 - 14 : y0,
                    duration: 110,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (n < 4)
                            hop();
                    },
                });
            };
            hop();
            // 飘出开心符号
            this._fxSymbol('♥', -ww / 4);
            this._fxSymbol('♫', ww / 5);
            this._bubble(this._petText());
        } catch (e) { /* 忽略 */ }
    }

    _petText() {
        if (this._lastBal && Math.random() < 0.5) {
            const b = this._lastBal;
            const c = b.cur === 'USD' ? '$' : '¥';
            return `💬 余额 ${c} ${Number(b.total).toFixed(2)}\n${this._pick(PET_LINES)}`;
        }
        return this._pick(PET_LINES);
    }

    // —— 松手 settle：中心落在视口水平/垂直外侧 1/4 带 → 贴对应边/角(两轴独立组合) ——
    _settle() {
        try {
            const wa = this._workArea();
            const nw = Math.round(this._w * this._whaleScale);
            const nh = Math.round(this._h * this._whaleScale);
            const wx = this._whale.get_x();
            const wy = this._whale.get_y();
            const cx = wx + nw / 2;
            const cy = wy + nh / 2;
            const qw = wa.width / 4;
            const qh = wa.height / 4;
            let h = 0;
            let v = 0;
            if (cx < wa.x + qw)          // 中心在左侧 1/4 带
                h = -1;
            else if (cx > wa.x + wa.width - qw)   // 右侧 1/4 带
                h = 1;
            if (cy < wa.y + qh)          // 上侧 1/4 带
                v = -1;
            else if (cy > wa.y + wa.height - qh)  // 下侧 1/4 带
                v = 1;
            this._snap = {h, v};
            this._snapAlign(220);
            // 朝向：贴哪边就看屏幕内(贴左朝右/贴右朝左)；中间带按半屏
            if (h !== 0)
                this._setMirror(h === -1 ? -1 : 1);
            else
                this._setMirror(cx < wa.x + wa.width / 2 ? -1 : 1);
        } catch (e) { /* 忽略 */ }
    }

    // 按当前 _snap 状态把鲸鱼 ease 到贴边坐标（未吸附轴保持原位）
    _snapAlign(dur) {
        try {
            const s = this._snap || {h: 0, v: 0};
            const wa = this._workArea();
            const nw = Math.round(this._w * this._whaleScale);
            const nh = Math.round(this._h * this._whaleScale);
            let tx = this._whale.get_x();
            let ty = this._whale.get_y();
            if (s.h === -1)
                tx = wa.x;
            else if (s.h === 1)
                tx = wa.x + wa.width - nw;
            if (s.v === -1)
                ty = wa.y;
            else if (s.v === 1)
                ty = wa.y + wa.height - nh;
            this._whale.ease({
                x: tx, y: ty, duration: dur || 220,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } catch (e) { /* 忽略 */ }
    }

    /** 显示器 / 工作区变化后：把鲸鱼拉回合法范围（已贴边则重新贴边） */
    _onGeometryChanged() {
        try {
            if (!this._whale || this._hold)
                return;
            const s = this._snap || {h: 0, v: 0};
            if (s.h || s.v) {
                // 已贴边：按「鲸鱼当前所在显示器」重新贴边即可；
                // 若该显示器已消失，_workArea() 会回落到主屏
                this._snapAlign(220);
                return;
            }
            const nw = Math.round(this._w * this._whaleScale);
            const nh = Math.round(this._h * this._whaleScale);
            const x = this._whale.get_x();
            const y = this._whale.get_y();
            const wa = this._workAreaFor(x + nw / 2, y + nh / 2);
            const nx = Math.round(Math.max(wa.x, Math.min(wa.x + wa.width - nw, x)));
            const ny = Math.round(Math.max(wa.y, Math.min(wa.y + wa.height - nh, y)));
            if (nx !== x || ny !== y)
                this._whale.set_position(nx, ny);
        } catch (e) {
            log(`[dsh-whale] geometry change err: ${e}`);
        }
    }

    _onScroll(a, ev) {
        let up = null;
        try {
            const d = ev.get_scroll_direction();
            if (d === Clutter.ScrollDirection.UP)
                up = true;
            else if (d === Clutter.ScrollDirection.DOWN)
                up = false;
        } catch (e) { /* 忽略 */ }
        if (up === null) {
            const [, dy] = ev.get_scroll_delta();
            up = dy < 0;
        }
        if (up === null)
            up = false;
        const step = up ? 0.08 : -0.08;
        this._whaleScale = Math.max(0.5, Math.min(2.5, (this._whaleScale || 1) + step));
        this._easeScale(1, 140, Clutter.AnimationMode.EASE_OUT_QUAD);
        if (this._snap && (this._snap.h || this._snap.v))
            this._snapAlign(140);   // 已贴边时缩放后维持贴边
        return Clutter.EVENT_STOP;
    }

    // ============ 右键菜单 ============
    _zoom(d) {
        this._whaleScale = Math.max(0.5, Math.min(2.5, (this._whaleScale || 1) + d));
        this._easeScale(1, 160, Clutter.AnimationMode.EASE_OUT_QUAD);
        if (this._snap && (this._snap.h || this._snap.v))
            this._snapAlign(160);
    }

    _goHome() {
        if (this._hold)
            this._endHold();
        // 「回家」= 主屏左下角：多显示器下不再受当前所在屏影响
        const wa = this._primaryWorkArea();
        const nw = Math.round(this._w * this._whaleScale);
        const nh = Math.round(this._h * this._whaleScale);
        if (this._whale)
            this._whale.set_position(wa.x, wa.y + wa.height - nh);
        this._snap = {h: -1, v: 1};
        this._setMirror(-1);
        this._snapAlign(280);
        this._lastMoveAt = Date.now();
    }

    _cyclePeak() {
        const i = PEAK_MODES.indexOf(this._peakMode);
        this._peakMode = PEAK_MODES[(i + 1) % PEAK_MODES.length];
        this._savePrefs();
    }

    _menuBtn(label, fn, hint) {
        const b = new St.Button({label: hint ? `${label}   ${hint}` : label, can_focus: false});
        b.style = BTN_STYLE;
        b.connect('enter-event', () => {
            b.style = BTN_HOVER;
        });
        b.connect('leave-event', () => {
            b.style = BTN_STYLE;
        });
        b.connect('clicked', () => {
            this._closeMenu();
            fn();
        });
        return b;
    }

    _openMenu(cx, cy) {
        this._closeMenu();
        this._menuPos = {cx, cy};
        const wa = this._workArea();
        const box = new St.BoxLayout({
            vertical: true,
            style: 'background-color: rgba(16,25,45,0.97); border-radius: 14px;' +
                'padding: 6px; spacing: 2px; border: 1px solid rgba(255,255,255,0.12);',
        });
        box.add_child(this._menuBtn('💰 查看余额', () => this._showBalanceFlavor()));
        box.add_child(this._menuBtn('🔄 自动刷新', () => {
            this._autoOn = !this._autoOn;
            this._savePrefs();
            if (this._autoOn && this._apiKey)
                this._fetchBalance(true, false);   // 开启即立即对齐一次
            this._openMenu(this._menuPos.cx, this._menuPos.cy);
        }, this._autoOn ? '60s' : '关'));
        box.add_child(this._menuBtn('🏠 回到左下角', () => this._goHome()));
        box.add_child(this._menuBtn('🔍 放大', () => this._zoom(0.15)));
        box.add_child(this._menuBtn('🔎 缩小', () => this._zoom(-0.15)));
        box.add_child(this._menuBtn('📒 用量', () => {
            this._usageMode = this._usageMode === 'token' ? 'ledger' : 'token';
            this._savePrefs();
            if (this._usageMode === 'token' && !this._platformToken) {
                this._bubble('令牌模式需在凭据配置\nDEEPSEEK_PLATFORM_TOKEN\n已自动回落「记账」模式', true);
            } else if (this._usageMode === 'token') {
                this._refreshTokenUsage();
                this._bubble('已切换：令牌模式\n正在拉取精确今日已用…', true);
            } else {
                this._bubble('已切换：记账模式(余额差值)', true);
            }
            this._openMenu(this._menuPos.cx, this._menuPos.cy);
        }, this._usageMode === 'token' ? '令牌' : '记账'));
        box.add_child(this._menuBtn('🎵 音色', () => {
            const keys = Object.keys(SFX_THEMES);
            const i = keys.indexOf(this._sfxTheme);
            this._sfxTheme = keys[(i + 1) % keys.length];
            this._savePrefs();
            this._playSound('pick');
            this._openMenu(this._menuPos.cx, this._menuPos.cy);
        }, SFX_THEMES[this._sfxTheme].label));
        box.add_child(this._volRow());
        box.add_child(this._menuBtn('🔊 音效', () => {
            this._soundOn = !this._soundOn;
            this._savePrefs();
            this._openMenu(this._menuPos.cx, this._menuPos.cy);
        }, this._soundOn ? '开' : '关'));
        box.add_child(this._menuBtn('💬 气泡', () => {
            this._bubbleOn = !this._bubbleOn;
            this._savePrefs();
            this._openMenu(this._menuPos.cx, this._menuPos.cy);
        }, this._bubbleOn ? '开' : '关'));
        box.add_child(this._menuBtn('🎙️ 峰谷文案', () => {
            this._cyclePeak();
            this._openMenu(this._menuPos.cx, this._menuPos.cy);
        }, PEAK_MODE_LABEL[this._peakMode]));
        box.add_child(this._menuBtn('🙈 隐藏', () => {
            try {
                // 卸载扩展(即时消失)；之后从开始菜单“DSH小鲸鱼 → 启用并放回左下角”恢复
                GLib.spawn_async(null, ['/usr/bin/gnome-extensions', 'disable', 'dsh-whale@local'],
                    null, GLib.SpawnFlags.SEARCH_PATH, null);
            } catch (e) { /* 忽略 */ }
        }));
        Main.uiGroup.add_child(box);
        box.get_preferred_width(-1);
        const [nw] = box.get_preferred_width(-1);
        const [nh] = box.get_preferred_height(-1);
        let x = Math.round(cx - nw - 12);
        let y = Math.round(cy - nh / 2);
        x = Math.max(wa.x, Math.min(wa.x + wa.width - nw, x));
        y = Math.max(wa.y, Math.min(wa.y + wa.height - nh, y));
        box.set_position(x, y);
        this._menu = box;
    }

    // 音量调节行：− / 当前值 / ＋(每档 5%)
    _volRow() {
        const row = new St.BoxLayout({style: 'spacing: 2px; padding: 2px 4px;' });
        const mk = (txt, d) => {
            const b = new St.Button({label: txt, can_focus: false});
            b.style = BTN_STYLE;
            b.connect('enter-event', () => {
                b.style = BTN_HOVER;
            });
            b.connect('leave-event', () => {
                b.style = BTN_STYLE;
            });
            b.connect('clicked', () => {
                this._vol = Math.max(0, Math.min(1, Math.round((this._vol + d) * 20) / 20));
                this._savePrefs();
                this._openMenu(this._menuPos.cx, this._menuPos.cy);
            });
            return b;
        };
        const lbl = new St.Label({
            text: '🎚 音量',
            style: 'color: #eaf1ff; font-size: 13px; font-weight: 500; padding: 8px 8px;',
        });
        const val = new St.Label({
            text: `${Math.round(this._vol * 100)}%`,
            style: 'color: #ffd76a; font-size: 13px; font-weight: 700; padding: 8px 4px;',
        });
        val.y_expand = true;
        lbl.y_expand = true;
        row.add_child(mk('−', -0.05));
        row.add_child(lbl);
        row.add_child(val);
        row.add_child(mk('＋', 0.05));
        return row;
    }

    _closeMenu() {
        if (this._menu) {
            this._menu.destroy();
            this._menu = null;
        }
    }

    // ============ 余额 / 台词 / 气泡 ============
    // 根据余额+当前风格拼台词文本（用于首次展示与点击换台词）
    _flavorText(cur, total) {
        const peak = this._isPeak();
        const sym = cur === 'USD' ? '$' : '¥';
        const used = this._todayUsage();
        const peakArr = peak ? PEAK_TXT[this._peakMode] : OFF_TXT[this._peakMode];
        const groups = [
            [peakArr, 4.5],   // 峰谷提示
            [CUTE_LINES, 3],  // 卖萌
            [TROLL_LINES, 1.6], // 吐槽
        ];
        if (used > 0)
            groups.push([[`💸 今天已花 ¥ ${used.toFixed(2)}，悠着点呀`,
                `今天用了 ¥ ${used.toFixed(2)}，充个值让我开心一下嘛~`], 1.2]);
        const line = this._pickWeighted(groups);
        return `💬 余额 ${sym} ${Number(total).toFixed(2)}\n`
            + `📊 今日已用 ${sym} ${used.toFixed(2)}\n`
            + line;
    }

    // 点击气泡 → 换下一句台词（不重新请求余额）
    _rerollBubble() {
        if (this._lastBal)
            this._bubble(this._flavorText(this._lastBal.cur, this._lastBal.total));
    }

    _showBalanceFlavor() {      // 手动查看：弹气泡
        if (!this._apiKey) {
            this._bubble('未配置 DEEPSEEK_API_KEY\n请在 ~/.dsh/.credentials.yaml 填写', true);
            return;
        }
        this._fetchBalance(false, true);
    }

    // silent=true 供 60s 自动轮询(静默)；force=true 忽略气泡开关强制显示
    _fetchBalance(silent, force) {
        if (this._fetching)
            return;
        this._fetching = true;
        const session = new Soup.Session();
        const msg = Soup.Message.new('GET', BALANCE_URL);
        msg.request_headers.append('Authorization', `Bearer ${this._apiKey}`);
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            this._fetching = false;
            try {
                const bytes = s.send_and_read_finish(res);
                const j = JSON.parse(decodeBytes(bytes.get_data()));
                const info = j.balance_infos && j.balance_infos[0];
                const total = info ? Number(info.total_balance) : null;
                const cur = (info && info.currency) || 'CNY';
                if (total !== null && isFinite(total)) {
                    const prev = this._lastBal;
                    this._lastBal = {cur, total};
                    this._ledgerObserve(total, cur);   // 记账：今日已用差值累计
                    // 自动刷新：仅当余额相对上次有变化才提示(首次只对齐缓存不弹)
                    const changed = prev && (prev.cur !== cur || Math.abs(prev.total - total) > 0.0001);
                    if (!silent || changed) {
                        const prevTotal = prev ? Number(prev.total) : null;
                        const newTotal = Number(total);
                        // 同币种且数值有变 → 给数字滚动动画
                        const anim = (prev && prev.cur === cur && prevTotal !== null
                            && Math.abs(prevTotal - newTotal) > 0.0001)
                            ? {sym: cur === 'USD' ? '$' : '¥', from: prevTotal, to: newTotal}
                            : null;
                        this._bubble(this._flavorText(cur, total), force, anim);
                    }
                } else if (!silent) {
                    this._bubble('余额解析失败，请稍后再试', true);
                }
            } catch (err) {
                if (!silent)
                    this._bubble(`获取失败：${err}`, true);
            }
        });
    }

    // 60s 自动轮询入口
    _autoTick() {
        if (!this._autoOn || !this._apiKey)
            return GLib.SOURCE_CONTINUE;
        this._fetchBalance(true, false);
        if (this._usageMode === 'token' && this._platformToken)
            this._refreshTokenUsage();
        return GLib.SOURCE_CONTINUE;
    }

    _bubbleTarget() {
        const wa = this._workArea();
        const w = this._bubW || 200;
        const h = this._bubH || 50;
        const [wx, wy] = this._whale.get_position();
        const [ww] = this._whale.get_size();
        let x = Math.round(wx + ww / 2 - w / 2);
        x = Math.max(wa.x, Math.min(wa.x + wa.width - w, x));
        let y = Math.round(wy - h - 12);
        if (y < wa.y + 4)
            y = wy + this._h + 8;
        y = Math.max(wa.y, Math.min(wa.y + wa.height - h, y));
        return {x, y};
    }

    // text 展示文本; force 忽略气泡开关; anim={sym,from,to} 时首行金额 700ms 数字滚动
    _bubble(text, force, anim) {
        if (!this._bubbleOn && !force)
            return;
        if (this._animT) {            // 停掉上一个数字滚动
            GLib.source_remove(this._animT);
            this._animT = 0;
        }
        if (this._bubTimer)
            clearTimeout(this._bubTimer);
        if (this._bub)
            this._bub.destroy();
        if (this._tail)
            this._tail.destroy();
        const lb = new St.Label({
            text,
            style: 'background-color: #ffffff; color: #203170;' +
                'border-radius: 16px; border: 1px solid rgba(32,49,112,0.15);' +
                'padding: 12px 16px; font-size: 13px; font-weight: 600;' +
                'text-align: center; line-height: 1.4;',
        });
        Main.uiGroup.add_child(lb);
        const [, natW] = lb.get_preferred_width(-1);
        const [, natH] = lb.get_preferred_height(-1);
        this._bubW = Math.max(natW, 120);
        this._bubH = Math.max(natH, 40);
        lb.set_size(this._bubW, this._bubH);
        const [, wy] = this._whale.get_position();
        const pos = this._bubbleTarget();
        lb.set_position(pos.x, pos.y);
        // 尾巴方向：气泡在鲸鱼上方→尾朝下(▼)，在鲸鱼下方→尾朝上(▲)
        this._tailChar = pos.y > wy ? '▲' : '▼';
        const tail = new St.Label({
            text: this._tailChar,
            style: 'color: #ffffff; font-size: 18px; font-weight: 700;',
        });
        Main.uiGroup.add_child(tail);
        this._tail = tail;
        this._placeTail(lb, tail);
        lb.reactive = true;                              // 气泡可点：换一句台词
        lb.connect('button-press-event', () => this._rerollBubble());
        lb.set_pivot_point(0.5, 0.5);
        lb.set_scale(0.88, 0.88);                        // 出现时 Q 弹缩放
        lb.set_opacity(0);
        tail.set_opacity(0);
        lb.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        tail.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._bub = lb;
        this._bubAt = null;   // 记录气泡当前目标，位置未变则跳过重定位，减少布局抖动
        if (!this._bubTick)
            this._bubTick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
                if (this._bub) {
                    const t = this._bubbleTarget();
                    if (!this._bubAt || this._bubAt.x !== t.x || this._bubAt.y !== t.y) {
                        this._bubAt = {x: t.x, y: t.y};
                        this._bub.ease({
                            x: t.x,
                            y: t.y,
                            duration: 80,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                        if (this._tail)
                            this._placeTail(this._bub, this._tail, t);
                    }
                    return GLib.SOURCE_CONTINUE;
                }
                this._bubAt = null;
                this._bubTick = 0;
                return GLib.SOURCE_REMOVE;
            });
        this._bubTimer = setTimeout(() => {
            if (this._bub) {
                this._bub.ease({
                    opacity: 0,
                    duration: 400,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => {
                        if (this._bub)
                            this._bub.destroy();
                        this._bub = null;
                    },
                });
                if (this._tail) {
                    this._tail.ease({
                        opacity: 0,
                        duration: 400,
                        mode: Clutter.AnimationMode.EASE_IN_QUAD,
                        onComplete: () => {
                            if (this._tail)
                                this._tail.destroy();
                            this._tail = null;
                        },
                    });
                }
            }
        }, 6000);
        // 余额数字滚动动画：首行金额从旧值平滑滚到新值
        if (anim) {
            const sym = anim.sym || '¥';
            const from = Number(anim.from) || 0;
            const to = Number(anim.to) || 0;
            const rest = text.split('\n').slice(1).join('\n');
            const head = `💬 余额 ${sym}`;
            lb.set_text(`${head} ${from.toFixed(2)}${rest ? '\n' + rest : ''}`);
            const t0 = Date.now();
            const DUR = 700;
            let lastTxt = '';
            // 16ms ≈ 60fps 平滑滚动；文本未变化时跳过 set_text，避免无谓整块重排
            this._animT = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                if (!lb || !this._bub || this._bub !== lb) {   // 气泡已被换掉/关闭
                    this._animT = 0;
                    return GLib.SOURCE_REMOVE;
                }
                const p = Math.min(1, (Date.now() - t0) / DUR);
                const e = 1 - Math.pow(1 - p, 3);   // ease-out cubic
                const v = from + (to - from) * e;
                const txt = `${head} ${v.toFixed(2)}${rest ? '\n' + rest : ''}`;
                if (txt !== lastTxt) {
                    lastTxt = txt;
                    lb.set_text(txt);
                }
                if (p >= 1) {
                    this._animT = 0;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    // 放置/更新气泡尾巴（跟随气泡目标位置）
    _placeTail(lb, tail, targetPos) {
        const t = targetPos || {x: lb.get_x(), y: lb.get_y()};
        const [, nw] = tail.get_preferred_width(-1);
        const [, nh] = tail.get_preferred_height(-1);
        let tx = Math.round(t.x + this._bubW / 2 - nw / 2);
        let ty;
        if (this._tailChar === '▼')
            ty = Math.round(t.y + this._bubH - nh / 2);   // 尾在气泡下缘(朝鲸鱼)
        else
            ty = Math.round(t.y - nh / 2);                 // 尾在气泡上缘(朝鲸鱼)
        const wa = this._workArea();
        tx = Math.max(wa.x, Math.min(wa.x + wa.width - nw, tx));
        ty = Math.max(wa.y, Math.min(wa.y + wa.height - nh, ty));
        tail.set_position(tx, ty);
    }
}
