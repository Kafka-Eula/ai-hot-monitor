import { useEffect, useState } from 'react';
import { api, fmtAgo, SOURCE_LABEL } from '../lib/api.js';
import RadarScope from '../components/RadarScope.jsx';

export default function Radar({ scanning, scanInfo, pollTick, onOpenTopic, showToast }) {
  const [topics, setTopics] = useState([]);
  const [items, setItems] = useState([]);
  const [showAll, setShowAll] = useState(false);

  const load = () => {
    api.topics(50).then(setTopics).catch(() => {});
    api.items(150).then((d) => setItems(d.rows || [])).catch(() => {});
  };

  useEffect(() => {
    load();
  }, [pollTick]);

  const sources = [];
  const seen = new Set();
  for (const r of items) {
    if (!seen.has(r.source)) {
      seen.add(r.source);
      sources.push({ source: r.source, c: 1 });
    }
  }

  const shown = showAll ? topics : topics.slice(0, 12);

  return (
    <>
      <div className="section radar-grid">
        <div className="panel" style={{ padding: 12 }}>
          <div className="radar-wrap">
            <RadarScope items={items} scanning={scanning} sources={sources} />
          </div>
          <div className="radar-meta">
            近 6 小时 · <b>{items.length}</b> 条信号 · {Object.keys(SOURCE_LABEL).length} 路信息源
            <br />
            {scanInfo?.nextRunAt
              ? `下次扫描 ${new Date(scanInfo.nextRunAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
              : '调度待命'}
          </div>
        </div>

        <div>
          <div className="section-title">热点信号 · 按热度排序</div>
          {!shown.length && (
            <div className="empty">
              暂无热点 · 点击右上角「立即扫描」或等待定时任务
              <br />
              <span style={{ fontSize: 11, opacity: 0.7 }}>（AI 聚类需要至少一轮扫描完成）</span>
            </div>
          )}
          {shown.map((t) => (
            <TopicCard key={t.id} t={t} items={items} onOpen={onOpenTopic} />
          ))}
          {topics.length > 12 && (
            <button className="btn ghost sm" style={{ width: '100%', marginTop: 6 }} onClick={() => setShowAll((v) => !v)}>
              {showAll ? '收起' : `展开全部 ${topics.length} 个话题`}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function TopicCard({ t, items, onOpen }) {
  const ids = new Set(t.item_ids || []);
  const mine = items.filter((i) => ids.has(i.id));
  const srcs = [...new Set(mine.map((i) => i.source))];
  const glow = Math.min(0.16, (t.score / 100) * 0.16);
  return (
    <div
      className={`topic ${t.score >= 80 ? 'hot' : ''}`}
      style={{ '--glow': `${glow}` }}
      onClick={() => onOpen(t.id)}
    >
      <div className="topic-top">
        <div className="score">
          <b>{Math.round(t.score)}</b>
          <s>HEAT</s>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h4>{t.title}</h4>
          <p className="topic-sum">{t.summary_zh}</p>
          {t.why_hot && <p className="topic-why">▸ {t.why_hot}</p>}
        </div>
      </div>
      <div className="topic-foot">
        {srcs.map((s) => (
          <span key={s} className="chip src">
            {SOURCE_LABEL[s] || s}
          </span>
        ))}
        <span className="chip">{t.item_ids?.length || 0} 条来源</span>
        <span className="chip t">{fmtAgo(t.last_updated)}更新</span>
      </div>
    </div>
  );
}
