import { useEffect, useState } from 'react';
import { api, enablePush } from '../lib/api.js';

const CRON_PRESETS = [
  ['*/10 * * * *', '每 10 分钟'],
  ['*/30 * * * *', '每 30 分钟'],
  ['0 * * * *', '每小时'],
  ['0 */3 * * *', '每 3 小时'],
  ['0 9 * * *', '每天 9 点'],
];

/** 实测推荐（免费链里速度快、JSON 稳定的） */
const RECOMMENDED = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'poolside/laguna-s-2.1:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'qwen/qwen3.8-27b:free',
];

export default function Settings({ refreshScan, showToast }) {
  const [st, setSt] = useState({});
  const [ai, setAi] = useState(null);
  const [ns, setNs] = useState(null);
  const [pushState, setPushState] = useState('');
  const [model, setModel] = useState('');
  const [cron, setCron] = useState('*/30 * * * *');
  const [minConf, setMinConf] = useState(0.6);
  const [minScore, setMinScore] = useState(70);
  const [emailOn, setEmailOn] = useState(true);
  const [pushOn, setPushOn] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [pick, setPick] = useState('__default__');
  const [models, setModels] = useState(null);

  const load = () => {
    api.settings().then((s) => {
      setSt(s);
      setCron(s.scanCron || '*/30 * * * *');
      setModel(s['openrouter.model'] || '');
      setMinConf(s['thresholds.minConfidence'] ?? 0.6);
      setMinScore(s['thresholds.minTopicScore'] ?? 70);
      setEmailOn(s['notify.email.enabled'] !== false);
      setPushOn(s['notify.webpush.enabled'] !== false);
    }).catch(() => {});
    api.aiStatus().then(setAi).catch(() => {});
    api.notifyStatus().then(setNs).catch(() => {});
    api.aiModels().then(setModels).catch(() => setModels({ free: [], popular: [], error: true }));
  };
  useEffect(load, []);

  const save = async (patch) => {
    setSaving(true);
    try {
      await api.saveSettings(patch);
      showToast('设置已保存，下轮扫描生效');
      load();
      refreshScan?.();
    } catch (e) {
      showToast(`保存失败：${e.message}`);
    }
    setSaving(false);
  };

  const enablePush = async () => {
    setPushState('请求授权中…');
    try {
      await enablePush();
      setPushState('✅ 已开启浏览器推送');
      showToast('浏览器推送已开启');
      load();
    } catch (e) {
      setPushState(`失败：${e.message}`);
    }
  };

  return (
    <>
      <div className="section">
        <div className="section-title">运行参数</div>
        <div className="set-grid">
          <div className="panel">
            <div className="panel-h"><h3>扫描计划</h3></div>
            <div className="field">
              <label>频率（cron 表达式）</label>
              <select className="mono" value={cron} onChange={(e) => setCron(e.target.value)}>
                {CRON_PRESETS.map(([v, l]) => (
                  <option key={v} value={v}>{l} · {v}</option>
                ))}
                {!CRON_PRESETS.some(([v]) => v === cron) && <option value={cron}>{cron}（自定义）</option>}
              </select>
              <div className="hint">默认每 30 分钟一轮；频率越高，免费 AI 额度消耗越快</div>
            </div>
            <button className="btn" disabled={saving} onClick={() => save({ scanCron: cron })}>保存</button>
          </div>

          <div className="panel">
            <div className="panel-h"><h3>AI 甄别阈值</h3></div>
            <div className="field">
              <label>关键词命中最低置信度（0~1）</label>
              <input type="number" min="0" max="1" step="0.05" value={minConf} onChange={(e) => setMinConf(Number(e.target.value))} />
              <div className="hint">低于该置信度不触发通知，只存档。当前 {minConf}</div>
            </div>
            <div className="field">
              <label>热点话题通知分数线（0~100）</label>
              <input type="number" min="0" max="100" value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} />
              <div className="hint">AI 评分达到该值的新话题才推送通知</div>
            </div>
            <button className="btn" disabled={saving} onClick={() => save({ 'thresholds.minConfidence': minConf, 'thresholds.minTopicScore': minScore })}>
              保存
            </button>
          </div>

          <div className="panel">
            <div className="panel-h">
              <h3>AI 模型</h3>
              <button className="btn ghost sm" onClick={() => setModelOpen((v) => !v)}>
                {modelOpen ? '收起列表' : '更换模型'}
              </button>
            </div>
            {ai && (
              <>
                <div className="field">
                  <label>当前模型链（自动降级）</label>
                  <div className="mono" style={{ fontSize: 12, color: 'var(--accent)', wordBreak: 'break-all' }}>
                    {ai.chain?.join(' → ')}
                  </div>
                  <div className="hint">
                    {ai.has_key ? 'OpenRouter key 已配置 · 换模型无需新 key、无需重启' : '⚠ 未配置 OPENROUTER_API_KEY（.env）'}
                    {ai.circuit_open ? ' · 熔断中，10 分钟后自动恢复' : ''}
                  </div>
                </div>

                {modelOpen && (
                  <>
                    <div className="field">
                      <label>从列表选择（{models ? `${models.free.length} 个免费 · ${models.popular.length} 个付费精选` : '加载中…'}）</label>
                      <select
                        className="mono"
                        value={pick}
                        onChange={(e) => {
                          const v = e.target.value;
                          setPick(v);
                          if (v === '__custom__') return;
                          if (v === '__default__') setModel('');
                          else setModel(v);
                        }}
                      >
                        <option value="__default__">使用默认链（{ai.model}）</option>
                        <optgroup label="★ 推荐（实测快且稳）">
                          {RECOMMENDED.map((id) => (
                            <option key={id} value={id}>{id}</option>
                          ))}
                        </optgroup>
                        {models && (
                          <optgroup label="付费精选（按 token 计费，几分钱/天）">
                            {models.popular.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.id} · ${Number(m.prompt) * 1e6}/1M in
                              </option>
                            ))}
                          </optgroup>
                        )}
                        {models && (
                          <optgroup label="全部免费模型">
                            {models.free.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.id} · ctx {Math.round((m.ctx || 0) / 1000)}k
                              </option>
                            ))}
                          </optgroup>
                        )}
                        <option value="__custom__">自定义（手动输入模型 ID）…</option>
                      </select>
                    </div>
                    <div className="field">
                      <label>生效模型 ID（保存后立用于下一轮扫描；备用链自动沿用）</label>
                      <input
                        className="mono"
                        placeholder={pick === '__custom__' ? '例如 google/gemini-2.5-flash' : ai.model}
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                      />
                      <div className="hint">完整清单：https://openrouter.ai/models（免费模型限 50 次/天，本项目每轮约 2 次）</div>
                    </div>
                    <div className="row2">
                      <button className="btn" disabled={saving} onClick={() => save({ 'openrouter.model': model.trim() })}>
                        应用
                      </button>
                      <button
                        className="btn ghost"
                        disabled={saving}
                        onClick={() => {
                          setModel('');
                          setPick('__default__');
                          save({ 'openrouter.model': '' });
                        }}
                      >
                        恢复默认
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-title">通知渠道</div>
        <div className="set-grid">
          <div className="panel">
            <div className="panel-h"><h3>站内 + 实时</h3></div>
            <p style={{ fontSize: 13, color: 'var(--dim)', margin: '0 0 12px' }}>
              通知中心与 SSE 实时推送{' '}
              <span className="dot ok" style={{ display: 'inline-block', verticalAlign: 'middle' }} /> 始终开启。
              页面开着就能实时收到红点和 toast。
            </p>
            <button className="btn ghost sm" onClick={() => api.notifyTest('HotPulse 自检', '站内 + 推送 + 邮件三渠道测试通知').then((r) => showToast(r.ok ? '测试通知已发出' : `已频控：${r.reason}`))}>
              发送测试通知
            </button>
          </div>

          <div className="panel">
            <div className="panel-h"><h3>浏览器推送</h3></div>
            {ns?.push?.configured ? (
              <>
                <div className="hint" style={{ marginBottom: 10 }}>
                  订阅者：<span className="mono" style={{ color: 'var(--accent)' }}>{ns.push.subscribers}</span> · 关闭页面也能收到系统通知
                </div>
                <label className="toggle" style={{ marginBottom: 12 }}>
                  <input type="checkbox" hidden checked={pushOn} onChange={(e) => { setPushOn(e.target.checked); save({ 'notify.webpush.enabled': e.target.checked }); }} />
                  <i /> {pushOn ? '已启用' : '已停用'}
                </label>
                <div className="row2">
                  <button className="btn sm" onClick={enablePush}>在本浏览器开启</button>
                  <button className="btn ghost sm" onClick={() => api.pushTest().then((r) => showToast(r.skipped ? `跳过：${r.reason}` : `已推送 ${r.ok}/${r.total}`))}>发送测试推送</button>
                </div>
                {pushState && <div className={pushState.startsWith('✅') ? 'ok-tip' : 'err-tip'} style={{ marginTop: 8 }}>{pushState}</div>}
              </>
            ) : (
              <div className="hint">
                未配置 VAPID 密钥。开启方法：在项目根目录运行
                <div className="mono" style={{ background: 'var(--bg2)', padding: '8px 10px', borderRadius: 4, margin: '8px 0', fontSize: 11.5 }}>
                  npx web-push generate-vapid-keys
                </div>
                把结果填入 .env 的 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 并重启服务。
              </div>
            )}
          </div>

          <div className="panel">
            <div className="panel-h"><h3>邮件通知</h3></div>
            {ns?.email?.ready ? (
              <>
                <div className="hint" style={{ marginBottom: 12 }}>SMTP 已配置，命中通知将同时发到你的邮箱。</div>
                <label className="toggle">
                  <input type="checkbox" hidden checked={emailOn} onChange={(e) => { setEmailOn(e.target.checked); save({ 'notify.email.enabled': e.target.checked }); }} />
                  <i /> {emailOn ? '已启用' : '已停用'}
                </label>
              </>
            ) : (
              <div className="hint">
                未配置。在 .env 填入 SMTP_HOST / SMTP_USER / SMTP_PASS（QQ、163 邮箱的"授权码"即可）与 MAIL_TO，重启后生效。
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-title">信息源状态</div>
        <div className="panel">
          <SourceStatus />
        </div>
      </div>
    </>
  );
}

function SourceStatus() {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    api.scanStatus().then(setInfo).catch(() => {});
    const t = setInterval(() => api.scanStatus().then(setInfo).catch(() => {}), 30000);
    return () => clearInterval(t);
  }, []);
  const last = info?.lastScan?.stats?.sources;
  if (!last) return <span className="hint">暂无扫描记录</span>;
  return (
    <div className="src-legend" style={{ fontSize: 12 }}>
      {Object.entries(last).map(([k, v]) => (
        <span key={k} style={{ color: v.ok ? 'var(--accent)' : 'var(--red)' }}>
          {k} {v.ok ? `✓ ${v.count ?? 0}` : '✗'} {v.ms}ms
        </span>
      ))}
    </div>
  );
}
