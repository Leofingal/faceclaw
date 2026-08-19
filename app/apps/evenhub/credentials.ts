import { ConfigSettingString } from "../../ui/dashboard-settings";

/**
 * EvenHub owns its account configuration. The storage keys intentionally
 * match the former Settings-app entries so existing users stay signed in.
 */
export const evenHubEmailSetting = new ConfigSettingString({
  id: "evenhub-email",
  label: "Email",
  storageKey: "integrations.evenhub.email",
  defaultValue: "",
  editorTitle: "Email",
  glassesEditTitle: "Edit Even email",
  inputKind: "email",
  normalize: (value) => (value ?? "").replace(/[\x00-\x1f]+/g, "").trim(),
});

export const evenHubPasswordSetting = new ConfigSettingString({
  id: "evenhub-password",
  label: "Password",
  storageKey: "integrations.evenhub.password",
  defaultValue: "",
  editorTitle: "Password",
  glassesEditTitle: "Edit Even password",
  inputKind: "password",
  normalize: (value) => (value ?? "").replace(/[\x00-\x1f]+/g, ""),
  formatValue: (value) => (value ? "(set)" : "(not set)"),
});

export function hasEvenHubCredentials(): boolean {
  return Boolean(evenHubEmailSetting.get().trim() && evenHubPasswordSetting.get());
}

export function clearEvenHubPassword(): void {
  evenHubPasswordSetting.set("");
}
