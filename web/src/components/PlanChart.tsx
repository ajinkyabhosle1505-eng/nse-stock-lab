import { inr } from "@/lib/format";

/** P1b — horizontal plan ladder: SL · Entry · Targets. */
export default function PlanChart({
  entry,
  sl,
  targets,
}: {
  entry?: number | null;
  sl?: number | null;
  targets?: number[] | null;
}) {
  const levels: { label: string; price: number; color: string }[] = [];
  if (sl != null) levels.push({ label: "Stop", price: sl, color: "#fb7185" });
  if (entry != null)
    levels.push({ label: "Entry", price: entry, color: "#38bdf8" });
  for (let i = 0; i < (targets?.length || 0); i++) {
    levels.push({
      label: `T${i + 1}`,
      price: targets![i],
      color: "#34d399",
    });
  }
  if (levels.length < 2) {
    return <p className="text-xs text-slate-500">Plan levels incomplete.</p>;
  }
  const prices = levels.map((l) => l.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const w = 320;
  const h = 72;
  const pad = 16;

  return (
    <div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full"
        role="img"
        aria-label="Plan price ladder"
      >
        <line
          x1={pad}
          x2={w - pad}
          y1={h / 2}
          y2={h / 2}
          stroke="#334155"
          strokeWidth="2"
        />
        {levels.map((l) => {
          const x = pad + ((l.price - min) / span) * (w - pad * 2);
          return (
            <g key={`${l.label}-${l.price}`}>
              <circle cx={x} cy={h / 2} r={5} fill={l.color} />
              <text
                x={x}
                y={h / 2 - 12}
                textAnchor="middle"
                fill={l.color}
                fontSize="10"
                fontFamily="system-ui,sans-serif"
              >
                {l.label}
              </text>
              <text
                x={x}
                y={h / 2 + 18}
                textAnchor="middle"
                fill="#94a3b8"
                fontSize="9"
                fontFamily="system-ui,sans-serif"
              >
                {inr(l.price)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
