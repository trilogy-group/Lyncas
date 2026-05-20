import { NextResponse } from "next/server";
import {
  getProAmountPaise,
  getRazorpay,
  getRazorpayKeyId,
  isRazorpayConfigured,
} from "@/lib/razorpay";
import { getUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RequestBody {
  tier?: unknown;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  if (!isRazorpayConfigured()) {
    return jsonError(
      "Payments are not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.",
      503,
    );
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const tier = typeof body.tier === "string" ? body.tier : "";
  if (tier !== "pro") {
    return jsonError('Only tier "pro" can be purchased via checkout', 400);
  }

  const amount = getProAmountPaise();
  const user = await getUser();
  const receipt = `pro-${Date.now()}`;

  try {
    const razorpay = getRazorpay();
    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt,
      notes: {
        tier,
        user_id: user?.id ?? "",
      },
    });

    return NextResponse.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: getRazorpayKeyId(),
    });
  } catch (err) {
    console.error("[razorpay/create-order]", err);
    return jsonError("Failed to create payment order", 500);
  }
}
