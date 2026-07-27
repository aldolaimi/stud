import { serve, file } from "bun";

const PORT = 3000;
const DATA_FILE = "./data.json";

// ── Data structures (matching structure.txt) ─────────────────────────

interface CustomerAccount {
  id: string;
  name: string;
  email: string;
  phone: string;
  whatsApp: string;
  numberOfRooms: string;
  rooms: string[];
  startDate: string;
  FixedMonthlyRent: string;
  OtherMonthlyCost: { description: string; value: string };
  duePaymentCurrentMonth: string;
  paymentHistory: { date: string; value: string }[];
}

interface Operator {
  id: string;
  name: string;
  ownerName: string;
  ownerPassword: string;          // bcrypt hash
  ownerPhone: string;
  ownerWhatsApp: string;
  ownerFawranNumber: string;
  ownerFawranName: string;
  startDate: string;
  NumberOfRoomsTotal: string;
  NumberOfRoomsOccupied: string;
  NumberOfRoomsFree: string;
  customers: CustomerAccount[];
  deletedCustomers: CustomerAccount[];
  revenueAccount: { customer_id: string; payment: string; date: string }[];
  costAccount: { item: string; value: string; date: string; recurring: string }[];
}

interface DataStore {
  Operator: Operator[];
  websiteAdminUserName: string;
  websiteAdminPasswordCrypt: string;  // bcrypt hash
  websiteKeyValues: Record<string, string>[];
  sessions: { token: string; operatorId: string; operatorName: string; role: string; created_at: number }[];
  audit_log: { id: number; operatorId: string; operatorName: string; action: string; details: string; created_at: number }[];
}

let store: DataStore = {
  Operator: [],
  websiteAdminUserName: "admin",
  websiteAdminPasswordCrypt: "",
  websiteKeyValues: [],
  sessions: [],
  audit_log: [],
};
let auditIdCounter = 1;

// ── JSON file I/O ────────────────────────────────────────────────────
async function loadStore(): Promise<void> {
  try {
    const raw = await Bun.file(DATA_FILE).text();
    const parsed = JSON.parse(raw);
    store.Operator = parsed.Operator || [];
    store.websiteAdminUserName = parsed.websiteAdminUserName || "admin";
    store.websiteAdminPasswordCrypt = parsed.websiteAdminPasswordCrypt || "";
    store.websiteKeyValues = parsed.websiteKeyValues || [];
    store.sessions = parsed.sessions || [];
    store.audit_log = parsed.audit_log || [];
    if (store.audit_log.length > 0) {
      auditIdCounter = Math.max(...store.audit_log.map(e => e.id)) + 1;
    }
    console.log(`[DATA] Loaded from ${DATA_FILE}: ${store.Operator.length} operator(s), ${store.Operator.reduce((s, o) => s + o.customers.length, 0)} customer(s), ${store.sessions.length} session(s), ${store.audit_log.length} audit entries`);
  } catch {
    console.log(`[DATA] ${DATA_FILE} not found or unreadable — starting with default empty structure.`);
  }
}

async function saveStore(): Promise<void> {
  const tmp = DATA_FILE + ".tmp";
  await Bun.write(tmp, JSON.stringify(store, null, 2));
  await Bun.write(DATA_FILE, await Bun.file(tmp).text());
  try { await Bun.file(tmp).delete(); } catch { /* ignore */ }
}

