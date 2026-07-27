const state = {
  authToken: localStorage.getItem("crmToken") || "",
  view: "dashboard",
  dashboard: null,
  customers: [],
  invoices: [],
  expenses: [],
};

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.authToken) headers.Authorization = `Bearer ${state.authToken}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function render() {
  const app = document.getElementById("app");
  if (!state.authToken) {
    app.innerHTML = `
      <div class="auth-screen">
        <div class="auth-card">
          <h1>Northstar CRM</h1>
          <p>Professional leasing and customer management platform.</p>
          <form id="loginForm">
            <label>Username<input name="username" required /></label>
            <label>Password<input name="password" type="password" required /></label>
            <button type="submit">Sign in</button>
          </form>
        </div>
      </div>
    `;
    document.getElementById("loginForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const payload = Object.fromEntries(new FormData(form));
      try {
        const result = await api("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        state.authToken = result.token;
        localStorage.setItem("crmToken", result.token);
        await boot();
      } catch (error) {
        alert(error.message);
      }
    });
    return;
  }

  app.innerHTML = `
    <div class="app-shell">
      <header>
        <div class="brand">
          <div class="brand-badge">NS</div>
          <div>
            <h2 style="margin:0">Northstar CRM</h2>
            <div style="color:var(--muted)">Lease operations • invoices • expenses</div>
          </div>
        </div>
        <div class="actions">
          <button class="secondary" data-view="dashboard">Dashboard</button>
          <button class="secondary" data-view="customers">Customers</button>
          <button class="secondary" data-view="invoices">Invoices</button>
          <button class="secondary" data-view="expenses">Expenses</button>
          <button class="danger" id="logoutBtn">Logout</button>
        </div>
      </header>

      <section class="grid stats-grid">
        <div class="card stat-card">
          <div class="label">Customers</div>
          <div class="value" id="statCustomers">0</div>
        </div>
        <div class="card stat-card">
          <div class="label">Monthly Revenue</div>
          <div class="value" id="statRevenue">0</div>
        </div>
        <div class="card stat-card">
          <div class="label">Monthly Expenses</div>
          <div class="value" id="statExpenses">0</div>
        </div>
        <div class="card stat-card">
          <div class="label">Net Profit</div>
          <div class="value" id="statProfit">0</div>
        </div>
      </section>

      <div class="panel">
        <div class="card form-card" id="mainPanel"></div>
        <div class="card" id="sidePanel"></div>
      </div>
    </div>
  `;

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.getAttribute("data-view");
      renderPanel();
    });
  });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST" });
    } catch {}
    localStorage.removeItem("crmToken");
    state.authToken = "";
    render();
  });

  renderPanel();
}

async function boot() {
  try {
    const [dashboard, customers, invoices, expenses] = await Promise.all([
      api("/api/dashboard"),
      api("/api/customers"),
      api("/api/invoices"),
      api("/api/expenses"),
    ]);
    state.dashboard = dashboard;
    state.customers = customers;
    state.invoices = invoices;
    state.expenses = expenses;
    render();
  } catch (error) {
    alert(error.message);
  }
}

function renderPanel() {
  if (!state.dashboard) return;
  document.getElementById("statCustomers").textContent = state.dashboard.totalCustomers;
  document.getElementById("statRevenue").textContent = `${state.dashboard.monthlyRevenue} QR`;
  document.getElementById("statExpenses").textContent = `${state.dashboard.monthlyExpenses} QR`;
  document.getElementById("statProfit").textContent = `${state.dashboard.netProfit} QR`;

  const mainPanel = document.getElementById("mainPanel");
  const sidePanel = document.getElementById("sidePanel");

  if (state.view === "dashboard") {
    mainPanel.innerHTML = `
      <h2>Executive summary</h2>
      <p style="color:var(--muted)">Stay ahead of occupancy, payments, and day-to-day operations.</p>
      <div class="grid" style="margin-top:16px">
        <div class="card" style="background:rgba(255,255,255,0.03)">
          <div class="label">Outstanding balance</div>
          <div class="value">${state.dashboard.outstanding} QR</div>
        </div>
        <div class="card" style="background:rgba(255,255,255,0.03)">
          <div class="label">Pending invoices</div>
          <div class="value">${state.dashboard.pendingInvoices}</div>
        </div>
      </div>
    `;
    sidePanel.innerHTML = `
      <h3>Quick actions</h3>
      <div style="display:grid;gap:10px">
        <button data-view="customers">Add customer</button>
        <button class="secondary" data-view="invoices">Create invoice</button>
      </div>
    `;
    return;
  }

  if (state.view === "customers") {
    mainPanel.innerHTML = `
      <h2>Customers</h2>
      <form id="customerForm">
        <div class="form-row">
          <label>Name<input name="name" required /></label>
          <label>Company<input name="company" /></label>
        </div>
        <div class="form-row">
          <label>Email<input name="email" type="email" /></label>
          <label>Phone<input name="phone" /></label>
        </div>
        <div class="form-row">
          <label>Room<input name="roomNumber" /></label>
          <label>Rent<input name="rentAmount" type="number" min="0" required /></label>
        </div>
        <label>Status<select name="status"><option value="active">Active</option><option value="pending">Pending</option><option value="inactive">Inactive</option></select></label>
        <label>Notes<textarea name="notes" rows="3"></textarea></label>
        <button type="submit">Save customer</button>
      </form>
    `;
    sidePanel.innerHTML = `
      <h3>Customer list</h3>
      <div style="display:grid;gap:10px">
        ${state.customers.map((customer) => `
          <div class="card" style="background:rgba(255,255,255,0.03)">
            <strong>${customer.name}</strong><br />
            <span style="color:var(--muted)">${customer.company || "No company"}</span>
            <div style="margin-top:8px"><span class="badge ${customer.status === "active" ? "success" : customer.status === "pending" ? "warning" : "danger"}">${customer.status}</span></div>
          </div>
        `).join("")}
      </div>
    `;
    document.getElementById("customerForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(event.currentTarget));
      payload.rentAmount = Number(payload.rentAmount || 0);
      await api("/api/customers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      await boot();
    });
    return;
  }

  if (state.view === "invoices") {
    mainPanel.innerHTML = `
      <h2>Invoices</h2>
      <form id="invoiceForm">
        <div class="form-row">
          <label>Customer Name<input name="customerName" required /></label>
          <label>Invoice Number<input name="invoiceNumber" required /></label>
        </div>
        <div class="form-row">
          <label>Due Date<input name="dueDate" type="date" required /></label>
          <label>Amount<input name="amount" type="number" min="0" required /></label>
        </div>
        <button type="submit">Create invoice</button>
      </form>
    `;
    sidePanel.innerHTML = `
      <h3>Recent invoices</h3>
      <div style="display:grid;gap:10px">
        ${state.invoices.map((invoice) => `
          <div class="card" style="background:rgba(255,255,255,0.03)">
            <strong>${invoice.invoiceNumber}</strong><br />
            <span style="color:var(--muted)">${invoice.customerName}</span><br />
            <div style="margin-top:8px"><span class="badge ${invoice.status === "paid" ? "success" : invoice.status === "pending" ? "warning" : "danger"}">${invoice.status}</span></div>
          </div>
        `).join("")}
      </div>
    `;
    document.getElementById("invoiceForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(event.currentTarget));
      payload.amount = Number(payload.amount || 0);
      await api("/api/invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      await boot();
    });
    return;
  }

  if (state.view === "expenses") {
    mainPanel.innerHTML = `
      <h2>Expenses</h2>
      <form id="expenseForm">
        <div class="form-row">
          <label>Description<input name="description" required /></label>
          <label>Category<input name="category" required /></label>
        </div>
        <div class="form-row">
          <label>Date<input name="date" type="date" required /></label>
          <label>Amount<input name="amount" type="number" min="0" required /></label>
        </div>
        <button type="submit">Save expense</button>
      </form>
    `;
    sidePanel.innerHTML = `
      <h3>Expense log</h3>
      <div style="display:grid;gap:10px">
        ${state.expenses.map((expense) => `
          <div class="card" style="background:rgba(255,255,255,0.03)">
            <strong>${expense.description}</strong><br />
            <span style="color:var(--muted)">${expense.category}</span><br />
            <div style="margin-top:8px">${expense.amount} QR</div>
          </div>
        `).join("")}
      </div>
    `;
    document.getElementById("expenseForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(event.currentTarget));
      payload.amount = Number(payload.amount || 0);
      await api("/api/expenses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      await boot();
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", async () => {
    if (state.authToken) {
      try {
        await api("/api/session");
        await boot();
      } catch {
        localStorage.removeItem("crmToken");
        state.authToken = "";
        render();
      }
    } else {
      render();
    }
  });
} else {
  render();
}
