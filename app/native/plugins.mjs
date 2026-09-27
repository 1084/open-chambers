// Bundled into www/native.js by scripts/prepare-www.mjs (esbuild). Exposes the Capacitor
// plugin proxies to the plain index.html, which has no module system of its own.
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
window.CapPlugins = { Capacitor, PushNotifications, Haptics, ImpactStyle };
