import crypto from "node:crypto";
import Razorpay from "razorpay";

const DEFAULT_PRO_AMOUNT_PAISE = 290_000;

let client: Razorpay | null = null;

export function getRazorpayKeyId(): string {
  return (
    process.env.RAZORPAY_KEY_ID ??
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ??
    ""
  );
}

export function getRazorpayKeySecret(): string {
  return process.env.RAZORPAY_KEY_SECRET ?? "";
}

export function isRazorpayConfigured(): boolean {
  return Boolean(getRazorpayKeyId() && getRazorpayKeySecret());
}

export function getProAmountPaise(): number {
  const raw = process.env.RAZORPAY_PRO_AMOUNT_PAISE;
  if (!raw) return DEFAULT_PRO_AMOUNT_PAISE;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PRO_AMOUNT_PAISE;
}

export function getRazorpay(): Razorpay {
  if (!isRazorpayConfigured()) {
    throw new Error(
      "Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.",
    );
  }
  if (!client) {
    client = new Razorpay({
      key_id: getRazorpayKeyId(),
      key_secret: getRazorpayKeySecret(),
    });
  }
  return client;
}

export function verifyPaymentSignature(
  orderId: string,
  paymentId: string,
  signature: string,
): boolean {
  const secret = getRazorpayKeySecret();
  const body = `${orderId}|${paymentId}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  return expected === signature;
}

export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return expected === signature;
}
