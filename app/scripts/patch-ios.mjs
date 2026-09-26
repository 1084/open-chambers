// One-time patches after `npx cap add ios`:
//  1. App.entitlements with aps-environment (push), wired into the pbxproj
//  2. UIBackgroundModes remote-notification + AppDelegate token forwarding is handled by the Capacitor plugin
//  3. PrivacyInfo.xcprivacy copied into the app target
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appDir = join(root, "ios/App/App"), pbx = join(root, "ios/App/App.xcodeproj/project.pbxproj");
if (!existsSync(pbx)) { console.error("Run `npx cap add ios` first."); process.exit(1); }

const ent = join(appDir, "App.entitlements");
writeFileSync(ent, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>aps-environment</key><string>development</string>
</dict></plist>
`);
copyFileSync(join(root, "resources/PrivacyInfo.xcprivacy"), join(appDir, "PrivacyInfo.xcprivacy"));

let p = readFileSync(pbx, "utf8");
if (!p.includes("CODE_SIGN_ENTITLEMENTS")) {
  p = p.replace(/(INFOPLIST_FILE = App\/Info\.plist;)/g, `CODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n\t\t\t\t$1`);
}
// Register PrivacyInfo.xcprivacy as a resource so it ships in the bundle.
if (!p.includes("PrivacyInfo.xcprivacy")) {
  const fileRef = "FV0000000000000000000001", buildRef = "FV0000000000000000000002";
  p = p.replace("/* Begin PBXFileReference section */", `/* Begin PBXFileReference section */\n\t\t${fileRef} /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };`);
  p = p.replace("/* Begin PBXBuildFile section */", `/* Begin PBXBuildFile section */\n\t\t${buildRef} /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = ${fileRef} /* PrivacyInfo.xcprivacy */; };`);
  p = p.replace(/(\/\* Info\.plist \*\/,)/, `$1\n\t\t\t\t${fileRef} /* PrivacyInfo.xcprivacy */,`);
  p = p.replace(/(isa = PBXResourcesBuildPhase;[\s\S]*?files = \()/, `$1\n\t\t\t\t${buildRef} /* PrivacyInfo.xcprivacy in Resources */,`);
}
writeFileSync(pbx, p);

// Info.plist: background remote notifications + no arbitrary loads needed (all HTTPS).
const plist = join(appDir, "Info.plist");
let info = readFileSync(plist, "utf8");
if (!info.includes("UIBackgroundModes")) info = info.replace("</dict>\n</plist>", `\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>remote-notification</string>\n\t</array>\n\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>\n</dict>\n</plist>`);
writeFileSync(plist, info);
console.log("ios patched: entitlements, privacy manifest, Info.plist");

// Xcode Cloud looks for ci_scripts next to the Xcode project/workspace.
import { mkdirSync, chmodSync } from "node:fs";
const ciDst = join(root, "ios/App/ci_scripts"); mkdirSync(ciDst, { recursive: true });
copyFileSync(join(root, "ci_scripts/ci_post_clone.sh"), join(ciDst, "ci_post_clone.sh")); chmodSync(join(ciDst, "ci_post_clone.sh"), 0o755);
// App icon: Capacitor's template uses a single 1024px file.
const iconDst = join(appDir, "Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png");
if (existsSync(join(root, "resources/AppIcon-1024.png")) && existsSync(dirname(iconDst))) copyFileSync(join(root, "resources/AppIcon-1024.png"), iconDst);
console.log("ios patched: ci_scripts, app icon");
