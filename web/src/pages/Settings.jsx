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
  const [gates, setGates] = useState({
    hnPoints: 30, hnComments: 15, hfUpvotes: 30, ghStarsToday: 50,
      ghSearchStars: 100, redditScore: 200, lobstersScore: 20, twitterLikes: 50, biliScore: 500,
      minQuality: 60, maxAgeDays: 14, engagementWeight: 0.4, engagementFull: 5000,
    authHn: 100, authReddit: 800, authTwitter: 500, authLobsters: 80, authGhTrending: 500, authGhSearch: 500, authHfPapers: 150,
  });
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
      setGates((gv) => ({
        ...gv,
        hnPoints: s['gates.hnPoints'] ?? gv.hnPoints,
        hnComments: s['gates.hnComments'] ?? gv.hnComments,
        hfUpvotes: s['gates.hfUpvotes'] ?? gv.hfUpvotes,
        ghStarsToday: s['gates.ghStarsToday'] ?? gv.ghStarsToday,
        ghSearchStars: s['gates.ghSearchStars'] ?? gv.ghSearchStars,
        redditScore: s['gates.redditScore'] ?? gv.redditScore,
        lobstersScore: s['gates.lobstersScore'] ?? gv.lobstersScore,
        twitterLikes: s['gates.twitterLikes'] ?? gv.twitterLikes,
                biliScore: s['gates.biliScore'] ?? gv.biliScore,
                minQuality: s['gates.minQuality'] ?? gv.minQuality,
        maxAgeDays: s['gates.maxAgeDays'] ?? gv.maxAgeDays,
                        engagementWeight: s['gates.engagementWeight'] ?? gv.engagementWeight,
                        engagementFull: s['gates.engagementFull'] ?? gv.engagementFull,
        authHn: s['gates.authHn'] ?? gv.authHn,
        authReddit: s['gates.authReddit'] ?? gv.authReddit,
        authTwitter: s['gates.authTwitter'] ?? gv.authTwitter,
        authLobsters: s['gates.authLobsters'] ?? gv.authLobsters,
        authGhTrending: s['gates.authGhTrending'] ?? gv.authGhTrending,
        authGhSearch: s['gates.authGhSearch'] ?? gv.authGhSearch,
        authHfPapers: s['gates.authHfPapers'] ?? gv.authHfPapers,
        authBili: s['gates.authBili'] ?? gv.authBili,
      }));
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
                  <div className="mono" style={{ fontSize: 12, color: 'var(--cyan)', wordBreak: 'break-all' }}>
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
        <div className="section-title">质量门槛 // 噪音拦截（低于门槛的条目不入库）</div>
        <div className="set-grid">
          <div className="panel">
            <div className="panel-h"><h3>互动硬门槛</h3></div>
            <div className="hint" style={{ marginBottom: 10 }}>
              互动数按传播力<b>加权</b>计算（如 X：点赞 + 转发×3 + 评论×2 + log₁₀浏览×10；HN：分数 + 评论×1.5），跨源可比。
              未达入库门槛直接拦截；达<b>爆款门槛</b>的社交条目才算"事件被广泛讨论"，可解锁更高话题分数。
            </div>
            <div className="field">
              <label>入库门槛 / 爆款门槛（加权互动分）</label>
            </div>
            <GatePairRow label="Hacker News" entry="hnPoints" auth="authHn" v={gates} set={setGates} />
            <GatePairRow label="X / Twitter" entry="twitterLikes" auth="authTwitter" v={gates} set={setGates} />
            <GatePairRow label="Lobsters" entry="lobstersScore" auth="authLobsters" v={gates} set={setGates} />
            <GatePairRow label="GitHub Trending（当日新增星）" entry="ghStarsToday" auth="authGhTrending" v={gates} set={setGates} />
            <GatePairRow label="GitHub 新库（stars+forks×2）" entry="ghSearchStars" auth="authGhSearch" v={gates} set={setGates} />
            <GatePairRow label="HF Papers（upvotes）" entry="hfUpvotes" auth="authHfPapers" v={gates} set={setGates} />
            <GatePairRow label="B站（点赞+投币×2+收藏×3+转发×4+弹幕+评论×1.5+log₁₀播放×30）" entry="biliScore" auth="authBili" v={gates} set={setGates} />
            <div className="field">
              <label>HN 评论数兜底（评论再多也算深度讨论）</label>
              <input type="number" min="0" value={gates.hnComments} onChange={(e) => setGates({ ...gates, hnComments: Number(e.target.value) })} />
            </div>
            <button
              className="btn"
              disabled={saving}
              onClick={() => {
                const patch = {};
                for (const [k, val] of Object.entries(gates)) patch[`gates.${k}`] = Number(val);
                save(patch);
              }}
            >
              保存互动门槛
            </button>
          </div>
          <div className="panel">
            <div className="panel-h"><h3>综合质量分门槛</h3></div>
            <div className="field">
              <label>无互动数据源（新闻/官宣/搜索）最低质量分（0~100）</label>
              <input type="number" min="0" max="100" value={gates.minQuality} onChange={(e) => setGates({ ...gates, minQuality: Number(e.target.value) })} />
              <div className="hint">
                由「源分级 + 域名权威 + 新鲜度 − 农场/营销惩罚」算出。当前 {gates.minQuality}，越高越严格（默认 60）。
              </div>
            </div>
            <div className="field">
              <label>最大时效（天）· 发布超过该天数的内容一律拦截</label>
              <input type="number" min="1" max="90" value={gates.maxAgeDays} onChange={(e) => setGates({ ...gates, maxAgeDays: Number(e.target.value) })} />
              <div className="hint">修复"7 月的旧帖又被抓进来"。GitHub Trending / HF 每日论文为快照榜源，不受此限。当前 {gates.maxAgeDays} 天。</div>
            </div>
            <button className="btn" disabled={saving} onClick={() => save({ 'gates.minQuality': gates.minQuality, 'gates.maxAgeDays': gates.maxAgeDays })}>
                          保存质量分门槛
                        </button>
                        <div className="hint" style={{ marginTop: 12 }}>
                          话题分数受<strong>证据分级封顶</strong>：
                          官方一手 / ≥2 家权威媒体交叉 → 不封顶（100，可通知）；
                          纯社交但 ≥2 条达爆款门槛 → 封顶 80（可通知）；
                          单条爆款孤证 → 65；未达爆款门槛 → 60（均不通知）。
                          同源近似标题自动去重，避免刷屏挤占 AI 预算。
                        </div>
                      </div>
                      <div className="panel">
                        <div className="panel-h"><h3>话题热度分：互动权重</h3></div>
                        <div className="hint" style={{ marginBottom: 10 }}>
                          最终热度分 = <b>(1−w) × AI 事件量级 + w × 互动热度</b>。互动热度由话题内**全部条目**的加权互动总量
                          做对数归一得出（B站/社交的观看·点赞·投币·收藏·转发·评论·弹幕都计入）。
                          权重越高，互动多的话题排名越靠前；设为 0 即退回"纯 AI 评分"。
                        </div>
                        <div className="field">
                          <label>互动权重 w（0~1）· 当前 {gates.engagementWeight}</label>
                          <input
                            type="range" min="0" max="1" step="0.05"
                            value={gates.engagementWeight}
                            onChange={(e) => setGates({ ...gates, engagementWeight: Number(e.target.value) })}
                          />
                          <div className="hint">
                            默认 0.4：一条 7.8 万互动的 B站视频话题 ≈ 互动分量 77 分，足以压过 0 互动的官方发布。
                          </div>
                        </div>
                        <div className="field">
                          <label>互动基准尺度 · 10 倍该值 ≈ +40 分（对数曲线）</label>
                          <input
                            type="number" min="100" step="100"
                            value={gates.engagementFull}
                            onChange={(e) => setGates({ ...gates, engagementFull: Number(e.target.value) })}
                          />
                          <div className="hint">默认 1000。调小 → 中小话题也能拿到高互动分；调大 → 只有头部爆款才拉满。</div>
                        </div>
                        <button
                          className="btn"
                          disabled={saving}
                          onClick={() => save({ 'gates.engagementWeight': gates.engagementWeight, 'gates.engagementFull': gates.engagementFull })}
                        >
                          保存互动权重
                        </button>
                        <div className="hint" style={{ marginTop: 12 }}>
                          证据分级封顶仍然生效（官方一手/媒体交叉 ≤100、多源爆款 ≤80、孤证 ≤65），
                          因此「单源孤证」不会因为互动高就绕过封顶；改权重后建议跑一次回填让历史话题重算。
                        </div>
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
                  订阅者：<span className="mono" style={{ color: 'var(--cyan)' }}>{ns.push.subscribers}</span> · 关闭页面也能收到系统通知
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

