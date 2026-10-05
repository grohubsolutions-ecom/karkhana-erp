/* ===========================================================================
   H290 PUSH TRIGGER — run this LAST, after send-push is deployed (5 Oct 2026)

   This is the only piece that makes a new bell notification ring the phone.
   Do NOT run it until the send-push edge function is deployed and its VAPID
   keys are set (see supabase/functions/send-push/index.ts), or every insert
   will try to reach a function that is not there yet.

   It stores the function URL and the service-role key in Vault, then adds an
   AFTER INSERT trigger on hub_notifications that calls send-push with the new
   row through pg_net. Sending is fire-and-forget: if the call fails the
   notification is still saved and still shows in the bell, so push can never
   hold up the app.

   STEP 1 — put the two values in Vault (replace both):
     select vault.create_secret('https://ozkhkhlwjblzgwmjbdde.supabase.co/functions/v1/send-push', 'hub_push_url');
     select vault.create_secret('<YOUR SERVICE ROLE KEY>', 'hub_push_key');
   (If they already exist, update instead:
     select vault.update_secret((select id from vault.secrets where name='hub_push_url'), 'https://…/send-push');
     select vault.update_secret((select id from vault.secrets where name='hub_push_key'), '<KEY>'); )

   STEP 2 — run the rest of this file.
   Hub tables only. Safe to run again.
=========================================================================== */

create or replace function hub_push_on_notify()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'hub_push_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'hub_push_key';
  if v_url is null or v_key is null then
    return new;   -- not configured yet: do nothing, the bell row still stands
  end if;
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_key),
    body    := jsonb_build_object('record', to_jsonb(new))
  );
  return new;
exception when others then
  return new;   -- never let a push failure break the insert
end;
$$;

drop trigger if exists trg_hub_push_on_notify on hub_notifications;
create trigger trg_hub_push_on_notify
  after insert on hub_notifications
  for each row execute function hub_push_on_notify();
