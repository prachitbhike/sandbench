import type { Metadata } from 'next';
import { Saira_Condensed, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

// Condensed sports face for the board type; true mono with tabular figures
// for every number, so digits never shift width as values tick.
const display = Saira_Condensed({
  subsets: ['latin'],
  weight: ['500', '700', '800'],
  variable: '--font-display',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Sandbox Grand Prix — Pit Wall',
  description: 'Live telemetry comparing E2B, Modal and Daytona sandbox providers.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
