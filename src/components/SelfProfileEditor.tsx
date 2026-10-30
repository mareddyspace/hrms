import { useState } from "react";
import { API_ENABLED } from "../api/client.ts";
import { getPerson } from "../data/peopleLocal.ts";
import { usePortal } from "../store.tsx";
import { ProfileEditForm } from "./ProfileEditForm.tsx";
import { Card } from "./ui.tsx";

const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** "Edit profile" card for the signed-in employee: contact details and photo, confirmed with an OTP. */
export function SelfProfileEditor({ onClose }: { onClose: () => void }) {
  const { employee } = usePortal();
  // Backend mode: start from the server record (masked mobile = keep), not the copy taken at sign-in.
  const [draft, setDraft] = useState(() =>
    API_ENABLED ? { ...employee, mobile: getPerson(employee.id)?.mobile || employee.mobile } : employee,
  );
  const [photoFile, setPhotoFile] = useState("");
  const [photoError, setPhotoError] = useState("");

  function readPhoto(file: File) {
    setPhotoError("");
    if (!PHOTO_TYPES.includes(file.type)) {
      setPhotoError("Choose a JPEG, PNG or WebP image.");
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoError("That photo is larger than 5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setPhotoError("Could not read that file. Try another photo.");
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => setPhotoError("That file is not a valid image.");
      image.onload = () => {
        const size = 320;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) {
          setPhotoError("Could not process that photo in this browser.");
          return;
        }
        const scale = Math.max(size / image.width, size / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
        setPhotoFile(canvas.toDataURL("image/jpeg", 0.86));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  return (
    <Card title="Edit profile">
      <ProfileEditForm
        draft={draft}
        setDraft={(next) =>
          setDraft((prev) => ({
            ...prev,
            ...(typeof next === "function" ? next(prev) : next),
          }))
        }
        photoFile={photoFile}
        photoError={photoError}
        onReadPhoto={readPhoto}
        onCancel={onClose}
        onSaved={onClose}
      />
    </Card>
  );
}
