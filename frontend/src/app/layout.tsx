import type { Metadata } from "next";
import { AuthProvider } from "@/lib/auth";
import { ThemeProvider, themeBootstrapScript } from "@/lib/theme";
import { ToastProviderContext } from "@/lib/toast";
import "../styles/globals.css";

export const metadata: Metadata = {
  title: "Ask the Archive",
  description:
    "Enterprise document intelligence with permission-aware retrieval, cited answers and honest abstention.",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
  manifest: "/site.webmanifest",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the stored theme before first paint so the page never
            flashes the wrong palette. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <ThemeProvider>
          <ToastProviderContext>
            <AuthProvider>{children}</AuthProvider>
          </ToastProviderContext>
        </ThemeProvider>
      </body>
    </html>
  );
}
