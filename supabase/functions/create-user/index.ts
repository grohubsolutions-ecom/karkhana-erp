// =====================================================================
//  Edge Function: create-user
//  Manages login accounts from inside the app — SECURELY.
//  The service-role key lives ONLY here on Supabase's servers, never in
//  the browser. Every call first checks the CALLER is a signed-in admin
//  with the 'users.manage' permission.
//
//  Actions:
//    { action: "create", email?, phone?, password, full_name?, role_id? }
//    { action: "delete", user_id }
//    { action: "reset_password", user_id, new_password }
//    { action: "change_email", user_id, new_email }   // H309 (3 Nov 2026)
//    { action: "set_status", user_id, status }        // N4 (20 Nov 2026)
//
//  Login by phone (no SMS): if a user has no email, we create them with an
//  internal email (<digits>@karkhana.local) and store their phone. They
//  sign in with phone + password; forgot-password = admin resets it here.
//
//  Auto-provided env vars (you do NOT set these):
//    SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
const digits = (s: string) => s.replace(/\D/g, "");

/* H309: a plain, strict RFC-5322-ish email check — enough to catch typos
   (missing @, trailing spaces, no TLD) without rejecting valid addresses the
   way an over-tight regex would. Supabase will do its own stricter check
   underneath; this one just saves a round trip for the obvious cases. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* N4: a blocked login. Supabase's ban stops sign-in AND refreshing an existing
   session, so a person already signed in is out within the hour (their current
   access token simply isn't renewed). ~100 years = "until unblocked". */
