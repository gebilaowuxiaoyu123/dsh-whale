#!/usr/bin/env node
/**
 * 桌面版 ↔ DSH 插件：记账账本兼容性测试
 *
 * 背景
 * ----
 * 两个桌面版（dsh-whale-desktop / dsh-whale-desktop-linux）与网页版插件
 * （dsh-whale-widget）**共用同一个账本文件** `~/.dsh/.dshw-usage.json`。
 *
 * 插件自 v0.3.16（lib/accounting.mjs）起改为新格式：
 *   { accounting: { version:1, active, books: { "<scope>-<币种>": { currency, days:{...}, lastAt } } } }
 * 并按「API key 指纹」分本。而桌面版旧写法是：
 *   if (!usage || usage.date !== today) usage = { date: today, ... }   // 整体重建对象
 * 跨天首次运行时这句会把插件写入的 accounting.books（全部历史账本）**整个丢弃**。
 *
 * 因此桌面版已改为与 accounting.mjs 对齐的写法（observeBalance）。
 * 本脚本从桌面版 main.js 中**提取真实的记账代码**（而非复制一份）与插件模块对测，
 * 确保两边读写同一本账时数据不丢、金额一致。
 *
 * 用法：node tools/ledger-compat-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log('  \u2713 ' + label);
  } else {
    fail++;
    console.log('  \u2717 ' + label);
  }
}
function close(actual, expected, label, eps = 1e-8) {
  const a = Number(actual);
  const e = Number(expected);
  ok(Math.abs(a - e) < eps, label + '（实际 ' + a + '，期望 ' + e + '）');
}

/** 从桌面版 main.js 中提取「记账」代码段，包装成可 require 的 CJS 模块 */
function extractLedgerModule(dirName) {
  const file = path.join(REPO, dirName, 'main.js');
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('// ---------- 记账：');
  const end = src.indexOf('function fetchBalancePayload()');
  if (start < 0 || end <= start) throw new Error(dirName + '/main.js 中未能定位记账代码段');
  const seg = src.slice(start, end);
  const code =
    "'use strict';\nconst crypto = require('crypto');\n" +
    seg +
    '\nmodule.exports = { observeBalance, ledgerScope, beijingDay, moneyUnits, ACCOUNTING_VERSION };\n';
  const out = path.join(os.tmpdir(), 'ledger-under-test-' + dirName.replace(/[^a-z0-9]/gi, '_') + '.cjs');
  fs.writeFileSync(out, code, 'utf8');
  return require(out);
}

const desktop = extractLedgerModule('dsh-whale-desktop');
const desktopLinux = extractLedgerModule('dsh-whale-desktop-linux');
const widget = await import(
  pathToFileURL(path.join(REPO, 'dsh-whale-widget', 'lib', 'accounting.mjs')).href
);

const KEY = 'sk-compat-test-0123456789abcdef';
const scope = crypto.createHash('sha256').update(KEY).digest('hex').slice(0, 24);
const CTX = scope + '-CNY';
const DAY1 = Date.parse('2026-09-27T02:00:00Z'); // 北京时间 2026-09-27 10:00
const DAY2 = Date.parse('2026-09-28T02:00:00Z'); // 北京时间 2026-09-28 10:00

console.log('账本兼容性测试（桌面版 ↔ 插件）\n');
console.log('scope = ' + scope);
console.log('day1  = ' + desktop.beijingDay(DAY1) + '   day2 = ' + desktop.beijingDay(DAY2) + '\n');

// ---------------------------------------------------------------------------
console.log('[1] 两个平台的记账实现必须一致（防止只改一个平台）');
ok(
  desktop.observeBalance.toString() === desktopLinux.observeBalance.toString(),
  'dsh-whale-desktop 与 -linux 的 observeBalance 实现相同'
);
ok(
  desktop.ledgerScope(KEY) === scope && desktopLinux.ledgerScope(KEY) === scope,
  '两平台 scope 计算与插件一致（sha256(key)[:24]）'
);

// ---------------------------------------------------------------------------
console.log('\n[2] 旧格式账本迁移：历史要保留，不能凭空丢掉');
{
  const ledger = {
    date: '2026-09-26',
    lastBalance: 50,
    lastCurrency: 'CNY',
    todayUsage: 3.5,
    history: { '2026-09-25': 1.25, '2026-09-26': 3.5 },
  };
  desktop.observeBalance(ledger, { balance: 100, currency: 'CNY', scope, at: DAY1 });
  ok(ledger.accounting && ledger.accounting.version === 1, '已升级为新格式（accounting.version=1）');
  close(ledger.accounting.legacyHistory['2026-09-26'], 3.5, '旧 history 保留进 legacyHistory');
  ok(!!ledger.accounting.books[CTX], '建立了当前账户的 book');
}

// ---------------------------------------------------------------------------
console.log('\n[3] 桌面版首次记账：今日已用从 0 起算');
{
  const ledger = {};
  desktop.observeBalance(ledger, { balance: 100, currency: 'CNY', scope, at: DAY1 });
  close(ledger.todayUsage, 0, '首次观测（尚无消费）todayUsage = 0');
  desktop.observeBalance(ledger, { balance: 97.5, currency: 'CNY', scope, at: DAY1 + 60000 });
  close(ledger.todayUsage, 2.5, '余额下降后 todayUsage = 2.5');
  close(ledger.accounting.books[CTX].days['2026-09-27'].debitUnits / 1e8, 2.5, 'debitUnits 同步累加');
}

