/**
 * 一次性历史数据回填（按新质量规则重算 + 清理证据不足的旧话题）。
 *
 * 用法：npm --workspace server run backfill        （正式执行）
 *       npm --workspace server run backfill:dry    （只预览不写库）
 *
 * 步骤：
 * 1) 备份 data/hotpulse.db（含 WAL/SHM）
 * 2) 对全部 items 计算 quality_score / engagement / source_tier / host，
 *    不达标者删除（与"不入库"口径一致）
 * 3) 重算 topics 的 source_count / host_count / has_official（基于存活条目），
 *    按封顶规则降分；无存活条目或纯噪音话题删除
  * 3.5) 给 GitHub Trending 条目补真实"建库时间"（repos API，仅补缺失的旧数据）
 * 4) v1.4：重算 topics 的最权威来源(primary_*)、权威来源数、最热条目原始指标、
  *    原始发布轴（来源精简与互动/时间露出，见 quality.summarizeSources）
 * 5) 打印前后对比
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import db from '../src/db.js';
import { applyQualityGate, gates, evidenceOf, capScore, summarizeSources } from '../src/quality.js';
import { fetchRepoMeta } from '../src/collectors/githubTrending.js';
import { sleep } from '../src/util/http.js';

const DRY = process.argv.includes('--dry-run');
const dbFile = config.dbFile;

function backup() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(path.dirname(dbFile), `hotpulse.pre-backup-${ts}.db`);
  // 先把 WAL 落盘再复制，保证备份完整
  db.pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(dbFile, dest);
  console.log(`[backfill] 已备份 → ${dest}`);
}

const g = gates();

const before = {
  items: db.prepare('SELECT COUNT(*) c FROM items').get().c,
  topics: db.prepare('SELECT COUNT(*) c FROM topics').get().c,
  hits: db.prepare('SELECT COUNT(*) c FROM hits').get().c,
  notices: db.prepare('SELECT COUNT(*) c FROM notices').get().c,
};
console.log('[backfill] 处理前:', JSON.stringify(before));
console.log('[backfill] 门槛:', JSON.stringify(g));
if (!DRY) backup();

// ---- 1) items 重算与清理 ----
const items = db
  .prepare('SELECT id, source, url, title, summary, published_at, collected_at, metrics, host FROM items')
  .all();

const delItemIds = new Set();
const stats = { deleted: 0, kept: 0, byReason: {}, bySource: {} };

const updItem = db.prepare(
  'UPDATE items SET quality_score=?, engagement=?, source_tier=?, host=?, quality_flags=? WHERE id=?'
);
const delItem = db.prepare('DELETE FROM items WHERE id=?');
const delHits = db.prepare('DELETE FROM hits WHERE item_id=?');

// 与实时管线完全相同的判定逻辑（硬门槛 + 质量分 + 同源近似去重）
const { passed, blocked } = applyQualityGate(items, { g });
const keptById = new Map(passed.map((p) => [p.id, p]));

db.transaction(() => {
  for (const it of items) {
    stats.bySource[it.source] ||= { kept: 0, deleted: 0 };
    const p = keptById.get(it.id);
    if (p) {
      stats.kept++;
      stats.bySource[it.source].kept++;
      if (!DRY) updItem.run(p.quality_score, p.engagement, p.source_tier, p.host, JSON.stringify(p.quality_flags || []), p.id);
    } else {
      stats.deleted++;
      stats.bySource[it.source].deleted++;
      delItemIds.add(it.id);
      if (!DRY) {
        delHits.run(it.id);
        delItem.run(it.id);
      }
    }
  }
  for (const b of blocked) {
    if (b.item.id === undefined) continue;
    const key = b.reason.replace(/\(.*/, '');
    stats.byReason[key] = (stats.byReason[key] || 0) + 1;
  }
})();

console.log(`[backfill] items: 保留 ${stats.kept} / 删除 ${stats.deleted}`);
console.log('[backfill] 删除原因:', JSON.stringify(stats.byReason));
console.log('[backfill] 各源去留:', JSON.stringify(stats.bySource));

