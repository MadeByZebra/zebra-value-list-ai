import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MadeByZebra — Value List · Version 1.9.0",
  description: "MadeByZebra Boxing League Value List",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}

        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                const title =
                  "MadeByZebra — Value List · Version 1.9.0     •     ";

                let position = 0;

                function moveTitle() {
                  document.title =
                    title.slice(position) +
                    title.slice(0, position);

                  position++;

                  if (position >= title.length) {
                    position = 0;
                  }
                }

                setInterval(moveTitle, 150);
              })();
            `,
          }}
        />
      </body>
    </html>
  );
}