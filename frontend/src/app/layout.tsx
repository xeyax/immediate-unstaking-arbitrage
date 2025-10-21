import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Immediate Unstaking Arbitrage",
  description: "An automated trading system for immediate unstaking arbitrage opportunities",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
