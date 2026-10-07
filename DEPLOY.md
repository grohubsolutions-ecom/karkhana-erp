# Karkhana ERP — deploy

Next.js 15 / React 19. The retail module (`/retail/*`) is wired to the
`retail_*` tables in the Karkhana Supabase project and is live-ready.

## Environment

Set these two in Vercel → Project → Settings → Environment Variables
(they are also in `.env.local` for local runs):

    NEXT_PUBLIC_SUPABASE_URL=https://ozkhkhlwjblzgwmjbdde.supabase.co
    NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_YppNSgbxAW_mIa20GJl9ZQ_eOt-xb2u

Without them the app falls back to preview mode (sample data, no real login).

## Deploy

    npm install
    npm run build        # verified clean on 2026-10-07
    vercel --prod        # or push to the branch Vercel builds

## Retail module status (as of 7 Oct 2026)

Data: 68,338 rows copied from the retail project into `retail_*`, verified
table by table. Sequences reset to the correct high-water mark.

Permissions: all 22 `retail.*` permissions granted to Super Administrator and
Administrator. They existed but were granted to no role, which would have shown
empty screens on every retail page.

To give another role access:

    insert into role_permissions (role_id, permission_id)
    select r.id, p.id from roles r cross join permissions p
    where r.name = '<role>' and p.code like 'retail.%'
      and not exists (select 1 from role_permissions rp
                       where rp.role_id = r.id and rp.permission_id = p.id);

## Note

grohubretail.netlify.app still runs on its own project (`aqufopdseiftoawxoaaz`)
and is untouched. Both now read from separate copies of the same data — decide
which is authoritative before staff use both.
