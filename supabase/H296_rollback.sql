-- H296 rollback — takes the Advance return feature out of the database.
-- Returns already recorded can stay: they are ordinary rows with a negative
-- amount, and every pay figure keeps netting them correctly without the
-- functions below. Run this in the Supabase SQL editor only if asked to.
drop trigger if exists trg_online_att_advances_net on public.online_att_advances;
drop function if exists public.hub_att_advance_net_check();
drop function if exists public.hub_advance_return(text, integer, integer, integer, text, text);
drop function if exists public.hub_advance_return_edit(text, integer, text, text);
drop function if exists public.hub_advance_return_remove(text);
drop function if exists public.hub_advance_outstanding();
alter table public.online_att_advances drop constraint if exists online_att_advances_amount_nonzero;
