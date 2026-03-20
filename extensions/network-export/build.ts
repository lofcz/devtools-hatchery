import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { buildExtension } from "../../packages/extension-build/build-extension.ts";

const root = import.meta.dir;
const dist = path.join(root, "dist");

await buildExtension({
  extensionRoot: root,
  scriptEntries: ["background.ts", "devtools.ts", "panel.tsx"],
  staticFiles: ["manifest.json", "devtools.html", "panel.html"],
});

// Generate Tailwind CSS
const css = Bun.spawnSync(
  ["bunx", "@tailwindcss/cli", "-i", "src/panel.css", "-o", "dist/panel.css"],
  { cwd: root, stdio: ["inherit", "inherit", "inherit"] },
);
if (css.exitCode !== 0) {
  throw new Error(`Tailwind CSS build failed (exit ${css.exitCode})`);
}

// Copy icons
const iconDir = path.join(dist, "icons");
await mkdir(iconDir, { recursive: true });
const iconSizes = [16, 32, 48, 128] as const;
for (const size of iconSizes) {
  await copyFile(path.join(root, "icons", `icon-${size}.png`), path.join(iconDir, `icon-${size}.png`));
}

console.log("Built extensions/network-export → dist/");
