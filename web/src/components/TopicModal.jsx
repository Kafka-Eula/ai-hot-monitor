import { useEffect, useState } from 'react';
import { api, fmtAgo, fmtShort, fmtDay, freshness, metricsList, SOURCE_LABEL, EVIDENCE_TIER_LABEL, NO_DATE_NOTE } from '../lib/api.js';

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

export default function TopicModal({ id, onClose }) {
  const [t, setT] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let on = true;
    api
      .topic(id)
      .then((d) => on && setT(d))
      .catch((e) => on && setErr(e.message));
    return () => {
      on = false;
    };
  }, [id]);

  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const bySrc = {};
  (t?.items || []).forEach((i) => {
    bySrc[i.source] = (bySrc[i.source] || 0) + 1;
  });
    // 有哪些真实来源域（判断"谁在说"）。平台自身域名（github.com / huggingface.co…）不列，
    // 它们不代表"谁在说这件事"，只说明内容托管在哪。
    const srcHosts = [];
    const seenHost = new Set();
    for (const i of t?.items || []) {
      const h = i.host || '';
      if (!h || i.platform_host || seenHost.has(h)) continue;
      seenHost.add(h);
      srcHosts.push({ host: h, brand: i.brand || h, source: i.source, count: (t.items || []).filter((x) => x.host === h).length });
    }
    const fresh = freshness(t?.published_first || t?.last_updated);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>✕</button>
        {err && <div className="err-tip">加载失败：{err}</div>}
        {!t && !err && <div className="empty">加载中…</div>}
        {t && (
          <>
            <div className="topic-top" style={{ marginBottom: 8 }}>
              <div className={`score ${t.score >= 80 ? '' : ''}`} style={t.score >= 80 ? { background: 'rgba(255,180,84,.09)', borderColor: '#8a5e26', color: '#ffb454' } : {}}>
                <b>{Math.round(t.score)}</b>
                <s>HEAT</s>
              </div>
              <div>
                <h2>{t.title}</h2>
                <div className="hit-meta" style={{ marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                  {t.primary_label && (
                                    <span
                                      className={`chip src ${t.primary_tier >= 4 ? 'src-official' : t.primary_tier === 3 ? 'src-media' : ''}`}
                                      title={t.primary_host || ''}
                                    >
                                      {t.primary_label}
                                    </span>
                                  )}
                                  {(t.authority_count || 0) > 1 && (
                                    <span className="chip" title="该话题涉及的官方/权威媒体域名总数">
                                      +{(t.authority_count || 0) - 1} 权威来源
                                    </span>
                                  )}
                                  {(t.source_count || 1) >= 2 && <span>⛓ 跨 {t.source_count} 源</span>}
                                  {!!t.has_official && <span style={{ color: '#34d399' }}>✓ 含官方一手</span>}
                                  {!!t.viral_count && <span style={{ color: '#e879f9' }}>🔥 {t.viral_count} 条社交爆款</span>}
                                  {t.evidence_tier && <span style={{ opacity: 0.75 }}>证据档: {EVIDENCE_TIER_LABEL[t.evidence_tier] || t.evidence_tier}</span>}
                                  <span>首次 {fmtAgo(t.first_seen)}</span>
                                  <span>更新 {fmtAgo(t.last_updated)}</span>
                                </div>
                                {/* 时间轴：区分"事件发生时间"与"收录/聚类时间"——这正是原先要跳站核对的信息 */}
                                <div className="hit-meta" style={{ marginTop: 3 }}>
                                  {t.published_first ? (
                                    <span title="话题内最早一条内容的原始发布时间 → 最新一条的发布时间">
                                      事件时间 {fmtDay(t.published_first)}
                                      {t.published_last && t.published_last !== t.published_first ? ` → ${fmtDay(t.published_last)}` : ''}
                                    </span>
                                  ) : (
                                    <span style={{ opacity: 0.7 }}>{NO_DATE_NOTE}（均为榜单快照类来源）</span>
                                  )}
                                  {fresh && <i className={`tfresh ${fresh.key}`}>{fresh.label}</i>}
                                  <span style={{ opacity: 0.7 }}>· 收录 {fmtAgo(t.last_updated)}</span>
                                </div>
              </div>
            </div>
            <p style={{ color: '#a9bacc', fontSize: 14 }}>{t.summary_zh}</p>
            {t.why_hot && <p className="topic-why">▸ {t.why_hot}</p>}

            <div className="src-bar">
              {Object.entries(bySrc).map(([s, c]) => (
                <i key={s} style={{ width: `${(c / t.items.length) * 100}%`, background: SRC_COLOR[s] || '#22d3ee' }} />
              ))}
            </div>
            <div className="src-legend">
              {Object.entries(bySrc).map(([s, c]) => (
                <span key={s} style={{ color: SRC_COLOR[s] }}>
                  {SOURCE_LABEL[s] || s} {c}
                </span>
              ))}
            </div>
                        {/* 真实来源域名（判断"谁在说"；话题卡的 +N 权威来源就是这里的权威域名条目） */}
                        {srcHosts.length > 0 && (
                          <div className="src-legend" style={{ marginTop: -4 }}>
                            {srcHosts.slice(0, 8).map((h) => (
                              <span key={h.host} style={{ color: '#8fa6bd' }} title={`${SOURCE_LABEL[h.source] || h.source} · ${h.host}`}>
                                {h.brand}
                                {h.count > 1 ? `×${h.count}` : ''}
                                <u>{h.host}</u>
                              </span>
                            ))}
                            {srcHosts.length > 8 && <span style={{ opacity: 0.6 }}>+{srcHosts.length - 8}</span>}
                          </div>
                        )}

                        <div className="section-title" style={{ marginTop: 4 }}>原始条目 · {t.items.length} 条</div>
                        {t.items.map((i) => {
                          const metrics = metricsList(i.source, i.metrics);
                          return (
                            <div key={i.id} className="hit" style={{ borderLeft: `2px solid ${SRC_COLOR[i.source] || '#22d3ee'}` }}>
                              <div className="hit-top">
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <a href={i.url} target="_blank" rel="noreferrer">{i.title}</a>
                                  <div className="hit-meta">
                                    <span style={{ color: SRC_COLOR[i.source] }}>■</span> {SOURCE_LABEL[i.source] || i.source}
                                    {i.author_label ? ` · ${i.author_label}` : ''}
                                    {i.host && !i.platform_host ? <span style={{ opacity: 0.65 }}> · {i.host}</span> : ''}
                                    {/* 发布时间与收录时间分开：没有发布时间的源（榜单快照）明说，不拿采集时间冒充 */}
                                    {i.has_published ? (
                                      <span title={`发布 ${i.published_at} · 收录 ${i.collected_at}`}> · 发布于 {fmtAgo(i.published_at)}</span>
                                    ) : (
                                      <span style={{ opacity: 0.6 }} title="该源页面不提供发布时间"> · {NO_DATE_NOTE}</span>
                                    )}
                                    {i.repo_created && <span style={{ opacity: 0.8 }}> · 建库于 {fmtAgo(i.repo_created)}</span>}
                                    {i.quality_score > 0 && <span style={{ opacity: 0.7 }}> · 质量 {Math.round(i.quality_score)}</span>}
                                    {i.tier_name && <span style={{ opacity: 0.7 }}> · {i.tier_name}</span>}
                                    <span style={{ opacity: 0.55 }} title={`收录于 ${i.collected_at}`}> · 收录 {fmtAgo(i.collected_at)}</span>
                                  </div>
                                  <div className="hit-metrics">
                                    {metrics.length > 0 ? (
                                      metrics.map((m) => (
                                        <span key={m.key} className="metric" title={m.label}>
                                          {m.ico}
                                          <b>{m.text}</b>
                                          <s>{m.label}</s>
                                        </span>
                                      ))
                                    ) : (
                                      <span className="metric none" title="该信息源不提供互动数据（新闻/官宣/媒体类）">
                                        无互动数据
                                      </span>
                                    )}
                                    {i.engagement > 0 && (
                                      <span className="metric none" title="跨源可比的加权传播力（点赞+转发×3+评论×2…）">
                                        传播力 {Math.round(i.engagement)}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
          </>
        )}
      </div>
    </div>
  );
}
