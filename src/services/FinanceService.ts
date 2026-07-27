import type { Customer, Expense, Invoice } from "../types";

export class FinanceService {
  static buildSummary(payload: { customers: Customer[]; invoices: Invoice[]; expenses: Expense[] }) {
    const monthlyRevenue = payload.invoices.reduce((sum, invoice) => sum + invoice.paidAmount, 0);
    const monthlyExpenses = payload.expenses.reduce((sum, expense) => sum + expense.amount, 0);
    const outstanding = payload.invoices.filter((invoice) => invoice.status !== "paid").reduce((sum, invoice) => sum + Math.max(0, invoice.total - invoice.paidAmount), 0);

    return {
      totalCustomers: payload.customers.length,
      monthlyRevenue,
      monthlyExpenses,
      netProfit: monthlyRevenue - monthlyExpenses,
      outstanding,
      pendingInvoices: payload.invoices.filter((invoice) => invoice.status !== "paid").length,
    };
  }
}
