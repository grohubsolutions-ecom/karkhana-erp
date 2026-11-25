import type { MetadataRoute } from "next";

/* N3 — makes the portal an installable app. Staff work from phones only:
   "Install app" on Android puts Grohub ERP on the home screen and it opens
   full-screen, without the browser bar, straight to the right desk. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Grohub ERP",
    short_name: "Grohub",
    description: "Grohub Solutions — Hub, Karkhana, shops and staff portal",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#F3F1EC",
    theme_color: "#F6F4EF",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
