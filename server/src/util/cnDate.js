/**
 * 中文搜索结果里的日期解析：各家引擎格式混杂，统一转 ISO。
 * 支持：2026年8月13日 / 2026-08-13 / 2025/3/1 / "5 天之前" / "3 小时前" / 昨天 / 前天 / 1周前
 * 解析不出返回 ''（由调用方决定是否丢弃）。
 */
const RELATIVE = [
  { re: /(\d{1,4})\s*(秒|秒钟)/, mult: 1000 },
  { re: /(\d{1,4})\s*分(钟)?/, mult: 60000 },
  { re: /(\d{1,4})\s*(小时|个小时|h)/i, mult: 3600000 },
  { re: /(\d{1,4})\s*(天|日|天之前|天前|d)/i, mult: 86400000 },
  { re: /(\d{1,3})\s*(周|星期|weeks?)/i, mult: 7 * 86400000 },
  { re: /(\d{1,3})\s*(个?月|months?)/i, mult: 30 * 86400000 },
  { re: /(\d{1,3})\s*(年|years?)/i, mult: 365 * 86400000 },
];

export function parseCnDate(text, nowMs = Date.now()) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (!s) return '';

  // 绝对日期：2026年8月13日 / 2026-08-13 / 2026/3/1
  // 统一按 UTC 零点解析：搜索结果只给到"日"，用 UTC 可保证跨时区部署结果确定
  const abs = /(?:^|[^0-9])(20[2-4]\d)\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})/.exec(s);
  if (abs) {
    const d = new Date(Date.UTC(Number(abs[1]), Number(abs[2]) - 1, Number(abs[3])));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const ym = /(?:^|[^0-9])(20[2-4]\d)[-/.](\d{1,2})(?![-.\d])/.exec(s);
  if (ym) {
    const d = new Date(Date.UTC(Number(ym[1]), Number(ym[2]) - 1, 1));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  // 中文相对日
  if (/前天/.test(s)) return new Date(nowMs - 2 * 86400000).toISOString();
  if (/昨天|昨日/.test(s)) return new Date(nowMs - 86400000).toISOString();
  if (/今天|今日|刚刚/.test(s)) return new Date(nowMs).toISOString();

  // 数字相对时间
  for (const { re, mult } of RELATIVE) {
    const m = re.exec(s);
    if (m) return new Date(nowMs - Number(m[1]) * mult).toISOString();
  }

  // 兜底：标准可解析串
  const t = Date.parse(s);
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
}

export default parseCnDate;
