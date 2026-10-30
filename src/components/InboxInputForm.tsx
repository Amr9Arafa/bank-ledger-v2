"use client";

import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { type InboxSubmitState, submitToInbox } from "@/actions/inbox";
import { inputClass, primaryButton, secondaryButton } from "@/components/form";
import { MAX_TEXT_LENGTH } from "@/lib/extraction";
import { fitWithin, formatBytes, JPEG_QUALITY, MAX_IMAGE_BYTES } from "@/lib/image";

type Photo = { file: File; url: string; originalBytes: number };

// Redraws the photo on a canvas: at most 1600 px on the long side, JPEG at 0.8.
// "from-image" applies the phone's EXIF rotation, so the cheque is not sideways.
async function shrinkPhoto(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not available");
    // JPEG has no transparency: a transparent PNG would otherwise turn black.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    if (!blob) throw new Error("Could not encode the photo");
    return new File([blob], "photo.jpg", { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}

// AI Inbox input: a message and/or a cheque photo. The AI reads it and the result appears
// below as a pending entry; nothing is saved to the ledger until someone approves it.
export default function InboxInputForm() {
  const t = useTranslations("inbox");
  const [state, dispatch, pending] = useActionState<InboxSubmitState, FormData>(
    submitToInbox,
    { text: "" },
  );
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [shrinking, setShrinking] = useState(false);

  // A new entry was created: start over with no photo. Done while rendering (not in an
  // effect), React's pattern for resetting state when a value changes.
  const [seenId, setSeenId] = useState(state.createdId);
  if (state.createdId !== seenId) {
    setSeenId(state.createdId);
    setPhoto(null);
  }

  // Free the preview's memory when the photo is replaced or removed.
  useEffect(() => (photo ? () => URL.revokeObjectURL(photo.url) : undefined), [photo]);

  async function onPhotoChosen(input: HTMLInputElement) {
    const original = input.files?.[0];
    // Cleared so that choosing the same file again still triggers a change.
    input.value = "";
    if (!original) return;
    setPhotoError(null);
    setShrinking(true);
    try {
      const file = await shrinkPhoto(original);
      if (file.size > MAX_IMAGE_BYTES) {
        setPhotoError("imageTooLarge");
        return;
      }
      setPhoto({ file, url: URL.createObjectURL(file), originalBytes: original.size });
    } catch {
      // The browser could not decode it (e.g. HEIC on a desktop browser, or not a photo).
      setPhotoError("imageUnsupported");
    } finally {
      setShrinking(false);
    }
  }

  // The file input has no name, so the original never leaves the browser:
  // only the shrunk copy is added to what the form sends.
  const submit = (formData: FormData) => {
    if (photo) formData.set("image", photo.file);
    dispatch(formData);
  };

  const error = photoError ?? state.error;

  return (
    <form action={submit} className="space-y-3" noValidate>
      <label htmlFor="inbox-text" className="block text-sm font-medium">
        {t("input.label")}
      </label>
      <textarea
        id="inbox-text"
        name="text"
        dir="auto"
        rows={3}
        maxLength={MAX_TEXT_LENGTH}
        defaultValue={state.text}
        placeholder={t("input.placeholder")}
        className={inputClass}
      />

      <div className="flex flex-wrap items-center gap-3">
        <label className={`${secondaryButton} cursor-pointer`}>
          {photo ? t("input.changePhoto") : t("input.addPhoto")}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            disabled={shrinking || pending}
            onChange={(e) => onPhotoChosen(e.currentTarget)}
          />
        </label>
        {shrinking && (
          <span className="text-sm text-foreground-secondary">{t("input.shrinking")}</span>
        )}
      </div>

      {photo && (
        <div className="flex flex-wrap items-end gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local blob: preview */}
          <img
            src={photo.url}
            alt={t("input.previewAlt")}
            className="max-h-48 w-auto rounded-md border border-border"
          />
          <div className="space-y-1 text-sm">
            <p className="text-foreground-secondary">
              {t("input.shrunk", {
                from: formatBytes(photo.originalBytes),
                to: formatBytes(photo.file.size),
              })}
            </p>
            <button
              type="button"
              onClick={() => setPhoto(null)}
              disabled={pending}
              className="text-debit underline-offset-2 hover:underline"
            >
              {t("input.removePhoto")}
            </button>
          </div>
        </div>
      )}

      <div aria-live="polite">
        {error && !pending && (
          <p className="rounded-md bg-debit-tint p-3 text-sm text-debit">
            {t(`errors.${error}` as "errors.aiUnavailable")}
          </p>
        )}
        {state.createdId && !pending && !photoError && (
          <p className="rounded-md bg-credit-tint p-3 text-sm text-credit">{t("input.sent")}</p>
        )}
      </div>

      <button type="submit" disabled={pending || shrinking} className={primaryButton}>
        {pending ? t("input.sending") : t("input.send")}
      </button>
    </form>
  );
}
