/** P1b — SVG sparkline from daily closes; optional plan level overlays. */

export default function Sparkline({
  closes,
  height = 56,
  className = "",
  entry,
  sl,
  targets,
}: {
  closes?: number[] | null;
  height?: number;
  className?: string;
  entry?: number | null;
  sl?: number | null;
  targets?: number[] | null;
}) {
  if (!closes || closes.length < 2) {
    return <p className="text-xs text-slate-500">No sparkline data.</p>;
  }
  const w = 320;
  const h = height;
  const pad = 4;
  const levelPrices = [
    ...(entry != null ? [entry] : []),
    ...(sl != null ? [sl] : []),
    ...((targets || []).filter((t) => t != null) as number[]),
  ];
  const min = Math.min(...closes, ...levelPrices);
  const max = Math.max(...closes, ...levelPrices);
  const span = max - min || 1;
  const yOf = (c: number) => pad + (1 - (c - min) / span) * (h - pad * 2);
  const pts = closes
    .map((c, i) => {
      const x = pad + (i / (closes.length - 1)) * (w - pad * 2);
      const y = yOf(c);
      return `${x},${y}`;
    })
    .join(" ");
  const up = closes[closes.length - 1] >= closes[0];
  const stroke = up ? "#34d399" : "#fb7185";

  const markers: { label: string; price: number; color: string }[] = [];
  if (sl != null) markers.push({ label: "SL", price: sl, color: "#fb7185" });
  if (entry != null)
    markers.push({ label: "Entry", price: entry, color: "#38bdf8" });
  (targets || []).forEach((t, i) => {
    if (t != null)
      markers.push({ label: `T${i + 1}`, price: t, color: "#34d399" });
  });

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={`w-full ${className}`}
      role="img"
      aria-label="Price sparkline with plan levels"
    >
      {markers.map((m) => {
        const y = yOf(m.price);
        return (
          <g key={`${m.label}-${m.price}`}>
            <line
              x1={pad}
              x2={w - pad}
              y1={y}
              y2={y}
              stroke={m.color}
              strokeWidth="1"
              strokeDasharray="3 3"
              opacity={0.7}
            />
            <text
              x={w - pad}
              y={y - 2}
              textAnchor="end"
              fill={m.color}
              fontSize="8"
              fontFamily="system-ui,sans-serif"
            >
              {m.label}
            </text>
          </g>
        );
      })}
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