// ---------------------------------------------------------------------------
console.log('\n[4] 插件先写 → 桌面版续写 → 插件再读（数据必须连贯）');
{
  const ledger = {};
  widget.observeBalance(ledger, { balance: 100, currency: 'CNY', scope, at: DAY1 });
  widget.observeBalance(ledger, { balance: 96, currency: 'CNY', scope, at: DAY1 + 60000 });
  close(widget.balanceSummary(ledger, '2026-09-27').amount, 4, '插件侧已记 4 元');

  desktop.observeBalance(ledger, { balance: 93.5, currency: 'CNY', scope, at: DAY1 + 120000 });
  close(ledger.todayUsage, 6.5, '桌面版续写后本地 todayUsage = 6.5');
  close(
    widget.balanceSummary(ledger, '2026-09-27').amount,
    6.5,
    '插件再次读取得到 6.5（未覆盖、未丢失）'
  );
}

// ---------------------------------------------------------------------------
console.log('\n[5] 桌面版先写 → 插件续写 → 桌面版再读（反向同样成立）');
{
  const ledger = {};
  desktop.observeBalance(ledger, { balance: 200, currency: 'CNY', scope, at: DAY1 });
  desktop.observeBalance(ledger, { balance: 198, currency: 'CNY', scope, at: DAY1 + 60000 });
  close(ledger.todayUsage, 2, '桌面版已记 2 元');

  widget.observeBalance(ledger, { balance: 195, currency: 'CNY', scope, at: DAY1 + 120000 });
  close(widget.balanceSummary(ledger, '2026-09-27').amount, 5, '插件续写后为 5 元');
  close(ledger.todayUsage, 5, '桌面版读到的兼容字段 todayUsage 也是 5');
}

// ---------------------------------------------------------------------------
console.log('\n[6] 跨天回归用例（原缺陷现场：跨天首次运行会丢光历史）');
{
  const ledger = {};
  widget.observeBalance(ledger, { balance: 100, currency: 'CNY', scope, at: DAY1 });
  widget.observeBalance(ledger, { balance: 95, currency: 'CNY', scope, at: DAY1 + 3600000 });
  close(widget.balanceSummary(ledger, '2026-09-27').amount, 5, '插件在 09-27 记了 5 元');

  // 次日桌面版首次运行
  desktop.observeBalance(ledger, { balance: 95, currency: 'CNY', scope, at: DAY2 });
  ok(!!ledger.accounting.books[CTX].days['2026-09-27'], '跨天后 09-27 的历史仍在账本里');
  close(
    widget.balanceSummary(ledger, '2026-09-27').amount,
    5,
    '插件仍能读出 09-27 的 5 元（历史未丢）'
  );
  ok(!!ledger.accounting.books[CTX].days['2026-09-28'], '09-28 已开新的一天');

  // 对照：模拟旧写法，证明原缺陷真实存在
  const legacy = {};
  widget.observeBalance(legacy, { balance: 100, currency: 'CNY', scope, at: DAY1 });
  const rebuilt =
    legacy.date !== '2026-09-28'
      ? { date: '2026-09-28', lastBalance: null, lastCurrency: null, todayUsage: 0, history: {} }
      : legacy;
  ok(!rebuilt.accounting, '【对照】旧写法重建对象后 accounting 整个消失（原缺陷复现）');
}

// ---------------------------------------------------------------------------
console.log('\n[7] 充值（余额上升）不得被误记为消费');
{
  const ledger = {};
  desktop.observeBalance(ledger, { balance: 100, currency: 'CNY', scope, at: DAY1 });
  desktop.observeBalance(ledger, { balance: 150, currency: 'CNY', scope, at: DAY1 + 60000 });
  close(ledger.todayUsage, 0, '充值后 todayUsage 仍为 0');
  close(ledger.accounting.books[CTX].days['2026-09-27'].creditUnits / 1e8, 50, '50 元计入 creditUnits');
  close(widget.balanceSummary(ledger, '2026-09-27').amount, 0, '插件侧同样为 0');
}

// ---------------------------------------------------------------------------
console.log('\n[8] 浮点精度：多笔小额累加不产生误差');
{
  const ledger = {};
  let balance = 100;
  let at = DAY1;
  desktop.observeBalance(ledger, { balance, currency: 'CNY', scope, at });
  for (const cost of [0.1, 0.2, 0.3]) {
    balance -= cost;
    at += 60000; // 时间戳须递增，否则会被乱序保护忽略
    desktop.observeBalance(ledger, { balance, currency: 'CNY', scope, at });
  }
  close(ledger.todayUsage, 0.6, '0.1+0.2+0.3 = 0.6（定点记账无浮点误差）');
}

// ---------------------------------------------------------------------------
console.log('\n[9] 重复 / 乱序样本应被忽略（防止重复计数）');
{
  const ledger = {};
  desktop.observeBalance(ledger, { balance: 100, currency: 'CNY', scope, at: DAY1 });
  desktop.observeBalance(ledger, { balance: 90, currency: 'CNY', scope, at: DAY1 + 60000 });
  close(ledger.todayUsage, 10, '正常累计 10 元');
  const again = desktop.observeBalance(ledger, { balance: 90, currency: 'CNY', scope, at: DAY1 });
  ok(again === 10, '时间戳更早的重复样本被忽略（todayUsage 仍为 10）');
}

// ---------------------------------------------------------------------------
console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
