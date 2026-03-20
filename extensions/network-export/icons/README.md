- **`logo_network.jpg`** — source of truth: your cropped square logo (edit this, then regenerate PNGs).
- **`icon-{16,32,48,128}.png`** — generated for the extension manifest:

  ```bash
  bun run --cwd extensions/network-export icons
  ```

  Uses [Sharp](https://sharp.pixelplumbing.com/) to resize `logo_network.jpg` to each size.

- **`icon-source.png`** — optional legacy reference only; the build no longer reads it.
