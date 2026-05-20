import { NextResponse } from "next/server";
import {
  getProAmountPaise,
  isRazorpayConfigured,
  verifyPaymentSignature,
} from "@/lib/razorpay";
import { appendTransaction } from "@/lib/payments/transaction-log";
import { getUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RequestBody {
  razorpay_order_id?: unknown;
  razorpay_payment_id?: unknown;
  razorpay_signature?: unknown;
  tier?: unknown;
  email?: unknown;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  if (!isRazorpayConfigured()) {
    return jsonError("Payments are not configured", 503);
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const orderId =
    typeof body.razorpay_order_id === "string" ? body.razorpay_order_id : "";
  const paymentId =
    typeof body.razorpay_payment_id === "string"
      ? body.razorpay_payment_id
      : "";
  const signature =
    typeof body.razorpay_signature === "string" ? body.razorpay_signature : "";
  const tier = typeof body.tier === "string" ? body.tier : "pro";
  const email =
    typeof body.email === "string" && body.email.includes("@")
      ? body.email
      : null;

  if (!orderId || !paymentId || !signature) {
    return jsonError("Missing payment verification fields", 400);
  }

  if (!verifyPaymentSignature(orderId, paymentId, signature)) {
    return jsonError("Invalid payment signature", 400);
  }

  const user = await getUser();

  await appendTransaction({
    ts: new Date().toISOString(),
    tier,
    order_id: orderId,
    payment_id: paymentId,
    amount_paise: getProAmountPaise(),
    currency: "INR",
    status: "captured",
    user_id: user?.id ?? null,
    email,
    source: "verify",
  });

  return NextResponse.json({ ok: true });
}
