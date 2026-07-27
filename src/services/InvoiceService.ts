import type { Invoice, PaymentRecord } from "../types";

export class InvoiceService {
  private static invoices: Invoice[] = [];

  static seed(initial: Invoice[]) {
    this.invoices = initial;
  }

  static list(): Invoice[] {
    return [...this.invoices].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }

  static createInvoice(input: Partial<Invoice>): Invoice {
    const invoice: Invoice = {
      id: crypto.randomUUID(),
      customerId: String(input.customerId || ""),
      customerName: String(input.customerName || ""),
      invoiceNumber: String(input.invoiceNumber || `INV-${Date.now()}`),
      issueDate: String(input.issueDate || new Date().toISOString().slice(0, 10)),
      dueDate: String(input.dueDate || new Date().toISOString().slice(0, 10)),
      amount: Number(input.amount || 0),
      paidAmount: 0,
      total: Number(input.amount || 0),
      status: "pending",
      lineItems: (input.lineItems || []).map((item) => ({ description: item.description, amount: Number(item.amount || 0) })),
      payments: [],
    };

    this.invoices.push(invoice);
    return invoice;
  }

  static recordPayment(invoiceId: string, amount: number): Invoice {
    const invoice = this.invoices.find((entry) => entry.id === invoiceId);
    if (!invoice) throw new Error("Invoice not found");

    const payment: PaymentRecord = {
      id: crypto.randomUUID(),
      amount,
      date: new Date().toISOString().slice(0, 10),
      note: "Paid",
    };

    invoice.payments.push(payment);
    invoice.paidAmount = invoice.payments.reduce((sum, entry) => sum + entry.amount, 0);
    invoice.status = invoice.paidAmount >= invoice.total ? "paid" : "pending";

    return invoice;
  }
}
