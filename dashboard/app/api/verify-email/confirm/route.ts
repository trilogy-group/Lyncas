import { NextResponse, type NextRequest } from "next/server";
import {
  createSupabaseServerClient,
  getUser,
} from "@/lib/supabase/server";

// POST /api/verify-email/confirm
//   body: { email: string, otp: string }
//
// Validates the OTP against the most recent un-verified row for
// (user_id, email). On success we stamp verified_at on the row AND
// flip user_profiles.digest_email_verified to true. On failure we
// return a generic 400 — leaking which step failed (wrong code vs
// expired) is fine for OTP usability but we don't expose stored
// codes back to the client.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RequestBody {
  email?: unknown;
  otp?: unknown;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
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
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const otp = typeof body.otp === "string" ? body.otp.trim() : "";
  if (!email) return jsonError("`email` is required", 400);
  if (!/^\d{6}$/.test(otp)) return jsonError("`otp` must be 6 digits", 400);

  const supabase = await createSupabaseServerClient();
  // Pull the most recent un-verified, non-expired row for this user+email.
  // Sorting by created_at desc means an OTP resend supersedes the prior
  // code naturally — the latest insert wins.
  const { data: rows, error } = await supabase
    .from("email_verifications")
    .select("id, otp, expires_at, verified_at")
    .eq("user_id", user.id)
    .ilike("email", email)
    .is("verified_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    return jsonError(
      `Could not look up verification: ${error.message}`,
      500,
    );
  }

  const row = (rows ?? [])[0] as
    | {
        id: string;
        otp: string;
        expires_at: string;
        verified_at: string | null;
      }
    | undefined;
  if (!row) {
    return jsonError(
      "No pending verification — request a new code first.",
      400,
    );
  }
  if (Date.parse(row.expires_at) < Date.now()) {
    return jsonError("Code expired — request a new one.", 400);
  }
  if (row.otp !== otp) {
    return jsonError("Incorrect code.", 400);
  }

  // Two writes: verifications row (audit) + user_profiles cache.
  const nowISO = new Date().toISOString();
  await supabase
    .from("email_verifications")
    .update({ verified_at: nowISO })
    .eq("id", row.id);
  // Upsert: if the profile row doesn't exist yet (race with first sign-in)
  // create it with verified flags set. The RLS WITH CHECK forces user_id =
  // auth.uid() so this can't write someone else's profile.
  await supabase
    .from("user_profiles")
    .upsert(
      {
        id: user.id,
        digest_email: email,
        digest_email_verified: true,
      },
      { onConflict: "id" },
    );

  return NextResponse.json({ ok: true });
}
