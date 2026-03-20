import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

export type ExtensionBuildOptions = {
  /** Absolute path to extension package root (contains `src/`). */
  extensionRoot: string;
  /** TS entry files under `src/`, bundled as sibling `.js` in `dist/`. */
  scriptEntries: string[];
  /** Static files under `src/` copied to `dist/` (e.g. manifest.json, html). */
  staticFiles: string[];
};

/**
 * Bundle extension scripts with Bun and copy static assets into `dist/`.
 */
export async function buildExtension(options: ExtensionBuildOptions): Promise<void> {
  const { extensionRoot, scriptEntries, staticFiles } = options;
  const srcDir = path.join(extensionRoot, "src");
  const distDir = path.join(extensionRoot, "dist");

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  const entrypoints = scriptEntries.map((name) => path.join(srcDir, name));
  const result = await Bun.build({
    entrypoints,
    outdir: distDir,
    format: "iife",
    target: "browser",
    minify: false,
    sourcemap: "linked",
    naming: "[name].js",
  });

  if (!result.success) {
    const messages = result.logs.map((log: { message: string }) => log.message).join("\n");
    throw new Error(`Bun.build failed:\n${messages}`);
  }

  for (const name of staticFiles) {
    await copyFile(path.join(srcDir, name), path.join(distDir, name));
  }
}
