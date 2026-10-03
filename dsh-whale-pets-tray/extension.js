/**
 * DSH 桌宠控制 —— GNOME 顶栏图标（Shell 45+，ESM 扩展）
 * ============================================================================
 * 干什么：
 *   顶栏放一个 🐋 按钮，点开能看到两个桌宠的状态，并直接开关：
 *     · DSH 小鲸鱼（Electron 桌面挂件，余额显示）
 *     · Live2D 鲸鱼娘（Coopanion）
 *   运行中的那个前面会有 ● 标记，点一下就是「切换」（开着就关，关着就开）。
 *
 * 为什么这么实现：
 *   1. 不自己造一套启停逻辑 —— 全部转发给仓库里的 tools/petctl.sh。
 *      桌面图标、开机自启、DSH 挂件的控制条、这个顶栏图标，四个入口同一套实现，
 *      不会出现「从 A 入口开的、从 B 入口关不掉」这种分裂。
 *   2. 状态读取必须**异步**：同步 spawn 会阻塞 GNOME Shell 主循环（界面卡顿）。
 *      这里用 Gio.Subprocess + communicate_utf8_async。
 *   3. 路径用候选列表 + 环境变量覆盖：扩展装到 ~/.local/share/gnome-shell/extensions/
 *      之后就和仓库分家了，不能靠相对路径。
 *
 * 安装：bash dsh-whale-pets-tray/install.sh
 * 调试：journalctl -f -o cat /usr/bin/gnome-shell | grep -i dsh
 */

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

/** petctl.sh 的候选路径（都找不到时状态会显示「未找到」，不会静默失败） */
function resolvePetctl() {
    const env = GLib.getenv('DSHW_PETCTL');
    const home = GLib.get_home_dir();
    const cands = [
        env,
        `${home}/dsh-whale/tools/petctl.sh`,
        '/home/wukai/dsh-whale/tools/petctl.sh',
    ].filter((p) => !!p);
    for (const p of cands) {
        if (GLib.file_test(p, GLib.FileTest.EXISTS))
            return p;
    }
    return '';
}

/** 异步跑 petctl，回调整字符输出（绝不阻塞 Shell 主循环） */
function petctl(args, cb) {
    const bin = resolvePetctl();
    if (!bin) {
        cb('', 'petctl 未找到');
        return;
    }
    let proc;
    try {
        proc = Gio.Subprocess.new(['bash', bin, ...args], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch (e) {
        cb('', String(e));
        return;
    }
    proc.communicate_utf8_async(null, null, (_p, res) => {
        try {
            const [, out, err] = proc.communicate_utf8_finish(res);
            cb(out || '', err || '');
        } catch (e) {
            cb('', String(e));
        }
    });
}

const PETS = [
    { id: 'dsh', name: 'DSH 小鲸鱼', icon: '🐟' },
    { id: 'live2d', name: 'Live2D 鲸鱼娘', icon: '🐋' },
];

const PetTrayButton = GObject.registerClass(
class PetTrayButton extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'DSH 桌宠控制', false);

        this._state = { dsh: '?', live2d: '?' };

        this._label = new St.Label({
            text: '🐋',
            y_align: 0.5,
            style_class: 'dsh-whale-pets-label',
        });
        this.add_child(this._label);

        this._rows = {};
        for (const pet of PETS) {
            const item = new PopupMenu.PopupMenuItem(`${pet.icon} ${pet.name}：读取中…`);
            item.connect('activate', () => {
                this._setBusy(pet.id);
                petctl([pet.id, 'toggle'], (out, err) => {
                    if (err && !out)
                        Main.notify('切换桌宠失败', err.slice(0, 200));
                    this._refresh();
                });
            });
            this.menu.addMenuItem(item);
            this._rows[pet.id] = item;
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const refresh = new PopupMenu.PopupMenuItem('🔄 刷新状态');
        refresh.connect('activate', () => this._refresh());
        this.menu.addMenuItem(refresh);

        const openConsole = new PopupMenu.PopupMenuItem('🐋 打开鲸鱼娘装扮页');
        openConsole.connect('activate', () => {
            petctl(['live2d', 'start'], () => this._refresh());
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                try {
                    Gio.AppInfo.launch_default_for_uri('http://127.0.0.1:17788/', null);
                } catch (e) {
                    Main.notify('打不开控制台', String(e).slice(0, 160));
                }
                return GLib.SOURCE_REMOVE;
            });
        });
        this.menu.addMenuItem(openConsole);

        // 每次打开菜单都刷新一次（不做常驻轮询：桌宠不常变，轮询纯浪费）
        this.menu.connect('open-state-changed', (_m, open) => { if (open) this._refresh(); });
        this._refresh();
    }

    _setBusy(id) {
        const row = this._rows[id];
        if (row)
            row.label.text = `${row.label.text.replace(/：.*$/, '')}：切换中…`;
    }

    _refresh() {
        petctl(['status'], (out) => {
            const m = {};
            for (const line of String(out || '').split('\n')) {
                const i = line.indexOf('=');
                if (i > 0)
                    m[line.slice(0, i).trim()] = line.slice(i + 1).trim();
            }
            this._state = { dsh: m.dsh || '?', live2d: m.live2d || '?' };
            for (const pet of PETS) {
                const row = this._rows[pet.id];
                if (!row)
                    continue;
                const st = this._state[pet.id];
                const dot = st === 'running' ? '●' : '○';
                const hint = st === 'running' ? '开着（点击关闭）' : '已停（点击打开）';
                row.label.text = `${dot} ${pet.icon} ${pet.name}：${hint}`;
            }
            // 顶栏图标本身也反映状态：任一在跑就亮色，都停了就暗色
            const anyRunning = this._state.dsh === 'running' || this._state.live2d === 'running';
            this._label.text = anyRunning ? '🐋' : '🐋';
            this._label.opacity = anyRunning ? 255 : 120;
            this._label.set_style(anyRunning ? '' : 'color: rgba(255,255,255,0.5);');
        });
    }

    destroy() {
        super.destroy();
    }
});

export default class DshWhalePetsTray extends Extension {
    enable() {
        this._button = new PetTrayButton();
        Main.panel.addToStatusArea('dsh-whale-pets', this._button, 1, 'right');
        console.log('[dsh-whale-pets] 顶栏图标已加载');
    }

    disable() {
        if (this._button) {
            this._button.destroy();
            this._button = null;
        }
    }
}
