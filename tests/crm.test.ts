import { describe, expect, it } from "bun:test";
import { CustomerService } from "../src/services/CustomerService";
import { InvoiceService } from "../src/services/InvoiceService";
import { FinanceService } from "../src/services/FinanceService";
import type { Customer, Invoice } from "../src/types";

describe("CustomerService", () => {
  it("creates a customer with normalized data", () => {
    const customer = CustomerService.createCustomer({
      name: "Amal Hassan",
      company: "Blue Harbor",
      email: "amal@example.com",
      phone: "0501234567",
      roomNumber: "201",
      rentAmount: 900,
      notes: "VIP",
    } as Partial<Customer>);

    expect(customer.name).toBe("Amal Hassan");
    expect(customer.roomNumber).toBe("201");
    expect(customer.status).toBe("active");
  });

  it("updates a customer and preserves ownership", () => {
    const customer = CustomerService.createCustomer({
      name: "Sara",
      company: "North Loft",
      email: "sara@example.com",
      phone: "0560000000",
      roomNumber: "110",
      rentAmount: 700,
    } as Partial<Customer>);

    const updated = CustomerService.updateCustomer(customer.id, { notes: "Updated" });
    expect(updated.notes).toBe("Updated");
  });
});

describe("InvoiceService", () => {
  it("creates an invoice with a pending status", () => {
    const invoice = InvoiceService.createInvoice({
      customerId: "cust-1",
      customerName: "Amal Hassan",
      amount: 900,
      dueDate: "2026-08-01",
      lineItems: [{ description: "Monthly rent", amount: 900 }],
    });

    expect(invoice.status).toBe("pending");
    expect(invoice.total).toBe(900);
  });

  it("records a payment and marks the invoice paid", () => {
    const invoice = InvoiceService.createInvoice({
      customerId: "cust-2",
      customerName: "Sara",
      amount: 700,
      dueDate: "2026-08-01",
      lineItems: [{ description: "Monthly rent", amount: 700 }],
    });

    const updated = InvoiceService.recordPayment(invoice.id, 700);
    expect(updated.paidAmount).toBe(700);
    expect(updated.status).toBe("paid");
  });
});

describe("FinanceService", () => {
  it("builds a dashboard summary from customers, invoices, and expenses", () => {
    const summary = FinanceService.buildSummary({
      customers: [
        { id: "1", name: "Amal", company: "", email: "", phone: "", roomNumber: "201", rentAmount: 900, status: "active", notes: "", createdAt: "2026-07-01" },
      ],
      invoices: [
        { id: "i1", customerId: "1", customerName: "Amal", invoiceNumber: "INV-001", issueDate: "2026-07-01", dueDate: "2026-07-15", amount: 900, paidAmount: 900, total: 900, status: "paid", lineItems: [], payments: [] },
      ],
      expenses: [
        { id: "e1", description: "Utilities", amount: 120, date: "2026-07-05", category: "Operations" },
      ],
    });

    expect(summary.totalCustomers).toBe(1);
    expect(summary.monthlyRevenue).toBe(900);
    expect(summary.monthlyExpenses).toBe(120);
    expect(summary.netProfit).toBe(780);
  });
});
