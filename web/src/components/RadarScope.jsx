import { useEffect, useRef } from 'react';

const SRC_COLOR = {
  hn: '#ff8a3d',
  gh_trending: '#8ab4ff',
  hf_papers: '#c58bff',
  blog: '#3ef2a5',
  web_search: '#ffd166',
  twitter: '#e8e8e8',
};

/**
 * 雷达盘：极坐标 = 角度(来源) × 半径(时间)，光点 = 近期条目，扫描线随扫描状态加速。
 */
export default function RadarScope({ items, scanning, sources }) {
  const ref = useRef(null);
  const dataRef = useRef({ items: [], scanning: false, sources: [] });
  dataRef.current = { items, scanning, sources };
  const angleRef = useRef(0);

  useEffect(() => {
    const cvs = ref.current;
    const ctx = cvs.getContext('2d');
    let raf;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const r = cvs.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cvs.width = r.width * dpr;
      cvs.height = r.height * dpr;
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = () => {
      const { items, scanning, sources } = dataRef.current;
      const W = cvs.width;
      const H = cvs.height;
      const cx = W / 2;
      const cy = H / 2;
      const R = Math.min(W, H) / 2 - 10 * dpr;
      const now = Date.now();
      const SPAN = 6 * 3600e3; // 显示近 6 小时

      ctx.clearRect(0, 0, W, H);

      // 同心环
      ctx.strokeStyle = 'rgba(34,52,79,0.85)';
      ctx.lineWidth = 1 * dpr;
      for (let i = 1; i <= 4; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, (R * i) / 4, 0, Math.PI * 2);
        ctx.globalAlpha = 0.5 + i * 0.12;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // 来源射线 + 标签
      const list = sources.length ? sources : [];
      const n = Math.max(list.length, 1);
      ctx.font = `${10 * dpr}px ui-monospace, Consolas, monospace`;
      list.forEach((s, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        ctx.strokeStyle = 'rgba(22,35,58,0.9)';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        ctx.stroke();
        ctx.fillStyle = SRC_COLOR[s.source] || '#61748f';
        ctx.globalAlpha = 0.75;
        const lx = cx + Math.cos(a) * (R + 4 * dpr);
        const ly = cy + Math.sin(a) * (R + 4 * dpr);
        ctx.textAlign = Math.cos(a) > 0.2 ? 'left' : Math.cos(a) < -0.2 ? 'right' : 'center';
        ctx.textBaseline = Math.sin(a) > 0.5 ? 'top' : Math.sin(a) < -0.5 ? 'bottom' : 'middle';
        ctx.fillText(s.source, lx, ly);
        ctx.globalAlpha = 1;
      });

      // 条目光点（按来源分扇区，半径=新近度）
      const bySrc = new Map();
      list.forEach((s, i) => bySrc.set(s.source, i));
      for (const it of items) {
        const t = Date.parse(it.collected_at || it.published_at);
        if (!t || now - t > SPAN) continue;
        const si = bySrc.has(it.source) ? bySrc.get(it.source) : Math.floor(Math.random() * n);
        const sector = (si / n) * Math.PI * 2 - Math.PI / 2;
        const jitter = ((hash(it.id) % 100) / 100 - 0.5) * ((Math.PI * 2) / n) * 0.72;
        const a = sector + jitter;
        const rr = (1 - (now - t) / SPAN) * R * 0.92 + R * 0.06;
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        const col = SRC_COLOR[it.source] || '#3ef2a5';
        const age = (now - t) / SPAN;
        const alpha = 0.28 + (1 - age) * 0.62;
        const rad = (1.6 + (1 - age) * 2.6) * dpr;

        const g = ctx.createRadialGradient(x, y, 0, x, y, rad * 3.2);
        g.addColorStop(0, hexA(col, alpha));
        g.addColorStop(1, hexA(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, rad * 3.2, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = hexA(col, Math.min(1, alpha + 0.25));
        ctx.beginPath();
        ctx.arc(x, y, rad * 0.62, 0, Math.PI * 2);
        ctx.fill();
      }

      // 扫描线
      angleRef.current += (scanning ? 0.045 : 0.012);
      const sa = angleRef.current - Math.PI / 2;
      const sg = ctx.createConicGradient
        ? (() => {
            const gr = ctx.createConicGradient(sa, cx, cy);
            gr.addColorStop(0, hexA('#3ef2a5', 0.32));
            gr.addColorStop(0.12, hexA('#3ef2a5', 0));
            gr.addColorStop(1, hexA('#3ef2a5', 0));
            return gr;
          })()
        : null;
      if (sg) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = sg;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
      const grad = ctx.createLinearGradient(cx, cy, cx + Math.cos(sa) * R, cy + Math.sin(sa) * R);
      grad.addColorStop(0, hexA('#3ef2a5', 0.15));
      grad.addColorStop(1, hexA('#3ef2a5', 0.85));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.6 * dpr;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(sa) * R, cy + Math.sin(sa) * R);
      ctx.stroke();

      // 中心
      ctx.fillStyle = '#3ef2a5';
      ctx.shadowColor = '#3ef2a5';
      ctx.shadowBlur = 10 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, 2.4 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={ref} className="radar" />;
}

function hash(n) {
  const x = Math.sin(Number(n) * 12.9898) * 43758.5453;
  return Math.abs(Math.floor(x * 1000));
}

function hexA(hex, a) {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
