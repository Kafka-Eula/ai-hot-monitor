#!/usr/bin/env node
/**
 * HotPulse Agent Skill CLI — 零依赖热点采集与状态管理。
 *
 * 分工（本 Skill 的核心设计）：
 *   本 CLI 做**确定性**工作：抓取 10 个信息源、算质量分与证据字段、去重、落库、合成分数。
 *   Claude 做**判断**工作：内容是否与关键词实质相关、是否真实可信、条目聚类、中文摘要点评。
 * 这样既不需要 API key、不产生调用费用，分析质量又取决于当前会话的模型。
 *
 * 用法：node hp.mjs <命令> [参数] [--json]
 * 需要 Node ≥ 22.5（用到内置 node:sqlite 与 undici）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_NODE = 22;
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < MIN_NODE || (maj === MIN_NODE && min < 5)) {
  console.error(`需要 Node ≥ ${MIN_NODE}.5（内置 node:sqlite / undici），当前 ${process.versions.node}`);
  console.error('升级后重试：https://nodejs.org/');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const args = argv.filter((a) => a !== '--json');
const [cmd, ...rest] = args;

/** 取 --flag 值（`--limit 40` / `--limit=40`），并从 rest 中移除 */
function flag(name, def) {
  const i = rest.indexOf(`--${name}`);
  if (i >= 0) {
    const v = rest[i + 1];
    if (v !== undefined && !v.startsWith('--')) {
      rest.splice(i, 2);
      return v;
    }
    rest.splice(i, 1);
    return true;
  }
  const eq = rest.findIndex((a) => a.startsWith(`--${name}=`));
  if (eq >= 0) {
    const v = rest[eq].slice(name.length + 3);
    rest.splice(eq, 1);
    return v;
  }
  return def;
}

const has = (name) => {
  const i = rest.indexOf(`--${name}`);
  if (i < 0) return false;
  rest.splice(i, 1);
  return true;
};

const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const nowIso = () => new Date().toISOString();

const { initProxy, probeAll, proxyMode } = await import('./lib/net.mjs');
const { collectAll, SOURCES } = await import('./lib/sources.mjs');
const {
  applyQualityGate,
  gates,
  evidenceLine,
  badgeText,
  freshness,
  SOURCE_LABEL,
  TIER_LABEL,
  combineScore,
  evidenceOf,
  isOfficialAnnouncement,
  isAuthorityHost,
} = await import('./lib/quality.mjs');
const state = await import('./lib/state.mjs');

/** 无发布时间的源（快照榜）：不能把采集时间冒充发布时间 */
const NO_DATE_SOURCES = new Set(['gh_trending', 'hf_papers']);

async function bootstrap() {
  await initProxy();
  state.openDb();
}

const pos = (i) => rest[i];

// ---------------- doctor ----------------

/** 环境自检：第一次用 / 出问题时的第一步。全部只读，不联网写库 */
async function doctor() {
  await bootstrap();
  const probes = await probeAll();
  const abroadBlocked = probes.filter((p) => p.abroad && !p.ok);
  const g = gates();
  const st = state.stats();

  const result = {
    node: process.versions.node,
    proxy: { mode: proxyMode(), url: process.env.HTTPS_PROXY || process.env.https_proxy || '' },
    db: { path: state.dbPath(), ...st },
    sources: probes.map((p) => ({ source: p.source, name: p.name, ok: p.ok, ms: p.ms, abroad: p.abroad, error: p.error || '' })),
    gates: { minQuality: g.minQuality, maxAgeDays: g.maxAgeDays, dedupThreshold: g.dedupThreshold },
    watches: state.listWatches().map((w) => w.term),
    scopes: state.listScopes().map((s) => s.label),
  };

  if (JSON_OUT) return out(result);

  console.log(`Node ${process.versions.node}  ·  内置 undici/node:sqlite 可用`);
  console.log(`代理: ${result.proxy.mode === 'env' ? `已启用 ${result.proxy.url}` : result.proxy.mode === 'none' ? '未配置（境外源会失败并静默跳过）' : '配置失败（直连）'}`);
  console.log(`数据库: ${result.db.path}`);
  console.log(`  条目 ${st.items} · 话题 ${st.topics} · 判定 ${st.verdicts} · 盯梢 ${st.watches} · 轮次 ${st.scans}`);
  console.log('\n信息源连通性：');
  for (const p of probes) {
    console.log(`  ${p.ok ? '✓' : '✗'} ${p.name.padEnd(14)} ${String(p.ms).padStart(5)}ms ${p.abroad ? '(境外)' : '(国内)'}${p.ok ? '' : `  ${p.error || 'HTTP ' + p.status}`}`);
  }
  if (abroadBlocked.length) {
    console.log(`\n⚠ ${abroadBlocked.length} 个境外源不可达：${abroadBlocked.map((x) => x.name).join('、')}`);
    console.log('  国内源仍可用。要启用境外源，设置 HTTPS_PROXY 指向本机代理（如 http://127.0.0.1:7897）。');
    console.log('  PowerShell: $env:HTTPS_PROXY="http://127.0.0.1:7897"; $env:NO_PROXY="localhost,127.0.0.1"');
  }
  console.log(`\n质量门槛: minQuality=${g.minQuality} maxAgeDays=${g.maxAgeDays}（改法：$env:HP_GATE_minQuality=55）`);
  if (!st.items) console.log('\n下一步：node hp.mjs collect --queries "GPT-6,Claude" 跑一次采集');
}

