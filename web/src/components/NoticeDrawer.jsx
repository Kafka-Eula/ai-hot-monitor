import { fmtAgo } from '../lib/api.js';

const KIND_LABEL = { keyword_hit: 'HIT', hot_topic: 'HOT', system: 'SYS', daily_digest: 'DIGEST' };

export default function NoticeDrawer({ notices, onClose, onRead, onReadAll, onOpenTopic }) {
  const open = (n) => {
    if (!n.read) onRead(n.id);
    const m = /^\/topic\/(\d+)$/.exec(n.link || '');
    if (m) return onOpenTopic(Number(m[1]));
    if (n.link && /^https?:/.test(n.link)) window.open(n.link, '_blank');
    onClose();
  };
  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-h">
          <h3>NOTICE CENTER · 通知中心</h3>
          <div className="row2">
            <button className="btn ghost sm" onClick={onReadAll}>全部已读</button>
            <button className="btn ghost sm" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="drawer-b">
          {!notices.rows.length && <div className="empty">暂无通知</div>}
          {notices.rows.map((n) => (
            <div key={n.id} className={`nt ${n.read ? '' : 'un'}`} onClick={() => open(n)}>
              <b>
                <span className={`kind ${n.kind}`}>{KIND_LABEL[n.kind] || 'SYS'}</span>
                {n.title}
              </b>
              {n.body && <p>{n.body}</p>}
              <time>{fmtAgo(n.created_at)}</time>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
