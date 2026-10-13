import { useEffect, useMemo, useState } from 'react';
import { api, fmtAgo, SOURCE_LABEL } from '../lib/api.js';
import RadarScope from '../components/RadarScope.jsx';
import { BackgroundBeams } from '../components/ui/background-beams.jsx';
import { Spotlight } from '../components/ui/spotlight.jsx';
import { BentoGrid, BentoCard } from '../components/ui/bento-grid.jsx';

export default function Radar({ scanning, scanInfo, pollTick, progress, onOpenTopic, showToast }) {
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

  const hits24 = topics.filter((t) => Date.now() - Date.parse(t.last_updated) < 86400e3).length;
  const shown = showAll ? topics : topics.slice(0, 8);

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
              十路信息源实时嗅探 · 质量门槛过滤噪音 · AI 甄别与多源佐证评分 —— 让你永远站在吃瓜第一线。
            </p>

            <div className="hud-stats">
              <div className="hud-stat">
                <b>{items.length}</b>
                <s>6H 信号</s>
              </div>
              <div className="hud-stat">
                <b>{topics.length}</b>
                <s>活跃话题</s>
              </div>
              <div className="hud-stat">
                <b>{hits24}</b>
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

      {/* ===== Bento 热点流 ===== */}
      <div className="section">
        <div className="section-title">Hot Signals // 热点信号 · 按热度排序</div>
        {!shown.length && (
          <div className="empty glass" style={{ padding: 48 }}>
            暂无热点 · 点击上方「立即扫描」或等待定时任务
            <br />
            <span style={{ fontSize: 11, opacity: 0.7 }}>（AI 聚类需要至少一轮扫描完成）</span>
          </div>
        )}
        <BentoGrid>
          {shown.map((t, idx) => (
            <TopicCard key={t.id} t={t} items={items} onOpen={onOpenTopic} rank={idx} />
          ))}
        </BentoGrid>
        {topics.length > 8 && (
          <button className="btn ghost sm" style={{ width: '100%', marginTop: 12 }} onClick={() => setShowAll((v) => !v)}>
            {showAll ? '收起' : `展开全部 ${topics.length} 个话题`}
          </button>
        )}
      </div>
    </>
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
};

function TopicCard({ t, items, onOpen, rank }) {
  const ids = new Set(t.item_ids || []);
  const mine = items.filter((i) => ids.has(i.id));
  const srcs = [...new Set(mine.map((i) => i.source))];
  const hot = t.score >= 80;
  const srcCount = t.source_count || srcs.length || 1;
  const official = t.has_official || srcs.includes('blog');
  const viral = t.viral_count || 0;
  const tier = t.evidence_tier || '';
  // Bento 错落：Top1 占双列双行，其余按节奏分布
  const span =
    rank === 0
      ? 'bp:col-span-2 bp:row-span-2'
      : rank === 1 || rank % 3 === 2
        ? 'bp:col-span-2'
        : '';
  return (
    <BentoCard
      className={`topic ${hot ? 'hot' : ''} ${span}`}
      highlight={hot ? '#E879F9' : '#22D3EE'}
      delay={Math.min(rank, 8) * 0.05}
      onClick={() => onOpen(t.id)}
    >
      <div className="topic-top">
        <div className="score">
          <b>{Math.round(t.score)}</b>
          <s>HEAT</s>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h4 style={rank === 0 ? { fontSize: 19 } : undefined}>{t.title}</h4>
          <p className="topic-sum">{t.summary_zh}</p>
          {t.why_hot && <p className="topic-why">▸ {t.why_hot}</p>}
        </div>
      </div>
      <div className="bento-foot">
        {srcCount >= 2 && (
          <span className="chip" style={{ borderColor: '#3ef2a566', color: '#3ef2a5' }} title="多源交叉证实">
            ⛓ {srcCount} 源
          </span>
        )}
        {official && (
          <span className="chip" style={{ borderColor: '#34d39966', color: '#34d399' }} title="含官方一手来源">
            ✓ 官方
          </span>
        )}
        {tier === 'media_cross' && !official && (
          <span className="chip" style={{ borderColor: '#38bdf866', color: '#38bdf8' }} title="≥2 家权威媒体交叉报道">
            📰 媒体交叉
          </span>
        )}
        {viral >= 2 && (
          <span className="chip" style={{ borderColor: '#e879f966', color: '#e879f9' }} title={`${viral} 条社交平台爆款（点赞/转发/评论达门槛）`}>
            🔥 {viral} 源爆款
          </span>
        )}
        {srcCount === 1 && !official && viral < 2 && (
          <span
            className="chip"
            style={{ borderColor: '#fbbf2455', color: '#fbbf24' }}
            title={viral === 1 ? '单条社交爆款，孤证暂不通知，热度封顶 65' : '单一来源且未达爆款门槛，热度已封顶'}
          >
            {viral === 1 ? '爆款·孤证' : '单源'}
          </span>
        )}
        {srcs.map((s) => (
          <span key={s} className="chip src" style={{ borderColor: SRC_COLOR[s] + '66', color: SRC_COLOR[s] }}>
            {SOURCE_LABEL[s] || s}
          </span>
        ))}
        <span className="chip">{t.item_ids?.length || 0} 条来源</span>
        <span className="chip t">{fmtAgo(t.last_updated)}更新</span>
      </div>
    </BentoCard>
  );
}
