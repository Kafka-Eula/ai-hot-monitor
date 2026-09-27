import '../src/config.js';
const { runPipeline } = await import('../src/pipeline.js');
const db = (await import('../src/db.js')).default;

const r = await runPipeline();
console.log('scan stats:', JSON.stringify(r.stats, null, 1));
console.log(
  'items in db:',
  db.prepare('SELECT COUNT(*) c FROM items').get().c
);
console.log(
  'by source:',
  JSON.stringify(db.prepare('SELECT source, COUNT(*) c FROM items GROUP BY source').all())
);
process.exit(0);
