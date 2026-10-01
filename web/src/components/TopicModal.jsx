import { useEffect, useState } from 'react';
import { api, fmtAgo, SOURCE_LABEL } from '../lib/api.js';

const SRC_COLOR = {
  hn: '#fb923c',
  gh_trending: '#38bdf8',
  hf_papers: '#a78bfa',
  blog: '#34d399',
  web_search: '#fbbf24',
  twitter: '#e879f9',
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
                <div className="hit-meta" style={{ marginTop: 2 }}>
                  首次发现 {fmtAgo(t.first_seen)} · 最近更新 {fmtAgo(t.last_updated)}
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

            <div className="section-title" style={{ marginTop: 4 }}>原始条目 · {t.items.length} 条</div>
            {t.items.map((i) => (
              <div key={i.id} className="hit" style={{ borderLeft: `2px solid ${SRC_COLOR[i.source] || '#22d3ee'}` }}>
                <div className="hit-top">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <a href={i.url} target="_blank" rel="noreferrer">{i.title}</a>
                    <div className="hit-meta">
                      <span style={{ color: SRC_COLOR[i.source] }}>■</span> {SOURCE_LABEL[i.source] || i.source}
                      {i.author ? ` · ${i.author}` : ''} · {fmtAgo(i.published_at || i.collected_at)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