// ---------------- collect ----------------

/**
 * 抓取 → 质量闸门 → 落库。
 * 输出"待甄别/待聚类"工作清单，交给 Claude 判断；判定结果用 commit 写回。
 */
async function collect() {
  await bootstrap();
  const qArg = flag('queries', '');
  const onlyArg = flag('only', '');
  const hours = Number(flag('hours', 72)) || 72;
  const scopeArg = has('global');

  let queries = [];
  if (qArg) queries = String(qArg).split(',').map((s) => s.trim()).filter(Boolean);
  else if (scopeArg) queries = [];
  else queries = state.allQueries();

  const only = onlyArg ? String(onlyArg).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const nowMs = Date.now();
  const windowStartMs = nowMs - hours * 3600000;
  const sinceIso = new Date(windowStartMs).toISOString();

  const lines = [];
  const log = (source, q, msg) => lines.push(`  [${source}] ${q} → ${msg}`);

  process.stderr.write(`采集中（${queries.length ? `检索词 ${queries.length} 个` : '全局源'}，窗口 ${hours}h，代理 ${proxyMode()}）…\n`);
  const t0 = Date.now();
  const { items, stats } = await collectAll({ allQueries: queries, sinceIso, windowStartMs, log, only });
  const { passed, blocked } = applyQualityGate(items, { g: gates(), nowMs });

  const collectedAt = nowIso();
  const newIds = [];
  for (const it of passed) {
    const r = state.upsertItem({ ...it, collected_at: collectedAt });
    it.id = r.id;
    if (r.isNew) newIds.push(r.id);
  }

  const coreFailed = SOURCES.filter((s) => s.core && (!only || only.includes(s.name)) && stats[s.name] && !stats[s.name].ok);
  // 拦截原因去掉括号里的数值后聚合（{too_old:45, hn_low_engagement:11,…}），便于观察门槛是否过严
  const reasonCounts = {};
  for (const b of blocked) {
    const k = b.reason.split('(')[0];
    reasonCounts[k] = (reasonCounts[k] || 0) + 1;
  }
  state.recordScan({
    queries,
    stats: {
      fetched: items.length,
      passed: passed.length,
      blocked: blocked.length,
      new_items: newIds.length,
      ms: Date.now() - t0,
      sources: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ok: v.ok, count: v.count, error: v.error || '' }])),
      blocked_reasons: reasonCounts,
    },
  });

  if (JSON_OUT) {
    return out({
      ok: coreFailed.length === 0,
      queries,
      window_hours: hours,
      fetched: items.length,
      passed: passed.length,
      blocked: blocked.length,
      new_items: newIds.length,
      ms: Date.now() - t0,
      stats,
      core_failed: coreFailed.map((s) => s.name),
      log: lines,
    });
  }

  console.log(`\n=== 采集完成（${Math.round((Date.now() - t0) / 1000)}s）===`);
  console.log(`抓取 ${items.length} 条 → 过闸门 ${passed.length} 条 → 其中新入库 ${newIds.length} 条`);
  console.log('\n各信息源：');
  for (const [name, v] of Object.entries(stats)) {
    const core = SOURCES.find((s) => s.name === name)?.core;
    console.log(`  ${v.ok ? '✓' : '✗'} ${(SOURCE_LABEL[name] || name).padEnd(16)} ${String(v.count).padStart(4)} 条 ${String(Math.round(v.ms)).padStart(6)}ms${!v.ok ? `  ${String(v.error).slice(0, 60)}` : ''}${core ? '  [核心]' : ''}`);
  }
  if (coreFailed.length) console.log(`\n⚠ 核心源失败：${coreFailed.map((s) => s.name).join('、')}（本轮结果不完整，可稍后重试）`);

  console.log(`\n拦截 ${blocked.length} 条：${Object.entries(reasonCounts).map(([k, v]) => `${k}×${v}`).join(' · ')}`);

  if (!newIds.length) {
    console.log('\n本轮没有新条目。直接查结果：node hp.mjs topics 10');
    return;
  }
  console.log(`\n下一步：node hp.mjs pending   （取工作清单交给你判断，然后 commit 写回）`);
}

