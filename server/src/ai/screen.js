import db, { getSetting } from '../db.js';
import { config } from '../config.js';
import { chatJSON } from './openrouter.js';
import { isOfficialHost, isOfficialAnnouncement, isAuthorityHost, isDeniedHost, normalizeHost } from '../quality.js';

const SYSTEM = `你是 AI 领域热点分析师。给定监控关键词和若干条来自不同信息源的内容，对每个【关键词 × 内容】组合判断两件事。

每条内容带有**代码预先算好的证据字段**，直接采用，不要自己推测：
- src=信息源；tier=来源分级(1官方一手/2强策展社区/3主流媒体/4泛搜索UGC)；host=域名；eng=互动数(点赞/评论/星，0 表示无热度)
- official=1 表示该域名是厂商官方一手来源；auth=1 表示在权威媒体名单内；farm=1 表示内容农场/自媒体转载站（名单判定，无需你识别媒体身份）

1. relevant：是否实质讨论该关键词所指的产品/事件/技术本身。
   仅在标题蹭词、营销软文、教程堆砌、排行/横评/导航聚合页、与关键词无关 → false。
2. genuine：所描述信息是否真实可信。判定只看来源与佐证，**不看你自己的知识**：
   - official=1 或 tier=1 → 一手权威，true；
   - auth=1 的媒体报道 → 属可信转述，true（"没有官方原文"不等于虚假，权威媒体交叉报道本身就是佐证）；
   - farm=1，或 tier=4 泛搜索/低热度 UGC 且无 official/auth 来源同题印证 → false；
   - eng 极低的社区随手帖、纯传闻爆料、内容自相矛盾 → false。
   注意：不得一边承认"权威媒体报道"一边又以"缺乏官方佐证"判 false，二者矛盾时以 auth 字段为准。
3. confidence：0~1，对上述两项结论的把握。
4. reason：一句话中文（≤50字），引用给定证据字段（如"auth=1 澎湃新闻可信转述""farm=1 自媒体转载"），不要复述标题。

只输出 JSON：{"results":[{"k":关键词序号,"i":内容序号,"relevant":true,"genuine":true,"confidence":0.9,"reason":"..."}]}
必须为每个组合都给出结果。`;

/** 关键：注入当前日期，避免模型用训练截止日期否定真实存在的新产品 */
function dateNote() {
  const today = new Date().toISOString().slice(0, 10);
  return `【当前日期：${today}】你的训练数据存在截止时间，**很多新产品/新模型在你所学之后才发布**。
严禁以"该产品在我的知识中不存在"为由判定为虚假；一律以给定来源与佐证为准。\n\n`;
}

