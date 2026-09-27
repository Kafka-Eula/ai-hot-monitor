/**
 * SSE 实时推送：/api/events
 * 任何模块可调用 publish(event, data) 向所有在线页面广播。
 */
let clients = new Set();

export function initSse(app) {
  // 在 /api 之前挂载，处理 /api/events
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: hello\ndata: {"ok":true}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });
}

/** 心跳，防止代理断连 */
setInterval(() => {
  for (const res of clients) {
    try {
      res.write(': ping\n\n');
    } catch {
      clients.delete(res);
    }
  }
}, 25000).unref();

export function publish(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

export function sseMiddleware(req, res, next) {
  next();
}

export default { initSse, publish };
