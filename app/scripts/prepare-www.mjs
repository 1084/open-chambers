// Copies www-src -> www (the folder Capacitor bundles). Kept as a manual copy because
// fs.cpSync fails with EACCES on some mounted volumes.
import { mkdirSync, readdirSync, copyFileSync, statSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "www-src"), dst = join(root, "www");
function copy(a, b) { mkdirSync(b, { recursive: true }); for (const n of readdirSync(a)) { const p = join(a, n), q = join(b, n); statSync(p).isDirectory() ? copy(p, q) : copyFileSync(p, q); } }
if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
copy(src, dst);
// Bundle the Capacitor JS runtime + plugins into one classic script the page can load.
execSync(`npx esbuild "${join(root, "native/plugins.mjs")}" --bundle --minify --format=iife --target=ios15 --outfile="${join(dst, "native.js")}"`, { stdio: "inherit", cwd: root });
console.log("www ready");
