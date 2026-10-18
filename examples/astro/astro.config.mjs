import { defineConfig } from "astro/config";
import mediakiln from "mediakiln/astro";

export default defineConfig({
  integrations: [
    mediakiln({
      // Any mediakiln config works here, e.g.:
      video: { hls: { minDurationSec: 8 } },
    }),
  ],
});
