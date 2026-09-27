import { useEffect, useState } from 'react';
import { api, fmtAgo, SOURCE_LABEL } from '../lib/api.js';

export default function Watch({ pollTick, scanning, showToast }) {
  const [kws, setKws] = useState([]);
  const [scopes, setScopes] = useState([]);
  const [sel, setSel] = useState(null);
  const [hits, setHits] = useState([]);
  const [term, setTerm] = useState('');
  const [scope, setScope] = useState('');
  const [filter, setFilter] = useState('all'); // all | pass | fail

  const load = () => {
    api.keywords().then((rows) => {
      setKws(rows);
      setSel((cur) => (cur && rows.some((r) => r.id === cur) ? cur : rows[0]?.id ?? null));
    }).catch(() => {});
    api.scopes().then(setScopes).catch(() => {});
  };

  useEffect(() => {
    load();
  }, [pollTick]);

  useEffect(() => {
    if (!sel) return setHits([]);
    api.hits(sel).then(setHits).catch(() => {});
  }, [sel, pollTick]);

  const add = async () => {
    const t = term.trim();
    if (!t) return;
    try {
      await api.addKeyword(t);
      setTerm('');
      showToast(`已添加监控：${t}`);
      load();
    } catch (e) {
      showToast(`添加失败：${e.message}`);
    }
  };

  const addScope = async () => {
    const t = scope.trim();
    if (!t) return;
    try {
      await api.addScope(t);
      setScope('');
      showToast(`已添加范围：${t}`);
      load();
    } catch (e) {
      showToast(`添加失败：${e.message}`);
    }
  };

  const del = async (id) => {
    if (!confirm('确认删除该关键词及其命中记录？')) return;
    await api.delKeyword(id);
    load();
  };

  const toggle = async (k) => {
    try {
      await fetch(`/api/keywords/${k.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !k.enabled }),
      });
      load();
    } catch {
      showToast('切换失败');
    }
  };

  const cur = kws.find((k) => k.id === sel);
  const shown = hits.filter((h) => (filter === 'all' ? true : filter === 'pass' ? h.passed : !h.passed));

  return (
    <>
      <div className="section">
        <div className="section-title">盯梢关键词 · 命中即刻通知</div>
        <div className="kw-row">
          {kws.map((k) => (
            <span
              key={k.id}
              className={`kw ${sel === k.id ? '' : 'off'} ${k.enabled ? '' : 'off'}`}
              style={sel === k.id && k.enabled ? { boxShadow: '0 0 14px rgba(62,242,165,.25)' } : {}}
              onClick={() => setSel(k.id)}
              title={k.enabled ? '监控中' : '已暂停'}
            >
              {k.term}
              <em>{k.hit_count}</em>
              <button onClick={(e) => { e.stopPropagation(); toggle(k); }} title={k.enabled ? '暂停' : '启用'}>
                {k.enabled ? '⏸' : '▶'}
              </button>
              <button onClick={(e) => { e.stopPropagation(); del(k.id); }} title="删除">✕</button>
            </span>
          ))}
        </div>
        <div className="row2" style={{ maxWidth: 460 }}>
          <input
            className="mono"
            placeholder="输入要盯梢的关键词，如 GPT-6 / Claude Fable"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="btn" onClick={add}>+ 盯梢</button>
        </div>
      </div>

      <div className="section">
        <div className="section-title">关注范围 · 每 30 分钟聚合热点</div>
        <div className="kw-row">
          {scopes.map((s) => (
            <span key={s.id} className="kw">
              {s.label}
              <button onClick={() => { api.delScope(s.id).then(load); }} title="删除">✕</button>
            </span>
          ))}
        </div>
        <div className="row2" style={{ maxWidth: 460 }}>
          <input
            className="mono"
            placeholder="输入关注范围，如 AI 编程 / 多模态 / 开源大模型"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addScope()}
          />
          <button className="btn" onClick={addScope}>+ 范围</button>
        </div>
      </div>

      <div className="section">
        <div className="panel-h">
          <h3>{cur ? `「${cur.term}」命中流水` : '命中流水'}</h3>
          <div className="row2">
            {[
              ['all', '全部'],
              ['pass', '✅ 真命中'],
              ['fail', '🚫 已过滤'],
            ].map(([f, label]) => (
              <button key={f} className={`btn sm ${filter === f ? '' : 'ghost'}`} onClick={() => setFilter(f)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {!cur && <div className="empty">还没有关键词 · 先添加一个盯梢目标</div>}
        {cur && !shown.length && <div className="empty">{scanning ? '扫描中，稍候…' : '暂无记录 · 点「立即扫描」开始甄别'}</div>}
        {cur &&
          shown.map((h) => (
            <div key={h.id} className={`hit ${h.passed ? 'hit-pass' : 'hit-fail'}`}>
              <div className="hit-top">
                <span className={`verdict ${h.passed ? 'p' : 'f'}`}>{h.passed ? 'HIT' : 'REJECT'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <a href={h.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                    {h.title}
                  </a>
                  <div className="hit-meta">
                    {SOURCE_LABEL[h.source] || h.source}
                    {h.author ? ` · ${h.author}` : ''} · {fmtAgo(h.published_at || h.screened_at)}
                    {h.confidence ? <span className="conf"> · 置信 {Math.round(h.confidence * 100)}%</span> : null}
                  </div>
                </div>
              </div>
              {h.reason && (
                <div className="report">
                  <b>AI 甄别报告</b> · {h.relevant ? '实质相关' : '蹭词/无关'} · {h.genuine ? '真实可信' : '存疑/假冒'}
                  <br />
                  {h.reason}
                </div>
              )}
            </div>
          ))}
      </div>
    </>
  );
}
