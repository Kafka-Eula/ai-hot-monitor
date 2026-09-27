import db, { getSetting } from '../db.js';
import { config } from '../config.js';
import { chatJSON } from './openrouter.js';

const SYSTEM = `你是 AI 领域热点分析师。用户给出监控关键词和若干条从不同信息源抓到的内容。
对每个【关键词 × 内容】组合判断：
1. relevant：内容是否实质讨论该关键词所指的产品/事件/技术本身。蹭词（仅在标题或无关上下文提及）、营销软文、教程堆砌、与关键词无关 → false。
2. genuine：内容描述的信息是否真实可信。**判定依据是来源可信度与交叉佐证，绝不是你自己的记忆**：
   - src=blog 是厂商官方博客 RSS（一手官宣，视为权威真实）；
   - 域名属于厂商官方（openai.com、anthropic.com、blog.google、huggingface.co、deepmind.google、mistral.ai、meta.com、ai.meta.com 等）视为一手来源；
   - src=hn/github 等社区讨论：作为"该事件被广泛讨论"的佐证，可信度中等；
   - **第三方转述型站点（SEO 站、内容农场、云厂商博客、"泄露/爆料"文、模型目录站）若理由中出现"未见官方/缺乏官方/无官方佐证/传闻"等措辞，genuine 必须为 false**——不得一边说没佐证一边放行；
   - 仅营销号、无官方佐证、内容自相矛盾 → false。
3. confidence：0~1，对 above 两项结论的把握。
4. reason：一句话中文理由（≤60字），需具体，说明判定依据。
只输出 JSON，格式：{"results":[{"k":关键词序号,"i":内容序号,"relevant":true,"genuine":true,"confidence":0.9,"reason":"..."}]}
必须为每个组合都给出结果。`;

/** 关键：注入当前日期，避免模型用训练截止日期否定真实存在的新产品 */
function dateNote() {
  const today = new Date().toISOString().slice(0, 10);
  return `【当前日期：${today}】你的训练数据存在截止时间，**很多新产品/新模型在你所学之后才发布**。
严禁以"该产品在我的知识中不存在"为由判定为虚假；一律以给定来源与佐证为准。\n\n`;
}

/** 官方一手来源域名（用于代码层兜底判定） */
const OFFICIAL_HOSTS = [
  'openai.com', 'anthropic.com', 'claude.com', 'blog.google', 'deepmind.google',
  'huggingface.co', 'meta.com', 'ai.meta.com', 'mistral.ai', 'cohere.com', 'x.ai',
  'microsoft.com', 'developers.openai.com',
];
function isOfficialUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return OFFICIAL_HOSTS.some((d) => h === d || h.endsWith('.' + d));
  } catch {
    return false;
  }
}

const schema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          k: { type: 'number' },
          i: { type: 'number' },
          relevant: { type: 'boolean' },
          genuine: { type: 'boolean' },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['k', 'i', 'relevant', 'genuine', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

/** 廉价预筛：文本包含关键词（忽略大小写/空格） */
function preMatch(item, term) {
  const t = (item.title + ' ' + item.summary + ' ' + item.author).toLowerCase();
  return t.includes(term.toLowerCase()) || t.includes(term.toLowerCase().replace(/\s+/g, '-'));
}

/**
 * 对本轮新入库条目做关键词甄别。
 * @param {number[]} newItemIds 本轮新入库的 item id
 * @returns { hits:number, screened:number }
 */
export async function screenKeywords(newItemIds) {
  const keywords = db
    .prepare('SELECT id, term FROM keywords WHERE enabled=1')
    .all();
  if (!keywords.length || !newItemIds.length) return { hits: 0, screened: 0 };

  const placeholders = newItemIds.map(() => '?').join(',');
  const items = db
    .prepare(
      `SELECT id, source, title, summary, author, url, published_at FROM items WHERE id IN (${placeholders})`
    )
    .all(...newItemIds);

  // 候选对：预筛通过的 (keyword, item)
  const pairs = [];
  for (const kw of keywords) {
    for (const it of items) {
      if (preMatch(it, kw.term)) pairs.push({ kw, it });
    }
  }
  if (!pairs.length) return { hits: 0, screened: 0 };

  // 去掉已甄别过的对
  const seen = db.prepare('SELECT 1 FROM hits WHERE keyword_id=? AND item_id=?');
  const fresh = pairs.filter((p) => !seen.get(p.kw.id, p.it.id));
  if (!fresh.length) return { hits: 0, screened: 0 };

  const kws = [...new Set(fresh.map((p) => p.kw.term))];
  const its = [...new Map(fresh.map((p) => [p.it.id, p.it])).values()];
  const user =
    dateNote() +
    JSON.stringify({
      keywords: kws,
      items: its.map((it) => ({
        i: it.id,
        title: it.title.slice(0, 200),
        summary: (it.summary || '').slice(0, 300),
        source: it.source,
        url: (it.url || '').slice(0, 160),
        author: it.author,
      })),
      pairs: fresh.map((p) => ({ k: kws.indexOf(p.kw.term), i: p.it.id })),
    });

  const { data } = await chatJSON({ system: SYSTEM, user, schema, name: 'screen' });

  const ins = db.prepare(
    `INSERT INTO hits(keyword_id,item_id,relevant,genuine,confidence,reason,screened_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(keyword_id,item_id) DO UPDATE SET relevant=excluded.relevant, genuine=excluded.genuine,
       confidence=excluded.confidence, reason=excluded.reason, screened_at=excluded.screened_at`
  );
  const minConf = Number(getSetting('thresholds.minConfidence', config.thresholds.minConfidence));
  let hits = 0;
  const hitList = [];
  const now = new Date().toISOString();
  const kwByTerm = new Map(keywords.map((k) => [k.term, k]));

  for (const r of data?.results || []) {
    const term = kws[r.k];
    const kw = kwByTerm.get(term);
    if (!kw) continue;
    let genuine = Boolean(r.genuine);
    const item = its.find((x) => x.id === r.i);
    // 兜底：AI 理由自曝"无官方佐证"而来源又非官方 → 强制降级（模型常言行不一）
    if (genuine && item) {
      const official = item.source === 'blog' || isOfficialUrl(item.url || '');
      const hedge = /未见官方|缺乏官方|无官方|没有官方|未见权威|缺乏佐证|无佐证|未经证实|传闻|爆料|泄露|无法证实|存疑/.test(r.reason || '');
      if (!official && hedge) {
        genuine = false;
        console.log(`[ai] 兜底降级: ${item.title.slice(0, 50)}`);
      }
    }
    ins.run(kw.id, r.i, r.relevant ? 1 : 0, genuine ? 1 : 0, r.confidence ?? 0, r.reason || '', now);
    if (r.relevant && genuine && (r.confidence ?? 0) >= minConf) {
      hits++;
      const item = its.find((x) => x.id === r.i);
      if (item) hitList.push({ keyword: kw, item, reason: r.reason, confidence: r.confidence });
    }
  }

  if (hitList.length) {
    const t = db.transaction(() => {
      for (const h of hitList) {
        db.prepare('UPDATE keywords SET last_hit_at=? WHERE id=?').run(now, h.keyword.id);
      }
    });
    t();
  }


  return { hits, screened: data?.results?.length || 0, hitList };
}
