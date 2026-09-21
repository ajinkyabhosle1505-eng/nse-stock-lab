/** P1b — simple SVG sparkline from daily closes. */

export default function Sparkline({
  closes,
  height = 56,
  className = "",
}: {
  closes?: number[] | null;
  height?: number;
  className?: string;
}) {
  if (!closes || closes.length < 2) {
    return (
      <p className="text-xs text-slate-500">No sparkline data.</p>
    );
  }
  const w = 320;
  const h = height;
  const pad = 4;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const pts = closes
    .map((c, i) => {
      const x = pad + (i / (closes.length - 1)) * (w - pad * 2);
      const y = pad + (1 - (c - min) / span) * (h - pad * 2);
      return `${x},${y}`;
    })
    .join(" ");
  const up = closes[closes.length - 1] >= closes[0];
  const stroke = up ? "#34d399" : "#fb7185";

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={`w-full ${className}`}
      role="img"
      aria-label="30-day price sparkline"
    >
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={pts}
      />
    </svg>
  );
}
