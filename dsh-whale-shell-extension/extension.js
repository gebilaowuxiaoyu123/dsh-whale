// DSH Whale Widget —— GNOME Shell 扩展版（Wayland 桌面悬浮小鲸鱼）v2
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const CRED_FILE = `${GLib.get_home_dir()}/.dsh/.credentials.yaml`;
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const POS_FILE = `${GLib.get_user_config_dir()}/dshw-pos.json`;

export default class DshWhaleWidget extends Extension {
    enable() {
        this._apiKey = null;
        this._bub = null;
        this._bubTimer = 0;
        this._drag = null;
        this._stageMotionId = 0;
        this._stageReleaseId = 0;
        this._whaleScale = 1;
        this._readKey();
        this._buildWhale();
        this._placeInitial();
    }

    disable() {
        if (this._stageMotionId) {
            global.stage.disconnect(this._stageMotionId);
            this._stageMotionId = 0;
        }
        if (this._stageReleaseId) {
            global.stage.disconnect(this._stageReleaseId);
            this._stageReleaseId = 0;
        }
        if (this._bubTimer)
            clearTimeout(this._bubTimer);
        if (this._bub)
            this._bub.destroy();
        this._bub = null;
        if (this._whale) {
            const parent = this._whale.get_parent();
            if (parent)
                parent.remove_child(this._whale);
            this._whale.destroy();
        }
        this._whale = null;
    }

