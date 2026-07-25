import { serve, file } from "bun";
import { Database } from "bun:sqlite";

const PORT = 3000;

// ── SQLite setup ────────────────────────────────────────────────────
const db = new Database("stable.db", { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

// ── Schema ──────────────────────────────────────────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    email TEXT NOT NULL
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    room TEXT NOT NULL,
    rent INTEGER NOT NULL,
    notes TEXT DEFAULT '',
    history TEXT DEFAULT '[]'
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    role TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  )
`);

// ── Seed users from access.json (hashes plaintext passwords on first run) ──
const userCount = db.query("SELECT COUNT(*) as c FROM users").get() as any;
if (userCount.c === 0) {
  console.log("[DB] Seeding users from access.json...");
  try {
    const access = JSON.parse(await Bun.file("./access.json").text());
    const users = Array.isArray(access) ? access : (access.users || []);
    const insert = db.prepare("INSERT INTO users (username, password_hash, role, email) VALUES (?, ?, ?, ?)");
    for (const u of users) {
      const hash = await Bun.password.hash(u.password);
      insert.run(u.username, hash, u.role, u.email);
      console.log(`[DB]   → user "${u.username}" seeded (password hashed with bcrypt)`);
    }
    // Save hashed version back to access.json
    const hashedUsers = users.map((u: any) => ({ ...u, password: "[HASHED]", password_hash: "[stored in stable.db]" }));
    await Bun.write("./access.json", JSON.stringify({ users: hashedUsers }, null, 2));
    console.log("[DB] access.json updated — plaintext passwords replaced with placeholders.");
  } catch (e) {
    console.error("[DB] Failed to seed users:", e);
  }
}

// ── Migrate clients from data.json (first run only) ──
const clientCount = db.query("SELECT COUNT(*) as c FROM clients").get() as any;
if (clientCount.c === 0) {
  console.log("[DB] Migrating clients from data.json...");
  try {
    const data = JSON.parse(await Bun.file("./data.json").text());
    const clients = Array.isArray(data) ? data : [];
    const insert = db.prepare("INSERT INTO clients (id, name, phone, room, rent, notes, history) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const c of clients) {
      insert.run(c.id, c.name, c.phone, c.room, c.rent, c.notes || "", JSON.stringify(c.history || []));
    }
    console.log(`[DB]   → ${clients.length} client(s) migrated.`);
  } catch (e) {
    console.error("[DB] Failed to migrate clients:", e);
  }
}

// ── Cleanup expired sessions (older than 24h) ──
db.run("DELETE FROM sessions WHERE created_at < ?", [Date.now() - 86400000]);

// ── Rate limiter (in-memory) ────────────────────────────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 5;     // max attempts
const RATE_LIMIT_WINDOW = 60_000; // per minute

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// ── Input validation ────────────────────────────────────────────────
function validateClient(body: any): string | null {
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const room = String(body.room || "").trim();
  const rent = Number(body.rent);
  const notes = String(body.notes || "").trim();

  if (!name || name.length < 2 || name.length > 100) return "الاسم يجب أن يكون بين 2 و 100 حرف";
  if (!/^\d{5,15}$/.test(phone)) return "رقم الهاتف يجب أن يحتوي على 5 إلى 15 رقم فقط";
  if (!room || room.length > 20) return "معرف الغرفة مطلوب ولا يزيد عن 20 حرف";
  if (isNaN(rent) || rent <= 0 || rent > 1_000_000) return "قيمة الإيجار يجب أن تكون رقماً موجباً";
  if (notes.length > 500) return "الملاحظات لا تزيد عن 500 حرف";
  return null;
}

// ── Audit logger ────────────────────────────────────────────────────
function audit(username: string, action: string, details: string = "") {
  db.run("INSERT INTO audit_log (username, action, details, created_at) VALUES (?, ?, ?, ?)",
    [username, action, details, Date.now()]);
  console.log(`[AUDIT] ${username} — ${action}${details ? ` (${details})` : ""}`);
}

// ── Helpers ─────────────────────────────────────────────────────────
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ error: message }, status);
}

function getClientIP(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "127.0.0.1";
}

function requireSession(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const row = db.query("SELECT username, role, email FROM sessions WHERE token = ?").get(token) as any;
  if (!row) return null;
  // Touch session timestamp
  db.run("UPDATE sessions SET created_at = ? WHERE token = ?", [Date.now(), token]);
  return row;
}

function requireManager(req: Request) {
  const session = requireSession(req);
  if (!session || session.role !== "manager") return null;
  return session;
}

// ── API Router ──────────────────────────────────────────────────────
async function handleAPI(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const ip = getClientIP(req);

  // ── POST /api/login ─────────────────────────────────────────────
  if (path === "/api/login" && method === "POST") {
    if (!checkRateLimit(ip)) {
      console.log(`[RATE LIMIT] IP ${ip} blocked — too many login attempts`);
      return errorResponse("محاولات تسجيل دخول كثيرة جداً. حاول مرة أخرى بعد دقيقة.", 429);
    }
    try {
      const { username, password } = await req.json();
      console.log(`[LOGIN ATTEMPT] username: "${username}", password: "${password}"`);

      const row = db.query("SELECT username, password_hash, role, email FROM users WHERE username = ?")
        .get(username) as any;
      console.log(`[CHECKING DB] entry found: ${row ? 'yes' : 'no'}`);

      if (!row) {
        console.log(`[LOGIN FAILED] username: "${username}" — not found`);
        return errorResponse("اسم المستخدم أو كلمة المرور غير صحيحة", 401);
      }
      console.log(`  ↳ stored hash: ${row.password_hash.substring(0, 20)}...`);

      const valid = await Bun.password.verify(password, row.password_hash);
      console.log(`  ↳ bcrypt verify: ${valid ? 'MATCH' : 'MISMATCH'}`);

      if (!valid) {
        console.log(`[LOGIN FAILED] username: "${username}" — wrong password`);
        return errorResponse("اسم المستخدم أو كلمة المرور غير صحيحة", 401);
      }

      const token = crypto.randomUUID();
      db.run("INSERT INTO sessions (token, username, role, email, created_at) VALUES (?, ?, ?, ?, ?)",
        [token, row.username, row.role, row.email, Date.now()]);

      console.log(`[LOGIN SUCCESS] username: "${username}", role: "${row.role}"`);
      audit(row.username, "LOGIN", `IP: ${ip}`);
      return jsonResponse({ token, role: row.role, email: row.email });
    } catch {
      return errorResponse("بيانات الطلب غير صالحة", 400);
    }
  }

  // ── POST /api/logout ────────────────────────────────────────────
  if (path === "/api/logout" && method === "POST") {
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const session = db.query("SELECT username FROM sessions WHERE token = ?").get(token) as any;
      if (session) {
        audit(session.username, "LOGOUT");
        db.run("DELETE FROM sessions WHERE token = ?", [token]);
      }
    }
    return jsonResponse({ ok: true });
  }

  // ── GET /api/session ────────────────────────────────────────────
  if (path === "/api/session" && method === "GET") {
    const session = requireSession(req);
    if (!session) return errorResponse("غير مصرح", 401);
    return jsonResponse({ username: session.username, role: session.role, email: session.email });
  }

  // ── GET /api/clients ────────────────────────────────────────────
  if (path === "/api/clients" && method === "GET") {
    const session = requireSession(req);
    if (!session) return errorResponse("غير مصرح", 401);
    const rows = db.query("SELECT * FROM clients ORDER BY room").all() as any[];
    const clients = rows.map(r => ({ ...r, history: JSON.parse(r.history) }));
    return jsonResponse(clients);
  }

  // ── POST /api/clients ──────────────────────────────────────────
  if (path === "/api/clients" && method === "POST") {
    const session = requireManager(req);
    if (!session) return errorResponse("هذا الإجراء متاح للمدراء فقط", 403);
    try {
      const body = await req.json();
      const err = validateClient(body);
      if (err) return errorResponse(err, 422);

      const id = crypto.randomUUID();
      db.run("INSERT INTO clients (id, name, phone, room, rent, notes, history) VALUES (?, ?, ?, ?, ?, ?, '[]')",
        [id, body.name.trim(), body.phone.trim(), body.room.trim(), Number(body.rent), (body.notes || "").trim()]);

      audit(session.username, "ADD_CLIENT", `${body.name} (room ${body.room})`);
      const row = db.query("SELECT * FROM clients WHERE id = ?").get(id) as any;
      return jsonResponse({ ...row, history: JSON.parse(row.history) }, 201);
    } catch {
      return errorResponse("بيانات العميل غير صالحة", 400);
    }
  }

  // ── PUT /api/clients/:id ───────────────────────────────────────
  const clientMatch = path.match(/^\/api\/clients\/([^/]+)$/);
  if (clientMatch && method === "PUT") {
    const session = requireManager(req);
    if (!session) return errorResponse("هذا الإجراء متاح للمدراء فقط", 403);
    const clientId = clientMatch[1];
    try {
      const body = await req.json();
      const err = validateClient(body);
      if (err) return errorResponse(err, 422);

      const existing = db.query("SELECT id FROM clients WHERE id = ?").get(clientId);
      if (!existing) return errorResponse("العميل غير موجود", 404);

      db.run("UPDATE clients SET name=?, phone=?, room=?, rent=?, notes=? WHERE id=?",
        [body.name.trim(), body.phone.trim(), body.room.trim(), Number(body.rent), (body.notes || "").trim(), clientId]);

      audit(session.username, "EDIT_CLIENT", `${body.name} (room ${body.room})`);
      const row = db.query("SELECT * FROM clients WHERE id = ?").get(clientId) as any;
      return jsonResponse({ ...row, history: JSON.parse(row.history) });
    } catch {
      return errorResponse("بيانات التعديل غير صالحة", 400);
    }
  }

  // ── DELETE /api/clients/:id ────────────────────────────────────
  if (clientMatch && method === "DELETE") {
    const session = requireManager(req);
    if (!session) return errorResponse("هذا الإجراء متاح للمدراء فقط", 403);
    const clientId = clientMatch[1];

    const existing = db.query("SELECT name, room FROM clients WHERE id = ?").get(clientId) as any;
    if (!existing) return errorResponse("العميل غير موجود", 404);

    db.run("DELETE FROM clients WHERE id = ?", [clientId]);
    audit(session.username, "DELETE_CLIENT", `${existing.name} (room ${existing.room})`);
    return jsonResponse({ ok: true });
  }

  // ── PUT /api/clients/:id/payment ───────────────────────────────
  const paymentMatch = path.match(/^\/api\/clients\/([^/]+)\/payment$/);
  if (paymentMatch && method === "PUT") {
    const session = requireManager(req);
    if (!session) return errorResponse("هذا الإجراء متاح للمدراء فقط", 403);
    const clientId = paymentMatch[1];
    try {
      const { period } = await req.json();
      const row = db.query("SELECT * FROM clients WHERE id = ?").get(clientId) as any;
      if (!row) return errorResponse("العميل غير موجود", 404);

      const history: string[] = JSON.parse(row.history);
      const idx = history.indexOf(period);
      const action = idx > -1 ? "UNPAID" : "PAID";
      if (idx > -1) history.splice(idx, 1);
      else history.push(period);

      db.run("UPDATE clients SET history = ? WHERE id = ?", [JSON.stringify(history), clientId]);
      audit(session.username, `TOGGLE_${action}`, `${row.name} — period ${period}`);
      return jsonResponse({ history });
    } catch {
      return errorResponse("بيانات الدفع غير صالحة", 400);
    }
  }

  // ── POST /api/clients/import ───────────────────────────────────
  if (path === "/api/clients/import" && method === "POST") {
    const session = requireManager(req);
    if (!session) return errorResponse("هذا الإجراء متاح للمدراء فقط", 403);
    try {
      const { clients: importedClients } = await req.json();
      if (!Array.isArray(importedClients)) return errorResponse("ملف النسخة الاحتياطية غير صالح", 400);

      db.run("DELETE FROM clients");
      const insert = db.prepare("INSERT INTO clients (id, name, phone, room, rent, notes, history) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const c of importedClients) {
        insert.run(crypto.randomUUID(), c.name, c.phone, c.room, Number(c.rent), c.notes || "", JSON.stringify(c.history || []));
      }
      audit(session.username, "IMPORT_BACKUP", `${importedClients.length} clients imported`);
      return jsonResponse({ count: importedClients.length });
    } catch {
      return errorResponse("تعذر استيراد البيانات", 400);
    }
  }

  // ── GET /api/audit ─────────────────────────────────────────────
  if (path === "/api/audit" && method === "GET") {
    const session = requireManager(req);
    if (!session) return errorResponse("هذا الإجراء متاح للمدراء فقط", 403);
    const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
    const rows = db.query("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?").all(limit) as any[];
    return jsonResponse(rows);
  }

  return errorResponse("المسار غير موجود", 404);
}

// ── Static file server ──────────────────────────────────────────────
serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      return handleAPI(req);
    }

    let path = url.pathname;
    if (path === "/" || path === "/index.html") path = "/index.html";

    const filePath = `.${path}`;
    try {
      const f = file(filePath);
      if (!(await f.exists())) return new Response("Not Found", { status: 404 });
      return new Response(f);
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  },
});

console.log(`🚀 Server running at http://localhost:${PORT}`);
console.log(`   SQLite: stable.db  |  Rate limit: ${RATE_LIMIT_MAX}/min  |  Sessions: persisted`);