// ── Seed: hash website admin password on first run ────────────────────
async function seedAdmin(): Promise<void> {
  // If website admin password is provided as plaintext via access.json, hash it
  if (store.websiteAdminPasswordCrypt && !store.websiteAdminPasswordCrypt.startsWith("$")) {
    // Looks like a plaintext password — hash it
    try {
      const hash = await Bun.password.hash(store.websiteAdminPasswordCrypt);
      store.websiteAdminPasswordCrypt = hash;
      console.log("[DATA] Website admin password hashed.");
      await saveStore();
    } catch (e) {
      console.error("[DATA] Failed to hash admin password:", e);
    }
  }

  // Seed operators from access.json if no operators exist
  if (store.Operator.length > 0) return;
  console.log("[DATA] Seeding operators from access.json...");
  try {
    const access = JSON.parse(await Bun.file("./access.json").text());
    const entries = Array.isArray(access) ? access : (access.operators || access.users || []);
    for (const e of entries) {
      const name = e.name || e.username || "operator";
      const existing = store.Operator.find(o => o.name === name);
      if (existing) continue;

      const hash = e.password ? await Bun.password.hash(e.password) : "";
      store.Operator.push({
        id: crypto.randomUUID(),
        name,
        ownerName: e.ownerName || e.username || name,
        ownerPassword: hash,
        ownerPhone: e.ownerPhone || e.phone || "",
        ownerWhatsApp: e.ownerWhatsApp || e.phone || "",
        ownerFawranNumber: e.ownerFawranNumber || "",
        ownerFawranName: e.ownerFawranName || "",
        startDate: new Date().toISOString().slice(0, 10),
        NumberOfRoomsTotal: "0",
        NumberOfRoomsOccupied: "0",
        NumberOfRoomsFree: "0",
        customers: [],
        deletedCustomers: [],
        revenueAccount: [],
        costAccount: [],
      });
      console.log(`[DATA]   → operator "${name}" seeded (password hashed with bcrypt)`);
    }
    const cleaned = entries.map((u: any) => ({ ...u, password: "[HASHED]" }));
    await Bun.write("./access.json", JSON.stringify(Array.isArray(access) ? cleaned : { operators: cleaned }, null, 2));
    console.log("[DATA] access.json updated — plaintext passwords replaced with placeholders.");
    await saveStore();
  } catch (e) {
    console.error("[DATA] Failed to seed operators:", e);
  }
}

// ── Cleanup expired sessions (older than 24h) ────────────────────────
function cleanupSessions(): void {
  const cutoff = Date.now() - 86400000;
  const before = store.sessions.length;
  store.sessions = store.sessions.filter(s => s.created_at >= cutoff);
  if (before !== store.sessions.length) {
    console.log(`[DATA] Cleaned up ${before - store.sessions.length} expired session(s).`);
    saveStore();
  }
}

// ── Rate limiter (in-memory) ────────────────────────────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 60_000;

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
function validateCustomer(body: any): string | null {
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const rooms = body.rooms || (body.room ? [body.room] : []);
  const rent = Number(body.FixedMonthlyRent || body.rent || 0);

  if (!name || name.length < 2 || name.length > 100) return "الاسم يجب أن يكون بين 2 و 100 حرف";
  if (!/^\d{5,15}$/.test(phone)) return "رقم الهاتف يجب أن يحتوي على 5 إلى 15 رقم فقط";
  if (!Array.isArray(rooms) || rooms.length === 0) return "معرف الغرفة مطلوب";
  if (isNaN(rent) || rent <= 0 || rent > 1_000_000) return "قيمة الإيجار يجب أن تكون رقماً موجباً";
  return null;
}

// ── Audit logger ────────────────────────────────────────────────────
function audit(operatorId: string, operatorName: string, action: string, details: string = "") {
  store.audit_log.push({
    id: auditIdCounter++,
    operatorId,
    operatorName,
    action,
    details,
    created_at: Date.now(),
  });
  console.log(`[AUDIT] ${operatorName} — ${action}${details ? ` (${details})` : ""}`);
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
  const session = store.sessions.find(s => s.token === token);
  if (!session) return null;
  session.created_at = Date.now();
  return session;
}

function requireOperator(req: Request) {
  const session = requireSession(req);
  if (!session || session.role !== "operator") return null;
  return session;
}

