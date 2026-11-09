'use client';

import { ShieldCheck } from 'lucide-react';

export function Footer() {
  return (
    <footer className="mt-auto border-t bg-zinc-950 py-8 text-zinc-400">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 sm:flex-row sm:px-6">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-600 text-white">
            <ShieldCheck className="h-4 w-4" aria-hidden />
          </span>
          <span className="font-medium text-zinc-200">BudgetGuard</span>
          <span className="text-sm">— Autopilot for Meta budget</span>
        </div>
        <p className="text-xs">
          MVP in active development · Not affiliated with Meta Platforms, Inc.
        </p>
      </div>
    </footer>
  );
}