// ---------------- pending ----------------

/**
 * 输出待 Claude 判断的工作清单。
 * 分两堆：screen（关键词甄别，只有设了盯梢关键词才需要）与 cluster（聚类）。
 * 证据字段（official/auth/farm/eng/q）已由代码算好，模型不必推测媒体身份。
 */
async function pending() {
  await bootstrap();
  const screenLimit = Number(flag('screen-limit', 25)) || 25;
  const clusterLimit = Number(flag('cluster-limit', 30)) || 30;
  const hours = Number(flag('hours', 72)) || 72;
  const verbose = has('verbose');

  const watches = state.listWatches().map((w) => w.term);
  const scopes = state.listScopes();
  const sinceIso = new Date(Date.now() - hours * 3600000).toISOString();

  // 未甄别：该条目对**任一**盯梢关键词都还没有判定记录
  const db = state.openDb();
  const unscreened = watches.length
    ? db
        .prepare(
          `SELECT i.* FROM items i
           WHERE i.collected_at>=? AND NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.item_id=i.id)
           ORDER BY i.quality_score DESC, i.id DESC LIMIT ?`
        )
        .all(sinceIso, screenLimit * 2)
    : [];

  // 未聚类：还没归入任何话题（含被判为噪音的，交给模型再确认一次是否真的无归属）
  const unclustered = db
    .prepare(
      `SELECT i.* FROM items i
       WHERE i.collected_at>=? AND NOT EXISTS (SELECT 1 FROM topic_items ti WHERE ti.item_id=i.id)
       ORDER BY i.quality_score DESC, i.id DESC LIMIT ?`
    )
    .all(sinceIso, clusterLimit);

  const hydrate = (r) => ({ ...r, metrics: JSON.parse(r.metrics || '{}'), engagement: r.engagement });
  const screenItems = unscreened.map(hydrate);
  const clusterItems = unclustered.map(hydrate);
  const keys = state.existingClusterKeys();

  if (JSON_OUT) {
    return out({
      note: '判定只看给定证据字段与来源，不要用模型自身知识否定新产品的存在。当前日期见 today。',
      today: nowIso().slice(0, 10),
      watches,
      scopes: scopes.map((s) => ({ label: s.label, queries: s.queries })),
      screen: screenItems.map((it) => ({ id: it.id, ev: evidenceLine(it), title: it.title, summary: it.summary.slice(0, 200), url: it.url, published_at: it.published_at })),
      cluster: clusterItems.map((it) => ({ id: it.id, ev: evidenceLine(it), title: it.title, summary: it.summary.slice(0, 300), url: it.url, published_at: it.published_at })),
      existing_topics: keys,
    });
  }

  console.log(`\n【当前日期 ${nowIso().slice(0, 10)}】证据字段已由代码算好，直接采用：`);
  console.log('  src=信息源 tier=来源分级(1官方一手/2强策展/3媒体/4泛搜索) eng=加权互动/入库门槛~权威门槛');
  console.log('  official=1 厂商官方一手 · auth=1 在权威媒体名单内 · farm=1 内容农场/自媒体转载站');
  console.log('  q=规则质量分 · m=原始互动 · age=距今小时\n');

  if (!watches.length) {
    console.log('（未设置盯梢关键词，跳过甄别环节。设置：node hp.mjs watch <关键词>）\n');
  } else {
    console.log(`=== 待甄别 ${screenItems.length} 条 × 关键词 ${watches.join('、')} ===`);
    for (const it of screenItems) printWorkItem(it, verbose);
    console.log('\n→ 对每个【关键词 × 条目】判 relevant/genuine/confidence/reason，写入 commit 文件');
  }

  console.log(`\n=== 待聚类 ${clusterItems.length} 条 ===`);
  for (const it of clusterItems) printWorkItem(it, verbose);

  if (keys.length) {
    console.log(`\n=== 既有话题（同一事件请沿用 cluster_key 并入，不要另开）===`);
    for (const k of keys.slice(0, 20)) {
      console.log(`  ${k.cluster_key.padEnd(28)} [${Math.round(k.score)}分 ${TIER_LABEL[k.evidence_tier] || k.evidence_tier}] ${k.title}`);
    }
  }
  if (scopes.length) {
    console.log(`\n关注范围（话题的 scope 从这里选，无则空）：${scopes.map((s) => s.label).join(' / ')}`);
  }
  console.log('\n下一步：把判定与话题写成 JSON，执行 node hp.mjs commit --file <路径>');
}

