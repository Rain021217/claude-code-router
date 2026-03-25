import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { A2GControlPlaneData } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const pathBadgeVariant = (ok: boolean): "default" | "destructive" => (ok ? "default" : "destructive");

export function A2GControlPlane() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [data, setData] = useState<A2GControlPlaneData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (background = false) => {
    if (background) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const payload = await api.getA2GControlPlane();
      setData(payload);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  return (
    <div className="h-screen bg-gray-50 font-sans">
      <header className="flex h-16 items-center justify-between border-b bg-white px-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-800">{t("a2gControlPlane.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("a2gControlPlane.description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => navigate("/dashboard")}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t("a2gControlPlane.backToDashboard")}
          </Button>
          <Button variant="outline" onClick={() => load(true)} disabled={refreshing}>
            <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            {t("a2gControlPlane.refresh")}
          </Button>
        </div>
      </header>

      <main className="h-[calc(100vh-4rem)] overflow-auto p-4">
        {loading && <div className="text-muted-foreground">{t("a2gControlPlane.loading")}</div>}
        {!loading && error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-red-600">{error}</div>
        )}
        {!loading && !error && data && (
          <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <Card>
              <CardHeader className="space-y-3 pb-4">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="default">{data.mode}</Badge>
                  <Badge variant="secondary">{data.sourceOfTruth}</Badge>
                  <Badge variant={data.poolSummary.coolingRouteCount > 0 ? "destructive" : "default"}>
                    {t("a2gControlPlane.coolingRoutes", { count: data.poolSummary.coolingRouteCount })}
                  </Badge>
                </div>
                <CardTitle className="text-lg">{t("a2gControlPlane.pipelineTitle")}</CardTitle>
                <CardDescription>{t("a2gControlPlane.pipelineDescription")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.paths.map((item) => (
                  <div key={item.label} className="flex items-center justify-between gap-3 rounded-md border p-3">
                    <div className="min-w-0">
                      <div className="font-medium">{item.label}</div>
                      <div className="truncate text-xs text-muted-foreground">{item.path}</div>
                    </div>
                    <Badge variant={pathBadgeVariant(item.exists)}>
                      {item.exists ? t("a2gControlPlane.exists") : t("a2gControlPlane.missing")}
                    </Badge>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">{t("a2gControlPlane.runtimeTitle")}</CardTitle>
                <CardDescription>{t("a2gControlPlane.runtimeDescription")}</CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="text-xs text-muted-foreground">{t("a2gControlPlane.providerCount")}</div>
                  <div className="mt-1 text-xl font-semibold">{data.runtime.providerCount}</div>
                </div>
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="text-xs text-muted-foreground">{t("a2gControlPlane.routeCount")}</div>
                  <div className="mt-1 text-xl font-semibold">{data.runtime.routeCount}</div>
                </div>
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="text-xs text-muted-foreground">{t("a2gControlPlane.transformerCount")}</div>
                  <div className="mt-1 text-xl font-semibold">{data.runtime.transformerCount}</div>
                </div>
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="text-xs text-muted-foreground">{t("a2gControlPlane.activeScenarios")}</div>
                  <div className="mt-1 text-xl font-semibold">{data.poolSummary.activeScenarios}</div>
                </div>
              </CardContent>
            </Card>

            {data.specSummary && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">{t("a2gControlPlane.specSummaryTitle")}</CardTitle>
                  <CardDescription>{t("a2gControlPlane.specSummaryDescription")}</CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">{t("a2gControlPlane.discovery")}</div>
                    <div className="mt-1 font-semibold">
                      {data.specSummary.providerDiscoveryEnabled ? t("common.yes") : t("common.no")}
                    </div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">{t("a2gControlPlane.declaredProviders")}</div>
                    <div className="mt-1 font-semibold">{data.specSummary.declaredProviderCount}</div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">{t("a2gControlPlane.modelTiers")}</div>
                    <div className="mt-1 font-semibold">{data.specSummary.modelTierCount}</div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">{t("a2gControlPlane.scenarioCount")}</div>
                    <div className="mt-1 font-semibold">{data.specSummary.scenarioCount}</div>
                  </div>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">{t("a2gControlPlane.poolSummaryTitle")}</CardTitle>
                <CardDescription>{t("a2gControlPlane.poolSummaryDescription")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">{t("a2gControlPlane.coolingRoutesLabel")}</div>
                    <div className="mt-1 font-semibold">{data.poolSummary.coolingRouteCount}</div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">{t("a2gControlPlane.recentFailures")}</div>
                    <div className="mt-1 font-semibold">{data.poolSummary.routesWithRecentFailures}</div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">{t("a2gControlPlane.retryableErrors")}</div>
                    <div className="mt-1 font-semibold">{data.poolSummary.stats.retryableErrors ?? 0}</div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">{t("a2gControlPlane.failFastErrors")}</div>
                    <div className="mt-1 font-semibold">{data.poolSummary.stats.failFastErrors ?? 0}</div>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="font-medium">{t("a2gControlPlane.notesTitle")}</div>
                  <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                    {data.notes.map((note, index) => (
                      <li key={`${index}-${note}`}>{note}</li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
