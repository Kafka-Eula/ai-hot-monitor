/**
 * 零依赖网络层。
 *
 * 为什么需要它：Node 的 fetch **不读** HTTPS_PROXY 环境变量（实测确认），
 * 而本机 Clash/Verge 之类的代理是访问 huggingface.co、github.com、news.google.com
 * 的前提。项目服务用 npm 装的 undici 解决这件事；本 Skill 要求"安装即用、不装包"，
 * 所以改用 **Node 内置的 undici**（Node ≥ 21 可直接 import('undici')）。
 *
 * 代理不可用时不会报错，只会让境外源失败并被上层静默跳过——国内源仍然可用。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 HotPulse/1.0';

let proxyState = 'off';

/** 尝试启用环境代理；失败则直连。返回状态供 doctor 展示。 */
export async function initProxy() {
  const url = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!url) {
    proxyState = 'none';
    return { mode: 'none', detail: '未设置 HTTP(S)_PROXY，境外源可能不可达' };
  }
  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent());
    proxyState = 'env';
    return { mode: 'env', detail: url };
  } catch (e) {
    proxyState = 'failed';
    return { mode: 'failed', detail: `内置 undici 不可用（${e.code || e.message}），将直连` };
  }
}

export const proxyMode = () => proxyState;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 单次请求：文本。opts: {timeout, headers, tries} */
export async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout ?? 15000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 90)}`);
  return res.text();
}

/** 带指数退避的重试（代理偶发 ECONNRESET 很常见，一次重试通常就好） */
export async function fetchTextRetry(url, opts = {}) {
  const tries = opts.tries ?? 2;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetchText(url, opts);
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(700 * (i + 1));
    }
  }
  throw lastErr;
}

export async function fetchJson(url, opts = {}) {
  const txt = await fetchTextRetry(url, { Accept: 'application/json', ...opts });
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(`JSON 解析失败 ${url.slice(0, 90)}`);
  }
}

/** 并发上限（自实现，替代 p-limit）：源之间打的是不同站点，4 并发安全 */
export function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(
      (v) => {
        active--;
        next();
        resolve(v);
      },
      (e) => {
        active--;
        next();
        reject(e);
      }
    );
  };
  return (fn) => new Promise((resolve, reject) => (queue.push({ fn, resolve, reject }), next()));
}

export const toIso = (d) => {
  if (!d) return '';
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '' : t.toISOString();
};

/** 自己跑一遍最小连通性探测，供 doctor 判断"哪些源在当前网络可用" */
export const PROBES = [
  { source: 'hn', name: 'Hacker News', url: 'https://hn.algolia.com/api/v1/search?hitsPerPage=1', abroad: false },
  { source: 'hf_papers', name: 'HF Papers', url: 'https://huggingface.co/api/daily_papers?limit=1', abroad: true },
  { source: 'gh_trending', name: 'GitHub', url: 'https://api.github.com/rate_limit', abroad: true },
  { source: 'news_search', name: 'Google News', url: 'https://news.google.com/rss/search?q=AI&hl=en-US&gl=US&ceid=US:en', abroad: true },
  { source: 'cn_search', name: '360 新闻', url: 'https://news.so.com/ns?q=AI', abroad: false },
  { source: 'cn_media', name: 'IT之家', url: 'https://www.ithome.com/rss/', abroad: false },
  { source: 'bilibili', name: 'B站', url: 'https://api.bilibili.com/x/web-interface/popular?ps=1', abroad: false },
];

export async function probeAll() {
  const limit = pLimit(4);
  return Promise.all(
    PROBES.map((p) =>
      limit(async () => {
        const t0 = Date.now();
        try {
          const res = await fetch(p.url, {
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(12000),
            redirect: 'follow',
          });
          await res.text().catch(() => {});
          return { ...p, ok: res.ok, status: res.status, ms: Date.now() - t0 };
        } catch (e) {
          return { ...p, ok: false, status: 0, ms: Date.now() - t0, error: e.cause?.code || e.message };
        }
      })
    )
  );
}
