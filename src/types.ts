export interface Customer {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  roomNumber: string;
  rentAmount: number;
  status: "active" | "inactive" | "pending";
  notes: string;
  createdAt: string;
}

export interface InvoiceLineItem {
  description: string;
  amount: number;
}

export interface PaymentRecord {
  id: string;
  amount: number;
  date: string;
  note: string;
}

export interface Invoice {
  id: string;
  customerId: string;
  customerName: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  amount: number;
  paidAmount: number;
  total: number;
  status: "draft" | "pending" | "paid" | "overdue";
  lineItems: InvoiceLineItem[];
  payments: PaymentRecord[];
}

export interface Expense {
  id: string;
  description: string;
  amount: number;
  date: string;
  category: string;
}

export interface Session {
  token: string;
  username: string;
  role: "admin";
  createdAt: number;
}

export interface Store {
  admin: {
    username: string;
    passwordHash: string;
  };
  customers: Customer[];
  invoices: Invoice[];
  expenses: Expense[];
  sessions: Session[];
}
