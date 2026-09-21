import VerdictCard from "@/components/VerdictCard";
import { getVerdicts } from "@/lib/data";
import { actionClass } from "@/lib/format";

export default async function IdeasPage() {
  const data = await getVerdicts();
  const verdicts = [...data.verdicts].sort((a, b) => {
    const order = { buy: 0, hold: 1, avoid: 2 } as Record<string, number>;
    const ao = order[a.action] ?? 9;
    const bo = order[b.action] ?? 9;
    if (ao !== bo) return ao - bo;
    return (b.confidence_1_10 || 0) - (a.confidence_1_10 || 0);
  });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-white">Ideas</h1>
        <p className="mt-1 text-sm text-slate-400">
          As of {data.as_of} · job {data.job_id}
        </p>
        {data.counts ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(data.counts).map(([k, v]) => (
              <span
                key={k}
                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${actionClass(
                  k
                )}`}
              >
                {k.replace(/_/g, " ")}: {v}
              </span>
            ))}
          </div>
        ) : null}
      </header>

      <div className="space-y-3">
        {verdicts.map((v) => (
          <VerdictCard key={v.ticker} v={v} />
        ))}
      </div>
    </div>
  );
}
