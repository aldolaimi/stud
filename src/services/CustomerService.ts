import type { Customer } from "../types";

export class CustomerService {
  private static customers: Customer[] = [];

  static seed(initial: Customer[]) {
    this.customers = initial;
  }

  static list(): Customer[] {
    return [...this.customers].sort((a, b) => a.name.localeCompare(b.name));
  }

  static createCustomer(input: Partial<Customer>): Customer {
    const customer: Customer = {
      id: crypto.randomUUID(),
      name: String(input.name || "").trim(),
      company: String(input.company || "").trim(),
      email: String(input.email || "").trim(),
      phone: String(input.phone || "").trim(),
      roomNumber: String(input.roomNumber || "").trim(),
      rentAmount: Number(input.rentAmount || 0),
      status: (input.status as Customer["status"]) || "active",
      notes: String(input.notes || "").trim(),
      createdAt: new Date().toISOString().slice(0, 10),
    };

    this.customers.push(customer);
    return customer;
  }

  static updateCustomer(id: string, updates: Partial<Customer>): Customer {
    const customer = this.customers.find((entry) => entry.id === id);
    if (!customer) throw new Error("Customer not found");

    Object.assign(customer, updates);
    return customer;
  }

  static deleteCustomer(id: string): void {
    this.customers = this.customers.filter((customer) => customer.id !== id);
  }
}
