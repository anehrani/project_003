'use client';

import { motion } from 'framer-motion';
import { Rocket, SlidersHorizontal, PlugZap } from 'lucide-react';

import { Badge } from '@/components/ui/badge';

const STEPS = [
  {
    icon: PlugZap,
    title: 'Connect Meta',
    body: 'One OAuth popup, official Marketing API. We request ads_read + ads_management — nothing more.',
    time: '60 seconds',
  },
  {
    icon: SlidersHorizontal,
    title: 'Pick campaign + budget',
    body: 'Choose the campaign to protect, set your monthly budget. Daily cap is auto-calculated — edit it if you like.',
    time: '60 seconds',
  },
  {
    icon: Rocket,
    title: 'Launch autopilot',
    body: 'One click on Balanced Autopilot. The engine checks your account every 15 minutes, forever.',
    time: '10 seconds',
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="scroll-mt-20 border-y bg-zinc-50">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <Badge variant="outline" className="mb-4 border-emerald-200 bg-emerald-50 text-emerald-700">
            Total setup time: under 3 minutes
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Onboarding so fast you&apos;ll double-check it
          </h2>
          <p className="mt-4 text-muted-foreground">
            No rules to write. No dashboards to configure. Connect, choose, launch.
          </p>
        </div>

        <ol className="mt-12 grid gap-6 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <motion.li
              key={s.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-60px' }}
              transition={{ duration: 0.4, delay: i * 0.1 }}
              className="relative rounded-xl border bg-white p-6 shadow-sm"
            >
              <span className="absolute right-5 top-5 text-4xl font-bold text-zinc-100" aria-hidden>
                {i + 1}
              </span>
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
                <s.icon className="h-5 w-5" aria-hidden />
              </div>
              <h3 className="font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
              <p className="mt-3 text-xs font-medium uppercase tracking-wide text-emerald-700">
                {s.time}
              </p>
            </motion.li>
          ))}
        </ol>
      </div>
    </section>
  );
}
