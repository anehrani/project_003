'use client';

import { useState } from 'react';

import { motion } from 'framer-motion';
import {
  DollarSign,
  Gauge,
  PiggyBank,
  Target,
  Wallet,
  PauseCircle,
  PlayCircle,
} from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { ACTION_LOG, KPIS, SERIES_30D, SERIES_7D, type DayPoint } from '@/lib/demo-data';

const ACTION_STYLES: Record<string, { label: string; className: string }> = {
  paused: { label: 'Paused', className: 'bg-red-100 text-red-700 border-red-200' },
  scaled: { label: 'Scaled', className: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  decreased: { label: 'Decreased', className: 'bg-amber-100 text-amber-800 border-amber-200' },
  alert: { label: 'Alert', className: 'bg-zinc-100 text-zinc-700 border-zinc-200' },
  resumed: { label: 'Resumed', className: 'bg-zinc-100 text-zinc-700 border-zinc-200' },
};

const DOT_COLORS: Record<string, string> = {
  pause: '#ef4444',
  scale: '#10b981',
  decrease: '#f59e0b',
};

function ActionDot(props: { cx?: number; cy?: number; payload?: DayPoint }) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || !payload?.action) return <g />;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={5}
      fill={DOT_COLORS[payload.action]}
      stroke="#ffffff"
      strokeWidth={2}
    />
  );
}

function KpiCard({
  icon: Icon,
  title,
  children,
  highlight,
}: {
  icon: typeof DollarSign;
  title: string;
  children: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <Card className={highlight ? 'border-emerald-300 bg-emerald-50' : undefined}>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Icon className={`h-3.5 w-3.5 ${highlight ? 'text-emerald-600' : ''}`} aria-hidden />
          {title}
        </div>
        <div className="mt-2">{children}</div>
      </CardContent>
    </Card>
  );
}

