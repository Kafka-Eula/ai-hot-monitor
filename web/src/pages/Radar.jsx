import { useEffect, useMemo, useState } from 'react';
import { api, fmtAgo, fmtShort, freshness, metricsList, SOURCE_LABEL, NO_DATE_NOTE } from '../lib/api.js';
import RadarScope from '../components/RadarScope.jsx';
import TopicFilters, { loadFilters, DEFAULT_FILTERS } from '../components/TopicFilters.jsx';
import { BackgroundBeams } from '../components/ui/background-beams.jsx';
import { Spotlight } from '../components/ui/spotlight.jsx';
import { BentoCard } from '../components/ui/bento-grid.jsx';

/** 每页话题数 */
const PAGE_SIZE = 10;

export default function Radar({ scanning, scanInfo, pollTick, progress, onOpenTopic, showToast }) {
  const [topics, setTopics] = useState([]);
  const [meta, setMeta] = useState({ total: 0, facets: null, scopes: [] });
  const [items, setItems] = useState([]);
  const [filters, setFilters] = useState(loadFilters);
  const [page, setPage] = useState(1);

  // 筛选条件写入 localStorage，刷新后保持
  useEffect(() => {
    try {
      localStorage.setItem('hotpulse.topicFilters', JSON.stringify(filters));
    } catch {
      /* 隐私模式下忽略 */
    }
  }, [filters]);

  // 只包含"影响服务端结果"的条件：切换平铺/分组不该触发重新请求
  const filterKey = JSON.stringify({
    q: filters.q,
    scope: filters.scope,
    tier: filters.tier,
    since: filters.since,
    sources: filters.sources,
    min_score: filters.min_score,
    sort: filters.sort,
    expandWeak: filters.expandWeak,
  });

  const offset = (page - 1) * PAGE_SIZE;

  // 翻页后把列表滚回顶部，避免停在长页面中间
  const goPage = (p) => {
    setPage(p);
    document.querySelector('.section-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const load = () => {
    // 话题由服务端完成筛选/排序/分页/分面计数
    const params = { ...filters, limit: PAGE_SIZE, offset };
    // 默认折叠低佐证：交给服务端过滤，否则分页会把被折叠的条目也算进页里
    if (filters.tier === 'all' && !filters.expandWeak) params.strong = '1';
    api
      .topics(params)
      .then((d) => {
        setTopics(d.rows || []);
        setMeta({ total: d.total ?? (d.rows || []).length, facets: d.facets, scopes: d.scopes || [] });
      })
      .catch(() => {});
    // items 只服务于雷达盘（近 6h 光点），与话题列表解耦
    api.items(150).then((d) => setItems(d.rows || [])).catch(() => {});
  };

  useEffect(() => {
    load();
  }, [pollTick, filterKey, offset]);

  // 筛选条件变化回到第 1 页（否则可能停在超出新结果集的页码上）
  useEffect(() => {
    setPage(1);
  }, [filterKey]);

  // 结果集变小时（如删除话题/展开折叠）当前页可能越界，自动回退到最后一页
  useEffect(() => {
    const max = Math.max(1, Math.ceil(meta.total / PAGE_SIZE));
    setPage((p) => (p > max ? max : p));
  }, [meta.total]);

  const sources = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const r of items) {
      if (!seen.has(r.source)) {
        seen.add(r.source);
        out.push({ source: r.source, c: 1 });
      }
    }
    return out;
  }, [items]);

  const shown = topics;
  const totalPages = Math.max(1, Math.ceil(meta.total / PAGE_SIZE));
  // 低佐证条数由后端 facets 给出（当前其余筛选下还剩多少），与分页无关
  const weakCount = filters.tier === 'all' && !filters.expandWeak ? meta.facets?.weak ?? 0 : 0;

  // 全量话题数（不受筛选影响），用于区分"没筛出来"和"本来就没数据"
  const facetsAll = meta.facets?.total_all;

  // 分组视图：按 scope 分桶（列由用户自建的关注范围动态生成，不假设数量）
  const groups = useMemo(() => {
    if (filters.view !== 'grouped') return [];
    const buckets = new Map();
    const label = (id) => meta.scopes.find((s) => String(s.id) === String(id))?.label || '未分类';
    for (const t of shown) {
      const k = t.scope_id == null ? 'none' : String(t.scope_id);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(t);
    }
    // 已删除范围/未分类排最后
    return [...buckets.entries()]
      .map(([k, list]) => ({ key: k, label: k === 'none' ? '未分类' : label(k), list }))
      .sort((a, b) => (a.key === 'none' ? 1 : b.key === 'none' ? -1 : b.list.length - a.list.length));
  }, [shown, filters.view, meta.scopes]);

  return (
    <>
      {/* ===== 全宽 Hero 指挥台 ===== */}
      <section className="hero-shell section" style={{ marginTop: 18 }}>
        <BackgroundBeams />
        <div className="hero-grid-bg" />
        <Spotlight className="-top-32 left-1/4" fill="#22D3EE" />
        <Spotlight className="top-10 right-0" fill="#8B5CF6" />

        <div className="hero-inner">
          <div>
            <div className="hud-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className={`dot ${scanning ? 'busy pulsing' : 'ok'}`} />
              {scanning
                ? progress && progress.total
                  ? `SCANNING // ${progress.phase === 'cluster' ? '聚类' : progress.phase === 'screen' ? '甄别' : '抓取'}中 ${progress.done}/${progress.total}`
                  : 'SCANNING // 正在扫描'
                : 'LIVE // 雷达在线'}
            </div>
            <h1 className="hero-title title-gradient">AI 热点雷达</h1>
            <p className="hero-sub">
              十一 路信息源实时嗅探 · 质量门槛过滤噪音 · AI 甄别与多源佐证评分 —— 让你永远站在吃瓜第一线。
            </p>

            <div className="hud-stats">
              <div className="hud-stat">
                <b>{items.length}</b>
                <s>6H 信号</s>
              </div>
              <div className="hud-stat">
                <b>{meta.total}</b>
                <s>活跃话题</s>
              </div>
              <div className="hud-stat">
                <b>{meta.facets?.since?.['24h'] ?? 0}</b>
                <s>24H 热点</s>
              </div>
              <div className="hud-stat">
                <CountDown nextRunAt={scanInfo?.nextRunAt} scanning={scanning} />
                <s>下次扫描</s>
              </div>
            </div>

            <div className="row2">
              <ScanButton scanning={scanning} showToast={showToast} />
              <button className="btn ghost" onClick={() => (location.hash = 'watch')}>
                管理盯梢 →
              </button>
            </div>
          </div>

          {/* 雷达盘（放大居右） */}
          <div className="hero-radar">
            <RadarScope items={items} scanning={scanning} sources={sources} />
            <div className="radar-legend">
              <div><em>角度</em> = 信息源扇区 · <em>半径</em> = 时间（中心=最新）</div>
              <div><em>悬停</em> 看标题 · <em>点击</em> 打开原文</div>
            </div>
          </div>
        </div>
      </section>

      {/* ===== 筛选 + 热点流 ===== */}
      <div className="section">
        <div className="section-title">Hot Signals // 热点信号</div>

        <TopicFilters
          value={filters}
          onChange={setFilters}
          facets={meta.facets}
          scopes={meta.scopes}
          resultCount={meta.total}
          totalCount={meta.facets?.total_all ?? meta.total}
        />

        {/* 筛选后为空 ≠ 无热点：两种情况给不同提示（meta.total 是服务端筛选后的条数） */}
        {meta.total === 0 && (facetsAll ?? 0) > 0 && (
          <div className="empty glass" style={{ padding: 40 }}>
            当前筛选条件下没有话题 · 试试放宽时间窗、降低热度门槛，或
            <button className="tf-reset" style={{ marginLeft: 6 }} onClick={() => setFilters({ ...DEFAULT_FILTERS, view: filters.view })}>
              重置筛选
            </button>
          </div>
        )}
        {meta.total === 0 && !facetsAll && (
          <div className="empty glass" style={{ padding: 48 }}>
            暂无热点 · 点击上方「立即扫描」或等待定时任务
            <br />
            <span style={{ fontSize: 11, opacity: 0.7 }}>（AI 聚类需要至少一轮扫描完成）</span>
          </div>
        )}

        {filters.view === 'grouped' ? (
          <div className="tf-groups">
            {groups.map((g) => (
              <div key={g.key} className="tf-group">
                <h3>
                  {g.label} <b>{g.list.length}</b>
                </h3>
                <div className="tf-list">
                  {g.list.map((t) => (
                                    <TopicCard key={t.id} t={t} onOpen={onOpenTopic} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* 统一长条形：一行一条，不再用 Bento 错落网格 */
          <div className="tf-list">
            {shown.map((t) => (
                        <TopicCard key={t.id} t={t} onOpen={onOpenTopic} />
            ))}
          </div>
        )}

        {/* 低佐证折叠：默认服务端只返回强佐证，展开后返回全部 */}
        {!!weakCount && (
          <button className="tf-fold" onClick={() => setFilters({ ...filters, expandWeak: !filters.expandWeak })}>
            {filters.expandWeak ? '▴ 只看强佐证话题' : `▾ 还有 ${weakCount} 个低佐证话题（单源/孤证，热度已封顶）`}
            {!filters.expandWeak && <b>点击查看</b>}
          </button>
        )}

        <Pager page={page} totalPages={totalPages} total={meta.total} pageSize={PAGE_SIZE} onGo={goPage} />
      </div>
    </>
  );
}

/** 页码条：首尾常驻 + 当前页邻近，中间省略 */
function pageList(page, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const out = [1];
  const from = Math.max(2, page - 1);
  const to = Math.min(totalPages - 1, page + 1);
  if (from > 2) out.push('…');
  for (let i = from; i <= to; i++) out.push(i);
  if (to < totalPages - 1) out.push('…');
  out.push(totalPages);
  return out;
}

function Pager({ page, totalPages, total, pageSize, onGo }) {
  if (totalPages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <nav className="tf-pager" aria-label="话题分页">
      <button className="tf-page nav" disabled={page <= 1} onClick={() => onGo(page - 1)} aria-label="上一页">
        ‹ 上一页
      </button>
      {pageList(page, totalPages).map((p, i) =>
        p === '…' ? (
          <span key={`e${i}`} className="tf-page-ellipsis">
            …
          </span>
        ) : (
          <button
            key={p}
            className={`tf-page ${p === page ? 'on' : ''}`}
            aria-current={p === page ? 'page' : undefined}
            onClick={() => onGo(p)}
          >
            {p}
          </button>
        )
      )}
      <button className="tf-page nav" disabled={page >= totalPages} onClick={() => onGo(page + 1)} aria-label="下一页">
        下一页 ›
      </button>
      <span className="tf-page-info">
        {from}–{to} / 共 {total} 条
      </span>
    </nav>
  );
}

/** 倒计时：距下次扫描 MM:SS，每秒刷新 */
function CountDown({ nextRunAt, scanning }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (scanning) return <b className="pulsing">···</b>;
  if (!nextRunAt) return <b>--:--</b>;
  const ms = Date.parse(nextRunAt) - Date.now();
  if (ms <= 0) return <b>NOW</b>;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return <b>{`${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`}</b>;
}

function ScanButton({ scanning, showToast }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await api.runScan();
      showToast('扫描已启动…');
    } catch (e) {
      showToast(`启动失败：${e.message}`);
    }
    setBusy(false);
  };
  return (
    <button className="btn" onClick={run} disabled={scanning || busy}>
      {scanning || busy ? '▶ 扫描中…' : '▶ 立即扫描'}
    </button>
  );
}

const SRC_COLOR = {
  hn: '#fb923c',
  gh_trending: '#38bdf8',
  gh_search: '#0ea5e9',
  hf_papers: '#a78bfa',
  blog: '#34d399',
  web_search: '#fbbf24',
  news_search: '#f472b6',
  cn_search: '#facc15',
  cn_media: '#ef4444',
  lobsters: '#c084fc',
  reddit: '#ff4500',
  twitter: '#e879f9',
  bilibili: '#FF6699',
  bilibili_hot: '#FF6699',
};

/**
 * 话题卡片：统一长条形（一行一条）。
 * 视觉上刻意"降噪"——描述小字与强调字都压到低对比度，
 * 让扫视时先看到标题与热度，细节按需再看。
 *
 * v1.4 省时改造：
 *  - 来源只显示 1~2 个**最权威**的（官方/媒体域名 → 品牌名），其余折叠为 +N，
 *    不再一次挂 4 个渠道名（Hacker News / 新闻搜索 这类名字无法判断信息价值）；
 *  - 显示**原始发布时间**与新鲜度，hover 看最新动态（last_updated 是聚类时间，会误导新旧）；
 *  - 显示话题内最热条目的**原始互动指标**（79赞·23评 / ⭐233 / ▲72）；
 *  - 最热原文可直接 ↗ 跳转，不点详情也能走。
 */
function TopicCard({ t, onOpen }) {
  const srcCount = t.source_count || 1;
    // 必须转成布尔：直接 `{official && ...}` 在 official=0 时 React 会把 0 渲染成文本
    const official = Boolean(t.has_official);
    const viral = t.viral_count || 0;
  const tier = t.evidence_tier || '';
  const hot = t.score >= 80;

  // 最权威来源（后端算好：primary_* + authority_count，跨轮次稳定）
  const primaryLabel = t.primary_label || SOURCE_LABEL[t.primary_source] || '';
  const extra = Math.max(0, (t.authority_count || 0) - 1);
  const tm = t.top_metrics || {};
    // 卡片上互动徽章取前 4 个（B站维度多：点赞/投币/收藏/转发…），其余在详情页看全
    const badges = metricsList(tm.source, tm.values, 4);
  const fresh = freshness(t.published_first);
  const pubText = t.published_first ? fmtShort(t.published_first) : '';

  return (
    <BentoCard className={`trow ${hot ? 'hot' : ''}`} highlight={hot ? '#E879F9' : '#22D3EE'} onClick={() => onOpen(t.id)}>
      <div className="score">
        <b>{Math.round(t.score)}</b>
        <s>HEAT</s>
      </div>

      <div className="trow-main">
        <h4>{t.title}</h4>
        {t.summary_zh && <p className="topic-sum">{t.summary_zh}</p>}
        {t.why_hot && <p className="topic-why">▸ {t.why_hot}</p>}

        <div className="bento-foot">
                  {/* 互动数据放主位：这是"值不值得点开"最快的判据（B站/社交源才有，新闻/官宣如实留白） */}
                  {badges.length > 0 ? (
                    <span className="chip metric lead" title={`${SOURCE_LABEL[tm.source] || tm.source} 原始互动数据（未加权）`}>
                      {badges.map((b) => (
                        <i key={b.key} title={b.label}>
                          {b.ico}
                          <b>{b.text}</b>
                        </i>
                      ))}
                    </span>
                  ) : (
                    <span className="chip metric lead none" title="该来源不提供互动数据（新闻/官宣/媒体类）">
                      无互动数据
                    </span>
                  )}

                  {/* 来源：权威优先，1 个标签 + 折叠计数 */}
                  {primaryLabel && (
                    <span
                      className={`chip src ${t.primary_tier >= 4 ? 'src-official' : t.primary_tier === 3 ? 'src-media' : ''}`}
                      title={t.primary_host ? `最权威来源：${t.primary_label}（${t.primary_host}）` : '最权威来源'}
                    >
                      {primaryLabel}
                    </span>
                  )}
                  {extra > 0 && (
                    <span className="chip" title={`另有 ${extra} 家权威媒体/官方也在报道（展开详情查看）`}>
                      +{extra}
                    </span>
                  )}

                  {official && (
            <span className="chip ok" title="含官方一手来源">
              ✓ 官方
            </span>
          )}
          {tier === 'media_cross' && !official && (
            <span className="chip info" title="≥2 家权威媒体交叉报道">
              媒体交叉
            </span>
          )}
          {viral >= 2 && (
            <span className="chip viral" title={`${viral} 条社交平台爆款（点赞/转发/评论达门槛）`}>
              🔥 {viral} 源爆款
            </span>
          )}
          {/* "单源"须同时满足：信息源类型唯一 且 域名唯一。
              否则会出现"1 个信息源但 ≥2 家媒体域名"（如 360新闻搜到新浪+凤凰）
              同时挂上「媒体交叉」与「单源」两个互相矛盾的标签。 */}
          {srcCount === 1 && (t.host_count || 1) === 1 && !official && viral < 2 && (
            <span
              className="chip warn"
              title={viral === 1 ? '单条社交爆款，孤证暂不通知，热度封顶 65' : '单一来源且未达爆款门槛，热度已封顶'}
            >
              {viral === 1 ? '爆款·孤证' : '单源'}
            </span>
          )}

          {/* 原始发布时间（事件何时发生）+ 新鲜度；标题提示最新动态时间 */}
          <span className="trow-time" title={`首发 ${pubText || '未知'} · 最新一条动态 ${fmtAgo(t.published_last || t.last_updated)} · 收录于 ${fmtAgo(t.last_updated)}`}>
            {pubText ? `首发 ${pubText}` : fresh === null ? NO_DATE_NOTE : ''}
            {fresh && <i className={`tfresh ${fresh.key}`}>{fresh.label}</i>}
            <s>{t.item_ids?.length || 0} 条</s>
          </span>

          {/* 直达最热原文（不点详情也能跳走） */}
          {tm.url && (
            <a
              className="trow-go"
              href={tm.url}
              target="_blank"
              rel="noreferrer"
              title={`打开原文：${tm.title || tm.url}`}
              onClick={(e) => e.stopPropagation()}
            >
              ↗ 原文
            </a>
          )}
        </div>
      </div>
    </BentoCard>
  );
}
