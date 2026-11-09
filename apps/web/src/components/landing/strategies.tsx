'use client';

import { Check, Scale, ShieldAlert, TrendingUp } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { STRATEGIES } from '@/lib/demo-data';

const ICONS = [Scale, ShieldAlert, TrendingUp] as const;

export function Strategies() {
  return (
    <section id="strategies" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Pick a strategy. That&apos;s the whole configuration.
        </h2>
        <p className="mt-4 text-muted-foreground">
          Rule builders make you do the work. BudgetGuard ships three proven autopilots —
          one click, fully guardrailed.
        </p>
      </div>

      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {STRATEGIES.map((s, i) => {
          const Icon = ICONS[i];
          return (
            <Card
              key={s.name}
              className={
                s.tag === 'Recommended'
                  ? 'relative border-emerald-300 shadow-lg shadow-emerald-100'
                  : 'relative'
              }
            >
              {s.tag === 'Recommended' && (
                <Badge className="absolute -top-2.5 left-4 border-transparent bg-emerald-600 text-white">
                  Recommended
                </Badge>
              )}
              <CardHeader>
                <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
                  <Icon className="h-5 w-5" aria-hidden />
                </div>
                <CardTitle className="text-lg">{s.name}</CardTitle>
                <CardDescription>{s.forWho}</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {s.rules.map((r) => (
                    <li key={r} className="flex items-start gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                      {r}
                    </li>
                  ))}
                </ul>
                <div className="mt-4 flex items-center justify-between border-t pt-4">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    Risk level
                  </span>
                  <Badge variant="outline" className={s.riskColor}>
                    {s.risk}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
