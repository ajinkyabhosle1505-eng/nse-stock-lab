/**
 * Official end-of-day files used ONLY to fill a missing / null Yahoo bar for the
 * report's `based_on_close` date (report_v3.1). Never intraday, never another date.
 *
 *   NSE equity  sec_bhavdata_full_DDMMYYYY.csv          → close_source "nse_bhavcopy"
 *   NSE equity  BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip (UDiFF) → "nse_bhavcopy"
 *   BSE equity  BhavCopy_BSE_CM_0_0_0_YYYYMMDD_F_0000.CSV (UDiFF)     → "bse_bhavcopy"
 *   NSE indices ind_close_all_DDMMYYYY.csv              → close_source "nse_index_close"
 *
 * Reachability (tested from the box 2026-10-06 with a browser UA + Referer): all four
 * returned 200. From Vercel it is untested, so every call fails soft (→ UNKNOWN stays).
 * Kill switch: BHAVCOPY_FALLBACK=0.
 *
 * One `BhavFetcher` per report build: each file is downloaded at most once per build
 * (lazy, memoised); nothing is cached across builds, so a retry re-downloads.
 */
import { inflateRawSync } from "node:zlib";

export type CloseSource = "yahoo" | "nse_bhavcopy" | "bse_bhavcopy" | "nse_index_close";

export interface BhavRow {
  symbol: string;
  series: string;
  date: string; // YYYY-MM-DD (from the file row, not the URL)
  open: number;
  high: number;
  low: number;
  close: number;
  prev_close: number | null;
  volume: number;
}

export interface IndexCloseRow {
  name: string;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  points_change: number | null;
}

interface EquityFile {
  ok: boolean;
  source: CloseSource;
  url: string;
  rows: Map<string, BhavRow>;
  error?: string;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const TIMEOUT_MS = 12_000;

export function bhavFallbackEnabled(): boolean {
  return process.env.BHAVCOPY_FALLBACK !== "0";
}

const ymd = (iso: string) => iso.replace(/-/g, "");
const dmy = (iso: string) => `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}`;

export const bhavUrls = (iso: string) => ({
  nse_full: `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${dmy(iso)}.csv`,
  nse_udiff: `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${ymd(iso)}_F_0000.csv.zip`,
  bse_udiff: `https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_${ymd(iso)}_F_0000.CSV`,
  nse_indices: `https://nsearchives.nseindia.com/content/indices/ind_close_all_${dmy(iso)}.csv`,
});

async function get(url: string, referer: string): Promise<{ ok: true; buf: Buffer } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "*/*", "Accept-Language": "en-US,en;q=0.9", Referer: referer },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, error: "empty" };
    return { ok: true, buf };
  } catch (e) {
    return { ok: false, error: e instanceof Error && /timeout|abort/i.test(e.name + e.message) ? "timeout" : "network" };
  }
}