const BAN_FOREVER = "876000h";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Not signed in." }, 401);

    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const caller = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: allowed, error: permErr } = await caller.rpc("has_permission", { p_permission_code: "users.manage" });
    if (permErr) return json({ error: permErr.message }, 400);
    if (!allowed) return json({ error: "You do not have permission to manage users." }, 403);

    const jwt = authHeader.replace("Bearer ", "");
    const { data: meData } = await caller.auth.getUser(jwt);
    const callerId = meData?.user?.id ?? null;

    const admin = createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "create");

    async function isSuper(id: string | null) {
      if (!id) return false;
      const { data } = await admin.from("app_users").select("is_super_admin").eq("id", id).maybeSingle();
      return !!data?.is_super_admin;
    }

    /* N4: block or unblock a login, and keep app_users.status in step.
       "Inactive" used to be only a label — nothing at sign-in or in the
       permission checks read it, so an inactive person could still sign in
       and see everything their role allowed. */
    async function setLoginBlocked(userId: string, blocked: boolean) {
      const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: blocked ? BAN_FOREVER : "none" });
      return error;
    }

    // ------------------------------- DELETE -------------------------------
    if (action === "delete") {
      const userId = String(body.user_id ?? "");
      if (!userId) return json({ error: "user_id is required." }, 400);
      if (userId === callerId) return json({ error: "You cannot remove your own account." }, 400);
      if (await isSuper(userId)) return json({ error: "You cannot remove a Super Admin account." }, 400);
      await admin.from("user_roles").delete().eq("user_id", userId);
      const { error: delErr } = await admin.auth.admin.deleteUser(userId); // cascades app_users
      if (!delErr) return json({ ok: true }, 200);

      /* N4: "Database error deleting user". 37 tables record who did what
         (tasks, stock movements, GRNs, articles, ad expenses…) and refuse to
         let that person be deleted. Deleting would erase whose work it was, so
         instead the login is switched off for good: blocked from signing in,
         no role (removed above), status inactive. Their history keeps their
         name, and they can be brought back by setting Status to Active. */
      if (/database error/i.test(delErr.message)) {
        const banErr = await setLoginBlocked(userId, true);
        if (banErr) return json({ error: banErr.message }, 400);
        await admin.from("app_users").update({ status: "inactive" }).eq("id", userId);
        return json({ ok: true, disabled: true }, 200);
      }
      return json({ error: delErr.message }, 400);
    }

    // ------------------------------ SET STATUS ----------------------------
    if (action === "set_status") {
      const userId = String(body.user_id ?? "");
      const status = String(body.status ?? "");
      if (!userId || !["active", "inactive", "suspended"].includes(status)) {
        return json({ error: "user_id and a valid status are required." }, 400);
      }
      if (userId === callerId && status !== "active") return json({ error: "You cannot switch off your own login." }, 400);
      if (await isSuper(userId) && userId !== callerId && !(await isSuper(callerId))) {
        return json({ error: "Only a Super Admin can change a Super Admin's status." }, 400);
      }
      const banErr = await setLoginBlocked(userId, status !== "active");
      if (banErr) return json({ error: banErr.message }, 400);
      const { error: stErr } = await admin.from("app_users").update({ status }).eq("id", userId);
      if (stErr) return json({ error: stErr.message }, 400);
      return json({ ok: true, status }, 200);
    }

    // --------------------------- RESET PASSWORD ---------------------------
    if (action === "reset_password") {
      const userId = String(body.user_id ?? "");
      const newPassword = String(body.new_password ?? "");
      if (!userId || !newPassword) return json({ error: "user_id and new_password are required." }, 400);
      if (newPassword.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);
      if (await isSuper(userId) && userId !== callerId && !(await isSuper(callerId))) {
        return json({ error: "Only a Super Admin can reset a Super Admin's password." }, 400);
      }
      const { error: upErr } = await admin.auth.admin.updateUserById(userId, { password: newPassword });
      if (upErr) return json({ error: upErr.message }, 400);
      await admin.from("app_users").update({ must_change_password: true }).eq("id", userId);
      return json({ ok: true }, 200);
    }

    // ---------------------------- CHANGE EMAIL ----------------------------
    /* H309 (3 Nov 2026) — Zeeshan asked for an admin-side way to change a
       user's email. Previously the only way was to delete and recreate the
       account, which lost everything linked by user_id (roles, attendance,
       their notification history, etc).

       This action:
         • validates the new email is well-formed
         • refuses if a Super Admin's email is being changed by anyone except
           another Super Admin (same rule reset_password uses)
         • updates BOTH auth.users (so the user signs in with the new email)
           AND app_users.email (so the UI shows it). email_confirm:true skips
           Supabase's confirmation email — the admin is making the change on
           the user's behalf, so an email asking them to confirm would be
           sent to an address they haven't been told about yet.
         • unlike a reset, does NOT force a password change; the password is
           independent of the email and asking for both at once breaks logins
           for staff who weren't expecting it. */
    if (action === "change_email") {
      const userId = String(body.user_id ?? "");
      const newEmail = String(body.new_email ?? "").trim().toLowerCase();
      if (!userId || !newEmail) return json({ error: "user_id and new_email are required." }, 400);
      if (!EMAIL_RE.test(newEmail)) return json({ error: "That doesn't look like a valid email address." }, 400);
      if (await isSuper(userId) && userId !== callerId && !(await isSuper(callerId))) {
        return json({ error: "Only a Super Admin can change a Super Admin's email." }, 400);
      }
      /* Up-front dupe check so we surface a friendlier message than Supabase's
         raw "email_exists" error, and before we touch the auth table. */
      const { data: existing } = await admin.from("app_users").select("id").eq("email", newEmail).maybeSingle();
      if (existing && existing.id !== userId) {
        return json({ error: "That email is already used by another account." }, 400);
      }
      const { error: upErr } = await admin.auth.admin.updateUserById(userId, {
        email: newEmail, email_confirm: true,
      });
      if (upErr) return json({ error: upErr.message }, 400);
      /* Keep app_users in step. If this write fails the login still works
         (auth table is the source of truth for signing in), but the UI would
         show the old email — report, don't silently drop. */
      const { error: appErr } = await admin.from("app_users").update({ email: newEmail }).eq("id", userId);
      if (appErr) return json({ error: `Signed-in email changed, but the user profile could not be updated: ${appErr.message}` }, 500);
      return json({ ok: true, email: newEmail }, 200);
    }

    // ------------------------------- CREATE -------------------------------
    const email = String(body.email ?? "").trim().toLowerCase();
    const phone = String(body.phone ?? "").trim();
    const password = String(body.password ?? "");
    const fullName = String(body.full_name ?? "").trim() || (email ? email.split("@")[0] : (phone || "User"));
    const roleId = body.role_id ? String(body.role_id) : null;

    if (!email && !phone) return json({ error: "Enter an email or a phone number." }, 400);
    if (!password) return json({ error: "Password is required." }, 400);
    if (password.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);

    // Duplicate phone guard (few login users, so a simple scan is fine).
    if (phone) {
      const d = digits(phone);
      const { data: rows } = await admin.from("app_users").select("phone");
      const dupe = (rows ?? []).some((r: { phone: string | null }) => r.phone && digits(r.phone) === d && d !== "");
      if (dupe) return json({ error: "That phone number is already used by another account." }, 400);
    }

    const authEmail = email || `${digits(phone)}@karkhana.local`;
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: authEmail, password, email_confirm: true, user_metadata: { full_name: fullName, phone },
    });
    if (createErr) return json({ error: createErr.message }, 400);

    const newId = created.user?.id;
    if (newId) {
      await admin.from("app_users").upsert(
        { id: newId, full_name: fullName, email: authEmail, phone: phone || null, must_change_password: true },
        { onConflict: "id" }
      );
      if (roleId) {
        await admin.from("user_roles").delete().eq("user_id", newId);
        await admin.from("user_roles").insert({ user_id: newId, role_id: roleId });
      }
    }
    return json({ ok: true, user_id: newId }, 200);
  } catch (e) {
    return json({ error: (e as Error)?.message ?? "Unexpected error" }, 500);
  }
});
