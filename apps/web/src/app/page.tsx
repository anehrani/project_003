import { DemoDashboard } from '@/components/landing/demo-dashboard';
import { Footer } from '@/components/landing/footer';
import { Header } from '@/components/landing/header';
import { Hero } from '@/components/landing/hero';
import { HowItWorks } from '@/components/landing/how-it-works';
import { Pricing } from '@/components/landing/pricing';
import { Strategies } from '@/components/landing/strategies';

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="flex-1">
        <Hero />
        <Strategies />
        <DemoDashboard />
        <HowItWorks />
        <Pricing />
      </main>
      <Footer />
    </div>
  );
}