const MON: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
/** "05-Oct-2026" | "05-10-2026" | "2026-10-05" → "2026-10-05" (null if unparseable). */
export function normDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m && MON[m[2].toUpperCase()]) return `${m[3]}-${MON[m[2].toUpperCase()]}-${m[1].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

const numOrNull = (s: string | undefined) => {
  if (s == null) return null;
  const t = s.trim();
  if (!t || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

function csvRows(text: string): string[][] {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.split(",").map((c) => c.trim()));
}

/** Parse NSE sec_bhavdata_full (SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, …). */
export function parseNseFull(text: string): BhavRow[] {
  const rows = csvRows(text);
  if (!rows.length) return [];
  const h = rows[0].map((x) => x.toUpperCase());
  const ix = (k: string) => h.indexOf(k);
  const [iS, iSe, iD, iP, iO, iH, iL, iC, iV] = ["SYMBOL", "SERIES", "DATE1", "PREV_CLOSE", "OPEN_PRICE", "HIGH_PRICE", "LOW_PRICE", "CLOSE_PRICE", "TTL_TRD_QNTY"].map(ix);
  if ([iS, iSe, iD, iO, iH, iL, iC].some((i) => i < 0)) return [];
  const out: BhavRow[] = [];
  for (const r of rows.slice(1)) {
    const date = normDate(r[iD] || "");
    const o = numOrNull(r[iO]), hi = numOrNull(r[iH]), lo = numOrNull(r[iL]), c = numOrNull(r[iC]);
    if (!date || o == null || hi == null || lo == null || c == null) continue;
    out.push({ symbol: r[iS], series: r[iSe], date, open: o, high: hi, low: lo, close: c, prev_close: iP >= 0 ? numOrNull(r[iP]) : null, volume: iV >= 0 ? numOrNull(r[iV]) ?? 0 : 0 });
  }
  return out;
}

/** Parse UDiFF CM bhavcopy (NSE or BSE): TradDt, TckrSymb, SctySrs, OpnPric, HghPric, LwPric, ClsPric, PrvsClsgPric, TtlTradgVol. */
export function parseUdiff(text: string): BhavRow[] {
  const rows = csvRows(text);
  if (!rows.length) return [];
  const h = rows[0];
  const ix = (k: string) => h.indexOf(k);
  const [iD, iS, iSe, iO, iH, iL, iC, iP, iV, iT] = ["TradDt", "TckrSymb", "SctySrs", "OpnPric", "HghPric", "LwPric", "ClsPric", "PrvsClsgPric", "TtlTradgVol", "FinInstrmTp"].map(ix);
  if ([iD, iS, iO, iH, iL, iC].some((i) => i < 0)) return [];
  const out: BhavRow[] = [];
  for (const r of rows.slice(1)) {
    if (iT >= 0 && r[iT] && r[iT] !== "STK") continue;
    const date = normDate(r[iD] || "");
    const o = numOrNull(r[iO]), hi = numOrNull(r[iH]), lo = numOrNull(r[iL]), c = numOrNull(r[iC]);
    if (!date || o == null || hi == null || lo == null || c == null) continue;
    out.push({ symbol: r[iS], series: iSe >= 0 ? r[iSe] : "", date, open: o, high: hi, low: lo, close: c, prev_close: iP >= 0 ? numOrNull(r[iP]) : null, volume: iV >= 0 ? numOrNull(r[iV]) ?? 0 : 0 });
  }
  return out;
}

/** Parse NSE ind_close_all (Index Name, Index Date, Open/High/Low/Closing Index Value, Points Change, …). */
export function parseIndexCloses(text: string): IndexCloseRow[] {
  const rows = csvRows(text);
  if (!rows.length) return [];
  const h = rows[0].map((x) => x.toLowerCase());
  const ix = (k: string) => h.indexOf(k);
  const [iN, iD, iO, iH, iL, iC, iP] = ["index name", "index date", "open index value", "high index value", "low index value", "closing index value", "points change"].map(ix);
  if ([iN, iD, iC].some((i) => i < 0)) return [];
  const out: IndexCloseRow[] = [];
  for (const r of rows.slice(1)) {
    const date = normDate(r[iD] || "");
    const c = numOrNull(r[iC]);
    if (!date || c == null) continue;
    out.push({ name: r[iN], date, open: numOrNull(r[iO]), high: numOrNull(r[iH]), low: numOrNull(r[iL]), close: c, points_change: iP >= 0 ? numOrNull(r[iP]) : null });
  }
  return out;
}

/** Minimal single-entry ZIP reader (stored or deflate) — enough for NSE's UDiFF zip. */
export function unzipFirst(buf: Buffer): Buffer | null {
  try {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const cd = buf.readUInt32LE(eocd + 16);
    if (buf.readUInt32LE(cd) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(cd + 10);
    const csize = buf.readUInt32LE(cd + 20);
    const lho = buf.readUInt32LE(cd + 42);
    if (buf.readUInt32LE(lho) !== 0x04034b50) return null;
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data);
    return null;
  } catch {
    return null;
  }
}

export interface BhavLookup {
  ok: boolean;
  row?: BhavRow;
  source?: CloseSource;
  url?: string;
  /** why nothing was used (per file tried) */
  tried: string[];
}

export class BhavFetcher {
  private eq = new Map<string, Promise<EquityFile>>();
  private idx = new Map<string, Promise<{ ok: boolean; url: string; rows: Map<string, IndexCloseRow>; error?: string }>>();
  /** every file fetched in this build (for lane stats / report notes) */
  readonly log: { url: string; ok: boolean; error?: string; rows?: number }[] = [];

  private loadEq(kind: "nse_full" | "nse_udiff" | "bse_udiff", iso: string): Promise<EquityFile> {
    const k = `${kind}:${iso}`;
    let p = this.eq.get(k);
    if (!p) {
      p = (async () => {
        const url = bhavUrls(iso)[kind];
        const source: CloseSource = kind === "bse_udiff" ? "bse_bhavcopy" : "nse_bhavcopy";
        const res = await get(url, kind === "bse_udiff" ? "https://www.bseindia.com/" : "https://www.nseindia.com/");
        if (!res.ok) {
          this.log.push({ url, ok: false, error: res.error });
          return { ok: false, source, url, rows: new Map(), error: res.error };
        }
        let text: string;
        if (kind === "nse_udiff") {
          const raw = unzipFirst(res.buf);
          if (!raw) {
            this.log.push({ url, ok: false, error: "bad_zip" });
            return { ok: false, source, url, rows: new Map(), error: "bad_zip" };
          }
          text = raw.toString("utf8");
        } else text = res.buf.toString("utf8");
        const parsed = kind === "nse_full" ? parseNseFull(text) : parseUdiff(text);
        // EQ first for NSE (BE/BZ only if no EQ row); BSE: any series
        const rows = new Map<string, BhavRow>();
        const rank = (s: string) => (kind === "bse_udiff" ? 0 : s === "EQ" ? 0 : s === "BE" ? 1 : s === "BZ" ? 2 : 9);
        for (const r of parsed) {
          if (rank(r.series) === 9) continue;
          const cur = rows.get(r.symbol);
          if (!cur || rank(r.series) < rank(cur.series)) rows.set(r.symbol, r);
        }
        this.log.push({ url, ok: rows.size > 0, rows: rows.size, ...(rows.size ? {} : { error: "no_rows" }) });
        return { ok: rows.size > 0, source, url, rows, ...(rows.size ? {} : { error: "no_rows" }) };
      })();
      this.eq.set(k, p);
    }
    return p;
  }

  /** Official settled EOD row for `symbol` on exactly `iso` (NSE full → NSE UDiFF → BSE UDiFF). */
  async equity(symbol: string, iso: string): Promise<BhavLookup> {
    const tried: string[] = [];
    if (!bhavFallbackEnabled()) return { ok: false, tried: ["disabled (BHAVCOPY_FALLBACK=0)"] };
    for (const kind of ["nse_full", "nse_udiff", "bse_udiff"] as const) {
      const f = await this.loadEq(kind, iso);
      if (!f.ok) { tried.push(`${kind}:${f.error}`); continue; }
      const row = f.rows.get(symbol);
      if (!row) { tried.push(`${kind}:symbol_absent`); continue; }
      if (row.date !== iso) { tried.push(`${kind}:date_mismatch(${row.date})`); continue; }
      return { ok: true, row, source: f.source, url: f.url, tried };
    }
    return { ok: false, tried };
  }

  /** NSE official index close for exactly `iso` (by NSE index name, case-insensitive). */
  async indexClose(name: string, iso: string): Promise<{ ok: boolean; row?: IndexCloseRow; url?: string; tried: string[] }> {
    if (!bhavFallbackEnabled()) return { ok: false, tried: ["disabled (BHAVCOPY_FALLBACK=0)"] };
    let p = this.idx.get(iso);
    if (!p) {
      p = (async () => {
        const url = bhavUrls(iso).nse_indices;
        const res = await get(url, "https://www.nseindia.com/");
        if (!res.ok) {
          this.log.push({ url, ok: false, error: res.error });
          return { ok: false, url, rows: new Map<string, IndexCloseRow>(), error: res.error };
        }
        const rows = new Map<string, IndexCloseRow>();
        for (const r of parseIndexCloses(res.buf.toString("utf8"))) if (!rows.has(r.name.toLowerCase())) rows.set(r.name.toLowerCase(), r);
        this.log.push({ url, ok: rows.size > 0, rows: rows.size, ...(rows.size ? {} : { error: "no_rows" }) });
        return { ok: rows.size > 0, url, rows, ...(rows.size ? {} : { error: "no_rows" }) };
      })();
      this.idx.set(iso, p);
    }
    const f = await p;
    if (!f.ok) return { ok: false, tried: [`nse_indices:${f.error}`] };
    const row = f.rows.get(name.toLowerCase());
    if (!row) return { ok: false, tried: ["nse_indices:index_absent"] };
    if (row.date !== iso) return { ok: false, tried: [`nse_indices:date_mismatch(${row.date})`] };
    return { ok: true, row, url: f.url, tried: [] };
  }
}
