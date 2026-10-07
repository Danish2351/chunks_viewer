// Chunk-store audit viewer for `public.documents` (vector chunk store).
// Run: node server.js   →  http://localhost:3000
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");
const { Pool } = require("pg");

// Load .env.server / .env if present
for (const envFile of [".env.server", ".env"]) {
  try {
    const envPath = path.join(__dirname, envFile);
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
        }
      }
    }
  } catch (e) {
    if (e.code !== "ENOENT") console.error(`failed to parse ${envFile}:`, e.message);
  }
}

const PORT = +(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const VIEWER_PASSWORD = process.env.VIEWER_PASSWORD || "";
if (!VIEWER_PASSWORD && !["127.0.0.1", "localhost", "::1"].includes(HOST)) {
  console.error(`refusing to bind ${HOST} without VIEWER_PASSWORD — the corpus would be exposed unauthenticated`);
  process.exit(1);
}
const html = fs.readFileSync(path.join(__dirname, "index.html"));

function authorized(req) {
  if (!VIEWER_PASSWORD) return true; // loopback-only dev mode
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const given = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(given), b = Buffer.from(VIEWER_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function preprodPassword() {
  const envPw = process.env.PGPASSWORD_SERVER || process.env.PREPROD_PGPASSWORD;
  if (envPw) return Promise.resolve(envPw);
  return Promise.reject(new Error("preprod password unavailable — set PGPASSWORD_SERVER in .env.server"));
}

function checkTcpReachable(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(timeoutMs);
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("timeout", () => { s.destroy(); resolve(false); });
    s.on("error", () => { s.destroy(); resolve(false); });
    s.connect(port, host);
  });
}

let sshTunnelProc = null;
async function resolveDbConnection() {
  const remoteHost = process.env.PREPROD_PGHOST ||
    (process.env.DB_SSH ? process.env.DB_SSH.split("@").pop() : "18.116.179.2");
  const remotePort = 5432;
  const sshTarget = process.env.DB_SSH || process.env.PREPROD_SSH || `ubuntu@${remoteHost}`;
  const localTunnelPort = +(process.env.PGPORT_SERVER || 5433);

  console.log(`[db] Probing direct TCP connection to ${remoteHost}:${remotePort}...`);
  const directWorks = await checkTcpReachable(remoteHost, remotePort, 2000);
  if (directWorks) {
    console.log(`[db] Direct connection to ${remoteHost}:${remotePort} succeeded! Connecting directly without tunnel.`);
    return { host: remoteHost, port: remotePort, mode: "direct" };
  }

  console.log(`[db] Direct connection to ${remoteHost}:${remotePort} timed out (port blocked by remote/AWS firewall).`);
  console.log(`[db] Checking local port 127.0.0.1:${localTunnelPort}...`);

  const tunnelAlreadyUp = await checkTcpReachable("127.0.0.1", localTunnelPort, 500);
  if (tunnelAlreadyUp) {
    console.log(`[db] Existing tunnel detected on 127.0.0.1:${localTunnelPort}.`);
    return { host: "127.0.0.1", port: localTunnelPort, mode: "existing-tunnel" };
  }

  console.log(`[db] Starting SSH port forward to ${sshTarget} (-N, no remote commands executed)...`);
  sshTunnelProc = spawn("ssh", [
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=6",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-N",
    "-L", `${localTunnelPort}:127.0.0.1:${remotePort}`,
    sshTarget,
  ], { stdio: ["ignore", "ignore", "pipe"] });

  sshTunnelProc.stderr.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[ssh tunnel] ${msg}`);
  });

  sshTunnelProc.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[ssh tunnel exited with code ${code}]`);
    }
  });

  let ready = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await checkTcpReachable("127.0.0.1", localTunnelPort, 400)) {
      ready = true;
      break;
    }
  }

  if (!ready) {
    throw new Error(`Failed to establish SSH tunnel on 127.0.0.1:${localTunnelPort} within 6 seconds.`);
  }

  console.log(`[db] SSH port forward ready on 127.0.0.1:${localTunnelPort} -> ${remoteHost}:${remotePort}`);
  return { host: "127.0.0.1", port: localTunnelPort, mode: "managed-tunnel" };
}

