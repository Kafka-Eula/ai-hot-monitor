import { fetchJson } from '../util/http.js';
import { normItem } from './normalize.js';

/** HuggingFace 每日论文 — 公开 API，全局源 */
export async function collect(ctx) {
  const j = await fetchJson('https://huggingface.co/api/daily_papers?limit=50', { timeout: 20000 });
  const out = [];
  for (const entry of Array.isArray(j) ? j : []) {
    const p = entry.paper || {};
    if (!p.id || !p.title) continue;
    const it = normItem({
      source: 'hf_papers',
      url: `https://huggingface.co/papers/${p.id}`,
      title: p.title.replace(/\s+/g, ' '),
      summary: (p.summary || '').slice(0, 500),
      published_at: p.publishedAt,
      metrics: { upvotes: p.upvotes },
    });
    if (it) out.push(it);
  }
  ctx.log('hf_papers', '-', `${out.length} papers`);
  // daily_papers 本身就是"今日精选"，不再套 since 窗口（论文 publishedAt 常早于入选日）
  return out.slice(0, 50);
}
