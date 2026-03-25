import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type {
  A2GControlPlaneData,
  A2GDiffPayload,
  A2GGeneratePayload,
  A2GReleaseContextPayload,
  A2GValidatePayload,
} from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const pathBadgeVariant = (ok: boolean): "default" | "destructive" =>
  ok ? "default" : "destructive";

export function A2GControlPlane() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [data, setData] = useState<A2GControlPlaneData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftSource, setDraftSource] = useState("spec");
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const [generatedPreview, setGeneratedPreview] =
    useState<A2GGeneratePayload | null>(null);
  const [validatePreview, setValidatePreview] =
    useState<A2GValidatePayload | null>(null);
  const [releaseContext, setReleaseContext] =
    useState<A2GReleaseContextPayload | null>(null);
  const [diffPreview, setDiffPreview] = useState<A2GDiffPayload | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const parseDraft = () => {
    try {
      return JSON.parse(draftText) as Record<string, unknown>;
    } catch {
      throw new Error(t("a2gControlPlane.invalidDraftJson"));
    }
  };

  const load = useCallback(async (background = false) => {
    if (background) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const [payload, draft, release] = await Promise.all([
        api.getA2GControlPlane(),
        api.getA2GDraft(),
        api.getA2GReleaseContext(),
      ]);
      setData(payload);
      setDraftText(JSON.stringify(draft.spec, null, 2));
      setDraftSource(draft.source);
      setReleaseContext(release);
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

  const runAction = async (action: string, runner: () => Promise<void>) => {
    setBusyAction(action);
    setActionError(null);
    setDraftMessage(null);
    try {
      await runner();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveDraft = () =>
    runAction("save", async () => {
      const spec = parseDraft();
      const result = await api.saveA2GDraft(spec);
      setDraftSource(result.source);
      setDraftMessage(t("a2gControlPlane.draftSaved"));
    });

  const handleGenerate = () =>
    runAction("generate", async () => {
      const spec = parseDraft();
      const result = await api.generateA2GConfig(spec);
      setGeneratedPreview(result);
      setDraftMessage(t("a2gControlPlane.generateSuccess"));
    });

  const handleValidate = () =>
    runAction("validate", async () => {
      const spec = parseDraft();
      const result = await api.validateA2GConfig(spec);
      const release = await api.getA2GReleaseContext();
      setValidatePreview(result);
      setGeneratedPreview({
        ok: result.ok,
        generatedConfig: result.generatedConfig,
        summary: result.summary,
      });
      setReleaseContext(release);
      setDraftMessage(result.message);
    });

  const handleDiffPreview = () =>
    runAction("diff", async () => {
      const result = await api.getA2GDiff();
      setDiffPreview(result);
      setDraftMessage(
        result.hasUnpublishedChanges
          ? t("a2gControlPlane.diffDetected")
          : t("a2gControlPlane.diffClean"),
      );
    });

  const handleCreateSnapshot = () =>
    runAction("snapshot", async () => {
      const spec = parseDraft();
      await api.createA2GSnapshot(spec);
      const release = await api.getA2GReleaseContext();
      setReleaseContext(release);
      setDraftMessage(t("a2gControlPlane.snapshotCreated"));
    });

  const handleResetDraft = () =>
    runAction("reset", async () => {
      await api.resetA2GDraft();
      setGeneratedPreview(null);
      setValidatePreview(null);
      setDiffPreview(null);
      await load(true);
      setDraftMessage(t("a2gControlPlane.draftReset"));
    });

  return (
    <div className="h-screen bg-gray-50 font-sans">
      <header className="flex h-16 items-center justify-between border-b bg-white px-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-800">
            {t("a2gControlPlane.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("a2gControlPlane.description")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => navigate("/dashboard")}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t("a2gControlPlane.backToDashboard")}
          </Button>
          <Button variant="outline" onClick={() => load(true)} disabled={refreshing}>
            <RefreshCw
              className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            />
            {t("a2gControlPlane.refresh")}
          </Button>
        </div>
      </header>

      <main className="h-[calc(100vh-4rem)] overflow-auto p-4">
        {loading && (
          <div className="text-muted-foreground">
            {t("a2gControlPlane.loading")}
          </div>
        )}
        {!loading && error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-red-600">
            {error}
          </div>
        )}
        {!loading && !error && data && (
          <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <Card>
              <CardHeader className="space-y-3 pb-4">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="default">{data.mode}</Badge>
                  <Badge variant="secondary">{data.sourceOfTruth}</Badge>
                  <Badge
                    variant={
                      data.poolSummary.coolingRouteCount > 0
                        ? "destructive"
                        : "default"
                    }
                  >
                    {t("a2gControlPlane.coolingRoutes", {
                      count: data.poolSummary.coolingRouteCount,
                    })}
                  </Badge>
                </div>
                <CardTitle className="text-lg">
                  {t("a2gControlPlane.pipelineTitle")}
                </CardTitle>
                <CardDescription>
                  {t("a2gControlPlane.pipelineDescription")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.paths.map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between gap-3 rounded-md border p-3"
                  >
                    <div className="min-w-0">
                      <div className="font-medium">{item.label}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {item.path}
                      </div>
                    </div>
                    <Badge variant={pathBadgeVariant(item.exists)}>
                      {item.exists
                        ? t("a2gControlPlane.exists")
                        : t("a2gControlPlane.missing")}
                    </Badge>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">
                  {t("a2gControlPlane.runtimeTitle")}
                </CardTitle>
                <CardDescription>
                  {t("a2gControlPlane.runtimeDescription")}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="text-xs text-muted-foreground">
                    {t("a2gControlPlane.providerCount")}
                  </div>
                  <div className="mt-1 text-xl font-semibold">
                    {data.runtime.providerCount}
                  </div>
                </div>
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="text-xs text-muted-foreground">
                    {t("a2gControlPlane.routeCount")}
                  </div>
                  <div className="mt-1 text-xl font-semibold">
                    {data.runtime.routeCount}
                  </div>
                </div>
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="text-xs text-muted-foreground">
                    {t("a2gControlPlane.transformerCount")}
                  </div>
                  <div className="mt-1 text-xl font-semibold">
                    {data.runtime.transformerCount}
                  </div>
                </div>
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="text-xs text-muted-foreground">
                    {t("a2gControlPlane.unpublishedChanges")}
                  </div>
                  <div className="mt-1 text-xl font-semibold">
                    {data.releaseSummary.hasUnpublishedChanges
                      ? t("common.yes")
                      : t("common.no")}
                  </div>
                </div>
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="text-xs text-muted-foreground">
                    {t("a2gControlPlane.activeScenarios")}
                  </div>
                  <div className="mt-1 text-xl font-semibold">
                    {data.poolSummary.activeScenarios}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle className="text-lg">
                  {t("a2gControlPlane.draftEditorTitle")}
                </CardTitle>
                <CardDescription>
                  {t("a2gControlPlane.draftEditorDescription", {
                    source: draftSource,
                  })}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Button onClick={handleSaveDraft} disabled={busyAction !== null}>
                    {t("a2gControlPlane.saveDraft")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleGenerate}
                    disabled={busyAction !== null}
                  >
                    {t("a2gControlPlane.generatePreview")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleValidate}
                    disabled={busyAction !== null}
                  >
                    {t("a2gControlPlane.validateDraft")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleDiffPreview}
                    disabled={busyAction !== null}
                  >
                    {t("a2gControlPlane.diffPreview")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleCreateSnapshot}
                    disabled={busyAction !== null}
                  >
                    {t("a2gControlPlane.createSnapshot")}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={handleResetDraft}
                    disabled={busyAction !== null}
                  >
                    {t("a2gControlPlane.resetDraft")}
                  </Button>
                </div>
                {draftMessage && (
                  <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">
                    {draftMessage}
                  </div>
                )}
                {actionError && (
                  <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    {actionError}
                  </div>
                )}
                <Textarea
                  value={draftText}
                  onChange={(event) => setDraftText(event.target.value)}
                  className="min-h-[360px] font-mono text-xs"
                  spellCheck={false}
                />
              </CardContent>
            </Card>

            {data.specSummary && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">
                    {t("a2gControlPlane.specSummaryTitle")}
                  </CardTitle>
                  <CardDescription>
                    {t("a2gControlPlane.specSummaryDescription")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">
                      {t("a2gControlPlane.discovery")}
                    </div>
                    <div className="mt-1 font-semibold">
                      {data.specSummary.providerDiscoveryEnabled
                        ? t("common.yes")
                        : t("common.no")}
                    </div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">
                      {t("a2gControlPlane.declaredProviders")}
                    </div>
                    <div className="mt-1 font-semibold">
                      {data.specSummary.declaredProviderCount}
                    </div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">
                      {t("a2gControlPlane.modelTiers")}
                    </div>
                    <div className="mt-1 font-semibold">
                      {data.specSummary.modelTierCount}
                    </div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">
                      {t("a2gControlPlane.scenarioCount")}
                    </div>
                    <div className="mt-1 font-semibold">
                      {data.specSummary.scenarioCount}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">
                  {t("a2gControlPlane.releaseTitle")}
                </CardTitle>
                <CardDescription>
                  {t("a2gControlPlane.releaseDescription")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">
                      {t("a2gControlPlane.draftRevision")}
                    </div>
                    <div className="mt-1 font-semibold">
                      {releaseContext?.draftRevision ?? "-"}
                    </div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">
                      {t("a2gControlPlane.activeVersion")}
                    </div>
                    <div className="mt-1 font-semibold">
                      {releaseContext?.activeVersion ?? "-"}
                    </div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">
                      {t("a2gControlPlane.latestSnapshot")}
                    </div>
                    <div className="mt-1 font-semibold">
                      {releaseContext?.latestSnapshotVersion ?? "-"}
                    </div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">
                      {t("a2gControlPlane.snapshotCount")}
                    </div>
                    <div className="mt-1 font-semibold">
                      {releaseContext?.snapshots.length ?? 0}
                    </div>
                  </div>
                </div>
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  {releaseContext?.validation.message ?? "-"}
                </div>
                <div className="space-y-2">
                  <div className="font-medium">
                    {t("a2gControlPlane.snapshotListTitle")}
                  </div>
                  <div className="space-y-2">
                    {(releaseContext?.snapshots ?? []).slice(0, 5).map((snapshot) => (
                      <div
                        key={snapshot.releaseVersion}
                        className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"
                      >
                        <div className="min-w-0">
                          <div className="font-medium">{snapshot.releaseVersion}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {snapshot.createdAt}
                          </div>
                        </div>
                        <Badge variant={snapshot.validation.ok ? "default" : "destructive"}>
                          {snapshot.validation.ok ? t("common.yes") : t("common.no")}
                        </Badge>
                      </div>
                    ))}
                    {(releaseContext?.snapshots.length ?? 0) === 0 && (
                      <div className="text-sm text-muted-foreground">
                        {t("a2gControlPlane.noSnapshots")}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">
                  {t("a2gControlPlane.poolSummaryTitle")}
                </CardTitle>
                <CardDescription>
                  {t("a2gControlPlane.poolSummaryDescription")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">
                      {t("a2gControlPlane.coolingRoutesLabel")}
                    </div>
                    <div className="mt-1 font-semibold">
                      {data.poolSummary.coolingRouteCount}
                    </div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">
                      {t("a2gControlPlane.recentFailures")}
                    </div>
                    <div className="mt-1 font-semibold">
                      {data.poolSummary.routesWithRecentFailures}
                    </div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">
                      {t("a2gControlPlane.retryableErrors")}
                    </div>
                    <div className="mt-1 font-semibold">
                      {data.poolSummary.stats.retryableErrors ?? 0}
                    </div>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-xs text-muted-foreground">
                      {t("a2gControlPlane.failFastErrors")}
                    </div>
                    <div className="mt-1 font-semibold">
                      {data.poolSummary.stats.failFastErrors ?? 0}
                    </div>
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

            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle className="text-lg">
                  {t("a2gControlPlane.candidatePreviewTitle")}
                </CardTitle>
                <CardDescription>
                  {t("a2gControlPlane.candidatePreviewDescription")}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="generated" className="w-full">
                  <TabsList>
                    <TabsTrigger value="generated">
                      {t("a2gControlPlane.generatedConfigTab")}
                    </TabsTrigger>
                    <TabsTrigger value="validation">
                      {t("a2gControlPlane.validationTab")}
                    </TabsTrigger>
                    <TabsTrigger value="diff">
                      {t("a2gControlPlane.diffTab")}
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="generated">
                    <pre className="max-h-[420px] overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
                      {generatedPreview
                        ? JSON.stringify(generatedPreview.generatedConfig, null, 2)
                        : t("a2gControlPlane.noGeneratedPreview")}
                    </pre>
                  </TabsContent>
                  <TabsContent value="validation" className="space-y-3">
                    {validatePreview ? (
                      <>
                        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                          <div className="rounded-md border p-3">
                            <div className="text-xs text-muted-foreground">
                              {t("a2gControlPlane.inSyncLabel")}
                            </div>
                            <div className="mt-1 font-semibold">
                              {validatePreview.inSyncWithRepoConfig
                                ? t("common.yes")
                                : t("common.no")}
                            </div>
                          </div>
                          <div className="rounded-md border p-3">
                            <div className="text-xs text-muted-foreground">
                              {t("a2gControlPlane.generatedProviders")}
                            </div>
                            <div className="mt-1 font-semibold">
                              {validatePreview.summary.providerCount}
                            </div>
                          </div>
                          <div className="rounded-md border p-3">
                            <div className="text-xs text-muted-foreground">
                              {t("a2gControlPlane.generatedScenarios")}
                            </div>
                            <div className="mt-1 font-semibold">
                              {validatePreview.summary.scenarioCount}
                            </div>
                          </div>
                          <div className="rounded-md border p-3">
                            <div className="text-xs text-muted-foreground">
                              {t("a2gControlPlane.generatedFallbacks")}
                            </div>
                            <div className="mt-1 font-semibold">
                              {validatePreview.summary.fallbackScenarioCount}
                            </div>
                          </div>
                        </div>
                        <div className="rounded-md border bg-muted/30 p-3 text-sm">
                          {validatePreview.message}
                        </div>
                      </>
                    ) : (
                      <div className="text-muted-foreground">
                        {t("a2gControlPlane.noValidationPreview")}
                      </div>
                    )}
                  </TabsContent>
                  <TabsContent value="diff" className="space-y-3">
                    {diffPreview ? (
                      <div className="grid gap-3 xl:grid-cols-2">
                        <div className="rounded-md border p-3">
                          <div className="mb-2 font-medium">
                            {t("a2gControlPlane.specDiffTitle")}
                          </div>
                          <div className="mb-3 text-sm text-muted-foreground">
                            {t("a2gControlPlane.diffSummary", {
                              total: diffPreview.specDiff.summary.total,
                              changed: diffPreview.specDiff.summary.changed,
                              added: diffPreview.specDiff.summary.added,
                              removed: diffPreview.specDiff.summary.removed,
                            })}
                          </div>
                          <pre className="max-h-[280px] overflow-auto rounded-md bg-muted/30 p-3 text-xs">
                            {JSON.stringify(diffPreview.specDiff.changes, null, 2)}
                          </pre>
                        </div>
                        <div className="rounded-md border p-3">
                          <div className="mb-2 font-medium">
                            {t("a2gControlPlane.generatedDiffTitle")}
                          </div>
                          <div className="mb-3 text-sm text-muted-foreground">
                            {t("a2gControlPlane.diffSummary", {
                              total: diffPreview.generatedDiff.summary.total,
                              changed: diffPreview.generatedDiff.summary.changed,
                              added: diffPreview.generatedDiff.summary.added,
                              removed: diffPreview.generatedDiff.summary.removed,
                            })}
                          </div>
                          <pre className="max-h-[280px] overflow-auto rounded-md bg-muted/30 p-3 text-xs">
                            {JSON.stringify(diffPreview.generatedDiff.changes, null, 2)}
                          </pre>
                        </div>
                      </div>
                    ) : (
                      <div className="text-muted-foreground">
                        {t("a2gControlPlane.noDiffPreview")}
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
