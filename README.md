# H309 — Admin change-email for Hub users

**Date:** 3 Nov 2026

## What changed

A **"Email"** button now appears next to each user in **Administration → Users**.
Any admin with `users.manage` can change any user's login email in one click —
no delete + recreate, no roles/attendance/history lost.

## Files in this zip

- `components/UsersTab.tsx` — adds the "Email" button and the change-email flow.

## What's already live server-side (not in this zip)

- Edge function `create-user` v40 — adds `action: "change_email"`.
  Already deployed; no upload needed.

## Rules the edge function enforces

- Caller must have `users.manage` permission (same as every other user action).
- Super Admin's email can only be changed by another Super Admin.
- Email must be well-formed and NOT already used by another account.
- Updates BOTH `auth.users.email` and `app_users.email` in one shot.
- `email_confirm: true` — Supabase does NOT send a confirmation email to the
  new address. The admin is making the change on behalf of the user; a
  confirmation email to an address the user hasn't been told about yet would
  be a surprise.
- Password is NOT reset — login email changes, password stays. If the admin
  also wants to reset the password, that's a separate "Reset" click.
