import cron from 'node-cron';
import { config } from './config.js';
import { getSetting } from './db.js';
import { runPipeline } from './pipeline.js';
import { publish } from './notify/sse.js';

let currentTask = null;
let currentExpr = null;
let lastScan = null; // { startedAt, finishedAt, stats, ok }
let running = false;

/** 执行一轮扫描（互斥：同一时刻只跑一轮） */
export async function runScan(trigger = 'manual') {
  if (running) return { skipped: true, reason: 'scan already running' };
  running = true;
  publish('scan', { state: 'start', trigger, at: new Date().toISOString() });
  try {
    lastScan = { trigger, ...(await runPipeline()) };
    publish('scan', { state: 'end', trigger, ok: lastScan.ok, stats: lastScan.stats, at: new Date().toISOString() });
    return lastScan;
  } catch (e) {
    lastScan = { trigger, startedAt: new Date().toISOString(), ok: false, error: String(e.message || e) };
    publish('scan', { state: 'end', trigger, ok: false, error: lastScan.error, at: new Date().toISOString() });
    return lastScan;
  } finally {
    running = false;
  }
}

export function isScanning() {
  return running;
}

export function scheduleInfo() {
  return {
    cron: getSetting('scanCron', config.scanCron),
    lastScan,
    nextRunAt: currentTask ? nextRunTime() : null,
  };
}

// node-cron 不直接暴露下次执行时间，用简单推算
function nextRunTime() {
  const expr = getSetting('scanCron', config.scanCron);
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(expr);
  if (m) {
    const step = Number(m[1]) * 60000;
    const now = Date.now();
    return new Date(Math.ceil(now / step) * step).toISOString();
  }
  return null;
}

export function initScheduler() {
  const schedule = () => getSetting('scanCron', config.scanCron);
  const apply = () => {
    const expr = schedule();
    if (!cron.validate(expr)) {
      console.warn(`[cron] 非法表达式: ${expr}`);
      return;
    }
    currentTask?.stop();
    currentTask = cron.schedule(expr, () => runScan('cron').catch(console.error));
    currentExpr = expr;
    console.log(`[cron] 扫描计划: ${expr}`);
  };
  apply();
  // 每 60s 检查一次设置是否变更（简单可靠）
  setInterval(() => {
    if (schedule() !== currentExpr) apply();
  }, 60000).unref();
}
