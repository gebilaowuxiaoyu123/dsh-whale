'use strict';
/**
 * DSH 宿主契约适配层（host shim）
 *
 * 作用：让 vendored 的 DSH 网页版插件本体（`dsh-whale-widget/lib/index.js`，cordis 插件形态）
 * 直接在我们自己的 Electron 本地服务里跑起来。这样做的价值：
 *   - 桌面版**获得与网页版插件完全一致的功能**（23 条 /dsh-whale/* 路由：多厂商额度、
 *     自定义角色/音效/泡泡图、余额校正、记账明细……），不再是一份功能落后的静态前端副本；
 *   - 插件目录现在是**唯一实现来源**：以后更新插件，桌面版自动同步，无需再逐条适配路由。
 *
 * 插件对宿主的最小契约（见插件 `apply(root)`）：
 *   root.effect(fn) / root.on(evt, cb) / root.inject(deps, cb)
 *   ctx.webServer.register(route) -> disposer ；ctx.webServer.tapIndex(fn) -> disposer
 *   ctx.credentials.resolve(key) -> { value } | null ；ctx.credentials.set(key, value)
 *   ctx.get(name) / ctx.on(evt, cb) / ctx.effect(fn)
 *
 * 缺失的可选服务（connection / sessionTitle / deepseekAccount）统一返回 null：
 * 插件内部对此有**设计好的降级分支** —— 会启用它自带的「回环 + 同源」校验来保护所有路由
 * （含写接口），并跳过依赖 DSH 会话事件的功能（每轮消耗、wait.json）。
 * 桌面版没有 DSH 会话，这正是我们期望的语义。
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

/** 把字符串转义进正则字面量（凭据键名） */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 .credentials.yaml 文本里取某个键的值（兼容带引号/不带引号） */
function parseCredential(txt, key) {
  if (!txt) return null;
  const re = new RegExp('^[ \\t]*' + escapeRegExp(key) + '[ \\t]*:[ \\t]*"?([^"\\s#]+)"?[ \\t]*$', 'm');
  const m = String(txt).match(re);
  return m ? m[1] : null;
}

/** 把某个键写回 .credentials.yaml（保留文件原有结构，与桌面版 saveApiKey 同一套写法） */
function writeCredential(credFile, key, value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) throw new Error('凭据为空');
  let txt = '';
  try {
    txt = fs.readFileSync(credFile, 'utf8');
  } catch (_e) {
    txt = '';
  }
  const lineRe = new RegExp('^[ \\t]*' + escapeRegExp(key) + '[ \\t]*:[ \\t]*[^\\r\\n]*$', 'm');
  if (lineRe.test(txt)) {
    txt = txt.replace(lineRe, '  ' + key + ': ' + v);
  } else if (/^[ \t]*refs[ \t]*:[ \t]*$/m.test(txt)) {
    txt = txt.replace(/^([ \t]*refs[ \t]*:[ \t]*)$/m, '$1\n  ' + key + ': ' + v);
  } else {
    const tail = txt.replace(/\s+$/, '');
    txt = (tail ? tail + '\n\n' : '') + 'version: 1\n\nrefs:\n  ' + key + ': ' + v + '\n';
  }
  fs.mkdirSync(path.dirname(credFile), { recursive: true });
  fs.writeFileSync(credFile, txt, 'utf8');
}

/** 删除 .credentials.yaml 里的某个键（保留其它内容） */
function deleteCredential(credFile, key) {
  let txt = '';
  try {
    txt = fs.readFileSync(credFile, 'utf8');
  } catch (_e) {
    return;
  }
  const lineRe = new RegExp('^[ \\t]*' + escapeRegExp(key) + '[ \\t]*:[ \\t]*[^\\r\\n]*\\r?\\n?', 'm');
  if (lineRe.test(txt)) {
    fs.writeFileSync(credFile, txt.replace(lineRe, ''), 'utf8');
  }
}

/**
 * 定位插件入口 lib/index.js。
 * 覆盖三种部署形态：仓库内开发、electron-builder 的 extraResources、以及同级目录。
 */
function resolvePluginEntry(appDir, resourcesPath) {
  const candidates = [
    path.join(appDir, '..', 'dsh-whale-widget', 'lib', 'index.js'), // 仓库内开发
    resourcesPath ? path.join(resourcesPath, 'dsh-whale-widget', 'lib', 'index.js') : null, // 打包
    path.join(appDir, 'dsh-whale-widget', 'lib', 'index.js'), // 同级兜底
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_e) {}
  }
  return null;
}