function printWorkItem(it, verbose) {
  const fresh = freshness(it.published_at);
  const dateNote = NO_DATE_SOURCES.has(it.source) ? '该源不提供发布时间' : it.published_at ? `${it.published_at.slice(0, 16).replace('T', ' ')}${fresh ? ` (${fresh.label})` : ''}` : '时间未知';
  console.log(`\n[${it.id}] ${evidenceLine(it)}`);
  console.log(`    ${it.title}`);
  const summary = (verbose ? it.summary : it.summary.slice(0, 160)).trim();
  if (summary) console.log(`    ${summary}`);
  console.log(`    ${it.url}`);
  if (it.author) console.log(`    发布者: ${it.author} · ${dateNote}`);
}

// ---------------- commit ----------------

/**
 * 写回 Claude 的判断结果。
 * 输入文件：{"verdicts":[{"k","i","relevant","genuine","confidence","reason"}],
 *            "topics":[{"cluster_key","title","summary_zh","why_hot","score","item_ids","scope"}]}
 * 分数不在这里定：commit 用代码按证据等级重算封顶，AI 给的只是基线分。
 */
async function commit() {
  await bootstrap();
  const file = flag('file', '');
  if (!file) throw new Error('用法: commit --file <json路径>（内容含 verdicts[] 与 topics[]）');
  const abs = path.resolve(String(file));
  if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${abs}`);

  let data;
  try {
    data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Error(`JSON 解析失败：${e.message}。请确认是合法 JSON（不要有注释和尾逗号）`);
  }

  const g = gates();
  const verdicts = Array.isArray(data.verdicts) ? data.verdicts : [];
  const topics = Array.isArray(data.topics) ? data.topics : [];
  const minConf = Number(process.env.HP_MIN_CONFIDENCE || 0.6);

  const hits = [];
  const vErr = [];
  for (const v of verdicts) {
    const term = String(v.k ?? v.term ?? '').trim();
    const itemId = Number(v.i ?? v.item_id);
    if (!term || !itemId) {
      vErr.push(`缺 k/i：${JSON.stringify(v).slice(0, 60)}`);
      continue;
    }
    if (!state.getItem(itemId)) {
      vErr.push(`条目 ${itemId} 不存在`);
      continue;
    }
    // 代码兜底：理由自曝"无官方佐证/传闻"却判 genuine=true 是言行不一，降级——
    // 但**只降级非官方非权威的来源**。权威媒体(auth=1)的可信转述本身即佐证，
    // 若模型写"未见官方"却放行属措辞问题而非判断错误，不能误杀（对齐 screen.js，曾误杀澎湃/每经）。
    let genuine = Boolean(v.genuine);
    const item = state.getItem(itemId);
    const strong =
      item.source_tier === 1 ||
      isOfficialAnnouncement(item.source, item.host, item.url) ||
      isAuthorityHost(item.host);
    const hedge = /未见官方|缺乏官方|无官方|没有官方|未见权威|缺乏佐证|无佐证|未经证实|传闻|爆料|泄露|无法证实|存疑/.test(v.reason || '');
    if (genuine && hedge && !strong) genuine = false;
    state.saveVerdict({ term, item_id: itemId, relevant: Boolean(v.relevant), genuine, confidence: Number(v.confidence) || 0, reason: String(v.reason || '') });
    if (v.relevant && genuine && (Number(v.confidence) || 0) >= minConf) hits.push({ term, item_id: itemId, reason: v.reason, confidence: v.confidence });
  }

  const topicResults = [];
  const tErr = [];
  for (const t of topics) {
    if (!t.cluster_key || !t.title || !Array.isArray(t.item_ids) || !t.item_ids.length) {
      tErr.push(`字段不全：${JSON.stringify(t).slice(0, 70)}`);
      continue;
    }
    const r = state.upsertTopic({ ...t, scope: String(t.scope || '') }, g);
    if (r.skipped) tErr.push(`${t.cluster_key}: ${r.skipped}`);
    else topicResults.push({ ...r, cluster_key: t.cluster_key, title: t.title });
  }

  if (JSON_OUT) {
    return out({ verdicts_saved: verdicts.length - vErr.length, hits, topics_saved: topicResults.length, topic_errors: tErr, verdict_errors: vErr });
  }
  console.log(`\n已写入：判定 ${verdicts.length - vErr.length} 条，话题 ${topicResults.length} 个`);
  if (hits.length) {
    console.log(`\n✅ 达到通知阈值的关键词命中 ${hits.length} 条：`);
    for (const h of hits) {
      const it = state.getItem(h.item_id);
      console.log(`  [${h.term}] ${Math.round((h.confidence || 0) * 100)}% ${it?.title?.slice(0, 60)}`);
      console.log(`      AI: ${h.reason}`);
    }
  } else if (verdicts.length) {
    console.log('本轮没有关键词命中（都被判为蹭词/不可信/置信度不足）。');
  }
  for (const e of tErr) console.log(`  ⚠ 话题未写入: ${e}`);
  for (const e of vErr) console.log(`  ⚠ 判定未写入: ${e}`);
  console.log('\n查看：node hp.mjs topics 10 | node hp.mjs hits <关键词> --all');
}

// ---------------- topics / topic ----------------

/** 话题列表：筛选 + 排序（对齐 F2b 热点检索） */
async function topics() {
  await bootstrap();
  const opts = {
    q: flag('q', ''),
    scope: flag('scope', ''),
    tier: flag('tier', ''),
    sources: flag('sources', ''),
    hours: Number(flag('hours', 0)) || 0,
    min_score: Number(flag('min-score', 0)) || 0,
    sort: flag('sort', 'score'),
    limit: Number(pos(0) || flag('limit', 10)) || 10,
    offset: Number(flag('offset', 0)) || 0,
  };
  if (has('strong')) opts.tier = 'strong';
  const r = state.listTopics(opts);

  if (JSON_OUT) return out(r);
  if (!r.rows.length) {
    console.log('没有符合条件的话题。先 collect + pending + commit 跑一轮。');
    return;
  }
  const axis = opts.hours ? `近${opts.hours}h` : '全部';
  console.log(`\n=== 热点榜（${axis}，按${{ score: '热度', updated: '最新', sources: '跨源数', engagement: '互动量' }[opts.sort] || '热度'}排序，第 ${r.offset + 1}–${Math.min(r.offset + r.limit, r.total)} 条 / 共 ${r.total} 条）===`);
  for (const t of r.rows) {
    const fresh = freshness(t.published_first);
    const badge = badgeText(t.top_metrics?.source, t.top_metrics?.values || {}, 3);
    console.log(`\n[${t.id}] ${Math.round(t.score)}分 · ${TIER_LABEL[t.evidence_tier] || t.evidence_tier} · ${t.source_count} 个源${t.authority_count ? ` · ${t.authority_count} 家权威` : ''}`);
    console.log(`    ${t.title}`);
    if (t.summary_zh) console.log(`    ${t.summary_zh}`);
    if (t.why_hot) console.log(`    ▸ ${t.why_hot}`);
    const pub = t.published_first ? `首发 ${t.published_first.slice(0, 16).replace('T', ' ')}${fresh ? ` (${fresh.label})` : ''}` : '该源不提供发布时间';
    console.log(`    ${pub}${badge ? ` · ${badge}` : ''} · ${t.scope || '未分类'} · 详情 node hp.mjs topic ${t.id}`);
  }
  if (r.weak_count) console.log(`\n（其中低佐证/单源孤证 ${r.weak_count} 个；只看有佐证的加 --strong）`);
}

/** 话题详情：逐条原始来源 + 互动 + 发布/收录区分（F2c 信息价值速判） */
async function topic() {
  await bootstrap();
  const id = pos(0);
  if (!id) throw new Error('用法: topic <id|cluster_key>');
  const t = state.getTopic(id);
  if (!t) throw new Error(`话题 ${id} 不存在`);

  if (JSON_OUT) return out(t);
  const fresh = freshness(t.published_first);
  // getTopic 已把 metrics 解析成对象，这里不能再 JSON.parse（会把对象当字符串解析）
  const ev = evidenceOf(t.items || [], gates());
  const final = combineScore(t.base_score, ev.engagement_total, ev, gates());
  console.log(`\n[${Math.round(t.score)}分] ${t.title}`);
  console.log(`${t.summary_zh}`);
  console.log(`▸ 为什么火：${t.why_hot}`);
  console.log(`证据：${TIER_LABEL[t.evidence_tier] || t.evidence_tier} · ${ev.source_count} 个源 · ${ev.host_count} 个域名 · 权威/官方 ${ev.authority_media_count} 家 · 加权互动 ${ev.engagement_total}`);
  console.log(`分数构成：AI 基线 ${final.base} × 0.6 + 互动分量 ${final.engagement} × 0.4 = ${final.blended}${final.capped ? ` → 封顶到 ${final.score}（证据等级 ${TIER_LABEL[final.tier]}上限 ${final.cap}）` : ''}`);
  console.log(`发布轴：${t.published_first ? `${t.published_first.slice(0, 16).replace('T', ' ')}${fresh ? ` (${fresh.label})` : ''}` : '无发布时间'} → 最新 ${t.published_last ? t.published_last.slice(0, 16).replace('T', ' ') : '—'}\n`);
  for (const it of t.items || []) {
    const badge = badgeText(it.source, it.metrics, 4);
    console.log(`  · [${SOURCE_LABEL[it.source] || it.source}] ${it.title}`);
    console.log(`    ${it.host || '—'} · ${badge || '该源无互动数据'} · ${it.published_at ? `发布于 ${it.published_at.slice(0, 16).replace('T', ' ')}` : '发布于未知'} · 收录于 ${it.collected_at?.slice(0, 10)}`);
    if (it.metrics?.created_at) console.log(`    建库于 ${String(it.metrics.created_at).slice(0, 10)}（trending 老库常驻榜，总星数不是热点信号）`);
    console.log(`    ${it.url}`);
  }
}

// ---------------- watch / unwatch / watches ----------------

async function watch() {
  await bootstrap();
  const term = rest.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!term) throw new Error('用法: watch <关键词>');
  const r = state.addWatch(term);
  if (JSON_OUT) return out(r);
  console.log(r.isNew ? `已添加盯梢：${term}` : `已在盯梢列表中：${term}`);
  if (has('now')) {
    console.log('立即采集一轮…');
    await collect();
  } else {
    console.log(`下一步：node hp.mjs collect（把 ${term} 加入检索词）`);
  }
}

async function unwatch() {
  await bootstrap();
  const term = rest.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!term) throw new Error('用法: unwatch <关键词>');
  const ok = state.removeWatch(term);
  out(JSON_OUT ? { removed: ok } : ok ? `已移除盯梢：${term}` : `盯梢列表里没有：${term}`);
}

async function watches() {
  await bootstrap();
  const rows = state.listWatches();
  if (JSON_OUT) return out(rows);
  if (!rows.length) return console.log('暂无盯梢关键词。添加：node hp.mjs watch <关键词>');
  console.log('\n=== 盯梢关键词 ===');
  for (const w of rows) {
    console.log(`  ${w.term}（真命中 ${w.hit_count}，上次命中 ${w.last_hit_at ? w.last_hit_at.slice(0, 16).replace('T', ' ') : '无'}）`);
  }
}

// ---------------- scope ----------------

async function scope() {
  await bootstrap();
  const sub = pos(0);
  const rows = state.listScopes();
  if (!sub || sub === 'list') {
    if (JSON_OUT) return out(rows);
    if (!rows.length) return console.log('暂无关注范围。添加：node hp.mjs scope add <名称> [检索词1,检索词2]');
    console.log('\n=== 关注范围 ===');
    for (const s of rows) console.log(`  ${s.label}（检索词：${s.queries.join('、')}）`);
    return;
  }
  if (sub === 'add') {
    const label = pos(1);
    if (!label) throw new Error('用法: scope add <名称> [检索词1,检索词2]');
    const qsRaw = pos(2);
    const r = state.addScope(label, qsRaw ? String(qsRaw).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
    return out(JSON_OUT ? r : `${r.created ? '已添加' : '已更新'}关注范围：${r.label}（检索词：${r.queries.join('、')}）`);
  }
  if (sub === 'remove') {
    const ok = state.removeScope(pos(1));
    return out(JSON_OUT ? { removed: ok } : ok ? `已移除：${pos(1)}` : `不存在：${pos(1)}`);
  }
  throw new Error('用法: scope [list|add <名称> [检索词]|remove <名称>]');
}

// ---------------- hits ----------------

/** 某关键词的甄别记录（含被过滤项，可解释误杀） */
async function hits() {
  await bootstrap();
  const term = rest.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!term) throw new Error('用法: hits <关键词> [--all] [--limit N]');
  const onlyPassed = !has('all');
  const limit = Number(flag('limit', 50)) || 50;
  const rows = state.listVerdicts(term, { onlyPassed, limit });
  const minConf = Number(process.env.HP_MIN_CONFIDENCE || 0.6);

  if (JSON_OUT) return out(rows);
  const watches = state.listWatches().map((w) => w.term);
  if (!watches.includes(term) && !rows.length) {
    console.log(`「${term}」没有判定记录。先：node hp.mjs watch ${term} → collect → pending → commit`);
    return;
  }
  console.log(`\n== 「${term}」${onlyPassed ? '真命中' : '全部甄别记录'} ${rows.length} 条 ==`);
  for (const h of rows) {
    const badge = badgeText(h.source, h.metrics, 3);
    const mark = h.passed ? (h.confidence >= minConf ? '✅HIT' : '⚪低置信') : '❌过滤';
    console.log(`\n${mark} [${Math.round((h.confidence || 0) * 100)}%] [${SOURCE_LABEL[h.source] || h.source}] ${h.title}`);
    console.log(`    AI: ${h.reason}`);
    console.log(`    ${h.url}${badge ? ` · ${badge}` : ''}`);
    console.log(`    ${h.published_at ? `发布于 ${h.published_at.slice(0, 16).replace('T', ' ')}` : '发布于未知'} · 判定于 ${h.screened_at.slice(0, 16).replace('T', ' ')}`);
  }
  if (!rows.length) console.log('（无记录）');
  if (onlyPassed) console.log('\n看被过滤掉的（含误杀排查）：加 --all');
}

// ---------------- digest ----------------

/** 今日简报：把结果整理成可直接播报的中文（Agent 最需要的产出形态） */
async function digest() {
  await bootstrap();
  const hours = Number(flag('hours', 24)) || 24;
  const limit = Number(pos(0) || flag('limit', 8)) || 8;
  const r = state.listTopics({ hours, tier: 'strong', sort: 'score', limit });
  const weak = state.listTopics({ hours, tier: 'weak', limit: 3 });
  const minConf = Number(process.env.HP_MIN_CONFIDENCE || 0.6);
  const hits = state.listWatches().flatMap((w) => state.listVerdicts(w.term, { onlyPassed: true, limit: 5 }).filter((h) => h.confidence >= minConf && Date.parse(h.screened_at) > Date.now() - hours * 3600000));
  const scans = state.listScans(1)[0];

  if (JSON_OUT) return out({ hours, topics: r.rows, weak: weak.rows, keyword_hits: hits, last_scan: scans || null });

  console.log(`\n============ HotPulse 简报 · 近 ${hours} 小时 ============`);
  if (scans) {
    const s = scans.stats;
    console.log(`上轮采集 ${scans.started_at.slice(5, 16).replace('T', ' ')}：抓取 ${s.fetched} · 过闸门 ${s.passed} · 新增 ${s.new_items}`);
  }
  if (hits.length) {
    console.log(`\n【盯梢关键词命中】${hits.length} 条`);
    for (const h of hits.slice(0, 8)) {
      console.log(`  ✅ [${h.term}] ${Math.round(h.confidence * 100)}% ${h.title}`);
      console.log(`     ${h.reason} · ${h.url}`);
    }
  }
  if (!r.rows.length) {
    console.log(`\n【热点】近 ${hours} 小时没有佐证充分的新热点。`);
    if (weak.total) console.log(`（有 ${weak.total} 个单源孤证，不足以通知，看全部：node hp.mjs topics 10）`);
    return;
  }
  console.log(`\n【热点 TOP ${r.rows.length}】`);
  r.rows.forEach((t, i) => {
    const fresh = freshness(t.published_first);
    const badge = badgeText(t.top_metrics?.source, t.top_metrics?.values || {}, 3);
    console.log(`\n${i + 1}. [${Math.round(t.score)}分 · ${TIER_LABEL[t.evidence_tier]}] ${t.title}`);
    console.log(`   ${t.summary_zh}`);
    console.log(`   ▸ ${t.why_hot}`);
    console.log(`   来源 ${t.primary_label || t.source_count + ' 个源'}${t.authority_count > 1 ? ` +${t.authority_count - 1} 家权威` : ''} · ${t.source_count} 源交叉 · 加权互动 ${t.engagement_total}${badge ? ` · ${badge}` : ''}`);
    console.log(`   ${t.published_first ? `首发 ${t.published_first.slice(5, 16).replace('T', ' ')}` : '该源不提供发布时间'}${fresh ? ` · ${fresh.label}` : ''} · ${t.scope || '未分类'}`);
  });
  if (weak.total) console.log(`\n（另有 ${weak.total} 个低佐证话题被折叠：单源孤证，热度已封顶，不足以当热点）`);
  console.log('\n======================================================');
}

// ---------------- stats / history / reset ----------------

async function stats() {
  await bootstrap();
  const st = state.stats();
  if (JSON_OUT) return out(st);
  console.log(`\n数据库 ${state.dbPath()}`);
  console.log(`条目 ${st.items} · 话题 ${st.topics} · 判定 ${st.verdicts} · 盯梢 ${st.watches} · 采集轮次 ${st.scans}`);
  console.log('\n各源入库条目：');
  for (const r of st.by_source) console.log(`  ${(SOURCE_LABEL[r.source] || r.source).padEnd(16)} ${r.c}`);
}

async function history() {
  await bootstrap();
  const limit = Number(pos(0) || 10) || 10;
  const rows = state.listScans(limit);
  if (JSON_OUT) return out(rows);
  if (!rows.length) return console.log('还没有采集记录。');
  console.log(`\n=== 最近 ${rows.length} 轮采集 ===`);
  for (const r of rows) {
    const s = r.stats;
    const failed = Object.entries(s.sources || {}).filter(([, v]) => !v.ok).map(([k]) => k);
    console.log(`  ${r.started_at.slice(5, 19).replace('T', ' ')}  抓${s.fetched ?? '?'} 过${s.passed ?? '?'} 新增${s.new_items ?? '?'} ${s.ms ? `(${Math.round(s.ms / 1000)}s)` : ''}${failed.length ? `  ✗${failed.join(',')}` : ''}`);
  }
}

async function reset() {
  await bootstrap();
  if (!has('yes')) {
    console.log('这会清空本 Skill 的全部数据（条目/话题/判定/盯梢）。确认请加 --yes');
    console.log(`数据库位置：${state.dbPath()}`);
    return;
  }
  state.resetAll();
  out(JSON_OUT ? { ok: true } : '已清空。');
}

// ---------------- help ----------------

async function help() {
  console.log(`HotPulse Agent Skill CLI · 零依赖热点采集（Node ≥22.5，无需 npm install）
数据：${state.dbPath()}（可用 HP_DB 覆盖）

【核心工作流】Claude 判断 + CLI 抓取
  doctor                       环境自检：Node/代理/各源连通性/库状态（第一次先跑这个）
  collect [--queries a,b]      抓取 10 源 → 质量闸门 → 入库（--global 只跑全局源）
    [--hours 72] [--only hn,blog]
  pending                      取"待判断"工作清单（证据字段已算好，交给你甄别/聚类）
    [--screen-limit 25] [--cluster-limit 30] [--verbose]
  commit --file <json>         写回你的判断：{"verdicts":[…],"topics":[…]}
                               分数由代码按证据等级重算封顶，你给的只是基线分

【查询】
  topics [n] [--q 词] [--scope X] [--tier strong] [--sources hn,blog]
           [--hours 24] [--min-score 70] [--sort score|updated|sources|engagement]
  topic <id|cluster_key>       详情：逐条来源、原始互动、发布/收录区分、分数构成
  digest [n] [--hours 24]      今日简报（可直接播报的中文，含命中+热点+速判字段）
  hits <关键词> [--all]        该关键词的甄别记录（--all 含被过滤项，可排查误杀）
  stats / history [n]          库统计 / 采集轮次历史

【盯梢与范围】
  watch <关键词> [--now]       添加盯梢关键词（--now 顺带采集一轮）
  watches / unwatch <关键词>
  scope list                   关注范围（热点聚合域）
  scope add <名称> [检索词1,检索词2]
  scope remove <名称>

【维护】
  reset --yes                  清空本 Skill 数据

任意命令加 --json 输出机器可读 JSON。
环境变量：HOTPULSE 无关；HP_DB 换库路径；HP_MIN_CONFIDENCE 命中阈值(默认0.6)；
         HP_GATE_minQuality/HP_GATE_maxAgeDays/… 调质量门槛；HTTPS_PROXY 走代理。`);
}

const COMMANDS = { doctor, collect, pending, commit, topics, topic, digest, hits, watch, unwatch, watches, scope, stats, history, reset, help };

if (!cmd || cmd === 'help' || !COMMANDS[cmd]) {
  if (cmd && cmd !== 'help') console.error(`未知命令: ${cmd}\n`);
  await COMMANDS.help();
  process.exit(cmd && cmd !== 'help' ? 1 : 0);
}

try {
  await COMMANDS[cmd]();
} catch (e) {
  console.error(`错误: ${e.message}`);
  process.exit(1);
}
