/**
 * Step2 抓取层独立测试：node test/collectors.test.js
 * 逐源运行 collect，打印统计；验证 hash 去重。
 */
import '../src/config.js';
import { SOURCES } from '../src/collectors/index.js';
import { normItem } from '../src/collectors/normalize.js';

const ctx = {
  allQueries: ['GPT-6', 'Claude', 'AI 编程', 'Llama'],
  sinceIso: new Date(Date.now() - 24 * 3600000).toISOString(),
  windowStartMs: Date.now() - 24 * 3600000,
  log: (src, q, msg) => console.log(`  [${src}] ${q}: ${msg}`),
};

let total = 0;
for (const s of SOURCES) {
  const t0 = Date.now();
  console.log(`\n=== ${s.name} ===`);
  try {
    const items = (await s.fn(ctx)) || [];
    total += items.length;
    console.log(`  -> ${items.length} 条 (${Date.now() - t0}ms)`);
    for (const it of items.slice(0, 3)) {
      console.log(`   · [${it.source}] ${it.title.slice(0, 80)}`);
    }
  } catch (e) {
    console.log(`  !! 失败: ${e.message}`);
  }
}

// 去重验证
const a = normItem({ source: 'test', url: 'https://example.com/x', title: 'A' });
const b = normItem({ source: 'test', url: 'https://example.com/x', title: 'A changed' });
console.log(`\n=== 去重 hash ===`);
console.log(`同 URL hash 一致: ${a.raw_hash === b.raw_hash ? 'PASS' : 'FAIL'}`);
console.log(`\n总计: ${total} 条`);
