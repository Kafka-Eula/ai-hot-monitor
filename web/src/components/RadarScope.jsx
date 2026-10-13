import { useEffect, useRef, useState } from 'react';
import { SOURCE_LABEL } from '../lib/api.js';

export const SRC_COLOR = {
  hn: '#fb923c',
  gh_trending: '#38bdf8',
  gh_search: '#0ea5e9',
  hf_papers: '#a78bfa',
  blog: '#34d399',
  web_search: '#fbbf24',
  news_search: '#f472b6',
  cn_search: '#facc15',
  cn_media: '#ef4444',
  lobsters: '#c084fc',
  reddit: '#ff4500',
  twitter: '#e879f9',
};

const ACCENT = '#22D3EE'; // 主强调：青电光

const SPAN = 6 * 3600e3; // 雷达时间窗口：近 6 小时（圆心=最新，外圈=6 小时前）

/**
 * 雷达盘：角度=信息源扇区，半径=时间，光点=一条内容。
 * 带时间刻度环、来源中文标签、悬停提示、点击打开原文。
 */
export default function RadarScope({ items, scanning, sources }) {
  const ref = useRef(null);
  const dataRef = useRef({ items: [], scanning: false, sources: [] });
  dataRef.current = { items, scanning, sources };
  const angleRef = useRef(0);
  const dotsRef = useRef([]); // CSS 像素坐标，用于命中检测
  const hoverRef = useRef(-1); // 当前悬停光点索引
  const [tip, setTip] = useState(null); // {x,y,item}

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
      const R = Math.min(W, H) / 2 - 46 * dpr; // 预留边距：水平方向的来源标签不再被裁切
      const now = Date.now();

      ctx.clearRect(0, 0, W, H);

      // 同心环 + 时间刻度（圆心=最新 → 外圈=6小时前；沿右上方 45° 标注，避开水平来源标签）
      ctx.strokeStyle = 'rgba(34,52,79,0.85)';
      ctx.lineWidth = 1 * dpr;
      const timeLabels = ['1.5h', '3h', '4.5h', '6h前'];
      const ta = -Math.PI / 4;
      for (let i = 1; i <= 4; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, (R * i) / 4, 0, Math.PI * 2);
        ctx.globalAlpha = 0.5 + i * 0.12;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.font = `${9 * dpr}px ui-monospace, Consolas, monospace`;
        const lx = cx + Math.cos(ta) * ((R * i) / 4 + 4 * dpr);
        const ly = cy + Math.sin(ta) * ((R * i) / 4 + 4 * dpr);
        const tw = ctx.measureText(timeLabels[i - 1]).width;
        ctx.fillStyle = 'rgba(4,6,12,0.82)'; // 暗色衬底防重叠
        ctx.fillRect(lx - 2 * dpr, ly - 6.5 * dpr, tw + 4 * dpr, 13 * dpr);
        ctx.fillStyle = '#5d7089';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(timeLabels[i - 1], lx, ly);
      }
      // 中心"现在"标记
      ctx.fillStyle = '#4a5d78';
      ctx.textAlign = 'center';
      ctx.fillText('现在', cx, cy - 10 * dpr);

      // 来源射线（标签最后画，避免被光点遮挡）
      const list = sources.length ? sources : [];
      const n = Math.max(list.length, 1);
      const counts = {};
      for (const it of items) counts[it.source] = (counts[it.source] || 0) + 1;
      list.forEach((s, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        ctx.strokeStyle = 'rgba(22,35,58,0.9)';
        ctx.lineWidth = 1 * dpr;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        ctx.stroke();
      });

      // 条目光点（半径=时间新旧，越靠中心越新）
      const bySrc = new Map();
      list.forEach((s, i) => bySrc.set(s.source, i));
      const dots = [];
      for (const it of items) {
        const t = Date.parse(it.collected_at || it.published_at);
        if (!t || now - t > SPAN) continue;
        const si = bySrc.has(it.source) ? bySrc.get(it.source) : Math.floor(Math.random() * n);
        const sector = (si / n) * Math.PI * 2 - Math.PI / 2;
        const jitter = ((hash(it.id) % 100) / 100 - 0.5) * ((Math.PI * 2) / n) * 0.72;
        const a = sector + jitter;
        const age = (now - t) / SPAN; // 0=最新 1=6小时前
        const jr = ((hash(it.id + 7) % 100) / 100 - 0.5) * 0.1; // 径向抖动，减少中心堆积
        const rr = R * (0.1 + Math.min(0.88, age + jr));
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        const col = SRC_COLOR[it.source] || '#22d3ee';
        const alpha = 0.28 + (1 - age) * 0.62;
        const rad = (1.6 + (1 - age) * 2.6) * dpr;

        const g = ctx.createRadialGradient(x, y, 0, x, y, rad * 1.5);
        g.addColorStop(0, hexA(col, alpha * 0.7));
        g.addColorStop(1, hexA(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, rad * 1.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = hexA(col, Math.min(1, alpha + 0.25));
        ctx.beginPath();
        ctx.arc(x, y, rad * 0.62, 0, Math.PI * 2);
        ctx.fill();

        dots.push({ x: x / dpr, y: y / dpr, item: it, col });
      }
      dotsRef.current = dots;

      // 悬停高亮
      const hi = hoverRef.current;
      if (hi >= 0 && dots[hi]) {
        const d = dots[hi];
        ctx.strokeStyle = d.col;
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        ctx.arc(d.x * dpr, d.y * dpr, 8 * dpr, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 扫描线
      angleRef.current += (scanning ? 0.045 : 0.012);
      const sa = angleRef.current - Math.PI / 2;
      const sg = ctx.createConicGradient
        ? (() => {
            const gr = ctx.createConicGradient(sa, cx, cy);
            gr.addColorStop(0, hexA('#22d3ee', 0.12));
            gr.addColorStop(0.1, hexA('#22d3ee', 0));
            gr.addColorStop(1, hexA('#22d3ee', 0));
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
      grad.addColorStop(0, hexA('#22d3ee', 0.08));
      grad.addColorStop(1, hexA('#22d3ee', 0.4));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.4 * dpr;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(sa) * R, cy + Math.sin(sa) * R);
      ctx.stroke();

      // 中心
      ctx.fillStyle = '#22d3ee';
      ctx.shadowColor = '#22d3ee';
      ctx.shadowBlur = 10 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, 2.4 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // 来源标签（最上层绘制，带衬底防遮挡）
      ctx.font = `${10 * dpr}px ui-monospace, Consolas, "Microsoft YaHei", monospace`;
      list.forEach((s, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        const col = SRC_COLOR[s.source] || '#61748f';
        const label = `${SOURCE_LABEL[s.source] || s.source} ${counts[s.source] || 0}`;
        const horiz = Math.abs(Math.cos(a)) > 0.35;
        const lr = horiz ? R - 12 * dpr : R + 14 * dpr; // 水平→圆内，竖直→圆外
        const lx = cx + Math.cos(a) * lr;
        const ly = cy + Math.sin(a) * lr;
        ctx.textAlign = horiz ? (Math.cos(a) > 0 ? 'right' : 'left') : 'center';
        ctx.textBaseline = Math.sin(a) > 0.5 ? 'top' : Math.sin(a) < -0.5 ? 'bottom' : 'middle';
        const tw = ctx.measureText(label).width;
        const bx = ctx.textAlign === 'right' ? lx - tw : ctx.textAlign === 'left' ? lx : lx - tw / 2;
        const by = ctx.textBaseline === 'top' ? ly : ctx.textBaseline === 'bottom' ? ly - 14 * dpr : ly - 7 * dpr;
        ctx.fillStyle = 'rgba(4,6,12,0.88)';
        ctx.fillRect(bx - 3 * dpr, by, tw + 6 * dpr, 14 * dpr);
        ctx.fillStyle = col;
        ctx.fillText(label, lx, ly);
      });

      // 时间刻度文字（最上层，沿右上方 45°，带衬底）
      ctx.font = `${9 * dpr}px ui-monospace, Consolas, monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let i = 1; i <= 4; i++) {
        const lx = cx + Math.cos(ta) * ((R * i) / 4 + 4 * dpr);
        const ly = cy + Math.sin(ta) * ((R * i) / 4 + 4 * dpr);
        const tw = ctx.measureText(timeLabels[i - 1]).width;
        ctx.fillStyle = 'rgba(4,6,12,0.85)';
        ctx.fillRect(lx - 2 * dpr, ly - 6.5 * dpr, tw + 4 * dpr, 13 * dpr);
        ctx.fillStyle = '#6b7f99';
        ctx.fillText(timeLabels[i - 1], lx, ly);
      }

      raf = requestAnimationFrame(draw);
    };
    draw();

    const findDot = (mx, my) => {
      const dots = dotsRef.current;
      let best = -1;
      let bd = 16; // 命中半径 16px，更易悬停
      for (let i = 0; i < dots.length; i++) {
        const d = Math.hypot(dots[i].x - mx, dots[i].y - my);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    };
    const onMove = (e) => {
      const r = cvs.getBoundingClientRect();
      const i = findDot(e.clientX - r.left, e.clientY - r.top);
      hoverRef.current = i;
      if (i >= 0) {
        const d = dotsRef.current[i];
        setTip({ x: d.x, y: d.y, item: d.item, col: d.col });
        cvs.style.cursor = 'pointer';
      } else {
        setTip(null);
        cvs.style.cursor = 'default';
      }
    };
    const onLeave = () => {
      hoverRef.current = -1;
      setTip(null);
    };
    const onClick = (e) => {
      const r = cvs.getBoundingClientRect();
      const i = findDot(e.clientX - r.left, e.clientY - r.top);
      if (i >= 0 && dotsRef.current[i].item.url) window.open(dotsRef.current[i].item.url, '_blank');
    };
    cvs.addEventListener('mousemove', onMove);
    cvs.addEventListener('mouseleave', onLeave);
    cvs.addEventListener('click', onClick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      cvs.removeEventListener('mousemove', onMove);
      cvs.removeEventListener('mouseleave', onLeave);
      cvs.removeEventListener('click', onClick);
    };
  }, []);

  return (
    <>
      <canvas ref={ref} className="radar" />
      {tip && (
        <div
          className="radar-tip"
          style={{
            left: Math.min(tip.x + 14, 999),
            top: tip.y - 10,
            borderColor: tip.col,
          }}
        >
          <b>{tip.item.title}</b>
          <span>
            {SOURCE_LABEL[tip.item.source] || tip.item.source} · {agoShort(tip.item)}
            {tip.item.url ? ' · 点击查看原文' : ''}
          </span>
        </div>
      )}
    </>
  );
}

function agoShort(it) {
  const t = Date.parse(it.collected_at || it.published_at);
  if (!t) return '未知时间';
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  return `${(m / 60).toFixed(1)} 小时前`;
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