function getOperator(session: { operatorId: string }) {
  return store.Operator.find(o => o.id === session.operatorId);
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
      console.log(`[LOGIN ATTEMPT] username: "${username}"`);

      // Try website admin first
      if (username === store.websiteAdminUserName && store.websiteAdminPasswordCrypt) {
        const valid = await Bun.password.verify(password, store.websiteAdminPasswordCrypt);
        if (valid) {
          const token = crypto.randomUUID();
          store.sessions.push({
            token,
            operatorId: "admin",
            operatorName: "admin",
            role: "admin",
            created_at: Date.now(),
          });
          console.log(`[LOGIN SUCCESS] admin`);
          return jsonResponse({ token, role: "admin", operatorName: "admin" });
        }
      }

      // Try operators
      const op = store.Operator.find(o => o.name === username);
      if (!op) {
        console.log(`[LOGIN FAILED] username: "${username}" — not found`);
        return errorResponse("اسم المستخدم أو كلمة المرور غير صحيحة", 401);
      }

      const valid = await Bun.password.verify(password, op.ownerPassword);
      if (!valid) {
        console.log(`[LOGIN FAILED] username: "${username}" — wrong password`);
        return errorResponse("اسم المستخدم أو كلمة المرور غير صحيحة", 401);
      }

      const token = crypto.randomUUID();
      store.sessions.push({
        token,
        operatorId: op.id,
        operatorName: op.name,
        role: "operator",
        created_at: Date.now(),
      });

      console.log(`[LOGIN SUCCESS] operator: "${op.name}"`);
      audit(op.id, op.name, "LOGIN", `IP: ${ip}`);
      await saveStore();
      return jsonResponse({ token, role: "operator", operatorName: op.name, operatorId: op.id });
    } catch {
      return errorResponse("بيانات الطلب غير صالحة", 400);
    }
  }

  // ── POST /api/logout ────────────────────────────────────────────
  if (path === "/api/logout" && method === "POST") {
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const session = store.sessions.find(s => s.token === token);
      if (session) {
        audit(session.operatorId, session.operatorName, "LOGOUT");
        store.sessions = store.sessions.filter(s => s.token !== token);
        await saveStore();
      }
    }
    return jsonResponse({ ok: true });
  }

  // ── GET /api/session ────────────────────────────────────────────
  if (path === "/api/session" && method === "GET") {
    const session = requireSession(req);
    if (!session) return errorResponse("غير مصرح", 401);
    return jsonResponse({
      operatorId: session.operatorId,
      operatorName: session.operatorName,
      role: session.role,
    });
  }

  // ── GET /api/customers ──────────────────────────────────────────
  if (path === "/api/customers" && method === "GET") {
    const session = requireSession(req);
    if (!session) return errorResponse("غير مصرح", 401);
    const op = getOperator(session);
    if (!op) return errorResponse("المشغل غير موجود", 404);

    // Return all customers sorted by first room number
    const customers = [...op.customers].sort((a, b) => {
      const na = parseInt(String(a.rooms[0] || "").match(/\d+/)?.[0] || "0");
      const nb = parseInt(String(b.rooms[0] || "").match(/\d+/)?.[0] || "0");
      return na - nb;
    });
    return jsonResponse(customers);
  }

  // ── POST /api/customers ────────────────────────────────────────
  if (path === "/api/customers" && method === "POST") {
    const session = requireOperator(req);
    if (!session) return errorResponse("هذا الإجراء متاح للمشغلين فقط", 403);
    const op = getOperator(session);
    if (!op) return errorResponse("المشغل غير موجود", 404);

    try {
      const body = await req.json();
      const err = validateCustomer(body);
      if (err) return errorResponse(err, 422);

      const rooms: string[] = body.rooms || (body.room ? [body.room.trim()] : []);
      const customer: CustomerAccount = {
        id: crypto.randomUUID(),
        name: body.name.trim(),
        email: (body.email || "").trim(),
        phone: body.phone.trim(),
        whatsApp: (body.whatsApp || body.phone || "").trim(),
        numberOfRooms: String(rooms.length),
        rooms,
        startDate: body.startDate || new Date().toISOString().slice(0, 10),
        FixedMonthlyRent: String(body.FixedMonthlyRent || body.rent || 0),
        OtherMonthlyCost: body.OtherMonthlyCost || { description: "", value: "" },
        duePaymentCurrentMonth: String(body.duePaymentCurrentMonth || body.FixedMonthlyRent || body.rent || 0),
        paymentHistory: Array.isArray(body.paymentHistory) ? body.paymentHistory : [],
      };
      op.customers.push(customer);

      // Update room stats
      op.NumberOfRoomsTotal = String(parseInt(op.NumberOfRoomsTotal || "0") + rooms.length);
      op.NumberOfRoomsOccupied = String(op.customers.length);
      op.NumberOfRoomsFree = String(Math.max(0, parseInt(op.NumberOfRoomsTotal) - op.customers.length));

      audit(op.id, op.name, "ADD_CUSTOMER", `${customer.name} (rooms ${rooms.join(", ")})`);
      await saveStore();
      return jsonResponse(customer, 201);
    } catch {
      return errorResponse("بيانات العميل غير صالحة", 400);
    }
  }

  // ── PUT /api/customers/:id ─────────────────────────────────────
  const customerMatch = path.match(/^\/api\/customers\/([^/]+)$/);
  if (customerMatch && method === "PUT") {
    const session = requireOperator(req);
    if (!session) return errorResponse("هذا الإجراء متاح للمشغلين فقط", 403);
    const op = getOperator(session);
    if (!op) return errorResponse("المشغل غير موجود", 404);
    const customerId = customerMatch[1];

    try {
      const body = await req.json();
      const customer = op.customers.find(c => c.id === customerId);
      if (!customer) return errorResponse("العميل غير موجود", 404);

      customer.name = (body.name || customer.name).trim();
      customer.email = (body.email !== undefined ? body.email : customer.email).trim();
      customer.phone = (body.phone || customer.phone).trim();
      customer.whatsApp = (body.whatsApp || body.phone || customer.whatsApp).trim();
      if (body.rooms) customer.rooms = body.rooms;
      if (body.room) customer.rooms = [body.room.trim()];
      customer.numberOfRooms = String(customer.rooms.length);
      if (body.startDate) customer.startDate = body.startDate;
      if (body.FixedMonthlyRent) customer.FixedMonthlyRent = String(body.FixedMonthlyRent);
      if (body.rent) customer.FixedMonthlyRent = String(body.rent);
      if (body.OtherMonthlyCost) customer.OtherMonthlyCost = body.OtherMonthlyCost;
      if (body.duePaymentCurrentMonth) customer.duePaymentCurrentMonth = String(body.duePaymentCurrentMonth);

      audit(op.id, op.name, "EDIT_CUSTOMER", `${customer.name} (rooms ${customer.rooms.join(", ")})`);
      await saveStore();
      return jsonResponse(customer);
    } catch {
      return errorResponse("بيانات التعديل غير صالحة", 400);
    }
  }

  // ── DELETE /api/customers/:id ──────────────────────────────────
  if (customerMatch && method === "DELETE") {
    const session = requireOperator(req);
    if (!session) return errorResponse("هذا الإجراء متاح للمشغلين فقط", 403);
    const op = getOperator(session);
    if (!op) return errorResponse("المشغل غير موجود", 404);
    const customerId = customerMatch[1];

    const idx = op.customers.findIndex(c => c.id === customerId);
    if (idx === -1) return errorResponse("العميل غير موجود", 404);

    const [deleted] = op.customers.splice(idx, 1);
    op.deletedCustomers.push(deleted);

    // Update room stats
    op.NumberOfRoomsOccupied = String(op.customers.length);
    op.NumberOfRoomsFree = String(Math.max(0, parseInt(op.NumberOfRoomsTotal || "0") - op.customers.length));

    audit(op.id, op.name, "DELETE_CUSTOMER", `${deleted.name}`);
    await saveStore();
    return jsonResponse({ ok: true });
  }

  // ── PUT /api/customers/:id/payment ─────────────────────────────
  const paymentMatch = path.match(/^\/api\/customers\/([^/]+)\/payment$/);
  if (paymentMatch && (method === "PUT" || method === "DELETE")) {
    const session = requireOperator(req);
    if (!session) return errorResponse("هذا الإجراء متاح للمشغلين فقط", 403);
    const op = getOperator(session);
    if (!op) return errorResponse("المشغل غير موجود", 404);
    const customerId = paymentMatch[1];

    try {
      const body = method === "DELETE" ? await req.json() : await req.json();
      const { date, value } = body;
      const customer = op.customers.find(c => c.id === customerId);
      if (!customer) return errorResponse("العميل غير موجود", 404);

      const paymentDate = date || new Date().toISOString().slice(0, 10);
      const paymentValue = String(value || customer.duePaymentCurrentMonth || customer.FixedMonthlyRent || "0");

      if (method === "DELETE") {
        // Force-remove a specific payment entry
        const idx = customer.paymentHistory.findIndex(p => p.date === paymentDate);
        if (idx > -1) {
          customer.paymentHistory.splice(idx, 1);
          const revIdx = op.revenueAccount.findIndex(r => r.customer_id === customerId && r.date === paymentDate);
          if (revIdx > -1) op.revenueAccount.splice(revIdx, 1);
          audit(op.id, op.name, "DELETE_PAYMENT", `${customer.name} — ${paymentDate}`);
        }
      } else {
        // PUT — toggle
        const existingIdx = customer.paymentHistory.findIndex(p => p.date === paymentDate);
        if (existingIdx > -1) {
          customer.paymentHistory.splice(existingIdx, 1);
          const revIdx = op.revenueAccount.findIndex(r => r.customer_id === customerId && r.date === paymentDate);
          if (revIdx > -1) op.revenueAccount.splice(revIdx, 1);
          audit(op.id, op.name, "UNPAID", `${customer.name} — ${paymentDate}`);
        } else {
          customer.paymentHistory.push({ date: paymentDate, value: paymentValue });
          op.revenueAccount.push({ customer_id: customerId, payment: paymentValue, date: paymentDate });
          audit(op.id, op.name, "PAID", `${customer.name} — ${paymentDate} (${paymentValue})`);
        }
      }

      await saveStore();
      return jsonResponse({ paymentHistory: customer.paymentHistory });
    } catch {
      return errorResponse("بيانات الدفع غير صالحة", 400);
    }
  }

  // ── POST /api/customers/import ─────────────────────────────────
  if (path === "/api/customers/import" && method === "POST") {
    const session = requireOperator(req);
    if (!session) return errorResponse("هذا الإجراء متاح للمشغلين فقط", 403);
    const op = getOperator(session);
    if (!op) return errorResponse("المشغل غير موجود", 404);

    try {
      const { customers: importedCustomers } = await req.json();
      if (!Array.isArray(importedCustomers)) return errorResponse("ملف النسخة الاحتياطية غير صالح", 400);

      op.customers = importedCustomers.map((c: any) => ({
        id: c.id || crypto.randomUUID(),
        name: c.name,
        email: c.email || "",
        phone: c.phone || "",
        whatsApp: c.whatsApp || c.phone || "",
        numberOfRooms: c.numberOfRooms || String((c.rooms || []).length),
        rooms: c.rooms || (c.room ? [c.room] : []),
        startDate: c.startDate || "",
        FixedMonthlyRent: c.FixedMonthlyRent || c.rent || "0",
        OtherMonthlyCost: c.OtherMonthlyCost || { description: "", value: "" },
        duePaymentCurrentMonth: c.duePaymentCurrentMonth || c.FixedMonthlyRent || c.rent || "0",
        paymentHistory: Array.isArray(c.paymentHistory) ? c.paymentHistory : [],
      }));

      op.NumberOfRoomsOccupied = String(op.customers.length);
      const totalRooms = op.customers.reduce((s, c) => s + parseInt(c.numberOfRooms || "0"), 0);
      op.NumberOfRoomsTotal = String(totalRooms);
      op.NumberOfRoomsFree = "0";

      audit(op.id, op.name, "IMPORT_BACKUP", `${importedCustomers.length} customers imported`);
      await saveStore();
      return jsonResponse({ count: importedCustomers.length });
    } catch {
      return errorResponse("تعذر استيراد البيانات", 400);
    }
  }

  // ── GET /api/revenue ───────────────────────────────────────────
  if (path === "/api/revenue" && method === "GET") {
    const session = requireSession(req);
    if (!session) return errorResponse("غير مصرح", 401);
    const op = getOperator(session);
    if (!op) return errorResponse("المشغل غير موجود", 404);
    return jsonResponse(op.revenueAccount);
  }

  // ── GET /api/costs ─────────────────────────────────────────────
  if (path === "/api/costs" && method === "GET") {
    const session = requireSession(req);
    if (!session) return errorResponse("غير مصرح", 401);
    const op = getOperator(session);
    if (!op) return errorResponse("المشغل غير موجود", 404);
    return jsonResponse(op.costAccount);
  }

  // ── POST /api/costs ────────────────────────────────────────────
  if (path === "/api/costs" && method === "POST") {
    const session = requireOperator(req);
    if (!session) return errorResponse("هذا الإجراء متاح للمشغلين فقط", 403);
    const op = getOperator(session);
    if (!op) return errorResponse("المشغل غير موجود", 404);

    try {
      const { item, value, date, recurring } = await req.json();
      if (!item || !value) return errorResponse("البيانات غير مكتملة", 422);

      op.costAccount.push({
        item: String(item).trim(),
        value: String(value).trim(),
        date: String(date || new Date().toISOString().slice(0, 10)).trim(),
        recurring: String(recurring || "no").trim(),
      });
      audit(op.id, op.name, "ADD_COST", `${item}: ${value}`);
      await saveStore();
      return jsonResponse(op.costAccount, 201);
    } catch {
      return errorResponse("بيانات التكلفة غير صالحة", 400);
    }
  }

  // ── GET /api/audit ─────────────────────────────────────────────
  if (path === "/api/audit" && method === "GET") {
    const session = requireSession(req);
    if (!session) return errorResponse("غير مصرح", 401);
    const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
    const rows = [...store.audit_log]
      .filter(e => session.role === "admin" || e.operatorId === session.operatorId)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit);
    return jsonResponse(rows);
  }

  // ── GET /api/operators ─────────────────────────────────────────
  if (path === "/api/operators" && method === "GET") {
    const session = requireSession(req);
    if (!session || session.role !== "admin") return errorResponse("هذا الإجراء متاح للمدير فقط", 403);
    const rows = store.Operator.map(o => ({
      id: o.id,
      name: o.name,
      ownerName: o.ownerName,
      ownerPhone: o.ownerPhone,
      startDate: o.startDate,
      customerCount: o.customers.length,
    }));
    return jsonResponse(rows);
  }

  // ── POST /api/operators ────────────────────────────────────────
  if (path === "/api/operators" && method === "POST") {
    const session = requireSession(req);
    if (!session || session.role !== "admin") return errorResponse("هذا الإجراء متاح للمدير فقط", 403);

    try {
      const { name, ownerName, password, ownerPhone, ownerWhatsApp, ownerFawranNumber, ownerFawranName } = await req.json();
      if (!name || typeof name !== "string" || name.trim().length < 2)
        return errorResponse("اسم المشغل يجب أن يكون حرفين على الأقل", 422);
      if (!password || typeof password !== "string" || password.length < 4)
        return errorResponse("كلمة المرور يجب أن تكون 4 أحرف على الأقل", 422);

      const existing = store.Operator.find(o => o.name === name.trim());
      if (existing) return errorResponse("اسم المشغل موجود مسبقاً", 409);

      const hash = await Bun.password.hash(password);
      const op: Operator = {
        id: crypto.randomUUID(),
        name: name.trim(),
        ownerName: (ownerName || name).trim(),
        ownerPassword: hash,
        ownerPhone: (ownerPhone || "").trim(),
        ownerWhatsApp: (ownerWhatsApp || ownerPhone || "").trim(),
        ownerFawranNumber: (ownerFawranNumber || "").trim(),
        ownerFawranName: (ownerFawranName || "").trim(),
        startDate: new Date().toISOString().slice(0, 10),
        NumberOfRoomsTotal: "0",
        NumberOfRoomsOccupied: "0",
        NumberOfRoomsFree: "0",
        customers: [],
        deletedCustomers: [],
        revenueAccount: [],
        costAccount: [],
      };
      store.Operator.push(op);
      console.log(`[DATA] Created operator "${op.name}"`);
      await saveStore();
      return jsonResponse({ id: op.id, name: op.name, ownerName: op.ownerName }, 201);
    } catch {
      return errorResponse("بيانات المشغل غير صالحة", 400);
    }
  }

  // ── GET /api/deleted-customers ─────────────────────────────────
  if (path === "/api/deleted-customers" && method === "GET") {
    const session = requireOperator(req);
    if (!session) return errorResponse("هذا الإجراء متاح للمشغلين فقط", 403);
    const op = getOperator(session);
    if (!op) return errorResponse("المشغل غير موجود", 404);
    return jsonResponse(op.deletedCustomers);
  }

  // ── POST /api/deleted-customers/:id/restore ────────────────────
  const restoreMatch = path.match(/^\/api\/deleted-customers\/([^/]+)\/restore$/);
  if (restoreMatch && method === "POST") {
    const session = requireOperator(req);
    if (!session) return errorResponse("هذا الإجراء متاح للمشغلين فقط", 403);
    const op = getOperator(session);
    if (!op) return errorResponse("المشغل غير موجود", 404);
    const customerId = restoreMatch[1];

    const idx = op.deletedCustomers.findIndex(c => c.id === customerId);
    if (idx === -1) return errorResponse("العميل المحذوف غير موجود", 404);

    const [restored] = op.deletedCustomers.splice(idx, 1);
    op.customers.push(restored);

    op.NumberOfRoomsOccupied = String(op.customers.length);
    op.NumberOfRoomsFree = String(Math.max(0, parseInt(op.NumberOfRoomsTotal || "0") - op.customers.length));

    audit(op.id, op.name, "RESTORE_CUSTOMER", `${restored.name}`);
    await saveStore();
    return jsonResponse(restored);
  }

  // ── DELETE /api/deleted-customers/:id (permanent) ──────────────
  const deleteForeverMatch = path.match(/^\/api\/deleted-customers\/([^/]+)$/);
  if (deleteForeverMatch && method === "DELETE") {
    const session = requireOperator(req);
    if (!session) return errorResponse("هذا الإجراء متاح للمشغلين فقط", 403);
    const op = getOperator(session);
    if (!op) return errorResponse("المشغل غير موجود", 404);
    const customerId = deleteForeverMatch[1];

    const idx = op.deletedCustomers.findIndex(c => c.id === customerId);
    if (idx === -1) return errorResponse("العميل المحذوف غير موجود", 404);

    const [deleted] = op.deletedCustomers.splice(idx, 1);
    audit(op.id, op.name, "DELETE_FOREVER", `${deleted.name}`);
    await saveStore();
    return jsonResponse({ ok: true });
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

// ── Startup ──────────────────────────────────────────────────────────
console.log("🚀 Starting server...");
await loadStore();
await seedAdmin();
cleanupSessions();
console.log(`🚀 Server running at http://localhost:${PORT}`);
console.log(`   Store: ${DATA_FILE}  |  Rate limit: ${RATE_LIMIT_MAX}/min`);
