"use client";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAiBudget, useUpdateBudget, type BudgetStatus } from "@/hooks/ai/useAiBudget";

interface Props {
  initialData?: BudgetStatus;
  isAdmin: boolean;
}

const brl = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

function fmtCents(cents: number): string {
  return brl.format((cents ?? 0) / 100);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function BudgetCard({ initialData, isAdmin }: Props) {
  const q = useAiBudget({ initialData });
  const status = q.data;

  if (!status) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">Carregando orçamento...</p>
      </Card>
    );
  }

  const limit = status.monthly_limit_cents;
  const consumed = status.current_month_consumed_cents;
  const pct = clamp(status.pct, 0, 100);
  const overLimit = status.pct >= 100;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">
            Orçamento mensal de IA
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Período iniciado em {status.current_period_start}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status.is_disabled && <Badge variant="destructive">Desabilitado</Badge>}
          {status.is_throttled && !status.is_disabled && (
            <Badge variant="secondary">Pausado</Badge>
          )}
          {overLimit && !status.is_throttled && !status.is_disabled && (
            <Badge variant="destructive">Limite alcançado</Badge>
          )}
          {isAdmin && <EditBudgetDialog status={status} />}
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full transition-all ${
              status.pct >= 100
                ? "bg-destructive"
                : status.pct >= status.alarm_threshold_pct
                ? "bg-amber-500"
                : "bg-primary"
            }`}
            style={{ width: `${pct}%` }}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            role="progressbar"
          />
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span>
            <strong>{fmtCents(consumed)}</strong>
            {limit > 0 ? <> gastos de {fmtCents(limit)}</> : <> gastos este mês</>}
          </span>
          {/*
            Sem limite definido, a linha antiga dizia "R$ 0,00 de —" e ainda
            prometia "pausa ao 100%" — 100% de um teto que não existe. Quem lê
            fica achando que há uma proteção ligada.
          */}
          <span className="text-muted-foreground">
            {limit > 0 ? (
              <>
                {status.pct.toFixed(0)}% do limite · avisamos em{" "}
                {status.alarm_threshold_pct}% ·{" "}
                {status.action_at_100pct === "disable"
                  ? "a IA é desligada ao chegar no limite"
                  : "a IA pausa ao chegar no limite"}
              </>
            ) : (
              "Sem limite definido — a IA não vai parar sozinha por gasto."
            )}
          </span>
        </div>
      </div>
    </Card>
  );
}

function EditBudgetDialog({ status }: { status: BudgetStatus }) {
  const [open, setOpen] = useState(false);
  const update = useUpdateBudget();
  const [limitBrl, setLimitBrl] = useState<string>(
    (status.monthly_limit_cents / 100).toFixed(2),
  );
  const [thresholdPct, setThresholdPct] = useState<number>(status.alarm_threshold_pct);
  const [action, setAction] = useState<"throttle" | "disable">(status.action_at_100pct);

  useEffect(() => {
    if (open) {
      setLimitBrl((status.monthly_limit_cents / 100).toFixed(2));
      setThresholdPct(status.alarm_threshold_pct);
      setAction(status.action_at_100pct);
    }
  }, [open, status]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const limitNum = Number(limitBrl.replace(",", "."));
    if (!Number.isFinite(limitNum) || limitNum < 0) return;
    const cents = Math.round(limitNum * 100);
    update.mutate(
      {
        monthly_limit_cents: cents,
        alarm_threshold_pct: clamp(Math.round(thresholdPct), 1, 100),
        action_at_100pct: action,
      },
      {
        onSuccess: () => setOpen(false),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Editar limite
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar orçamento de IA</DialogTitle>
          <DialogDescription>
            Define quando o bot deve alertar e como reagir ao atingir 100% do
            consumo mensal.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="limit-brl">Limite mensal (R$)</Label>
            <Input
              id="limit-brl"
              type="number"
              min={0}
              step="0.01"
              value={limitBrl}
              onChange={(e) => setLimitBrl(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              0 desativa o orçamento (sem limite, sem alertas).
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="threshold-pct">Alerta em (%)</Label>
            <Input
              id="threshold-pct"
              type="number"
              min={1}
              max={100}
              step={1}
              value={thresholdPct}
              onChange={(e) => setThresholdPct(Number(e.target.value))}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Ação ao atingir 100%</Label>
            <Select value={action} onValueChange={(v) => setAction(v as "throttle" | "disable")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="throttle">Pausar (reversível mensalmente)</SelectItem>
                <SelectItem value="disable">Desabilitar (requer reativar manualmente)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={update.isPending}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? "Salvando..." : "Salvar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
