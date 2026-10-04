import type { MetadataRoute } from "next";

// Lets the till be installed like an app (blueprint Phase 10).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Billing",
    short_name: "Billing",
    description: "Billing, stock and accounts for your shop",
    start_url: "/pos",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#111827",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
