#!/usr/bin/env node
/**
 * HotPulse CLI — 让任何 AI Agent 通过命令行操作本机「AI 热点雷达」。
 * 用法：node hotpulse.mjs <command> [args...] [--json]
 * 服务地址：环境变量 HOTPULSE_URL（默认 http://localhost:4117）
 */
const BASE = (process.env.HOTPULSE_URL || 'http://localhost:4117').replace(/\/$/, '');
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const args = argv.filter((a) => a !== '--json');
const [cmd, ...rest] = args;

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok && res.status !== 409) throw new Error(`${res.status} ${JSON.stringify(data)}`);
  return data;
}

const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));

function printKV(label, rows) {
  console.log(`\n== ${label} ==`);
  for (const r of rows) console.log(r);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const COMMANDS = {
  /** 服务健康 + AI + 通知 + 扫描状态总览 */
  async status() {
    const [health, ai, notify, scan] = await Promise.all([
      req('GET', '/api/health'),
      req('GET', '/api/ai/status'),
      req('GET', '/api/notify/status'),
      req('GET', '/api/scan/status'),
    ]);
    if (JSON_OUT) return out({ health, ai, notify, running: scan.running, lastScan: scan.lastScan?.stats, nextRunAt: scan.nextRunAt });
    console.log(`服务: ${health.ok ? 'OK' : 'DOWN'} @ ${BASE}`);
    console.log(`AI: ${ai.has_key ? `key 已配置 · 模型链 [${ai.chain.join(', ')}]` : '⚠ 未配置 OPENROUTER_API_KEY'}${ai.circuit_open ? ' · 熔断中' : ''}`);
    console.log(`推送: ${notify.push.configured ? `${notify.push.subscribers} 个订阅` : '未配置'} · 邮件: ${notify.email.ready ? '就绪' : '未配置'}`);
    console.log(`扫描: ${scan.running ? '进行中…' : '空闲'} · 下次 ${scan.nextRunAt ? new Date(scan.nextRunAt).toLocaleString('zh-CN') : '—'}`);
    if (scan.lastScan?.stats) {
      const s = scan.lastScan.stats;
      console.log(`上轮: 抓取${s.fetched} 新增${s.inserted} · AI ${s.ai?.skipped ? `跳过(${s.ai.reason})` : `甄别${s.ai.screened} 命中${s.ai.hits} 话题${s.ai.topics}`}`);
    }
  },

  /** 触发扫描并等待完成：scan [--wait 600] */
  async scan(maxWaitSec) {
    const wi = rest.indexOf('--wait');
    const maxWait = (maxWaitSec ?? (wi >= 0 ? Number(rest[wi + 1]) : 420)) * 1000;
    try {
      await req('POST', '/api/scan/run');
    } catch (e) {
      console.log('扫描已在进行中，转为等待…');
    }
    const t0 = Date.now();
    while (Date.now() - t0 < maxWait) {
      await wait(8000);
      const s = await req('GET', '/api/scan/status');
      if (!s.running && s.lastScan?.stats) {
        if (JSON_OUT) return out(s.lastScan.stats);
        const st = s.lastScan.stats;
        console.log(`扫描完成（${Math.round((Date.now() - t0) / 1000)}s）`);
        console.log(`来源: ${Object.entries(st.sources || {}).map(([k, v]) => `${k}:${v.ok ? v.count : '✗'}`).join(' ')}`);
        console.log(`新增 ${st.inserted} 条（重复 ${st.duplicates}）`);
        const a = st.ai || {};
        if (a.skipped) console.log(`AI 跳过：${a.reason}（稍后重试或检查 .env 的 key）`);
        else console.log(`AI：甄别 ${a.screened} · 关键词命中 ${a.hits} · 话题 ${a.topics}（新热点 ${a.newHot}）`);
        return;
      }
      process.stdout.write('.');
    }
    console.log('\n超时：扫描仍在进行（免费模型较慢），稍后用 topics/hits 查询结果');
  },

  /** 热点榜：topics [limit] */
  async topics() {
    const limit = rest[0] || 15;
    const rows = await req('GET', `/api/topics?limit=${limit}`);
    if (JSON_OUT) return out(rows);
    if (!rows.length) return console.log('暂无热点，先执行 scan');
    printKV(
      `热点 TOP ${rows.length}`,
      rows.map((t) => `[${Math.round(t.score)}分] ${t.title}\n    ${t.summary_zh}\n    ▸ ${t.why_hot}  · ${t.item_ids.length} 条来源 · /#topic/${t.id}`)
    );
  },

  /** 话题详情：topic <id> */
  async topic() {
    const t = await req('GET', `/api/topics/${rest[0]}`);
    if (JSON_OUT) return out(t);
    console.log(`[${t.score}分] ${t.title}\n${t.summary_zh}\n▸ ${t.why_hot}\n`);
    for (const i of t.items || []) console.log(`  · [${i.source}] ${i.title}\n    ${i.url}`);
  },

  /** 关键词列表 */
  async keywords() {
    const rows = await req('GET', '/api/keywords');
    if (JSON_OUT) return out(rows);
    if (!rows.length) return console.log('暂无盯梢关键词，用 add-keyword 添加');
    printKV('盯梢关键词', rows.map((k) => `${k.enabled ? '⏵' : '⏸'} ${k.term}（命中 ${k.hit_count}，上次 ${k.last_hit_at || '无'}）`));
  },

  /** 添加关键词：add-keyword <term> */
  async 'add-keyword'() {
    const term = rest.join(' ').trim();
    if (!term) throw new Error('用法: add-keyword <关键词>');
    const r = await req('POST', '/api/keywords', { term });
    out(JSON_OUT ? r : `已添加盯梢关键词：${r.term}（id=${r.id}）`);
  },

  /** 删除关键词：remove-keyword <id> */
  async 'remove-keyword'() {
    await req('DELETE', `/api/keywords/${rest[0]}`);
    out(JSON_OUT ? { ok: true } : '已删除');
  },

  /** 命中记录：hits <keywordId|term> [--all 含被过滤] */
  async hits() {
    const key = rest[0];
    const showAll = rest.includes('--all');
    const kws = await req('GET', '/api/keywords');
    const kw = kws.find((k) => String(k.id) === key || k.term === key);
    if (!kw) throw new Error(`找不到关键词 "${key}"，先用 keywords 查看列表`);
    const rows = await req('GET', `/api/keywords/${kw.id}/hits`);
    const list = showAll ? rows : rows.filter((r) => r.passed);
    if (JSON_OUT) return out(list);
    printKV(
      `「${kw.term}」${showAll ? '全部甄别记录' : '真命中'} ${list.length} 条`,
      list.map(
        (h) =>
          `${h.passed ? '✅HIT' : '❌过滤'} [${Math.round(h.confidence * 100)}%] [${h.source}] ${h.title}\n    AI: ${h.reason}\n    ${h.url}`
      )
    );
  },

  /** 关注范围：scopes / add-scope <label> / remove-scope <id> */
  async scopes() {
    const rows = await req('GET', '/api/scopes');
    if (JSON_OUT) return out(rows);
    printKV('关注范围', rows.map((s) => `${s.label}（检索词：${s.queries.join(', ')}）`));
  },
  async 'add-scope'() {
    const label = rest.join(' ').trim();
    if (!label) throw new Error('用法: add-scope <范围名称，如 AI 编程>');
    const r = await req('POST', '/api/scopes', { label });
    out(JSON_OUT ? r : `已添加关注范围：${r.label}`);
  },
  async 'remove-scope'() {
    await req('DELETE', `/api/scopes/${rest[0]}`);
    out(JSON_OUT ? { ok: true } : '已删除');
  },

  /** 通知：notices [--unread] */
  async notices() {
    const d = await req('GET', '/api/notices');
    const rows = rest.includes('--unread') ? d.rows.filter((r) => !r.read) : d.rows;
    if (JSON_OUT) return out({ unread: d.unread, rows });
    console.log(`未读 ${d.unread} / 总 ${d.rows.length}`);
    printKV(
      '通知',
      rows.slice(0, 30).map((n) => `${n.read ? ' ' : '●'} [${n.kind}] ${n.title}\n    ${(n.body || '').split('\n')[0]} · ${new Date(n.created_at).toLocaleString('zh-CN')}`)
    );
  },

  /** 标记已读：read <id|all> */
  async read() {
    if (rest[0] === 'all') await req('POST', '/api/notices/read', { all: true });
    else await req('POST', '/api/notices/read', { id: Number(rest[0]) });
    out(JSON_OUT ? { ok: true } : '已标记已读');
  },

  /** 一键盯梢：watch <关键词> —— 添加 + 立即扫描 + 输出命中（Agent 最常用） */
  async watch() {
    const wi = rest.indexOf('--wait');
    const waitSec = wi >= 0 ? Number(rest[wi + 1]) : undefined;
    const termArgs = rest.filter((a, i) => a !== '--wait' && !(wi >= 0 && i === wi + 1));
    const term = termArgs.join(' ').trim();
    if (!term) throw new Error('用法: watch <关键词>');
    let kws = await req('GET', '/api/keywords');
    if (!kws.find((k) => k.term === term)) {
      await req('POST', '/api/keywords', { term });
      console.log(`已添加盯梢：${term}`);
    }
    await COMMANDS.scan(waitSec);
    kws = await req('GET', '/api/keywords');
    const kw = kws.find((k) => k.term === term);
    rest[0] = String(kw.id);
    rest.splice(1, rest.length);
    await COMMANDS.hits();
  },

  /** 帮助 */
  async help() {
    console.log(`HotPulse CLI · 服务地址 ${BASE}（HOTPULSE_URL 可覆盖）

命令:
  status                     服务/AI/通知/扫描总览
  scan [--wait 秒]           触发一轮扫描并等待完成
  topics [limit]             热点榜（默认 15）
  topic <id>                 话题详情（含原始条目）
  keywords                   盯梢关键词列表
  add-keyword <term>         添加关键词
  remove-keyword <id>        删除关键词
  hits <id|关键词> [--all]   命中记录（--all 含被 AI 过滤项）
  scopes                     关注范围列表
  add-scope <label>          添加关注范围
  remove-scope <id>          删除关注范围
  notices [--unread]         通知列表
  read <id|all>              标记已读
  watch <关键词>             一键：添加+扫描+命中（推荐）

任意命令加 --json 输出机器可读 JSON。`);
  },
};

if (!cmd || cmd === 'help' || !COMMANDS[cmd]) {
  if (cmd && cmd !== 'help') console.error(`未知命令: ${cmd}\n`);
  COMMANDS.help();
  process.exit(cmd && cmd !== 'help' ? 1 : 0);
}

COMMANDS[cmd]().catch((e) => {
  console.error(`错误: ${e.message}\n提示: 确认 HotPulse 服务已启动（项目目录运行 npm run dev:server 或 node server/src/index.js），或用 HOTPULSE_URL 指定地址`);
  process.exit(1);
});
