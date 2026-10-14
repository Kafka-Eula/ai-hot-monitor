import { useEffect, useMemo, useRef, useState } from 'react';
import { SOURCE_LABEL } from '../lib/api.js';

/**
 * 话题检索条：搜索 + 视图切换 + 排序（全部平铺为按钮）+ 筛选弹层。
 *
 * 交互约定（对齐"深空雷达控制台"玻璃风格与 ui-ux-pro-max 规范）：
 *  - 排序不再用原生 <select>：四个选项直接做成段控按钮，一次点击即生效；
 *  - 五类筛选条件（范围/佐证/时间/信息源/热度）收进「筛选」弹层，
 *    主栏只留搜索框与两个段控，避免整屏都是控件；
 *  - 弹层支持 Esc 关闭、点击外部关闭、关闭后焦点回到触发按钮；
 *  - chip 计数来自后端 facets（全量统计），不随当前筛选跳变；
 *  - 所有控件带 aria-pressed / aria-expanded，图标用同一套 HUD 字形，不混用 emoji。
 */
export const DEFAULT_FILTERS = {
  q: '',
  scope: 'all',
  tier: 'all',
  since: 'all',
  sources: [],
  min_score: 0,
  sort: 'score',
  view: 'flat',
  /** 是否展开"低佐证话题"（默认折叠，纯前端状态，会转成服务端 strong=1） */
  expandWeak: false,
};

const STORE_KEY = 'hotpulse.topicFilters';

