import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribe, fmtAgo } from './lib/api.js';
import Radar from './pages/Radar.jsx';
import Watch from './pages/Watch.jsx';
import Settings from './pages/Settings.jsx';
import NoticeDrawer from './components/NoticeDrawer.jsx';
import TopicModal from './components/TopicModal.jsx';

const TABS = [
  { id: 'radar', label: 'RADAR 雷达' },
  { id: 'watch', label: 'WATCH 盯梢' },
  { id: 'settings', label: 'CONFIG 设置' },
];

function routeFromHash() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('watch')) return { tab: 'watch' };
  if (h.startsWith('settings')) return { tab: 'settings' };
  const m = /^topic\/(\d+)$/.exec(h);
  if (m) return { tab: 'radar', topicId: Number(m[1]) };
  return { tab: 'radar' };
}

export default function App() {
  const [route, setRoute] = useState(routeFromHash);
  const [notices, setNotices] = useState({ unread: 0, rows: [] });
  const [drawer, setDrawer] = useState(false);
  const [toast, setToast] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanInfo, setScanInfo] = useState(null);
  const [topicModal, setTopicModal] = useState(null);
  const [pollTick, setPollTick] = useState(0);
  const [sse, setSse] = useState('open');
  const toastTimer = useRef();

  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => {
    const on = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const go = useCallback((path) => {
    location.hash = path;
  }, []);

  const refreshNotices = useCallback(() => {
    api.notices().then(setNotices).catch(() => {});
  }, []);

  // SSE 重连成功后对齐一次通知，避免断线期间漏掉的未读
  const setNoticesFresh = useCallback(() => {
    api.notices().then(setNotices).catch(() => {});
  }, []);

  useEffect(() => {
    refreshNotices();
  }, [refreshNotices]);

  // SSE 不可靠时（retrying/closed）每 30s 兜底拉取通知
  useEffect(() => {
    if (sse === 'open') return;
    const t = setInterval(refreshNotices, 30000);
    return () => clearInterval(t);
  }, [sse, refreshNotices]);

  const refreshScan = useCallback(() => {
    api
      .scanStatus()
      .then((s) => {
        setScanning(Boolean(s.running));
        setScanInfo(s);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshScan();
    const t = setInterval(() => {
      api
        .scanStatus()
        .then((s) => {
          setScanning(Boolean(s.running));
          setScanInfo((prev) => {
            // 兜底：SSE 丢失时靠轮询发现新扫描结束，同样触发页面数据刷新
            const prevId = prev?.recent?.[0]?.id;
            const curId = s.recent?.[0]?.id;
            if (curId !== undefined && curId !== prevId) setPollTick((x) => x + 1);
            return s;
          });
        })
        .catch(() => {});
    }, 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const close = subscribe(
      (n) => {
        setNotices((prev) => ({ unread: prev.unread + 1, rows: [n, ...prev.rows] }));
        showToast(`📡 ${n.title}`);
      },
      (ev) => {
        if (ev.state === 'start') {
          setScanning(true);
        } else {
          setScanning(false);
          refreshScan();
          setPollTick((x) => x + 1);
          if (ev.ok) {
            const a = ev.stats?.ai || {};
            showToast(
              a.skipped
                ? `扫描完成 · 新增 ${ev.stats?.inserted ?? 0} 条`
                : `扫描完成 · 新增 ${ev.stats?.inserted ?? 0} · 命中 ${a.hits ?? 0} · 话题 ${a.topics ?? 0}`
            );
          } else showToast(`扫描异常：${ev.error || '未知错误'}`);
        }
      },
      (status) => {
        setSse(status);
        if (status === 'retrying') showToast('⚠ 实时连接断开，降级为轮询模式');
        if (status === 'open') setNoticesFresh();
      }
    );
    return close;
  }, [showToast, refreshScan]);

  const openTopic = useCallback((id) => go(`topic/${id}`), [go]);
  useEffect(() => {
    setTopicModal(route.topicId || null);
  }, [route.topicId]);

  const runScan = useCallback(async () => {
    try {
      await api.runScan();
      setScanning(true);
      showToast('扫描已启动…');
    } catch (e) {
      showToast(`启动失败：${e.message}`);
    }
  }, [showToast]);

  return (
    <>
      <div className="bg-fx">
        <div className="bg-grid" />
        <div className="bg-scan" />
        <div className="bg-vig" />
      </div>

      <div className="shell">
        <header className="top">
          <div className="brand">
            <b>HOTPULSE</b>
            <span>AI 热点雷达</span>
          </div>
          <nav className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={route.tab === t.id ? 'on' : ''} onClick={() => go(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="top-right">
            <span className="status" title={scanInfo?.nextRunAt ? `下次扫描 ${new Date(scanInfo.nextRunAt).toLocaleTimeString()}` : ''}>
              <span className={`dot ${scanning ? 'busy pulsing' : 'ok'}`} />
              {scanning
                ? 'SCANNING'
                : scanInfo?.lastScan?.startedAt
                  ? `IDLE · ${fmtAgo(scanInfo.lastScan.startedAt)}`
                  : 'IDLE'}
            </span>
            <button className="btn sm" onClick={runScan} disabled={scanning}>
              {scanning ? '扫描中…' : '▶ 立即扫描'}
            </button>
            <button className="bell" onClick={() => setDrawer(true)} title="通知中心">
              🔔{notices.unread > 0 && <i>{notices.unread > 99 ? '99+' : notices.unread}</i>}
            </button>
          </div>
        </header>

        {route.tab === 'radar' && (
          <Radar scanning={scanning} scanInfo={scanInfo} pollTick={pollTick} onOpenTopic={openTopic} showToast={showToast} />
        )}
        {route.tab === 'watch' && <Watch pollTick={pollTick} scanning={scanning} showToast={showToast} />}
        {route.tab === 'settings' && <Settings refreshScan={refreshScan} showToast={showToast} />}
      </div>

      {drawer && (
        <NoticeDrawer
          notices={notices}
          onClose={() => setDrawer(false)}
          onRead={async (id) => {
            await api.readNotice(id);
            refreshNotices();
          }}
          onReadAll={async () => {
            await api.readAll();
            refreshNotices();
          }}
          onOpenTopic={(id) => {
            setDrawer(false);
            go(`topic/${id}`);
          }}
        />
      )}

      {topicModal && <TopicModal id={topicModal} onClose={() => go('radar')} />}

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
