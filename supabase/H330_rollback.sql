-- H330 rollback — removes the WhatsApp inbox tables, functions and bucket policy.
-- The wa-media bucket is kept (objects must be emptied in the dashboard first).
drop function if exists hub_wa_customer(text);
drop function if exists hub_wa_chat_flag(text, boolean, boolean, boolean);
drop function if exists hub_wa_mark_read(text);
drop policy if exists wa_media_read on storage.objects;
drop trigger if exists online_wa_messages_status on online_wa_messages;
drop trigger if exists online_wa_messages_touch on online_wa_messages;
drop function if exists online_wa_chat_status();
drop function if exists online_wa_chat_touch();
drop table if exists online_wa_messages;
drop table if exists online_wa_chats;
delete from role_permissions where permission_id in (select id from permissions where code = 'hub.whatsapp.reply');
delete from permissions where code = 'hub.whatsapp.reply';