export function loadFilters() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULT_FILTERS };
    return { ...DEFAULT_FILTERS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

const SORT_OPTS = [
  { v: 'score', label: '热度', hint: '按 AI 热度分从高到低' },
  { v: 'updated', label: '最新', hint: '按最近更新时间的话题' },
  { v: 'sources', label: '跨源', hint: '被多少个不同信息源报道' },
  { v: 'items', label: '条数', hint: '话题合并的原始条目数' },
];

const TIER_OPTS = [
  { v: 'all', label: '不限', hint: '不限制佐证强度' },
  { v: 'strong', label: '强佐证', hint: '官方一手 / ≥2 家权威媒体 / ≥2 平台爆款' },
  { v: 'official', label: '官方一手' },
  { v: 'media_cross', label: '媒体交叉' },
  { v: 'viral_social', label: '多源爆款' },
  { v: 'weak', label: '单源弱佐证' },
];

const SINCE_OPTS = [
  { v: 'all', label: '不限' },
  { v: '24h', label: '24 小时' },
  { v: '3d', label: '3 天' },
  { v: '7d', label: '7 天' },
  { v: '30d', label: '30 天' },
];

export default function TopicFilters({ value, onChange, facets, scopes, resultCount, totalCount }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const f = value;

  // 防抖回调必须读"最新"状态：否则用户在 280ms 内改了别的条件，
  // 待写入的 q 会用旧快照覆盖掉那次改动。
  const valueRef = useRef(f);
  valueRef.current = f;
  const set = (patch) => onChange({ ...valueRef.current, ...patch });

  /* ---- 搜索防抖 ---- */
  const [qDraft, setQDraft] = useState(f.q);
  useEffect(() => setQDraft(f.q), [f.q]);
  useEffect(() => {
    if (qDraft === valueRef.current.q) return;
    const t = setTimeout(() => set({ q: qDraft }), 260);
    return () => clearTimeout(t);
  }, [qDraft]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- 展开区：inline 在检索条内，仅由触发按钮 / Esc 收起 ----
     （不做"点击外部关闭"：它已属于页面流，点卡片时误收起反而打断操作） */
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const srcFacets = facets?.sources || {};
  const allSources = useMemo(
    () =>
      Object.keys(SOURCE_LABEL)
        .filter((s) => srcFacets[s] || f.sources.includes(s))
        .sort((a, b) => (srcFacets[b] || 0) - (srcFacets[a] || 0)),
    [srcFacets, f.sources]
  );

  // 「筛选」按钮上统计已生效的条件数，收起弹层也能看到当前状态
  const activeCount =
    (f.scope !== 'all' ? 1 : 0) +
    (f.tier !== 'all' ? 1 : 0) +
    (f.since !== 'all' ? 1 : 0) +
    (f.sources.length ? 1 : 0) +
    (f.min_score > 0 ? 1 : 0);
  const dirty = !!activeCount || !!f.q;

  const toggleSrc = (s) =>
    set({ sources: f.sources.includes(s) ? f.sources.filter((x) => x !== s) : [...f.sources, s] });

  return (
    <div className="tfilter glass">
      <div className="tf-bar">
        {/* 搜索：主控件，做大 */}
        <div className="tf-search">
          <span className="tf-ico" aria-hidden="true">
            ⌕
          </span>
          <input
            className="mono"
            placeholder="搜索热点：标题 / 摘要 / 为什么火…"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            aria-label="搜索热点"
          />
          {qDraft ? (
            <button className="tf-clear" onClick={() => setQDraft('')} aria-label="清空搜索">
              ✕
            </button>
          ) : null}
        </div>

        {/* 视图切换 */}
        <div className="tf-seg" role="group" aria-label="视图切换">
          <button
            className={f.view === 'flat' ? 'on' : ''}
            aria-pressed={f.view === 'flat'}
            onClick={() => set({ view: 'flat' })}
            title="平铺：Bento 错落网格"
          >
            <i aria-hidden="true">▦</i> 平铺
          </button>
          <button
            className={f.view === 'grouped' ? 'on' : ''}
            aria-pressed={f.view === 'grouped'}
            onClick={() => set({ view: 'grouped' })}
            title="分组：按关注范围分列"
          >
            <i aria-hidden="true">▤</i> 分组
          </button>
        </div>

        {/* 排序：四个选项全部平铺成按钮 */}
        <div className="tf-seg tf-sort" role="group" aria-label="排序方式">
          <em className="tf-seg-lead" aria-hidden="true">
            ⇅ 排序
          </em>
          {SORT_OPTS.map((o) => (
            <button
              key={o.v}
              className={f.sort === o.v ? 'on' : ''}
              aria-pressed={f.sort === o.v}
              title={o.hint}
              onClick={() => set({ sort: o.v })}
            >
              {o.label}
            </button>
          ))}
        </div>

        {/* 筛选弹层触发器 */}
        <button
          ref={triggerRef}
          className={`tf-tool ${open ? 'on' : ''} ${activeCount ? 'active' : ''}`}
          aria-expanded={open}
          aria-controls="topic-filter-panel"
          onClick={() => setOpen((v) => !v)}
        >
          <i aria-hidden="true">⚑</i> 筛选
          {!!activeCount && <n>{activeCount}</n>}
        </button>

        {dirty && (
          <span className="tf-summary">
            命中 <b>{resultCount}</b>
            <s>/{totalCount}</s>
            <button
              className="tf-reset"
              onClick={() => {
                onChange({ ...DEFAULT_FILTERS, view: f.view, sort: f.sort });
                setOpen(false);
              }}
            >
              重置
            </button>
          </span>
        )}
      </div>

      {open && (
        <div className="tf-pop" id="topic-filter-panel">
          <Group label="关注范围">
            <Chip active={f.scope === 'all'} onClick={() => set({ scope: 'all' })} count={totalCount}>
              全部
            </Chip>
            {(scopes || []).map((s) => (
              <Chip
                key={s.id}
                active={f.scope === String(s.id)}
                onClick={() => set({ scope: String(s.id) })}
                count={facets?.scope?.[s.id]}
              >
                {s.label}
              </Chip>
            ))}
            {!!facets?.scope?.none && (
              <Chip active={f.scope === 'none'} onClick={() => set({ scope: 'none' })} count={facets.scope.none}>
                未分类
              </Chip>
            )}
          </Group>

          <Group label="佐证强度">
            {TIER_OPTS.map((o) => (
              <Chip
                key={o.v}
                title={o.hint}
                active={f.tier === o.v}
                onClick={() => set({ tier: o.v })}
                count={countForTier(facets?.tier, o.v)}
              >
                {o.label}
              </Chip>
            ))}
          </Group>

          <Group label="时间窗">
            {SINCE_OPTS.map((o) => (
              <Chip
                key={o.v}
                active={f.since === o.v}
                onClick={() => set({ since: o.v })}
                count={o.v === 'all' ? totalCount : facets?.since?.[o.v]}
              >
                {o.label}
              </Chip>
            ))}
          </Group>

          <Group label="信息源">
            {allSources.map((s) => (
              <Chip
                key={s}
                active={f.sources.includes(s)}
                onClick={() => toggleSrc(s)}
                count={srcFacets[s]}
                color={SRC_COLOR[s]}
              >
                {SOURCE_LABEL[s] || s}
              </Chip>
            ))}
            {!allSources.length && <span className="tf-none">暂无数据</span>}
          </Group>

          <div className="tf-pop-foot">
            <em className="tf-label">热度 ≥ {f.min_score || '不限'}</em>
            <input
              className="tf-range"
              type="range"
              min="0"
              max="100"
              step="5"
              value={f.min_score}
              onChange={(e) => set({ min_score: Number(e.target.value) })}
              aria-label="最低热度分"
            />
            <span className="tf-spacer" />
            {!!activeCount && (
              <button
                className="tf-reset"
                onClick={() => set({ scope: 'all', tier: 'all', since: 'all', sources: [], min_score: 0 })}
              >
                清除条件
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Group({ label, children }) {
  return (
    <div className="tf-grp">
      <em className="tf-label">{label}</em>
      <div className="tf-grp-items">{children}</div>
    </div>
  );
}

function Chip({ active, onClick, count, children, title, color }) {
  return (
    <button
      className={`fchip ${active ? 'on' : ''}`}
      onClick={onClick}
      title={title}
      aria-pressed={active}
      style={active && color ? { borderColor: color + '88', color, boxShadow: `0 0 12px ${color}22` } : undefined}
    >
      {children}
      {count != null && count > 0 && <n>{count}</n>}
    </button>
  );
}

function countForTier(tierFacets, v) {
  if (!tierFacets) return undefined;
  const strong = ['official', 'media_cross', 'viral_social'];
  if (v === 'all') return Object.values(tierFacets).reduce((a, b) => a + b, 0);
  if (v === 'strong') return strong.reduce((a, k) => a + (tierFacets[k] || 0), 0);
  if (v === 'weak') return Object.entries(tierFacets).reduce((a, [k, n]) => (strong.includes(k) ? a : a + n), 0);
  return tierFacets[v];
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
