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
