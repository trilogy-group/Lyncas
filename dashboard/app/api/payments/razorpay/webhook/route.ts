import { NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/razorpay";
import {
  appendTransaction,
  paymentIdExists,
} from "@/lib/payments/transaction-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RazorpayPaymentEntity {
  id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  email?: string;
  notes?: Record<string, string>;
}

interface RazorpayWebhookPayload {
  event?: string;
  payload?: {
    payment?: {
      entity?: RazorpayPaymentEntity;
    };
  };
}

export async function POST(request: Request) {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 503 },
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature") ?? "";

  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let payload: RazorpayWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as RazorpayWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (payload.event !== "payment.captured") {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const payment = payload.payload?.payment?.entity;
  if (!payment?.id || !payment.order_id) {
    return NextResponse.json({ error: "Missing payment entity" }, { status: 400 });
  }

  if (await paymentIdExists(payment.id)) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  await appendTransaction({
    ts: new Date().toISOString(),
    tier: payment.notes?.tier ?? "pro",
    order_id: payment.order_id,
    payment_id: payment.id,
    amount_paise: payment.amount ?? 0,
    currency: payment.currency ?? "INR",
    status: payment.status ?? "captured",
    user_id: payment.notes?.user_id || null,
    email: payment.email ?? null,
    source: "webhook",
  });

  return NextResponse.json({ ok: true });
}