/**
 * 创建宿主。返回 { root, routes, dispose }：
 *   - root   : 交给 plugin.apply(root)
 *   - routes : Map<path, route>，本地服务按它分发 /dsh-whale/* 请求
 *   - dispose: 卸载插件注册的所有路由与副作用
 */
function createHost(options) {
  const opts = options || {};
  const dshHome = opts.dshHome || path.join(require('os').homedir(), '.dsh');
  const credFile = opts.credFile || path.join(dshHome, '.credentials.yaml');
  const logger = opts.logger || console;

  /** @type {Map<string, {kind?:string, path:string, handler:Function}>} */
  const routes = new Map();
  const disposers = [];
  const listeners = new Map();

  function safeRun(fn, label) {
    try {
      return fn();
    } catch (err) {
      try {
        logger.warn('[whale-host] ' + label + ' 出错（已忽略）: ' + String((err && err.message) || err));
      } catch (_e) {}
      return undefined;
    }
  }

  const credentials = {
    async resolve(key) {
      const env = process.env[key];
      if (env) return { value: String(env) };
      let txt = '';
      try {
        txt = fs.readFileSync(credFile, 'utf8');
      } catch (_e) {
        return null;
      }
      const v = parseCredential(txt, key);
      return v ? { value: v } : null;
    },
    async set(key, value) {
      writeCredential(credFile, key, value);
    },
    async delete(key) {
      deleteCredential(credFile, key);
    },
  };

  const ctx = {
    webServer: {
      register(route) {
        if (!route || typeof route.path !== 'string' || typeof route.handler !== 'function') {
          return () => {};
        }
        routes.set(route.path, route);
        return () => {
          if (routes.get(route.path) === route) routes.delete(route.path);
        };
      },
      // 我们自己就是页面宿主（直接加载 /dsh-whale/widget.js），不需要往页面上注入脚本
      tapIndex() {
        return () => {};
      },
    },
    credentials,
    // 可选服务：桌面版没有 DSH 的 connection / sessionTitle / deepseekAccount
    // 返回 null，插件会走它自带的回环校验与降级分支
    get() {
      return null;
    },
    on(event, cb) {
      if (typeof cb !== 'function') return () => {};
      const arr = listeners.get(event) || [];
      arr.push(cb);
      listeners.set(event, arr);
      return () => {
        const cur = listeners.get(event) || [];
        const i = cur.indexOf(cb);
        if (i >= 0) cur.splice(i, 1);
      };
    },
    effect(fn) {
      const d = safeRun(fn, 'effect');
      return typeof d === 'function' ? d : () => {};
    },
    logger,
  };

  const root = {
    effect(fn) {
      const d = safeRun(fn, 'root.effect');
      if (typeof d === 'function') disposers.push(d);
      return typeof d === 'function' ? d : () => {};
    },
    on(event, cb) {
      const d = ctx.on(event, cb);
      disposers.push(d);
      return d;
    },
    // 桌面版三个服务都是现成的，直接同步回调（插件语义：服务就绪后执行注册逻辑）
    inject(_deps, cb) {
      if (typeof cb === 'function') safeRun(() => cb(ctx), 'root.inject');
    },
  };

  return {
    root,
    ctx,
    routes,
    dispose() {
      for (const d of disposers.splice(0)) {
        try {
          d();
        } catch (_e) {}
      }
      routes.clear();
      listeners.clear();
    },
  };
}

/**
 * 加载并启动插件本体。
 * 成功返回 { ok:true, host, entry }；失败返回 { ok:false, error }（调用方据此回退到内置实现）。
 */
async function startPlugin(options) {
  const opts = options || {};
  const host = createHost(opts);
  const entry = resolvePluginEntry(opts.appDir, opts.resourcesPath);
  if (!entry) return { ok: false, error: '未找到插件入口 dsh-whale-widget/lib/index.js', host };
  try {
    const mod = await import(pathToFileURL(entry).href);
    const plugin = mod && (mod.default || mod);
    if (!plugin || typeof plugin.apply !== 'function') {
      return { ok: false, error: '插件入口缺少 apply()', host, entry };
    }
    plugin.apply(host.root);
    return { ok: true, host, entry, name: plugin.name || '' };
  } catch (err) {
    return { ok: false, error: String((err && err.stack) || err), host, entry };
  }
}

module.exports = { createHost, startPlugin, resolvePluginEntry, parseCredential, writeCredential };
