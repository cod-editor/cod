export const sitePermissionNames = {
  camera: "Camera",
  microphone: "Microphone",
  geolocation: "Location",
  notifications: "Notifications",
  "clipboard-read": "Clipboard",
  fullscreen: "Fullscreen",
  pointerLock: "Pointer lock",
} as const;
export type SitePermission = keyof typeof sitePermissionNames;
export interface SitePolicy {
  origin: string;
  topOrigin: string;
  permission: SitePermission;
  decision: "allow" | "block";
}
export interface SiteRequest {
  id: string;
  browserId: string;
  origin: string;
  topOrigin: string;
  permissions: SitePermission[];
}
