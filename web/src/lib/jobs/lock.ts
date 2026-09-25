/**
 * job_runs lease (brief §2.3) on Redis: SET NX EX. Completed/holiday_skip runs
 * are recorded under job:run:<job>:<date> so duplicate cron deliveries no-op.
 * No Redis → per-instance memory (best effort).
 */
import { getRedis, parseJson } from "../redis";

export type JobStatus = "running" | "partial" | "complete" | "failed" | "holiday_skip";
export interface JobRun {
  job: string;
  session_date: string;
  status: JobStatus;
  attempts: number;
  trigger_source: string;
  started_at: string;
  finished_at?: string;
  error?: string;
  detail?: unknown;
}

const mem = globalThis as typeof globalThis & {
  __jobLocks?: Map<string, number>;
  __jobRuns?: Map<string, JobRun>;
};
const locks = () => (mem.__jobLocks ||= new Map());
const runs = () => (mem.__jobRuns ||= new Map());

export async function getJobRun(job: string, date: string): Promise<JobRun | null> {
  const r = getRedis();
  if (!r) return runs().get(`${job}:${date}`) || null;
  return parseJson<JobRun>(await r.get(`job:run:${job}:${date}`));
}

export async function putJobRun(run: JobRun): Promise<void> {
  const r = getRedis();
  if (!r) {
    runs().set(`${run.job}:${run.session_date}`, run);
    return;
  }
  // job history kept 90 days (Hobby logs keep only 1h)
  await r.set(`job:run:${run.job}:${run.session_date}`, JSON.stringify(run), { ex: 90 * 86400 });
}

/** Acquire a lease; returns release fn or null if another run holds it. */
export async function acquireLease(
  job: string,
  date: string,
  ttlSec = 360
): Promise<(() => Promise<void>) | null> {
  const key = `job:lock:${job}:${date}`;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = getRedis();
  if (!r) {
    const until = locks().get(key);
    if (until && until > Date.now()) return null;
    locks().set(key, Date.now() + ttlSec * 1000);
    return async () => {
      locks().delete(key);
    };
  }
  const ok = await r.set(key, token, { nx: true, ex: ttlSec });
  if (ok !== "OK") return null;
  return async () => {
    try {
      if ((await r.get(key)) === token) await r.del(key);
    } catch {
      /* expires */
    }
  };
}