function GateRow({ label, k, v, set }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type="number"
        min="0"
        value={v[k]}
        onChange={(e) => set({ ...v, [k]: Number(e.target.value) })}
      />
    </div>
  );
}

/** 一行两个输入：入库门槛 + 爆款（权威）门槛 */
function GatePairRow({ label, entry, auth, v, set }) {
  const on = (k) => (e) => set({ ...v, [k]: Number(e.target.value) });
  return (
    <div className="field">
      <label>{label}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input type="number" min="0" value={v[entry]} onChange={on(entry)} style={{ flex: 1 }} title="入库门槛" />
        <input type="number" min="0" value={v[auth]} onChange={on(auth)} style={{ flex: 1 }} title="爆款门槛" />
      </div>
    </div>
  );
}

function SourceStatus() {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    api.scanStatus().then(setInfo).catch(() => {});
    const t = setInterval(() => api.scanStatus().then(setInfo).catch(() => {}), 30000);
    return () => clearInterval(t);
  }, []);
  const stats = info?.lastScan?.stats;
  const last = stats?.sources;
  if (!last) return <span className="hint">暂无扫描记录</span>;
  const blocked = stats.blockedStats || {};
  return (
    <>
      <div className="hint" style={{ marginBottom: 10 }}>
        本轮抓取 <b style={{ color: 'var(--cyan)' }}>{stats.fetched ?? 0}</b> 条 →
        质量拦截 <b style={{ color: 'var(--amber, #fbbf24)' }}>{stats.blocked ?? 0}</b> 条 →
        入库 <b style={{ color: '#3ef2a5' }}>{stats.passed ?? 0}</b> 条（新增 {stats.inserted ?? 0}）
      </div>
      <div className="src-legend" style={{ fontSize: 12 }}>
        {Object.entries(last).map(([k, v]) => (
          <span key={k} style={{ color: v.ok ? 'var(--cyan)' : 'var(--red)' }}>
            {k} {v.ok ? `✓ ${v.count ?? 0}` : '✗'}
            {blocked[k]?.total ? `（拦 ${blocked[k].total}）` : ''} {v.ms}ms
          </span>
        ))}
      </div>
    </>
  );
}