    _assetPath(name) {
        // GJS 无全局 URL 构造器；import.meta.url 形如 file:///home/.../extension.js
        const filePath = decodeURIComponent(import.meta.url.replace(/^file:\/\//, ''));
        const dir = filePath.slice(0, filePath.lastIndexOf('/'));
        return `${dir}/assets/${name}`;
    }

    _workArea() {
        const lm = Main.layoutManager;
        const mono = lm.primaryMonitor
            || (Array.isArray(lm.monitors) && lm.monitors[0])
            || null;
        if (mono && mono.workArea)
            return mono.workArea;
        // 兜底：用主显示器几何
        try {
            const idx = global.display.get_primary_monitor();
            const g = global.display.get_monitor_geometry(idx);
            return {x: g.x, y: g.y, width: g.width, height: g.height};
        } catch (e) {
            return {x: 0, y: 0, width: 1920, height: 1080};
        }
    }

    _buildWhale() {
        const asset = this._assetPath('dshw.png');
        // 用 St.Icon（GIO 文件图标）：St 内部纹理缓存机制，图标类漂浮扩展的稳定做法，
        // 避免 St.Widget CSS 背景图大纹理在移动时造成合成残影/拉丝。
        const icon = new St.Icon({
            gicon: Gio.FileIcon.new(Gio.File.new_for_path(asset)),
            icon_size: 220,
            reactive: true,
            track_hover: true,
        });
        icon.set_pivot_point(0.5, 0.5);
        icon.connect('button-press-event', (a, ev) => this._onPress(a, ev));
        icon.connect('button-release-event', () => this._dragEnd());
        icon.connect('motion-event', (a, ev) => this._dragMove(ev));
        icon.connect('scroll-event', (a, ev) => this._onScroll(a, ev));

        this._w = 220;
        this._h = 220;
        this._img = icon;
        this._whale = icon;
        Main.uiGroup.add_child(this._whale);
        // Clutter 置顶：sibling 传 null 表示放到 parent 子列表最上（无 raise_top 方法）
        Main.uiGroup.set_child_above_sibling(this._whale, null);
    }

    _placeInitial() {
        const wa = this._workArea();
        let x = wa.x + wa.width - this._w - 48;
        let y = wa.y + wa.height - this._h - 84;
        try {
            const [ok, data] = GLib.file_get_contents(POS_FILE);
            if (ok) {
                const p = JSON.parse(data.toString());
                if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
                    x = p.x;
                    y = p.y;
                }
            }
        } catch (e) {
            log(`[dsh-whale] pos read failed: ${e}`);
        }
        this._whale.set_position(Math.round(x), Math.round(y));
    }

    _savePos() {
        const [x, y] = this._whale.get_position();
        try {
            GLib.file_set_contents(POS_FILE, JSON.stringify({x, y}));
        } catch (e) {
            log(`[dsh-whale] pos save failed: ${e}`);
        }
    }

    _readKey() {
        this._apiKey = null;
        try {
            const [ok, data] = GLib.file_get_contents(CRED_FILE);
            if (ok) {
                const m = data.toString().match(/DEEPSEEK_API_KEY\s*:\s*"?([^\s"#]+)"?/);
                if (m)
                    this._apiKey = m[1];
            }
        } catch (e) {
            log(`[dsh-whale] cred read failed: ${e}`);
        }
    }

    _onPress(a, ev) {
        const [ax, ay] = a.get_transformed_position();
        const [px, py] = ev.get_coords();
        this._drag = {dx: px - ax, dy: py - ay, moved: false, sx: px, sy: py};
        a.ease({
            scale_x: this._whaleScale * 0.92,
            scale_y: this._whaleScale * 0.92,
            duration: 90,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        return Clutter.EVENT_STOP;
    }

    _dragMove(ev) {
        const d = this._drag;
        if (!d)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = ev.get_coords();
        if (Math.abs(px - d.sx) > 6 || Math.abs(py - d.sy) > 6)
            d.moved = true;
        if (d.moved) {
            // St.Icon 移动不产生残影 → 用即时 set_position 最跟手；轻微节流(6ms)合并事件风暴
            const now = GLib.get_monotonic_time() / 1000;
            if (now - (d.lastTs || 0) < 6)
                return Clutter.EVENT_STOP;
            d.lastTs = now;
            const wa = this._workArea();
            const nw = Math.round(this._w * this._whaleScale);
            const nh = Math.round(this._h * this._whaleScale);
            let nx = Math.round(px - d.dx);
            let ny = Math.round(py - d.dy);
            nx = Math.max(wa.x, Math.min(wa.x + wa.width - nw, nx));
            ny = Math.max(wa.y, Math.min(wa.y + wa.height - nh, ny));
            this._whale.set_position(nx, ny);
        }
        return Clutter.EVENT_STOP;
    }

    _dragEnd() {
        const d = this._drag;
        if (!d)
            return Clutter.EVENT_PROPAGATE;
        this._drag = null;
        this._img.ease({
            scale_x: this._whaleScale,
            scale_y: this._whaleScale,
            duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
        if (!d.moved)
            this._clicked();
        this._savePos();
        return Clutter.EVENT_STOP;
    }

    _onScroll(a, ev) {
        // 滚轮调整大小 0.5x–2.5x
        const [, dy] = ev.get_scroll_delta();
        const step = dy > 0 ? -0.08 : 0.08;
        this._whaleScale = Math.max(0.5, Math.min(2.5, (this._whaleScale || 1) + step));
        a.ease({
            scale_x: this._whaleScale,
            scale_y: this._whaleScale,
            duration: 140,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        return Clutter.EVENT_STOP;
    }

    _clicked() {
        if (!this._apiKey) {
            this._bubble('未配置 DEEPSEEK_API_KEY\n请在 ~/.dsh/.credentials.yaml 填写');
            return;
        }
        this._fetchBalance();
    }

    _fetchBalance() {
        const session = new Soup.Session();
        const msg = Soup.Message.new('GET', BALANCE_URL);
        msg.request_headers.append('Authorization', `Bearer ${this._apiKey}`);
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                const j = JSON.parse(bytes.get_data());
                const info = j.balance_infos && j.balance_infos[0];
                const total = info ? Number(info.total_balance) : null;
                const cur = (info && info.currency) || 'CNY';
                if (total !== null && isFinite(total))
                    this._bubble(`💬 账户余额：${cur === 'USD' ? '$' : '¥'} ${total.toFixed(2)}\n单击刷新 · 滚轮可缩放大小`);
                else
                    this._bubble('余额解析失败，请稍后再试');
            } catch (err) {
                this._bubble(`获取失败：${err}`);
            }
        });
    }

    _bubble(text) {
        if (this._bubTimer)
            clearTimeout(this._bubTimer);
        if (this._bub)
            this._bub.destroy();
        const lb = new St.Label({
            text,
            style: 'background-color: #ffffff; color: #203170;' +
                'border-radius: 16px; border: 1px solid rgba(32,49,112,0.15);' +
                'padding: 12px 16px; font-size: 13px; font-weight: 600;' +
                'text-align: center; line-height: 1.4;',
        });
        Main.uiGroup.add_child(lb);
        const [minW, natW] = lb.get_preferred_width(-1);
        const [minH, natH] = lb.get_preferred_height(-1);
        const width = Math.max(natW, 120);
        lb.set_size(width, Math.max(natH, 40));
        const [wx, wy] = this._whale.get_position();
        const [ww] = this._whale.get_size();
        const x = Math.round(wx + ww / 2 - width / 2);
        const y = Math.max(0, Math.round(wy - Math.max(natH, 40) - 12));
        lb.set_position(x, y);
        lb.set_pivot_point(0.5, 1);
        lb.set_opacity(0);
        lb.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._bub = lb;
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
            }
        }, 6000);
    }
}
