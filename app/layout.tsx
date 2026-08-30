import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('http://127.0.0.1:3000'),
  icons: { icon: '/og.png' },
  title: 'KPi Travels | Bus ticketing',
  description: 'Find a bus, book your journey, and manage your tickets with KPi Travels.',
  openGraph: {
    title: 'KPi Travels',
    description: 'Your next journey, one booking away.',
    type: 'website',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'KPi Travels',
    description: 'Your next journey, one booking away.',
    images: ['/og.png'],
  },
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
