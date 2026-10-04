import { createSerwistRoute } from "@serwist/turbopack";

// Serves the service worker built from src/serwist/sw.ts (Serwist's
// Turbopack integration). The precache list is the app's built static files.
export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } = createSerwistRoute({
  swSrc: "src/serwist/sw.ts",
  useNativeEsbuild: true,
});
