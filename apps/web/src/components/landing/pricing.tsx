'use client';

import { Check } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

import { PLANS } from '@/lib/demo-data';

export function Pricing() {
  return (
    <section id="pricing" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Priced like a tool. Saves like an employee.
        </h2>
        <p className="mt-4 text-muted-foreground">
          Every plan starts with a 14-day free trial — no credit card required.
        </p>
      </div>

      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {PLANS.map((p) => (
          <Card
            key={p.name}
            className={
              p.featured
                ? 'relative border-emerald-300 shadow-xl shadow-emerald-100 md:-translate-y-2'
                : 'relative'
            }
          >
            {p.featured && (
              <Badge className="absolute -top-2.5 left-4 border-transparent bg-emerald-600 text-white">
                Most popular
              </Badge>
            )}
            <CardHeader>
              <CardTitle className="text-lg">{p.name}</CardTitle>
              <div className="flex items-baseline gap-1">
                <span className="text-4xl font-bold tracking-tight">${p.price}</span>
                <span className="text-sm text-muted-foreground">/month</span>
              </div>
              <CardDescription>{p.blurb}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2.5 text-sm">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                    <span className="text-muted-foreground">{f}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
            <CardFooter>
              <Button
                className={
                  p.featured
                    ? 'w-full bg-emerald-600 text-white hover:bg-emerald-700'
                    : 'w-full border-emerald-600 bg-transparent text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800'
                }
                variant={p.featured ? 'default' : 'outline'}
              >
                {p.cta}
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
    </section>
  );
}
