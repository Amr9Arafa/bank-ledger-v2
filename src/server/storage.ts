// Private Storage bucket for AI Inbox photos. Server only: uses the secret key, and the
// bucket has no public URLs, so a photo is only visible through a short-lived signed link.
import { createClient } from "@supabase/supabase-js";

const BUCKET = "inbox-images";

function bucket() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY are not set");
  }
  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).storage.from(BUCKET);
}

export async function uploadInboxImage(path: string, bytes: Uint8Array, contentType: string) {
  const { error } = await bucket().upload(path, bytes, { contentType });
  if (error) throw error;
}

export async function deleteInboxImage(path: string) {
  const { error } = await bucket().remove([path]);
  if (error) throw error;
}

export async function signedInboxImageUrl(path: string, seconds = 600): Promise<string | null> {
  const { data } = await bucket().createSignedUrl(path, seconds);
  return data?.signedUrl ?? null;
}