// ---- 2.5) 给 GitHub Trending 条目补真实"建库时间"（一次性；新扫描会自动补新仓库）----
if (!DRY) {
  const trendRows = db
    .prepare("SELECT id, url, metrics FROM items WHERE source='gh_trending'")
    .all()
    .filter((r) => !JSON.parse(r.metrics || '{}').created_at);
  let patched = 0;
  for (let i = 0; i < trendRows.length; i++) {
    const row = trendRows[i];
    try {
      const meta = await fetchRepoMeta(row.url);
      if (meta?.created_at) {
        db.prepare('UPDATE items SET metrics=? WHERE id=?').run(
          JSON.stringify({ ...JSON.parse(row.metrics || '{}'), ...meta }),
          row.id
        );
        patched++;
      }
    } catch (e) {
      console.warn(`  [repo] ${row.url} 元数据失败: ${String(e.message || e).slice(0, 60)}`);
    }
    // 未登录 GitHub API 限 60 次/小时，放慢节奏并留余量
    if (i < trendRows.length - 1) await sleep(1200);
  }
  console.log(`[backfill] gh_trending 建库时间: 补 ${patched}/${trendRows.length} 条`);
} else {
  const n = db
    .prepare("SELECT metrics FROM items WHERE source='gh_trending'")
    .all()
    .filter((r) => !JSON.parse(r.metrics || '{}').created_at).length;
  console.log(`[backfill] gh_trending 建库时间: 待补 ${n} 条（试运行不写库、不请求 API）`);
}

// ---- 3) topics 证据重算、封顶降分、清理 ----
const topics = db.prepare('SELECT * FROM topics').all();
const tStats = { updated: 0, deleted: 0, demoted: 0, orphaned: 0, enriched: 0 };
const delTopic = db.prepare('DELETE FROM topics WHERE id=?');
const updTopic = db.prepare(
  `UPDATE topics SET score=?, item_ids=?, source_count=?, host_count=?, has_official=?, viral_count=?, evidence_tier=?, sources=?,
       primary_host=?, primary_label=?, primary_url=?, primary_source=?, primary_tier=?, authority_count=?, top_metrics=?, published_first=?, published_last=?
   WHERE id=?`
);

db.transaction(() => {
  for (const t of topics) {
    const ids = JSON.parse(t.item_ids || '[]');
    const alive = ids.filter((id) => !delItemIds.has(id));
    if (!alive.length) {
      tStats.deleted++;
      tStats.orphaned++;
      if (!DRY) delTopic.run(t.id);
      continue;
    }
    const rows = db
      // 不带 engagement 列：让 evidenceOf 按加权口径从 metrics 重算（旧列是"取最大值"口径）
      .prepare(`SELECT source,url,host,metrics,published_at,author,title FROM items WHERE id IN (${alive.map(() => '?').join(',')})`)
      .all(...alive);
    const ev = evidenceOf(rows);
    const capped = capScore(t.score, ev);
    const src = summarizeSources(rows);
    if (capped.capped) tStats.demoted++;
    // 仅剩 1 条且非官方、封顶后仍低于 40 → 视为噪音话题删除
    if (alive.length === 1 && !ev.has_official && capped.score < 40) {
      tStats.deleted++;
      if (!DRY) delTopic.run(t.id);
      continue;
    }
    tStats.updated++;
    if (!DRY) {
      updTopic.run(
        capped.score, JSON.stringify(alive), ev.source_count, ev.host_count, ev.has_official, ev.viral_count, capped.tier,
              JSON.stringify(ev.sources), src.primaryHost, src.primaryLabel, src.primaryUrl, src.primarySource, src.primaryTier,
              src.authorityCount, JSON.stringify(src.metrics || {}), src.publishedFirst, src.publishedLast, t.id
      );
    }
    if (!t.primary_label && src.primaryLabel) tStats.enriched++;
    if (capped.capped) {
      console.log(`  [demote] ${t.cluster_key}: ${t.score} → ${capped.score} (${capped.tier}: 源${ev.source_count}/域${ev.host_count}/官方${ev.has_official}/爆款${ev.viral_count})`);
    }
  }
})();

console.log(
  `[backfill] topics: 更新 ${tStats.updated} / 删除 ${tStats.deleted}（无存活条目 ${tStats.orphaned}）/ 降分 ${tStats.demoted} / 补来源与发布轴 ${tStats.enriched}`
);

// ---- 3) 结果对比 ----
const after = {
  items: db.prepare('SELECT COUNT(*) c FROM items').get().c,
  topics: db.prepare('SELECT COUNT(*) c FROM topics').get().c,
  hits: db.prepare('SELECT COUNT(*) c FROM hits').get().c,
};
console.log(`[backfill] ${DRY ? '试运行（未写库）' : '已完成'}，处理后:`, JSON.stringify(after));

if (!DRY) {
  console.table(
    db
        .prepare('SELECT id, score, source_count, authority_count, primary_label, published_first, substr(title,1,26) title FROM topics ORDER BY score DESC LIMIT 12')
      .all()
  );
  console.log('[backfill] 建议：重启服务并点「立即扫描」，让新规则接管后续抓取。');
} else {
  console.log('[backfill] 试运行结束。去掉 --dry-run 正式执行。');
}
