# Daily Wage Desk (K198)

Supervisor portal at `/wage-desk`. Shows only Karkhana daily-wage workers (Karkhana, Labor and factory sections).
Hub, Inventory, Shops Sales and all monthly-salary staff are never returned by the database.

## Files
- `supabase/migrations/K198_wage_desk_supervisor_portal.sql` — run once in the Supabase SQL editor (project ozkhkhlwjblzgwmjbdde)
- `app/wage-desk/page.tsx` — new route, no existing file changed

## One line in lib/access.ts
Add to ROUTE_PERMS:

    "/wage-desk": ["wages.desk"],

## If the repo has its own browser client helper
Replace the two `createBrowserClient(...)` lines at the top of page.tsx with the repo's helper import.

## Give the login
1. Administration → Users: add mianshahidazeem@hotmail.com (password must be at least 6 characters).
2. Karkhana → Team: set his job role to **Wage Supervisor**.
3. Supervisor opens https://karkhana-erp-app.vercel.app/wage-desk and bookmarks it.

## Rules enforced in the database
- Only `wages.desk` can read the desk; it has no access to employees.manage, payroll, Hub or retail.
- Pay / edit / undo allowed for today and the last 7 days; older needs a Karkhana admin.
- Amount different from the portal requires a note.
- Payments land in `att_wage_payments` — the same table the admin daily-wages and month-pay screens read.
