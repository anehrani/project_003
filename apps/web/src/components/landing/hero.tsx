'use client';

import { motion } from 'framer-motion';
import { ArrowRight, Clock, CreditCard, PlugZap, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const TRUST = [
  { icon: CreditCard, label: 'No credit card' },
  { icon: Clock, label: '3-minute setup' },
  { icon: XCircle, label: 'Cancel anytime' },
  { icon: PlugZap, label: 'Official Meta API' },
];

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-zinc-950 text-zinc-50">
      {/* emerald glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-emerald-600/20 blur-3xl"
      />
      <div className="relative mx-auto max-w-6xl px-4 py-20 text-center sm:px-6 sm:py-28">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mx-auto max-w-3xl"
        >
          <Badge className="mb-6 border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15">
            MVP launching now · 20 beta spots
          </Badge>
          <h1 className="text-balance text-4xl font-bold leading-tight tracking-tight sm:text-5xl lg:text-6xl">
            Give us your ad + budget.{' '}
            <span className="text-emerald-400">We spend it optimally on Meta, 24/7.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-relaxed text-zinc-400 sm:text-lg">
            BudgetGuard is the autopilot for your Meta ad budget. It pauses losers, scales
            winners and hard-caps your spend while you sleep — and explains every decision in
            plain English. No rule builder. No 2am panic.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button
              asChild
              size="lg"
              className="h-12 w-full bg-emerald-600 px-6 text-base text-white hover:bg-emerald-700 sm:w-auto"
            >
              <a href="#pricing">
                Start 14-day free trial
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
              </a>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 w-full border-zinc-700 bg-transparent px-6 text-base text-zinc-200 hover:bg-zinc-800 hover:text-white sm:w-auto"
            >
              <a href="#demo">See the live demo ↓</a>
            </Button>
          </div>

          <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-zinc-400">
            {TRUST.map((t) => (
              <li key={t.label} className="flex items-center gap-1.5">
                <t.icon className="h-4 w-4 text-emerald-500" aria-hidden />
                {t.label}
              </li>
            ))}
          </ul>
        </motion.div>
      </div>
    </section>
  );
}
