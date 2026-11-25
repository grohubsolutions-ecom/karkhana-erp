import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./theme.css";
import "./glass.css";
import localFont from "next/font/local";
import AppFrame from "@/components/AppFrame";
import { ConfirmProvider } from "@/components/ConfirmDialog";

/* Self-hosted: one 30 kB variable file (all weights) shipped with the app and
   preloaded from our own domain. It replaces the render-blocking stylesheet
   from fonts.googleapis.com, which cost two extra connections before any
   text could be drawn. A size-matched fallback stops the text jumping. */
const jakarta = localFont({
  src: "./fonts/plus-jakarta-sans-latin-wght-normal.woff2",
  weight: "200 800",
  display: "swap",
  variable: "--font-jakarta",
  adjustFontFallback: "Arial",
});

export const metadata: Metadata = {
  title: "Karkhana ERP — Head Office",
  description: "Raw-material inventory, production & piece-rate management",
  /* N3: installable. On Android, Chrome offers "Install app" / "Add to Home
     screen"; it then opens full-screen like a native app, no address bar. */
  applicationName: "Grohub ERP",
  appleWebApp: { capable: true, title: "Grohub ERP", statusBarStyle: "default" },
  icons: { icon: "/icon.svg", apple: "/apple-touch-icon.png" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F6F4EF" },
    { media: "(prefers-color-scheme: dark)", color: "#17140f" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={jakarta.variable} suppressHydrationWarning>
      <head>
        {/* Open the connection to the database while the page is still
            loading, so the first query doesn't also pay for DNS + TLS. */}
        {process.env.NEXT_PUBLIC_SUPABASE_URL && <link rel="preconnect" href={process.env.NEXT_PUBLIC_SUPABASE_URL} crossOrigin="" />}
        {process.env.NEXT_PUBLIC_SUPABASE_URL && <link rel="dns-prefetch" href={process.env.NEXT_PUBLIC_SUPABASE_URL} />}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{if(localStorage.getItem('kk-theme')==='dark')document.documentElement.classList.add('dark');}catch(e){}" +
              /* A password-reset link that Supabase sends to the wrong page (its
                 Site URL instead of /reset-password, when that address is not on
                 the allowed list) would otherwise just sign the person in without
                 ever asking for a new password. Catch it before anything runs. */
              "try{var h=location.hash;if(/type=recovery|error_code=otp_expired/.test(h)&&location.pathname!=='/reset-password')location.replace('/reset-password'+h);}catch(e){}",
          }}
        />
      </head>
      <body>
        <AppFrame><ConfirmProvider>{children}</ConfirmProvider></AppFrame>
      </body>
    </html>
  );
}
