import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Store } from "../types";

export class StorageService {
  static filePath = join(process.cwd(), "data.json");

  static loadStore(): Store {
    if (!existsSync(this.filePath)) {
      const seed: Store = {
        admin: {
          username: "admin",
          passwordHash: "",
        },
        customers: [],
        invoices: [],
        expenses: [],
        sessions: [],
      };
      this.saveStore(seed);
      return seed;
    }

    const raw = readFileSync(this.filePath, "utf8");
    return JSON.parse(raw) as Store;
  }

  static saveStore(store: Store) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(store, null, 2));
  }
}
