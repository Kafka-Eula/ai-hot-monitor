const j = (r) => {
  if (!r.ok) return r.json().then((b) => Promise.reject(new Error(b.error || r.status)));
  return r.json();
};
// 注意：method 必须放在返回值里由参数决定，而不是让调用方 `{ method:'PUT', ...opt() }`
// 那样展开——spread 在后会把前面的 method 覆盖回 POST（正是这个 bug 让保存设置一直 404）。
const opt = (body, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  health: () => fetch('/api/health').then(j),
  keywords: () => fetch('/api/keywords').then(j),
  addKeyword: (term) => fetch('/api/keywords', opt({ term })).then(j),
  delKeyword: (id) => fetch(`/api/keywords/${id}`, { method: 'DELETE' }).then(j),
  patchKeyword: (id, enabled) => fetch(`/api/keywords/${id}`, opt({ enabled }, 'PATCH')).then(j),
  hits: (id) => fetch(`/api/keywords/${id}/hits`).then(j),

  scopes: () => fetch('/api/scopes').then(j),
  addScope: (label) => fetch('/api/scopes', opt({ label })).then(j),
  delScope: (id) => fetch(`/api/scopes/${id}`, { method: 'DELETE' }).then(j),

  topics: (params = {}) => {
    const qs = new URLSearchParams();
    // view / expandWeak 是纯前端状态，不参与查询
    for (const [k, v] of Object.entries(params)) {
      if (k === 'view' || k === 'expandWeak') continue;
      if (v === '' || v == null || v === 'all' || v === 0) continue;
      if (Array.isArray(v) && !v.length) continue;
      qs.set(k, Array.isArray(v) ? v.join(',') : v);
    }
    if (!qs.has('limit')) qs.set('limit', '10');
    return fetch(`/api/topics?${qs}`).then(j);
  },
  topic: (id) => fetch(`/api/topics/${id}`).then(j),
  items: (limit = 150) => fetch(`/api/items?limit=${limit}`).then(j),

  notices: () => fetch('/api/notices').then(j),
  readNotice: (id) => fetch('/api/notices/read', opt({ id })).then(j),
  readAll: () => fetch('/api/notices/read', opt({ all: true })).then(j),

  scanStatus: () => fetch('/api/scan/status').then(j),
  runScan: () => fetch('/api/scan/run', { method: 'POST' }).then(j),
  aiStatus: () => fetch('/api/ai/status').then(j),
  aiModels: () => fetch('/api/ai/models').then(j),
  notifyStatus: () => fetch('/api/notify/status').then(j),
  settings: () => fetch('/api/settings').then(j),
  saveSettings: (obj) => fetch('/api/settings', opt(obj, 'PUT')).then(j),
  pushKey: () => fetch('/api/push/public-key').then(j),
  pushSubscribe: (sub) => fetch('/api/push/subscribe', opt(sub)).then(j),
  pushTest: () => fetch('/api/push/test', { method: 'POST' }).then(j),
  notifyTest: (title, body) => fetch('/api/notify/test', opt({ title, body })).then(j),
};

export function subscribe(onNotice, onScan, onStatus, onProgress) {
  let es;
  const open = () => {
    es = new EventSource('/api/events');
    es.addEventListener('hello', () => onStatus?.('open'));
    es.addEventListener('notice', (e) => onNotice?.(JSON.parse(e.data)));
    es.addEventListener('scan', (e) => onScan?.(JSON.parse(e.data)));
    es.addEventListener('scan_progress', (e) => onProgress?.(JSON.parse(e.data)));
    es.onerror = () => onStatus?.(es.readyState === 0 ? 'retrying' : 'closed');
  };
  open();
  return () => es?.close();
}

export async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('此浏览器不支持推送');
  const reg = await navigator.serviceWorker.register('/sw.js');
  const { publicKey } = await api.pushKey();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await api.pushSubscribe(sub.toJSON());
  return sub;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export const fmtAgo = (iso) => {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return `${Math.floor(s / 86400)}天前`;
};

/** 短日：今天/昨天显示时刻，更早显示月-日（判断"原始发布时间"比"N天前"更好用） */
export const fmtShort = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const y = new Date(now.getTime() - 86400000);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay(d, now)) return hm;
  if (sameDay(d, y)) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
};

