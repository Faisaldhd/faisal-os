/** Draws a faint-grid line chart of a numeric history onto a canvas, in theme colors. */
export function drawLineChart(
  canvas: HTMLCanvasElement,
  history: number[],
  opts: { max?: number; color: string; gridColor: string; fill?: string } = { color: '#E3B650', gridColor: 'rgba(255,255,255,.08)' },
): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // grid
  ctx.strokeStyle = opts.gridColor;
  ctx.lineWidth = 1;
  const rows = 4;
  for (let i = 0; i <= rows; i++) {
    const y = Math.round((h / rows) * i) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (history.length < 2) return;
  const max = opts.max ?? Math.max(1, ...history);
  const stepX = w / Math.max(1, history.length - 1);
  const points = history.map((v, i) => {
    const x = i * stepX;
    const y = h - (Math.min(v, max) / max) * h;
    return [x, y] as const;
  });

  if (opts.fill) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], h);
    for (const [x, y] of points) ctx.lineTo(x, y);
    ctx.lineTo(points[points.length - 1][0], h);
    ctx.closePath();
    ctx.fillStyle = opts.fill;
    ctx.fill();
  }

  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
  ctx.strokeStyle = opts.color;
  ctx.lineWidth = 1.75;
  ctx.lineJoin = 'round';
  ctx.stroke();
}
