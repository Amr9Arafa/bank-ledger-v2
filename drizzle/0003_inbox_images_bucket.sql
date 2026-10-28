-- Private bucket for AI Inbox photos (Supabase Storage). Not public: photos are shown only
-- through short-lived signed links made on the server with the secret key. No storage
-- policies, so the publishable key cannot read or write it.
-- 3 MB per file: the browser shrinks photos to well under that before upload.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('inbox-images', 'inbox-images', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
