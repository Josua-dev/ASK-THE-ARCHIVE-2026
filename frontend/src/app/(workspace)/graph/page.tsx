"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  type NodeMouseHandler,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  CircleDot,
  FileText,
  Loader2,
  Network,
  RefreshCw,
  Search,
  Share2,
  Tag,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type { EntityDetail, GraphNode, GraphResponse } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PageBody, PageHeader } from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  LoadingPanel,
  StatCard,
} from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/primitives";

const EDGE_KINDS = [
  { value: "all", label: "All relationships" },
  { value: "mentions", label: "Mentions" },
  { value: "co_occurs", label: "Co-occurrence" },
  { value: "references", label: "References" },
  { value: "cites", label: "Cites" },
];

const NODE_STYLE: Record<string, { fill: string; stroke: string; label: string }> = {
  document: {
    fill: "hsl(var(--foreground) / 0.08)",
    stroke: "hsl(var(--foreground) / 0.45)",
    label: "Document",
  },
  entity: {
    fill: "hsl(var(--accent) / 0.16)",
    stroke: "hsl(var(--accent) / 0.75)",
    label: "Entity",
  },
  contract_ref: {
    fill: "hsl(var(--success) / 0.14)",
    stroke: "hsl(var(--success) / 0.7)",
    label: "Contract reference",
  },
};

export default function KnowledgeGraphPage() {
  return (
    <ReactFlowProvider>
      <GraphWorkspace />
    </ReactFlowProvider>
  );
}