function isOfficialUrl(url) {
  return isOfficialHost(normalizeHost(url));
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

/** 每批最多甄别的候选对数（防大批量超时） */
const SCREEN_BATCH = 25;

/**
 * 对本轮新入库条目做关键词甄别。
 * @param {number[]} newItemIds 本轮新入库的 item id
 * @returns { hits:number, screened:number }
 */
export async function screenKeywords(newItemIds, onProgress) {
  const keywords = db
    .prepare('SELECT id, term FROM keywords WHERE enabled=1')
    .all();
  if (!keywords.length || !newItemIds.length) return { hits: 0, screened: 0 };

  const placeholders = newItemIds.map(() => '?').join(',');
  const items = db
    .prepare(
      `SELECT id, source, title, summary, author, url, published_at, host, engagement, source_tier, quality_score FROM items WHERE id IN (${placeholders})`
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

  const ins = db.prepare(
    `INSERT INTO hits(keyword_id,item_id,relevant,genuine,confidence,reason,screened_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(keyword_id,item_id) DO UPDATE SET relevant=excluded.relevant, genuine=excluded.genuine,
       confidence=excluded.confidence, reason=excluded.reason, screened_at=excluded.screened_at`
  );
  const minConf = Number(getSetting('thresholds.minConfidence', config.thresholds.minConfidence));
  const kwByTerm = new Map(keywords.map((k) => [k.term, k]));
  const now = new Date().toISOString();
  let hits = 0;
  let screened = 0;
  const hitList = [];
  const failedIds = new Set();

  // 分批：每批最多 SCREEN_BATCH 个候选对，避免大批量一次请求超时
  for (let b = 0; b < fresh.length; b += SCREEN_BATCH) {
    const batch = fresh.slice(b, b + SCREEN_BATCH);
    const kws = [...new Set(batch.map((p) => p.kw.term))];
    const its = [...new Map(batch.map((p) => [p.it.id, p.it])).values()];
    const user =
      dateNote() +
      JSON.stringify({
        keywords: kws,
        items: its.map((it) => {
          const h = it.host || normalizeHost(it.url || '');
          return {
            i: it.id,
            title: it.title.slice(0, 200),
            summary: (it.summary || '').slice(0, 300),
            source: it.source,
            url: (it.url || '').slice(0, 160),
            author: it.author,
            // 证据字段：tier=1 官方一手；eng=互动数。
            // host 的权威/官方/农场判定由**代码查名单**得出并直接给出（auth/official/farm），
            // 不让模型自己猜某域名是否权威——它对中国媒体名单（澎湃/每经/新浪财经等）判断不稳，
            // 曾把白名单内媒体一律当成"非权威媒体"而误杀。
            tier: it.source_tier,
            eng: it.engagement,
            host: h,
            official: isOfficialHost(h) ? 1 : 0,
            auth: isAuthorityHost(h) ? 1 : 0,
            farm: isDeniedHost(h) ? 1 : 0,
          };
        }),
        pairs: batch.map((p) => ({ k: kws.indexOf(p.kw.term), i: p.it.id })),
      });

    let data;
    try {
      ({ data } = await chatJSON({ system: SYSTEM, user, schema, name: 'screen' }));
    } catch (e) {
      console.warn(`[ai] 甄别批次 ${Math.floor(b / SCREEN_BATCH) + 1} 失败: ${e.code || ''} ${e.message}`);
      for (const p of batch) failedIds.add(p.it.id); // 该批未写 hits，下轮重试
      onProgress?.({ phase: 'screen', done: Math.min(b + SCREEN_BATCH, fresh.length), total: fresh.length });
      continue;
    }

    for (const r of data?.results || []) {
      const kw = kwByTerm.get(kws[r.k]);
      if (!kw) continue;
      const item = its.find((x) => x.id === r.i);
      if (!item) continue;
      let genuine = Boolean(r.genuine);
      // 兜底：AI 理由自曝"无官方佐证"而来源**既非官方也非权威媒体** → 强制降级（模型常言行不一）。
      // auth=1 的权威媒体可信转述不在此列——新提示词已明确"权威媒体报道本身即佐证"，
      // 若模型仍写"未见官方"却放行，属于措辞矛盾而非判断错误，不再降级（曾误杀澎湃/每经等）。
      if (genuine) {
        const h = item.host || normalizeHost(item.url || '');
        const strong =
          item.source_tier === 1 ||
          isOfficialAnnouncement(item.source, h) ||
          isOfficialUrl(item.url || '') ||
          isAuthorityHost(h);
        const hedge = /未见官方|缺乏官方|无官方|没有官方|未见权威|缺乏佐证|无佐证|未经证实|传闻|爆料|泄露|无法证实|存疑/.test(r.reason || '');
        if (!strong && hedge) {
          genuine = false;
          console.log(`[ai] 兜底降级: ${item.title.slice(0, 50)}`);
        }
      }
      ins.run(kw.id, r.i, r.relevant ? 1 : 0, genuine ? 1 : 0, r.confidence ?? 0, r.reason || '', now);
      screened++;
      if (r.relevant && genuine && (r.confidence ?? 0) >= minConf) {
        hits++;
        hitList.push({ keyword: kw, item, reason: r.reason, confidence: r.confidence });
      }
    }
    console.log(`[ai] 甄别批次 ${Math.floor(b / SCREEN_BATCH) + 1}: ${batch.length} 对完成`);
    onProgress?.({ phase: 'screen', done: Math.min(b + SCREEN_BATCH, fresh.length), total: fresh.length });
  }

  if (hitList.length) {
    const t = db.transaction(() => {
      for (const h of hitList) {
        db.prepare('UPDATE keywords SET last_hit_at=? WHERE id=?').run(now, h.keyword.id);
      }
    });
    t();
  }

  return { hits, screened, hitList, failedIds: [...failedIds] };
}
