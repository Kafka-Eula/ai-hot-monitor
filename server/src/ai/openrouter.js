import { config } from '../config.js';
import { getSetting } from '../db.js';

/**
 * OpenRouter 客户端（OpenAI 兼容 /chat/completions）。
 * 零成本策略：默认 :free 模型；429/402 触发熔断，10 分钟内不再调用，扫描降级继续。
 */
export class AiError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

let circuitOpenUntil = 0;
const CIRCUIT_MS = 10 * 60000;
/** 单模型限流冷却表 model -> untilTs */
const modelCooldown = new Map();
const MODEL_COOL_MS = 12 * 60000;

/** 主模型：设置页覆盖值优先，回退 .env */
function effectiveModel() {
  return String(getSetting('openrouter.model', '') || config.openrouter.model);
}

/** 备用链：设置页覆盖值优先（逗号分隔），回退 .env */
function effectiveFallbacks() {
  const raw = getSetting('openrouter.fallbackModels', '');
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(raw) && raw.length) return raw;
  return config.openrouter.fallbackModels || [];
}

/** 候选模型链：主模型 + 免费备胎（按序尝试） */
export function modelChain() {
  const chain = [effectiveModel(), ...effectiveFallbacks()];
  return [...new Set(chain.filter(Boolean))];
}

function availableModels() {
  const now = Date.now();
  return modelChain().filter((m) => (modelCooldown.get(m) || 0) <= now);
}

export function aiReady() {
  if (!config.openrouter.apiKey) return false;
  if (Date.now() < circuitOpenUntil) return false;
  return availableModels().length > 0;
}

export function aiStatus() {
  const now = Date.now();
  return {
    has_key: Boolean(config.openrouter.apiKey),
    model: effectiveModel(),
    chain: modelChain(),
    available: availableModels(),
    cooling: Object.fromEntries(
      [...modelCooldown.entries()].filter(([, t]) => t > now).map(([m, t]) => [m, new Date(t).toISOString()])
    ),
    circuit_open: now < circuitOpenUntil,
    circuit_until: circuitOpenUntil ? new Date(circuitOpenUntil).toISOString() : null,
  };
}

function tripCircuit(reason) {
  circuitOpenUntil = Date.now() + CIRCUIT_MS;
  console.warn(`[ai] 熔断 10 分钟（${reason}）`);
}

/** 推荐付费模型（便宜、质量高），供设置页下拉展示 */
const POPULAR_PAID = [
  'google/gemini-2.5-flash',
  'openai/gpt-4o-mini',
  'deepseek/deepseek-chat',
  'x-ai/grok-4-fast',
];

let modelsCache = null;
let modelsCacheAt = 0;

/** 拉取 OpenRouter 模型列表（公开端点），缓存 1 小时 */
export async function listModels() {
  if (modelsCache && Date.now() - modelsCacheAt < 3600e3) return modelsCache;
  const res = await fetch(`${config.openrouter.baseUrl}/models`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new AiError('http_' + res.status, `models HTTP ${res.status}`);
  const j = await res.json();
  const all = j.data || [];
  const toRow = (m) => ({
    id: m.id,
    name: m.name,
    ctx: m.context_length,
    prompt: m.pricing?.prompt,
    completion: m.pricing?.completion,
  });
  const isFree = (m) =>
    m.id.endsWith(':free') || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0);
  modelsCache = {
    free: all.filter(isFree).map(toRow).sort((a, b) => (b.ctx || 0) - (a.ctx || 0)),
    popular: all.filter((m) => POPULAR_PAID.includes(m.id)).map(toRow),
  };
  modelsCacheAt = Date.now();
  return modelsCache;
}

function coolModel(model, reason) {
  modelCooldown.set(model, Date.now() + MODEL_COOL_MS);
  console.warn(`[ai] 模型 ${model} 冷却 ${MODEL_COOL_MS / 60000} 分钟（${reason}），尝试切换备用模型`);
}

async function callOnce(body) {
  const res = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openrouter.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:4117',
      'X-Title': 'HotPulse',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  }).catch((e) => {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new AiError('model_slow', `请求超时(60s): ${body.model}`);
    }
    throw e;
  });
  if (!res.ok) {
    const txt = (await res.text().catch(() => '')).slice(0, 300);
    if (res.status === 402) throw new AiError('no_credit', `余额不足: ${txt}`);
    if (res.status === 429) throw new AiError('rate_limited', `限流: ${txt}`);
    if (res.status >= 500) throw new AiError('model_slow', `上游错误 HTTP ${res.status}`);
    throw new AiError('http_' + res.status, `HTTP ${res.status}: ${txt}`);
  }
  return res.json();
}

function extractJson(text) {
  if (!text) throw new AiError('empty', 'AI 返回为空');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(raw);
  } catch {
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(raw.slice(s, e + 1));
      } catch {
        /* fallthrough */
      }
    }
    throw new AiError('bad_json', 'AI 输出不是合法 JSON');
  }
}

/**
 * 要求模型返回符合 schema 的 JSON（Structured Outputs）。
 * 模型链轮询：主模型 429 → 冷却并切换 fallback；每模型内部三级
 * response_format 降级（json_schema → json_object → 纯提示词）。
 */
export async function chatJSON({ system, user, schema, name = 'output', model }) {
  if (!config.openrouter.apiKey) throw new AiError('no_key', '未配置 OPENROUTER_API_KEY');
  if (Date.now() < circuitOpenUntil) throw new AiError('circuit', 'AI 熔断中，本轮跳过');

  const models = model ? [model, ...modelChain().filter((m) => m !== model)] : availableModels();
  if (!models.length) throw new AiError('all_cooling', '所有模型冷却中，本轮跳过');

  let lastErr;
  for (const m of models) {
    if (!model && (modelCooldown.get(m) || 0) > Date.now()) continue; // 指定 model 时不过滤
    const base = {
      model: m,
      temperature: 0.1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    const attempts = [
      { ...base, response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } } },
      { ...base, response_format: { type: 'json_object' } },
      { ...base }, // 部分免费模型不支持 response_format：纯提示词约束 + 容错解析
    ];
    for (let i = 0; i < attempts.length; i++) {
      try {
        const j = await callOnce(attempts[i]);
        const content = j?.choices?.[0]?.message?.content;
        return { data: extractJson(content), usage: j?.usage || {}, model: m };
      } catch (e) {
        lastErr = e;
        if (e.code === 'no_credit') {
          tripCircuit('no_credit');
          throw e;
        }
        if (e.code === 'rate_limited' || e.code === 'model_slow') {
          coolModel(m, e.code);
          break; // 模型本身不可用：冷却并切换，不做格式降级
        }
        if (i < attempts.length - 1) {
          console.warn(`[ai] ${m} 格式不支持(${e.code || e.message})，降级重试`);
        }
      }
    }
  }
  throw lastErr || new AiError('no_model', '无可用模型');
}
