'use client';

import { ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';

const LINKS = [
  { href: '#strategies', label: 'Strategies' },
  { href: '#demo', label: 'Live demo' },
  { href: '#how', label: 'How it works' },
  { href: '#pricing', label: 'Pricing' },
];

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <a href="#" className="flex items-center gap-2" aria-label="BudgetGuard home">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white">
            <ShieldCheck className="h-5 w-5" aria-hidden />
          </span>
          <span className="text-lg font-semibold tracking-tight">BudgetGuard</span>
          <span className="ml-1 hidden rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 sm:inline">
            Autopilot for Meta budget
          </span>
        </a>

        <nav aria-label="Main" className="hidden items-center gap-6 md:flex">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <Button
          asChild
          className="bg-emerald-600 text-white hover:bg-emerald-700"
        >
          <a href="#pricing">Start free trial</a>
        </Button>
      </div>
    </header>
  );
}
