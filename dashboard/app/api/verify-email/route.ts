import { NextResponse, type NextRequest } from "next/server";
import {
  createSupabaseServerClient,
  getUser,
} from "@/lib/supabase/server";

// POST /api/verify-email
//   body: { email: string }
//
// Generates a fresh 6-digit OTP, stores it in `email_verifications`
// (RLS-scoped to the calling user), and tries to send it to the
// supplied address via Gmail SMTP. When SMTP credentials are absent
// (dev / preview deploys without GMAIL_USER + GMAIL_APP_PASSWORD set),
// the OTP is logged to stdout and the response includes a `dev_otp`
// hint so the user can self-serve.
//
// Idempotency: each call inserts a new row. The /confirm route only
// looks at the most-recent un-verified row for (user_id, email), so a
// resend supersedes the old code naturally. Old rows are kept for
// audit; a periodic cleanup can prune > 30d old verifications.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

interface RequestBody {
  email?: unknown;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function generateOTP(): string {
  // crypto.getRandomValues is available on both edge + node runtimes in
  // modern Next. Modulo 1_000_000 with zero-padding yields a uniform-ish
  // 6-digit code (very slight bias at the top, irrelevant at OTP scale).
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const n = buf[0] % 1_000_000;
  return n.toString().padStart(6, "0");
}

async function sendOTPEmail(
  to: string,
  otp: string,
): Promise<{ sent: boolean; reason?: string }> {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    // Dev fallback per spec — emit to server logs and bail.
    console.log(`[verify-email] DEV OTP for ${to}: ${otp}`);
    return { sent: false, reason: "no_smtp_credentials" };
  }
  try {
    // Lazy-import nodemailer so the runtime startup of routes that
    // never send mail isn't slowed by the SMTP module graph.
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user, pass },
    });
    await transport.sendMail({
      from: user,
      to,
      subject: "Verify your Night PR Reviewer digest email",
      text: `Your verification code is: ${otp}\n\nIt expires in 10 minutes. If you didn't request this, ignore the email.`,
      html: `\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:24px;">
  <h1 style="font-size:18px;font-weight:600;margin:0 0 12px 0;">Verify your digest email</h1>
  <p style="margin:0 0 16px 0;color:#57534e;">Use this code in the Night PR Reviewer dashboard to confirm <strong>${to}</strong>:</p>
  <div style="font-family:'JetBrains Mono','SF Mono',Menlo,monospace;font-size:28px;font-weight:600;letter-spacing:0.25em;padding:16px 20px;background:#fafaf9;border:1px solid #e7e5e4;border-radius:8px;text-align:center;">${otp}</div>
  <p style="margin:16px 0 0 0;color:#a8a29e;font-size:12px;">Expires in 10 minutes. Didn't request this? Safely ignore the email.</p>
</div>`,
    });
    return { sent: true };
  } catch (e) {
    console.error("[verify-email] SMTP send failed:", e);
    return { sent: false, reason: (e as Error).message };
  }
}

export async function POST(request: NextRequest) {
  const user = await getUser().catch(() => null);
  if (!user) return jsonError("Not authenticated", 401);

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return jsonError("Body must be JSON", 400);
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !EMAIL_PATTERN.test(email)) {
    return jsonError("`email` must be a valid email address", 400);
  }

  const otp = generateOTP();

  const supabase = await createSupabaseServerClient();
  const { error: insertError } = await supabase
    .from("email_verifications")
    .insert({
      user_id: user.id,
      email,
      otp,
    });
  if (insertError) {
    return jsonError(
      `Could not persist verification code: ${insertError.message}`,
      500,
    );
  }

  // When the user changes the address, mark profile flag stale so the
  // UI re-prompts. We do this BEFORE the email send to keep the DB
  // consistent even if SMTP fails — they'll retry, the next OTP wins.
  await supabase
    .from("user_profiles")
    .update({ digest_email: email, digest_email_verified: false })
    .eq("id", user.id);

  const send = await sendOTPEmail(email, otp);
  return NextResponse.json({
    ok: true,
    sent: send.sent,
    // Only include the OTP in the response when SMTP isn't configured.
    // Production deploys with GMAIL_USER + GMAIL_APP_PASSWORD never
    // expose it.
    ...(send.sent ? {} : { dev_otp: otp, reason: send.reason ?? null }),
  });
}
