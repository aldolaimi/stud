import { serve, file } from "bun";
import { createHash } from "node:crypto";
import { CustomerService } from "./src/services/CustomerService";
import { FinanceService } from "./src/services/FinanceService";
import { InvoiceService } from "./src/services/InvoiceService";
import { StorageService } from "./src/services/StorageService";
import type { Customer, Expense, Invoice, Session, Store } from "./src/types";

const PORT = Number(process.env.PORT || 3002);

function hashPassword(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readBody(req: Request) {
  return req.json();
}

function createSession(username: string): Session {
  const token = crypto.randomUUID();
  return { token, username, role: "admin", createdAt: Date.now() };
}

function requireSession(req: Request, store: Store) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const session = store.sessions.find((entry) => entry.token === token);
  return session || null;
}

function ensureSeed(store: Store) {
  if (!store.admin.passwordHash) {
    store.admin.passwordHash = hashPassword("admin123");
    StorageService.saveStore(store);
  }
}

function syncServices(store: Store) {
  CustomerService.seed(store.customers);
  InvoiceService.seed(store.invoices);
}

async function loadAppState() {
  const store = StorageService.loadStore();
  ensureSeed(store);
  syncServices(store);
  return store;
}

let store = await loadAppState();

async function saveState() {
  store.customers = CustomerService.list();
  store.invoices = InvoiceService.list();
  StorageService.saveStore(store);
}

async function handleAPI(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/api/login" && req.method === "POST") {
    const body = await readBody(req) as { username?: string; password?: string };
    if (!body.username || !body.password) {
      return Response.json({ error: "Missing credentials" }, { status: 400 });
    }

    if (body.username === store.admin.username && hashPassword(body.password) === store.admin.passwordHash) {
      const session = createSession(body.username);
      store.sessions.push(session);
      StorageService.saveStore(store);
      return Response.json({ token: session.token, username: session.username });
    }

    return Response.json({ error: "Invalid login" }, { status: 401 });
  }

  if (path === "/api/session" && req.method === "GET") {
    const session = requireSession(req, store);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return Response.json({ username: session.username });
  }

  if (path === "/api/logout" && req.method === "POST") {
    const session = requireSession(req, store);
    if (session) {
      store.sessions = store.sessions.filter((entry) => entry.token !== session.token);
      StorageService.saveStore(store);
    }
    return Response.json({ ok: true });
  }

  if (path === "/api/dashboard" && req.method === "GET") {
    const session = requireSession(req, store);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const summary = FinanceService.buildSummary({ customers: store.customers, invoices: store.invoices, expenses: store.expenses });
    return Response.json(summary);
  }

  if (path === "/api/customers" && req.method === "GET") {
    const session = requireSession(req, store);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return Response.json(store.customers);
  }

  if (path === "/api/customers" && req.method === "POST") {
    const session = requireSession(req, store);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await readBody(req) as Partial<Customer>;
    const customer = CustomerService.createCustomer(body);
    store.customers = CustomerService.list();
    await saveState();
    return Response.json(customer, { status: 201 });
  }

  if (path.startsWith("/api/customers/") && req.method === "PUT") {
    const session = requireSession(req, store);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const id = path.split("/").at(-1) || "";
    const body = await readBody(req) as Partial<Customer>;
    const customer = CustomerService.updateCustomer(id, body);
    store.customers = CustomerService.list();
    await saveState();
    return Response.json(customer);
  }

  if (path.startsWith("/api/customers/") && req.method === "DELETE") {
    const session = requireSession(req, store);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const id = path.split("/").at(-1) || "";
    CustomerService.deleteCustomer(id);
    store.customers = CustomerService.list();
    await saveState();
    return Response.json({ ok: true });
  }

  if (path === "/api/invoices" && req.method === "GET") {
    const session = requireSession(req, store);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return Response.json(store.invoices);
  }

  if (path === "/api/invoices" && req.method === "POST") {
    const session = requireSession(req, store);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await readBody(req) as Partial<Invoice>;
    const invoice = InvoiceService.createInvoice(body);
    store.invoices = InvoiceService.list();
    await saveState();
    return Response.json(invoice, { status: 201 });
  }

  if (path.startsWith("/api/invoices/") && path.endsWith("/pay") && req.method === "POST") {
    const session = requireSession(req, store);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const id = path.split("/")[3] || "";
    const body = await readBody(req) as { amount?: number };
    const invoice = InvoiceService.recordPayment(id, Number(body.amount || 0));
    store.invoices = InvoiceService.list();
    await saveState();
    return Response.json(invoice);
  }

  if (path === "/api/expenses" && req.method === "GET") {
    const session = requireSession(req, store);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return Response.json(store.expenses);
  }

  if (path === "/api/expenses" && req.method === "POST") {
    const session = requireSession(req, store);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await readBody(req) as Expense;
    store.expenses.push({ ...body, id: crypto.randomUUID() });
    await saveState();
    return Response.json(store.expenses[store.expenses.length - 1], { status: 201 });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return handleAPI(req);

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
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

console.log(`CRM server running on http://localhost:${PORT}`);