export const fmtNum = (n) => {
  const v = Number(n) || 0;
  // 中文语境用 万/亿 更好读（B站播放动辄百万，之前会显示成 "1834k"）
  if (v >= 1e8) return `${trimZero(v / 1e8)}亿`;
  if (v >= 1e4) return `${trimZero(v / 1e4)}万`;
  return String(v);
};

const trimZero = (x) => {
  const s = x.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};

/** 带日期与时刻（详情页"事件时间"跨度可能跨天，只给月-日会看不懂） */
export const fmtDay = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = new Date();
  const same = d.getFullYear() === y.getFullYear();
  const md = `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return same ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
  };

  /** 原始互动指标标签（与后端 spec 对齐；只用于展示，不参与加权） */
export const METRIC_LABEL = {
  points: { label: '点赞', ico: '▲' },
  upvotes: { label: '赞', ico: '▲' },
  score: { label: '得分', ico: '◆' },
  comments: { label: '评论', ico: '💬' },
  replies: { label: '回复', ico: '↩' },
  likes: { label: '点赞', ico: '👍' },
  rts: { label: '转发', ico: '🔁' },
  views: { label: '浏览', ico: '👁' },
  stars: { label: 'Star', ico: '⭐' },
  stars_today: { label: '今日新增', ico: '＋' },
  forks: { label: 'Fork', ico: '⑂' },
  // B站：互动维度最全，按"传播力"排序展示
  like: { label: '点赞', ico: '👍' },
  coin: { label: '投币', ico: '🪙' },
  fav: { label: '收藏', ico: '⭐' },
  share: { label: '转发', ico: '🔁' },
  reply: { label: '评论', ico: '💬' },
  danmaku: { label: '弹幕', ico: '💭' },
  view: { label: '播放', ico: '▶' },
};

/** 各源的互动指标展示顺序（B站按"值得看/值得传"优先，播放量放最后） */
const METRIC_ORDER = {
  gh_trending: ['stars_today', 'stars', 'forks'],
  gh_search: ['stars', 'forks'],
  bilibili: ['like', 'coin', 'fav', 'share', 'reply', 'danmaku', 'view'],
  bilibili_hot: ['like', 'coin', 'fav', 'share', 'reply', 'danmaku', 'view'],
};
const DEFAULT_METRIC_ORDER = ['points', 'likes', 'upvotes', 'score', 'stars', 'comments', 'rts', 'replies', 'views'];

/** 条目原始互动指标 → 徽章列表（无互动数据的源返回空数组，前端据此标注"该源无互动数据"） */
export function metricsList(source, metrics, max = 0) {
  const order = METRIC_ORDER[source] || DEFAULT_METRIC_ORDER;
  const list = order
    .filter((k) => Number(metrics?.[k]) > 0)
    .map((k) => ({ key: k, ...METRIC_LABEL[k], text: fmtNum(metrics[k]) }));
  return max > 0 ? list.slice(0, max) : list;
}

/** 新鲜度分档：用于"新 <6h / 发酵中 / 冷却"标签 */
export function freshness(iso) {
  const t = Date.parse(iso || '');
  if (!t) return null;
  const h = (Date.now() - t) / 3600000;
  if (h < 6) return { key: 'new', label: '新' };
  if (h < 48) return { key: 'warm', label: '发酵中' };
  return { key: 'cold', label: '冷却' };
}

/** 无发布时间的源：术语更准确，避免把采集时间当发布时间 */
export const NO_DATE_NOTE = '该源不提供发布时间';

export const SOURCE_LABEL = {
  hn: 'Hacker News',
  gh_trending: 'GitHub',
  gh_search: 'GitHub 新库',
  hf_papers: 'HF Papers',
  blog: '官方博客',
  web_search: '网页搜索',
  news_search: '新闻搜索',
  cn_search: '360新闻搜索',
  cn_media: '中文媒体',
  lobsters: 'Lobsters',
  reddit: 'Reddit',
  twitter: 'X / Twitter',
  bilibili: 'B站',
  bilibili_hot: 'B站热门',
};

/** 来源可信分级（与后端 quality.js 对齐） */
export const TIER_LABEL = { 1: '官方一手', 2: '强策展', 3: '主流媒体', 4: '泛搜索' };

/** 话题证据等级（与后端 evidenceTier 对齐） */
export const EVIDENCE_TIER_LABEL = {
  official: '官方一手',
  media_cross: '多权威媒体交叉',
  viral_social: '多平台爆款',
  single_viral: '单平台爆款（孤证）',
  social_weak: '社交弱信号',
  weak: '证据不足',
};
