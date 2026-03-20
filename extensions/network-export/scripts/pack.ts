import JSZip from "jszip";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function addDir(zip: JSZip, absDir: string, zipPrefix: string): Promise<void> {
  const entries = await readdir(absDir, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(absDir, e.name);
    const rel = zipPrefix ? `${zipPrefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await addDir(zip, abs, rel);
    } else {
      zip.file(rel, await readFile(abs));
    }
  }
}

const root = path.join(import.meta.dir, "..");
const distDir = path.join(root, "dist");
const outPath = path.join(root, "network-export.zip");

const zip = new JSZip();
await addDir(zip, distDir, "");
const buf = await zip.generateAsync({
  type: "uint8array",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
});
await Bun.write(outPath, buf);
console.log(`Packed ${distDir} → ${outPath} (${buf.byteLength} bytes)`);
