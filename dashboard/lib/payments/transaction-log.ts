import fs from "node:fs/promises";
import path from "node:path";

export interface TransactionRecord {
  ts: string;
  tier: string;
  order_id: string;
  payment_id: string;
  amount_paise: number;
  currency: string;
  status: string;
  user_id: string | null;
  email: string | null;
  source: "verify" | "webhook";
}

const LOG_FILE = path.join(process.cwd(), "data", "transactions.txt");

async function ensureLogFile(): Promise<void> {
  const dir = path.dirname(LOG_FILE);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.access(LOG_FILE);
  } catch {
    await fs.writeFile(LOG_FILE, "", "utf8");
  }
}

export async function paymentIdExists(paymentId: string): Promise<boolean> {
  try {
    await ensureLogFile();
    const content = await fs.readFile(LOG_FILE, "utf8");
    return content.includes(`"payment_id":"${paymentId}"`);
  } catch {
    return false;
  }
}

export async function appendTransaction(
  record: TransactionRecord,
): Promise<void> {
  const exists = await paymentIdExists(record.payment_id);
  if (exists) return;

  await ensureLogFile();
  const line = `${JSON.stringify(record)}\n`;
  await fs.appendFile(LOG_FILE, line, "utf8");
}
