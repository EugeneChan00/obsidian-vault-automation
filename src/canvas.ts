import { TFile, type App } from "obsidian";
import type { CanvasApi, CanvasGroupSpec, CanvasSpec } from "./api";

interface CanvasNode {
  id: string;
  type: "file" | "group" | "text" | "link";
  x: number;
  y: number;
  width: number;
  height: number;
  file?: string;
  label?: string;
  /** Advanced Canvas: collapsed group and its stashed contents (positions relative to the group). */
  collapsed?: boolean;
  collapsedData?: { nodes: CanvasNode[]; edges: CanvasEdge[] };
  /** Set when automation collapsed the group, so a user expand is not undone. */
  automationCollapsed?: boolean;
  [extra: string]: unknown;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: string;
  toSide?: string;
  [extra: string]: unknown;
}

interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [extra: string]: unknown;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const CELL = 360;
const GAP = 40;
const PAD = 40;
const COLS = 4;
const HEADER = 40;
/** Top-level groups are created full grid width so growth is vertical only and never overlaps the next group. */
const GROUP_WIDTH = 2 * PAD + COLS * CELL + (COLS - 1) * GAP;
const EMPTY_GROUP_HEIGHT = HEADER + 2 * PAD + CELL;

/** FNV-1a: stable short id for a vault path. */
function pathHash(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function inside(n: Rect, g: Rect): boolean {
  return n.x >= g.x && n.y >= g.y && n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height;
}

/** JSON with object keys sorted, so expand/collapse round-trips that only reorder keys compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

/** Collapse a group in Advanced Canvas's on-disk format. */
function collapse(data: CanvasData, g: CanvasNode): void {
  const members = data.nodes.filter((n) => n.id !== g.id && inside(n, g));
  const ids = new Set(members.map((n) => n.id));
  const edges = data.edges.filter((e) => ids.has(e.fromNode) || ids.has(e.toNode));
  g.collapsed = true;
  g.collapsedData = {
    nodes: [...(g.collapsedData?.nodes ?? []), ...members.map((n) => ({ ...n, x: n.x - g.x, y: n.y - g.y }))],
    edges: [...(g.collapsedData?.edges ?? []), ...edges],
  };
  data.nodes = data.nodes.filter((n) => !ids.has(n.id));
  data.edges = data.edges.filter((e) => !edges.includes(e));
}

/** Inverse of `collapse`: put stashed contents back at absolute positions. */
function expand(data: CanvasData, g: CanvasNode): void {
  const stash = g.collapsedData;
  delete g.collapsedData;
  g.collapsed = false;
  if (!stash) return;
  data.nodes.push(...stash.nodes.map((n) => ({ ...n, x: n.x + g.x, y: n.y + g.y })));
  data.edges.push(...stash.edges);
}

/**
 * Grow `chain[0]` by `dy` at `atY`, pushing everything inside it at or below `atY` down, then
 * repeat for each ancestor at the old bottom edge, so content below never gets overlapped.
 */
function makeRoom(data: CanvasData, chain: CanvasNode[], atY: number, dy: number): void {
  const moved = new Set<string>();
  let y = atY;
  for (const container of chain) {
    const bottom = container.y + container.height;
    for (const n of data.nodes) {
      if (n === container || moved.has(n.id) || !inside(n, container) || n.y < y) continue;
      n.y += dy;
      moved.add(n.id);
    }
    container.height += dy;
    moved.add(container.id);
    y = bottom;
  }
}

/** Pure reconcile of canvas data against a spec; only `idPrefix` elements are added, moved, or removed. */
export function reconcile(data: CanvasData, spec: CanvasSpec, rebuild = false): void {
  const p = spec.idPrefix;
  const anchorId = `${p}anchor`;
  const groupId = (key: string) => `${p}group-${key}`;
  const fileId = (path: string) => `${p}file-${pathHash(path)}`;
  const nodeId = (ref: string) => (ref === "anchor" ? anchorId : groupId(ref));
  const managed = (id: string) => id.startsWith(p);
  const byId = () => new Map(data.nodes.map((n) => [n.id, n]));

  // Flatten the spec tree: parent links, desired group per file, top-down order.
  const order: { spec: CanvasGroupSpec; parent: string | null }[] = [];
  const walk = (g: CanvasGroupSpec, parent: string | null) => {
    order.push({ spec: g, parent });
    for (const c of g.groups ?? []) walk(c, groupId(g.key));
  };
  for (const g of spec.groups) walk(g, null);
  const parentOf = new Map(order.map(({ spec: g, parent }) => [groupId(g.key), parent]));
  const desiredGroup = new Map<string, string>();
  for (const { spec: g } of order) for (const f of g.files) desiredGroup.set(f, groupId(g.key));
  const wantedGroups = new Set(order.map(({ spec: g }) => groupId(g.key)));

  // Work on absolute positions: expand every collapsed managed group, re-collapse at the end.
  const recollapse: string[] = [];
  for (let next = data.nodes.find((n) => managed(n.id) && n.type === "group" && n.collapsed); next; next = data.nodes.find((n) => managed(n.id) && n.type === "group" && n.collapsed)) {
    expand(data, next);
    recollapse.unshift(next.id); // inner groups are expanded later, so they re-collapse first
  }
  if (rebuild) {
    data.nodes = data.nodes.filter((n) => !managed(n.id) || n.id === anchorId);
    data.edges = data.edges.filter((e) => !managed(e.id) && !managed(e.fromNode) && !managed(e.toNode));
    recollapse.length = 0;
  }

  if (spec.anchor) {
    let anchor = data.nodes.find((n) => n.id === anchorId);
    if (!anchor) {
      anchor = { id: anchorId, type: "file", file: spec.anchor, x: 0, y: 0, width: 400, height: 520 };
      data.nodes.push(anchor);
    }
    anchor.file = spec.anchor;
  }

  // Drop managed groups no longer in the spec (unless they still hold user nodes) and managed
  // files that are not desired or whose tightest managed group is not their desired group.
  const before = byId();
  const keep = (n: CanvasNode): boolean => {
    if (!managed(n.id) || n.id === anchorId) return true;
    if (n.type === "group") return wantedGroups.has(n.id) || data.nodes.some((m) => !managed(m.id) && m.type !== "group" && inside(m, n));
    if (!n.id.startsWith(`${p}file-`) || !n.file) return false;
    const target = before.get(desiredGroup.get(n.file) ?? "");
    if (!target) return false;
    const enclosing = data.nodes
      .filter((g) => g.type === "group" && managed(g.id) && inside(n, g))
      .sort((a, b) => a.width * a.height - b.width * b.height)[0];
    return enclosing === target;
  };
  const dropped = new Set(data.nodes.filter((n) => !keep(n)).map((n) => n.id));
  data.nodes = data.nodes.filter((n) => !dropped.has(n.id));
  data.edges = data.edges.filter((e) => !dropped.has(e.fromNode) && !dropped.has(e.toNode));
  const stillCollapse = recollapse.filter((id) => !dropped.has(id));

  const chainOf = (id: string): CanvasNode[] => {
    const all = byId();
    const out: CanvasNode[] = [];
    for (let cur: string | null | undefined = id; cur; cur = parentOf.get(cur)) {
      const n = all.get(cur);
      if (n) out.push(n);
    }
    return out;
  };

  // Ensure groups, parents first. A new top-level group goes right of everything; a new nested
  // group goes below the lowest content of its parent, full parent width.
  for (const { spec: g, parent } of order) {
    const id = groupId(g.key);
    const all = byId();
    let node = all.get(id);
    if (!node) {
      const parentNode = parent ? all.get(parent) : undefined;
      if (!parentNode) {
        const right = data.nodes.reduce((max, n) => Math.max(max, n.x + n.width), 0);
        node = { id, type: "group", label: g.label, x: right + 2 * GAP, y: 0, width: GROUP_WIDTH, height: EMPTY_GROUP_HEIGHT };
      } else {
        const top = data.nodes
          .filter((n) => n !== parentNode && inside(n, parentNode))
          .reduce((max, n) => Math.max(max, n.y + n.height + GAP), parentNode.y + PAD + HEADER);
        node = { id, type: "group", label: g.label, x: parentNode.x + PAD, y: top, width: parentNode.width - 2 * PAD, height: EMPTY_GROUP_HEIGHT };
        const need = node.y + node.height + PAD - (parentNode.y + parentNode.height);
        if (need > 0) makeRoom(data, chainOf(parentNode.id), parentNode.y + parentNode.height, need);
      }
      data.nodes.push(node);
    }
    node.label = g.label;
  }

  // Place missing files in their group's grid. A slot over a nested group pushes that group down.
  const shown = new Set(data.nodes.filter((n) => n.file).map((n) => n.file!));
  for (const { spec: g } of order) {
    for (const filePath of g.files) {
      if (shown.has(filePath)) continue;
      const group = byId().get(groupId(g.key))!;
      const cols = Math.max(1, Math.floor((group.width - 2 * PAD + GAP) / (CELL + GAP)));
      for (let i = 0; ; i++) {
        const rect = {
          x: group.x + PAD + (i % cols) * (CELL + GAP),
          y: group.y + PAD + HEADER + Math.floor(i / cols) * (CELL + GAP),
          width: CELL,
          height: CELL,
        };
        const nested = data.nodes.filter((n) => n.type === "group" && n !== group && inside(n, group) && overlaps(n, rect));
        if (nested.length) {
          const top = Math.min(...nested.map((n) => n.y));
          makeRoom(data, chainOf(group.id), top, rect.y + CELL + GAP - top);
        }
        if (data.nodes.some((n) => n.type !== "group" && overlaps(n, rect))) continue;
        const need = rect.y + CELL + PAD - (group.y + group.height);
        if (need > 0) makeRoom(data, chainOf(group.id), group.y + group.height, need);
        data.nodes.push({ id: fileId(filePath), type: "file", file: filePath, ...rect });
        shown.add(filePath);
        break;
      }
    }
  }

  for (const id of stillCollapse) {
    const n = byId().get(id);
    if (n) collapse(data, n);
  }
  for (const { spec: g } of order) {
    const n = byId().get(groupId(g.key));
    if (n && g.collapse && !n.collapsed && !n.automationCollapsed) {
      collapse(data, n);
      n.automationCollapsed = true;
    }
  }

  const want = new Map(spec.edges.map(([from, to]) => [`${p}edge-${from}--${to}`, [nodeId(from), nodeId(to)] as const]));
  data.edges = data.edges.filter((e) => !e.id.startsWith(`${p}edge-`) || want.has(e.id));
  const have = new Set(data.edges.map((e) => e.id));
  for (const [id, [fromNode, toNode]] of want) {
    if (!have.has(id)) data.edges.push({ id, fromNode, toNode, fromSide: "right", toSide: "left" });
  }
}

export function createCanvas(app: App): CanvasApi {
  return {
    async sync(spec, opts) {
      let file = app.vault.getAbstractFileByPath(spec.canvasPath);
      if (!(file instanceof TFile)) file = await app.vault.create(spec.canvasPath, JSON.stringify({ nodes: [], edges: [] }, null, "\t"));
      if (!(file instanceof TFile)) return false;
      let changed = false;
      await app.vault.process(file, (raw) => {
        // Canvas files are JSON Canvas documents; unknown keys are preserved untouched.
        const data = (raw.trim() ? JSON.parse(raw) : {}) as CanvasData;
        data.nodes ??= [];
        data.edges ??= [];
        const original = canonical(data);
        reconcile(data, spec, opts?.rebuild ?? false);
        changed = canonical(data) !== original;
        return changed ? JSON.stringify(data, null, "\t") : raw;
      });
      return changed;
    },
  };
}