function cleanup() {
  if (sshTunnelProc && !sshTunnelProc.killed) {
    console.log("[db] Closing SSH tunnel...");
    sshTunnelProc.kill("SIGTERM");
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

let CONNECTIONS = {};

function initConnections(dbHost, dbPort) {
  const conns = {};
  if (process.env.PGDATABASE_SERVER) {
    conns["preprod-server"] = {
      label: `remote · ${process.env.PGDATABASE_SERVER} (.env.server)`,
      host: dbHost, port: dbPort, user: "postgres",
      database: process.env.PGDATABASE_SERVER, password: preprodPassword,
    };
  }
  conns["preprod"] = {
    label: "remote · akhudforbs_db (LIVE corpus)",
    host: dbHost, port: dbPort, user: "postgres",
    database: "akhudforbs_db", password: preprodPassword,
  };
  conns["preprod-v2-replica"] = {
    label: "remote · reliable_akhundforbes_db_v2_replica (v2 replica)",
    host: dbHost, port: dbPort, user: "postgres",
    database: "reliable_akhundforbes_db_v2_replica", password: preprodPassword,
  };
  conns["preprod-prewipe"] = {
    label: "remote · akhudforbs_prewipe_20260815 (pre-wipe backup)",
    host: dbHost, port: dbPort, user: "postgres",
    database: "akhudforbs_prewipe_20260815", password: preprodPassword,
  };
  conns["local-restore"] = {
    label: "local · akhudforbs_restore_20260810 (localhost:5432)",
    host: process.env.PGHOST || "localhost",
    port: +(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "postgres",
    database: process.env.PGDATABASE || "akhudforbs_restore_20260810",
    password: () => Promise.resolve(process.env.PGPASSWORD || "1234"),
  };
  CONNECTIONS = conns;
}

const pools = {}; // name -> Promise<Pool>
function getPool(name) {
  const cfg = CONNECTIONS[name];
  if (!cfg) throw new Error(`unknown connection "${name}"`);
  if (!pools[name]) {
    pools[name] = (async () => {
      const pool = new Pool({
        host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database,
        password: await cfg.password(),
        max: 8, connectionTimeoutMillis: 30000, statement_timeout: 120000,
        options: "-c default_transaction_read_only=on", // audit tool: enforce read-only sessions
      });
      pool.on("error", () => {}); // dropped idle connection must not kill the process
      return pool;
    })();
    pools[name].catch(() => { delete pools[name]; }); // failed setup is retryable
  }
  return pools[name];
}

async function q(conn, sql, params) {
  try {
    return await (await getPool(conn)).query(sql, params);
  } catch (e) {
    if (e.code === "28P01" || /password authentication|timeout|connection terminated|ECONNREFUSED/i.test(e.message || "")) {
      const stale = pools[conn]; delete pools[conn];
      if (stale) stale.then(p => p.end().catch(() => {})).catch(() => {});
    }
    throw e;
  }
}

// whitelisted ORDER BY clauses — never interpolate user input into SQL
const SORTS = {
  doc: "doc_id, chunk_index",
  index: "chunk_index, doc_id",
  section: `meta->>'law_family',
            nullif(left(regexp_replace(coalesce(meta->>'section_number',''),'[^0-9]','','g'),9),'')::int nulls last,
            meta->>'section_number', chunk_index`,
  created_desc: "created_at desc nulls last, id desc",
  created_asc: "created_at asc nulls last, id asc",
  id: "id",
};

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// shared filter builder for /api/documents (chunk-level filters)
function chunkFilters(sp) {
  const where = [], params = [];
  const add = (val, clause) => { params.push(val); where.push(clause(params.length)); };
  const g = k => (sp.get(k) || "").trim();
  if (g("q"))       add(`%${g("q")}%`,       n => `content ilike $${n}`);
  if (g("name"))    add(`%${g("name")}%`,    n => `meta->>'name' ilike $${n}`);
  if (g("family"))  add(g("family"),         n => `meta->>'law_family' = $${n}`);
  if (g("section")) add(g("section"),        n => `meta->>'section_number' = $${n}`);
  if (g("type"))    add(g("type"),           n => `chunk_type = $${n}`);
  if (g("doc"))     add(g("doc"),            n => `doc_id = $${n}`);
  return { w: where.length ? "where " + where.join(" and ") : "", params };
}

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="chunks-viewer"' });
    return res.end("auth required");
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const defaultConn = Object.keys(CONNECTIONS)[0] || "preprod";
  const conn = url.searchParams.get("conn") || defaultConn;
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(html);
    }

    if (url.pathname === "/api/connections") {
      return json(res, 200, Object.entries(CONNECTIONS).map(([id, c]) =>
        ({ id, label: c.label, host: c.host, database: c.database })));
    }

    if (url.pathname === "/api/stats") {
      const { rows } = await q(conn, `
        select count(*)::int as total,
               count(*) filter (where chunk_type='structured')::int as structured,
               count(*) filter (where chunk_type='sequential')::int as sequential,
               count(distinct doc_id)::int as docs,
               count(distinct meta->>'law_family')::int as law_families,
               min(embedding_model) as model, max(embedding_dim) as dim,
               min(created_at) as oldest, max(created_at) as newest
        from public.documents`);
      return json(res, 200, rows[0]);
    }

    if (url.pathname === "/api/families") {
      const { rows } = await q(conn, `
        select meta->>'law_family' as family, count(*)::int as chunks,
               count(distinct doc_id)::int as docs
        from public.documents group by 1 order by 1 nulls last`);
      return json(res, 200, rows);
    }

    if (url.pathname === "/api/docs") {
      const family = (url.searchParams.get("family") || "").trim();
      const name = (url.searchParams.get("name") || "").trim();
      const where = [], params = [];
      if (family) { params.push(family); where.push(`meta->>'law_family' = $${params.length}`); }
      if (name) { params.push(`%${name}%`); where.push(`meta->>'name' ilike $${params.length}`); }
      const w = where.length ? "where " + where.join(" and ") : "";
      const LIMIT = 1000;
      const { rows } = await q(conn, `
        select doc_id, max(meta->>'name') as name, max(meta->>'law_family') as law_family,
               count(*)::int as chunks
        from public.documents ${w}
        group by doc_id order by 2 nulls last limit ${LIMIT + 1}`, params);
      const truncated = rows.length > LIMIT;
      return json(res, 200, { truncated, rows: rows.slice(0, LIMIT) });
    }

    if (url.pathname === "/api/documents") {
      const page = Math.max(1, +(url.searchParams.get("page") || 1));
      const size = Math.min(200, Math.max(5, +(url.searchParams.get("size") || 25)));
      const sort = SORTS[url.searchParams.get("sort")] || SORTS.doc;
      const { w, params } = chunkFilters(url.searchParams);
      const countPromise = q(conn, `select count(*)::int as n from public.documents ${w}`, params);
      const docParams = [...params, size, (page - 1) * size];
      const rowsPromise = q(conn, `
        with ids as (
          select id
          from public.documents ${w}
          order by ${sort}
          limit $${docParams.length - 1} offset $${docParams.length}
        )
        select d.id, d.doc_id, d.chunk_index, d.chunk_id, d.chunk_type, d.content,
               d.meta->>'name' as name, d.meta->>'law_family' as law_family,
               d.meta->>'section_number' as section_number, d.meta->>'section_title' as section_title,
               d.meta->>'heading_path' as heading_path,
               d.meta->>'source_type' as source_type, d.meta->>'law_doc_type' as law_doc_type,
               d.meta->>'is_latest_version' as is_latest_version,
               d.embedding_model, d.embedding_dim, d.created_at,
               left(d.embedding::text, 120) as embedding_preview,
               jsonb_pretty(d.meta) as meta
        from ids
        join public.documents d using (id)
        order by ${sort}`, docParams);
      const [count, { rows }] = await Promise.all([countPromise, rowsPromise]);
      return json(res, 200, { total: count.rows[0].n, page, size, rows });
    }

    if (url.pathname === "/api/similar") {
      const id = +(url.searchParams.get("id") || 0);
      const emb = await q(conn, `select embedding::text as e from public.documents where id=$1`, [id]);
      if (!emb.rows.length || emb.rows[0].e == null) return json(res, 200, []);
      const { rows } = await q(conn, `
        select id, doc_id, chunk_index, chunk_type, left(content, 300) as content,
               meta->>'section_number' as section_number, meta->>'law_family' as law_family,
               round((1 - (embedding <=> $2::vector))::numeric, 4) as similarity
        from public.documents
        where id <> $1
        order by embedding <=> $2::vector limit 8`, [id, emb.rows[0].e]);
      return json(res, 200, rows);
    }

    res.writeHead(404); res.end("not found");
  } catch (e) {
    console.error(`[${conn}]`, e.message);
    json(res, 500, { error: `[${conn}] ${e.message}` });
  }
});

(async () => {
  const target = await resolveDbConnection();
  initConnections(target.host, target.port);
  server.listen(PORT, HOST, () => {
    console.log(`chunk audit viewer → http://${HOST}:${PORT}`);
    for (const [k, d] of Object.entries(CONNECTIONS)) {
      console.log(`  ${k.padEnd(20)} ${d.host}:${d.port}/${d.database}`);
    }
  });
})().catch((err) => {
  console.error("Fatal startup error:", err.message);
  process.exit(1);
});
