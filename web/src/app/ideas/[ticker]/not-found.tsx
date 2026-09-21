import Link from "next/link";

export default function NotFound() {
  return (
    <div className="space-y-3 py-10 text-center">
      <h1 className="text-xl font-semibold text-white">Ticker not found</h1>
      <p className="text-sm text-slate-400">No verdict for this symbol in the fixture set.</p>
      <Link href="/ideas" className="text-sm text-emerald-400 hover:underline">
        Back to ideas
      </Link>
    </div>
  );
}
