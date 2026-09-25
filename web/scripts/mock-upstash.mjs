// Local-only mock of the Upstash Redis REST API (subset used by the app) for
// tests without a real database. NOT used in production.
// Usage: MOCK_TOKEN=dev node scripts/mock-upstash.mjs 8079
import http from "node:http";

const port = Number(process.argv[2] || 8079);
const TOKEN = process.env.MOCK_TOKEN || "dev";
const str = new Map(); // key -> {v, exp}
const sets = new Map();
const zsets = new Map();
const lists = new Map();

function alive(k) {
  const e = str.get(k);
  if (e && e.exp && e.exp < Date.now()) str.delete(k);
  return str.get(k);
}
const has = (k) => !!alive(k) || sets.has(k) || zsets.has(k) || lists.has(k);

function zsorted(k) {
  const z = zsets.get(k);
  if (!z) return [];
  return [...z.entries()].sort((a, b) => a[1] - b[1] || String(a[0]).localeCompare(String(b[0])));
}

function run(cmd) {
  const [op, ...a] = cmd.map((x) => (typeof x === "number" ? String(x) : x));
  switch (String(op).toUpperCase()) {
    case "PING": return "PONG";
    case "GET": return alive(a[0])?.v ?? null;
    case "MGET": return a.map((k) => alive(k)?.v ?? null);
    case "SET": {
      const [k, v, ...opts] = a;
      const up = opts.map((o) => String(o).toUpperCase());
      if (up.includes("NX") && alive(k)) return null;
      const exIdx = up.indexOf("EX");
      const exp = exIdx >= 0 ? Date.now() + Number(opts[exIdx + 1]) * 1000 : 0;
      str.set(k, { v: String(v), exp });
      return "OK";
    }
    case "DEL": { let n = 0; for (const k of a) { if (str.delete(k) | sets.delete(k) | zsets.delete(k) | lists.delete(k)) n++; } return n; }
    case "EXISTS": return a.filter(has).length;
    case "INCR": { const cur = Number(alive(a[0])?.v || 0) + 1; const e = alive(a[0]); str.set(a[0], { v: String(cur), exp: e?.exp || 0 }); return cur; }
    case "EXPIRE": { const e = alive(a[0]); if (!e) return 0; e.exp = Date.now() + Number(a[1]) * 1000; return 1; }
    case "SADD": { const s = sets.get(a[0]) || new Set(); sets.set(a[0], s); let n = 0; for (const m of a.slice(1)) { if (!s.has(m)) n++; s.add(m); } return n; }
    case "SREM": { const s = sets.get(a[0]); if (!s) return 0; let n = 0; for (const m of a.slice(1)) if (s.delete(m)) n++; return n; }
    case "SMEMBERS": return [...(sets.get(a[0]) || [])];
    case "ZADD": { const z = zsets.get(a[0]) || new Map(); zsets.set(a[0], z); let n = 0; for (let i = 1; i < a.length; i += 2) { if (!z.has(a[i + 1])) n++; z.set(a[i + 1], Number(a[i])); } return n; }
    case "ZREM": { const z = zsets.get(a[0]); if (!z) return 0; let n = 0; for (const m of a.slice(1)) if (z.delete(m)) n++; return n; }
    case "ZRANGE": {
      const [k, min, max, ...opts] = a;
      const up = opts.map((o) => String(o).toUpperCase());
      let s = zsorted(k);
      if (up.includes("BYSCORE")) {
        const lo = min === "-inf" ? -Infinity : Number(min), hi = max === "+inf" ? Infinity : Number(max);
        s = s.filter(([, sc]) => sc >= lo && sc <= hi);
        if (up.includes("REV")) s.reverse();
        return s.map((e) => e[0]);
      }
      if (up.includes("REV")) s.reverse();
      const stop = Number(max);
      return s.slice(Number(min), stop < 0 ? s.length + stop + 1 : stop + 1).map((e) => e[0]);
    }
    case "RPUSH": { const l = lists.get(a[0]) || []; lists.set(a[0], l); l.push(...a.slice(1)); return l.length; }
    case "LTRIM": { const l = lists.get(a[0]) || []; const n = l.length; let s = Number(a[1]), e = Number(a[2]); if (s < 0) s = Math.max(0, n + s); if (e < 0) e = n + e; lists.set(a[0], l.slice(s, e + 1)); return "OK"; }
    case "LRANGE": { const l = lists.get(a[0]) || []; const n = l.length; let s = Number(a[1]), e = Number(a[2]); if (s < 0) s = Math.max(0, n + s); if (e < 0) e = n + e; return l.slice(s, e + 1); }
    case "LLEN": return (lists.get(a[0]) || []).length;
    case "KEYS": { const re = new RegExp("^" + String(a[0]).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"); return [...new Set([...str.keys(), ...sets.keys(), ...zsets.keys(), ...lists.keys()])].filter((k) => re.test(k) && has(k)); }
    case "FLUSHALL": str.clear(); sets.clear(); zsets.clear(); lists.clear(); return "OK";
    default: throw new Error(`ERR unsupported ${op}`);
  }
}

const enc = (v) => (typeof v === "string" ? Buffer.from(v).toString("base64") : Array.isArray(v) ? v.map(enc) : v);

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "Unauthorized" }));
    }
    const b64 = String(req.headers["upstash-encoding"] || "").toLowerCase() === "base64";
    const wrap = (fn) => { try { const r = fn(); return { result: b64 ? enc(r) : r }; } catch (e) { return { error: e.message }; } };
    try {
      const parsed = JSON.parse(body || "null");
      if (req.url === "/pipeline" || req.url === "/multi-exec") {
        return res.end(JSON.stringify(parsed.map((c) => wrap(() => run(c)))));
      }
      const out = wrap(() => run(parsed));
      if (out.error) res.statusCode = 400;
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}).listen(port, () => console.log(`mock upstash on :${port}`));
