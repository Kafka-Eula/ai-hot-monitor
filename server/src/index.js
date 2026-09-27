import express from 'express';
import { config } from './config.js';
import db, { getSetting, setSetting, allSettings } from './db.js';
import api from './routes/api.js';
import { initScheduler } from './scheduler.js';
import { initSse, sseMiddleware } from './notify/sse.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  req.app.locals.db = db;
  req.app.locals.getSetting = getSetting;
  req.app.locals.setSetting = setSetting;
  req.app.locals.allSettings = allSettings;
  next();
});

initSse(app);
app.use('/api', sseMiddleware, api);

// 静态前端（构建产物存在时托管）
app.use(express.static(config.webDist, { fallthrough: true }));
app.get(/^(?!\/api).*/, (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(config.webDist + '/index.html', (err) => {
    if (err) res.status(200).type('html').send('<pre>HotPulse server OK. 前端未构建：npm run dev 或 npm --workspace web run build</pre>');
  });
});

// 统一错误处理
app.use((err, req, res, next) => {
  console.error('[api-error]', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

const server = app.listen(config.port, () => {
  console.log(`[hotpulse] server on http://localhost:${config.port}`);
  initScheduler();
});
server.on('error', (e) => console.error('[server] listen error:', e.message));

// 优雅退出（规避 Node24 + better-sqlite3 退出析构断言）
let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`[hotpulse] ${sig}，正在退出...`);
  try {
    server.close();
    db.close(); // WAL 已 checkpoint 落盘
  } catch (e) {
    console.error(e);
  }
  // Node24 + better-sqlite3 正常退出会触发原生析构断言崩溃，直接硬退出绕开
  process.kill(process.pid, 'SIGKILL');
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => shutdown(sig));
}
