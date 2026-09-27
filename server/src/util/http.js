import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/** 本机若设置了 HTTPS_PROXY/https_proxy（如 Clash Verge），全局 fetch 自动走代理 */
if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log('[net] fetch 已启用环境代理:', process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
  } catch (e) {
    console.warn('[net] 代理配置失败（忽略，直连）:', e.message);
  }
}

/** 共享 HTTP 工具：带超时的 fetch 封装（Node 24 原生 fetch） */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 HotPulse/0.1';

export async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout ?? 15000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

export async function fetchJson(url, opts = {}) {
  const txt = await fetchText(url, opts);
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(`JSON 解析失败 ${url}`);
  }
}

export function toIso(dateLike) {
  if (!dateLike) return '';
  const d = new Date(dateLike);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetchText + 指数退避重试（应对代理偶发 ECONNRESET） */
export async function fetchTextRetry(url, opts = {}) {
  const tries = opts.tries ?? 2;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetchText(url, opts);
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(800 * (i + 1));
    }
  }
  throw lastErr;
}
