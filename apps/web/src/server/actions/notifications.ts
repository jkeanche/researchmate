"use server";

import { NOTIFICATION_KINDS } from "@researchmate/database";
import { markRead, setPreferences } from "@researchmate/tenancy";
import { revalidatePath } from "next/cache";
import { type FormState, handle, str } from "../form";
import { db } from "../services";
import { requireSession } from "../session";

/** Mark one notification (or all) read. Scoped to the signed-in user by markRead. */
export async function markReadAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const id = str(form, "notificationId");
    await markRead(db(), s.user.id, /^[0-9a-f-]{36}$/i.test(id) ? id : undefined);
    revalidatePath("/app", "layout");
    return { success: id ? "Marked as read." : "All marked as read." };
  });
}

export async function savePreferencesAction(_: FormState, form: FormData): Promise<FormState> {
  return handle(async () => {
    const s = await requireSession();
    const prefs = Object.keys(NOTIFICATION_KINDS).map((kind) => ({ kind, inApp: form.get(`${kind}:inApp`) === "on", email: form.get(`${kind}:email`) === "on" }));
    await setPreferences(db(), s.user.id, prefs);
    revalidatePath("/app/settings/notifications");
    return { success: "Notification settings saved." };
  });
}