function GraphWorkspace() {
  const toast = useToast();

  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [rawNodes, setRawNodes] = useState<GraphNode[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [docType, setDocType] = useState("all");
  const [edgeKind, setEdgeKind] = useState("all");
  const [minWeight, setMinWeight] = useState(1);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [entity, setEntity] = useState<EntityDetail | null>(null);
  const [entityLoading, setEntityLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.graph({
        doc_type: docType === "all" ? null : docType,
        kind: edgeKind === "all" ? null : edgeKind,
        min_weight: minWeight,
        max_nodes: 400,
      });
      setGraph(response);
      setRawNodes(response.nodes);
      setEdges(toFlowEdges(response.edges));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not build the knowledge graph.",
      );
    } finally {
      setLoading(false);
    }
  }, [docType, edgeKind, minWeight, setEdges]);

  useEffect(() => {
    load();
  }, [load]);

  // Filtering dims everything that does not match rather than removing it, so
  // the reader keeps the shape of the graph while searching.
  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return null;
    const matched = new Set(
      rawNodes
        .filter(
          (node) =>
            node.label.toLowerCase().includes(term) ||
            node.kind.toLowerCase().includes(term),
        )
        .map((node) => node.id),
    );
    if (!matched.size) return new Set<string>();
    const keep = new Set(matched);
    for (const edge of graph?.edges ?? []) {
      if (matched.has(edge.source)) keep.add(edge.target);
      if (matched.has(edge.target)) keep.add(edge.source);
    }
    return keep;
  }, [filter, rawNodes, graph]);

  useEffect(() => {
    setNodes(
      toFlowNodes(rawNodes, visible ? (id) => !visible.has(id) : undefined),
    );
  }, [rawNodes, visible, setNodes]);

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      const raw = (node.data as { raw?: GraphNode }).raw;
      if (!raw) return;
      setSelected(raw);
      setEntity(null);
      if (raw.kind === "entity") {
        setEntityLoading(true);
        api
          .entity(raw.id.replace(/^entity:/, ""))
          .then(setEntity)
          .catch((err) =>
            toast.error(
              "Could not load the entity",
              err instanceof Error ? err.message : undefined,
            ),
          )
          .finally(() => setEntityLoading(false));
      }
    },
    [toast],
  );

  const stats = graph?.stats;

  return (
    <PageBody>
      <PageHeader
        eyebrow="Knowledge"
        title="Knowledge Graph"
        description="Every node and edge here is derived from real extractions — entities and their mentions, document profiles, and page-level co-occurrence. Nothing in this graph is generated or guessed."
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Rebuild
          </Button>
        }
      />

      {error && (
        <ErrorState className="mt-6" message={error} onRetry={load} />
      )}

      {/* Real counts */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Documents"
          value={loading ? null : (stats?.document_count ?? 0)}
          hint="In your permitted scope"
        />
        <StatCard
          label="Entities"
          value={loading ? null : (stats?.entity_count ?? 0)}
          hint="Extracted from document text"
          tone="accent"
        />
        <StatCard
          label="Contract references"
          value={loading ? null : (stats?.contract_reference_count ?? 0)}
          hint="Cited identifiers"
          tone="success"
        />
        <StatCard
          label="Relationships"
          value={loading ? null : (stats?.edge_count ?? 0)}
          hint="Between the nodes above"
        />
      </div>

      {/* Controls */}
      <div className="mt-5 flex flex-wrap items-end gap-3">
        <div className="min-w-[180px] flex-1">
          <label
            htmlFor="graph-filter"
            className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
          >
            Find a node
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="graph-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Name an organisation, person or contract…"
              className="pl-8"
            />
          </div>
        </div>

        <div className="w-[190px]">
          <label
            htmlFor="graph-doctype"
            className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
          >
            Document type
          </label>
          <Select value={docType} onValueChange={setDocType}>
            <SelectTrigger id="graph-doctype">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {["lease", "contract", "policy", "invoice", "nda", "report", "agreement", "survey"].map(
                (type) => (
                  <SelectItem key={type} value={type}>
                    {type.toUpperCase()}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>

        <div className="w-[200px]">
          <label
            htmlFor="graph-kind"
            className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
          >
            Relationship
          </label>
          <Select value={edgeKind} onValueChange={setEdgeKind}>
            <SelectTrigger id="graph-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EDGE_KINDS.map((kind) => (
                <SelectItem key={kind.value} value={kind.value}>
                  {kind.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="w-[170px]">
          <label
            htmlFor="graph-weight"
            className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
          >
            Minimum strength
          </label>
          <Select
            value={String(minWeight)}
            onValueChange={(value) => setMinWeight(Number(value))}
          >
            <SelectTrigger id="graph-weight">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 5, 10].map((weight) => (
                <SelectItem key={weight} value={String(weight)}>
                  {weight === 1 ? "Any connection" : `Strength ≥ ${weight}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Canvas + detail panel */}
      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_360px]">
        <section className="panel overflow-hidden shadow-panel">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
            <p className="label flex items-center gap-1.5">
              <Network className="h-3 w-3" />
              Graph
            </p>
            <div className="flex flex-wrap items-center gap-3">
              {Object.entries(NODE_STYLE).map(([kind, style]) => (
                <span
                  key={kind}
                  className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full border"
                    style={{ background: style.fill, borderColor: style.stroke }}
                  />
                  {style.label}
                </span>
              ))}
            </div>
          </div>

          <div className="h-[560px] bg-background">
            {loading ? (
              <div className="p-6">
                <LoadingPanel label="Building the graph from extracted data…" rows={5} />
              </div>
            ) : !graph?.nodes.length ? (
              <EmptyState
                className="m-6 border-0"
                icon={<Network className="h-4 w-4" />}
                title="No graph to show yet"
                description="The graph is built from extracted entities and document profiles. Once the extraction pass has run over documents in your scope, their relationships appear here."
              />
            ) : (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={onNodeClick}
                nodeTypes={FLOW_NODE_TYPES}
                fitView
                minZoom={0.15}
                maxZoom={2.5}
                proOptions={{ hideAttribution: true }}
                className="[&_.react-flow__node]:cursor-pointer"
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={22}
                  size={1}
                  color="hsl(var(--foreground) / 0.16)"
                />
                <Controls showInteractive={false} />
                <MiniMap
                  pannable
                  zoomable
                  className="!bg-surface !border-border"
                  maskColor="hsl(var(--foreground) / 0.06)"
                  nodeColor={(node) => {
                    const kind = (node.data as { kind?: string })?.kind;
                    return kind === "entity"
                      ? "hsl(var(--accent) / 0.8)"
                      : kind === "contract_ref"
                        ? "hsl(var(--success) / 0.8)"
                        : "hsl(var(--foreground) / 0.45)";
                  }}
                />
              </ReactFlow>
            )}
          </div>
        </section>

        {/* Inspector */}
        <aside className="panel p-4 shadow-panel">
          {!selected ? (
            <EmptyState
              className="border-0 px-2 py-10"
              icon={<CircleDot className="h-4 w-4" />}
              title="Select a node"
              description="Click any node to see where it came from, which documents mention it, and the passages that prove it."
            />
          ) : (
            <NodeInspector
              node={selected}
              entity={entity}
              entityLoading={entityLoading}
              graph={graph}
            />
          )}
        </aside>
      </div>

      {/* Provenance */}
      {stats?.sources?.length ? (
        <section className="mt-5 panel p-4 shadow-panel">
          <p className="label">Where this graph comes from</p>
          <ul className="mt-2.5 space-y-1.5">
            {stats.sources.map((source) => (
              <li
                key={source}
                className="flex items-start gap-2 text-[12px] leading-relaxed text-muted-foreground"
              >
                <Share2 className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
                {source}
              </li>
            ))}
          </ul>
          <Separator className="my-3" />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            A document you cannot read contributes nothing to this graph — not
            even a node that would hint it exists.
          </p>
        </section>
      ) : null}
    </PageBody>
  );
}

/** The right-hand inspector for a selected node. */
function NodeInspector({
  node,
  entity,
  entityLoading,
  graph,
}: {
  node: GraphNode;
  entity: EntityDetail | null;
  entityLoading: boolean;
  graph: GraphResponse | null;
}) {
  const related = useMemo(() => {
    const edges = graph?.edges ?? [];
    return edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  }, [graph, node.id]);

  const documentId = node.id.startsWith("document:")
    ? node.id.replace(/^document:/, "")
    : null;

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-[14px] font-semibold leading-snug tracking-tight">
            {node.label}
          </h2>
          <Badge
            variant={
              node.kind === "entity"
                ? "accent"
                : node.kind === "contract_ref"
                  ? "success"
                  : "default"
            }
          >
            {node.kind.replace("_", " ")}
          </Badge>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {node.mention_count > 0
            ? `${node.mention_count} mention${node.mention_count === 1 ? "" : "s"}`
            : "No mentions recorded"}
          {node.document_count > 0
            ? ` across ${node.document_count} document${node.document_count === 1 ? "" : "s"}`
            : ""}
        </p>
        {documentId && (
          <Link
            href={`/library/${documentId}`}
            className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent transition-colors hover:underline"
          >
            <FileText className="h-3 w-3" />
            Open the document
          </Link>
        )}
      </div>

      {Object.keys(node.attributes ?? {}).length > 0 && (
        <div>
          <p className="label mb-1.5">Attributes</p>
          <dl className="space-y-1">
            {Object.entries(node.attributes).map(([key, value]) => (
              <div key={key} className="flex justify-between gap-3 text-[11px]">
                <dt className="text-muted-foreground">{key.replace(/_/g, " ")}</dt>
                <dd className="truncate text-right font-mono">
                  {String(value)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {node.kind === "entity" && (
        <div>
          <p className="label mb-1.5">Passages that mention it</p>
          {entityLoading ? (
            <div className="space-y-2">
              <div className="skeleton h-12 rounded" />
              <div className="skeleton h-12 rounded" />
            </div>
          ) : entity?.documents?.length ? (
            <ul className="space-y-1.5">
              {entity.documents.map((doc, index) => (
                <li
                  key={`${doc.document_id}-${index}`}
                  className="rounded-md border border-border bg-background px-2.5 py-2"
                >
                  <Link
                    href={`/library/${doc.document_id}?page=${doc.page_start ?? 1}`}
                    className="text-[11px] font-semibold transition-colors hover:text-accent"
                  >
                    {doc.filename ?? "Document"}
                  </Link>
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    p.{doc.page_start ?? "—"}
                    {doc.page_end && doc.page_end !== doc.page_start
                      ? `–${doc.page_end}`
                      : ""}
                  </p>
                  {doc.excerpt && (
                    <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                      {doc.excerpt}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              No passages recorded for this entity.
            </p>
          )}
        </div>
      )}

      <div>
        <p className="label mb-1.5">Relationships</p>
        {related.length ? (
          <ul className="space-y-1">
            {related.slice(0, 12).map((edge) => {
              const otherId = edge.source === node.id ? edge.target : edge.source;
              const other = graph?.nodes.find((n) => n.id === otherId);
              return (
                <li
                  key={edge.id}
                  className="flex items-baseline justify-between gap-2 text-[11px]"
                >
                  <span className="truncate">{other?.label ?? otherId}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {edge.kind.replace("_", " ")} · {edge.weight}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            No relationships recorded.
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- flow layer */

function toFlowNodes(
  nodes: GraphNode[],
  isDimmed?: (id: string) => boolean,
): Node[] {
  return nodes.map((node) => ({
    id: node.id,
    type: "archive",
    position: { x: 0, y: 0 },
    data: { ...node, raw: node, dimmed: isDimmed?.(node.id) ?? false },
  }));
}

function toFlowEdges(edges: GraphResponse["edges"]): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label ?? undefined,
    style: {
      stroke:
        edge.kind === "cites"
          ? "hsl(var(--success) / 0.65)"
          : edge.kind === "references"
            ? "hsl(var(--foreground) / 0.4)"
            : "hsl(var(--accent) / 0.45)",
      strokeWidth: Math.min(3, 0.8 + edge.weight * 0.35),
    },
    labelStyle: {
      fill: "hsl(var(--muted-foreground))",
      fontSize: 9,
    },
    labelBgStyle: {
      fill: "hsl(var(--surface))",
      fillOpacity: 0.85,
    },
  }));
}

/** A custom node that renders the node kind with its own shape. */
function ArchiveNode({ data }: { data: Record<string, unknown> }) {
  const node = data as unknown as GraphNode & { dimmed?: boolean };
  const style = NODE_STYLE[node.kind] ?? NODE_STYLE.entity;

  return (
    <div
      className={cn(
        "max-w-[190px] rounded-md border px-2.5 py-1.5 shadow-sm transition-opacity",
        node.dimmed && "opacity-25",
      )}
      style={{ background: style.fill, borderColor: style.stroke }}
      title={node.label}
    >
      <p className="truncate text-[11px] font-semibold leading-tight">
        {node.label}
      </p>
      <p
        className="mt-0.5 text-[9px] uppercase tracking-[0.08em] opacity-70"
        style={{ color: "hsl(var(--muted-foreground))" }}
      >
        {style.label}
        {node.mention_count > 0 && ` · ${node.mention_count}`}
      </p>
    </div>
  );
}

const FLOW_NODE_TYPES = { archive: ArchiveNode };