export function DemoDashboard() {
  const [range, setRange] = useState<'7d' | '30d'>('7d');
  const [autopilotOn, setAutopilotOn] = useState(true);

  const data = range === '7d' ? SERIES_7D : SERIES_30D;

  return (
    <section id="demo" className="scroll-mt-20 bg-zinc-50">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <Badge variant="outline" className="mb-4 border-emerald-200 bg-emerald-50 text-emerald-700">
            Interactive demo — try the switches
          </Badge>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            One dashboard. Total peace of mind.
          </h2>
          <p className="mt-4 text-muted-foreground">
            This is the only screen 90% of users ever need: live KPIs, every action with its
            reason, and one big switch to hand control back.
          </p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.5 }}
          className="mt-12"
        >
          {/* ---- KPI row ---- */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <KpiCard icon={Wallet} title="Spend today">
              <p className="text-xl font-bold tracking-tight">
                ${KPIS.spendToday.value.toFixed(2)}
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  / ${KPIS.spendToday.cap}
                </span>
              </p>
              <Progress value={KPIS.spendToday.pct} className="mt-2 h-1.5" />
              <p className="mt-1 text-[11px] text-muted-foreground">{KPIS.spendToday.pct}% of daily cap</p>
            </KpiCard>

            <KpiCard icon={Gauge} title="Spend this month">
              <p className="text-xl font-bold tracking-tight">
                ${KPIS.spendMonth.value}
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  / ${KPIS.spendMonth.budget.toLocaleString()}
                </span>
              </p>
              <Progress value={KPIS.spendMonth.pct} className="mt-2 h-1.5" />
              <p className="mt-1 text-[11px] text-muted-foreground">{KPIS.spendMonth.pct}% of monthly budget</p>
            </KpiCard>

            <KpiCard icon={Target} title="ROAS · last 7 days">
              <p className="text-xl font-bold tracking-tight">{KPIS.roas7d.value}</p>
              <p className="mt-1.5 text-[11px] font-medium text-emerald-700">{KPIS.roas7d.delta}</p>
            </KpiCard>

            <KpiCard icon={DollarSign} title="CPA · last 7 days">
              <p className="text-xl font-bold tracking-tight">{KPIS.cpa7d.value}</p>
              <p className="mt-1.5 text-[11px] font-medium text-emerald-700">{KPIS.cpa7d.delta}</p>
            </KpiCard>

            <KpiCard icon={PiggyBank} title="Money saved" highlight>
              <p className="text-xl font-bold tracking-tight text-emerald-700">
                ${KPIS.moneySaved.value.toFixed(2)}
              </p>
              <p className="mt-1.5 text-[11px] text-muted-foreground">{KPIS.moneySaved.detail}</p>
            </KpiCard>
          </div>

          {/* ---- Main grid: chart + log | status ---- */}
          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              {/* Chart */}
              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-base">Spend vs. revenue</CardTitle>
                  <Tabs
                    value={range}
                    onValueChange={(v) => setRange(v as '7d' | '30d')}
                  >
                    <TabsList>
                      <TabsTrigger value="7d">7 days</TabsTrigger>
                      <TabsTrigger value="30d">30 days</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </CardHeader>
                <CardContent>
                  <div className="h-72 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" vertical={false} />
                        <XAxis
                          dataKey="date"
                          tick={{ fontSize: 11, fill: '#71717a' }}
                          tickLine={false}
                          axisLine={{ stroke: '#e4e4e7' }}
                          interval={range === '30d' ? 4 : 0}
                        />
                        <YAxis
                          tick={{ fontSize: 11, fill: '#71717a' }}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={(v: number) => `$${v}`}
                          width={44}
                        />
                        <Tooltip
                          formatter={(value: number, name: string) => [`$${value.toFixed(2)}`, name]}
                          contentStyle={{
                            borderRadius: 8,
                            border: '1px solid #e4e4e7',
                            fontSize: 12,
                          }}
                        />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Line
                          type="monotone"
                          dataKey="spend"
                          name="Spend"
                          stroke="#3f3f46"
                          strokeWidth={2}
                          dot={<ActionDot />}
                          activeDot={{ r: 4 }}
                        />
                        <Line
                          type="monotone"
                          dataKey="revenue"
                          name="Revenue"
                          stroke="#10b981"
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full bg-red-500" /> Paused ad set
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Scaled ad set
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Decreased budget
                    </span>
                  </div>
                </CardContent>
              </Card>

              {/* Action log */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Action log</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Every decision, in plain English — this is how trust is built.
                  </p>
                </CardHeader>
                <CardContent>
                  <div className="max-h-96 overflow-y-auto overflow-x-auto rounded-lg border">
                    <Table>
                      <TableHeader className="sticky top-0 bg-zinc-50">
                        <TableRow>
                          <TableHead className="min-w-24 text-xs">Time</TableHead>
                          <TableHead className="min-w-32 text-xs">Ad set</TableHead>
                          <TableHead className="min-w-32 text-xs">Action</TableHead>
                          <TableHead className="min-w-48 text-xs">Reason</TableHead>
                          <TableHead className="min-w-28 text-xs">Impact</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {ACTION_LOG.map((row, i) => {
                          const style = ACTION_STYLES[row.action];
                          return (
                            <TableRow key={i}>
                              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                                {row.time}
                              </TableCell>
                              <TableCell className="whitespace-nowrap text-xs font-medium">
                                {row.adSet}
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline" className={`whitespace-nowrap text-[11px] ${style.className}`}>
                                  {row.detail}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {row.reason}
                              </TableCell>
                              <TableCell className="whitespace-nowrap text-xs font-medium text-emerald-700">
                                {row.impact}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* ---- Autopilot status sidebar ---- */}
            <div className="space-y-6">
              <Card className={autopilotOn ? 'border-emerald-300' : undefined}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Autopilot status</CardTitle>
                    <Switch
                      checked={autopilotOn}
                      onCheckedChange={setAutopilotOn}
                      aria-label="Toggle autopilot"
                    />
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    {autopilotOn ? (
                      <>
                        <span className="relative flex h-2.5 w-2.5">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-600" />
                        </span>
                        <Badge className="border-transparent bg-emerald-600 text-white">ON</Badge>
                        <span className="text-xs text-muted-foreground">checking every 15 min</span>
                      </>
                    ) : (
                      <>
                        <span className="h-2.5 w-2.5 rounded-full bg-zinc-400" />
                        <Badge variant="outline" className="border-zinc-300 text-zinc-600">
                          PAUSED
                        </Badge>
                        <span className="text-xs text-muted-foreground">engine standing by</span>
                      </>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="rounded-lg border bg-zinc-50 p-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Active strategy
                    </p>
                    <p className="mt-1 text-sm font-semibold">Balanced Autopilot</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {autopilotOn
                        ? 'Pausing losers, scaling winners, protecting your cap.'
                        : 'Your ads keep running — BudgetGuard stops watching them.'}
                    </p>
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Guardrails
                    </p>
                    <ul className="mt-2 space-y-1.5 text-sm">
                      <li className="flex items-center gap-2">
                        <Wallet className="h-4 w-4 text-emerald-600" aria-hidden />
                        Daily cap <span className="font-medium">$50</span>
                      </li>
                      <li className="flex items-center gap-2">
                        <Target className="h-4 w-4 text-emerald-600" aria-hidden />
                        Max CPA <span className="font-medium">$25</span>
                      </li>
                      <li className="flex items-center gap-2">
                        <Gauge className="h-4 w-4 text-emerald-600" aria-hidden />
                        Min ROAS <span className="font-medium">3.0x</span>
                      </li>
                    </ul>
                  </div>

                  <Button
                    size="lg"
                    className={
                      autopilotOn
                        ? 'w-full border-red-200 bg-white text-red-600 hover:bg-red-50 hover:text-red-700'
                        : 'w-full bg-emerald-600 text-white hover:bg-emerald-700'
                    }
                    variant={autopilotOn ? 'outline' : 'default'}
                    onClick={() => setAutopilotOn(!autopilotOn)}
                  >
                    {autopilotOn ? (
                      <>
                        <PauseCircle className="mr-2 h-5 w-5" aria-hidden />
                        Pause autopilot
                      </>
                    ) : (
                      <>
                        <PlayCircle className="mr-2 h-5 w-5" aria-hidden />
                        Resume autopilot
                      </>
                    )}
                  </Button>
                  <p className="text-center text-[11px] text-muted-foreground">
                    {autopilotOn
                      ? 'Next check in ~7 minutes'
                      : 'Paused — no checks, no changes, no protection'}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4">
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    <span className="font-semibold text-foreground">Why the log matters:</span>{' '}
                   Birch-style tools fail beginners because they hide what happened.
                    BudgetGuard shows every pause, every dollar saved, and the exact reason —
                    so you never have to wonder what it did at 2am.
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
