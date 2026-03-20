import path from "node:path";
import sharp from "sharp";

const root = path.join(import.meta.dir, "..");
/** Cropped square master; edit this file, then run `bun run icons`. */
const source = path.join(root, "icons", "logo_network.jpg");
const sizes = [16, 32, 48, 128] as const;

for (const size of sizes) {
  await sharp(source)
    .resize(size, size, {
      fit: "cover",
      position: "centre",
    })
    .png()
    .toFile(path.join(root, "icons", `icon-${size}.png`));
}

console.log(
  `Rasterized logo_network.jpg → ${sizes.map((s) => `icon-${s}.png`).join(", ")}`,
);
