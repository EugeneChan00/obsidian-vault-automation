import { TFile, type App } from "obsidian";
import type { CanvasApi, CanvasSpec } from "./api";

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

const CELL = 360;
const GAP = 40;
const PAD = 40;
const COLS = 4;
const HEADER = 40;
/** Groups are created full grid width so growth is vertical only and never overlaps the next group. */
const GROUP_WIDTH = 2 * PAD + COLS * CELL + (COLS - 1) * GAP;

/** FNV-1a: stable short id for a vault path. */
function pathHash(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function overlaps(a: CanvasNode, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function inside(n: CanvasNode, g: CanvasNode): boolean {
  return n.x >= g.x && n.y >= g.y && n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height;
}

function freeSlot(members: CanvasNode[], origin: { x: number; y: number }): { x: number; y: number } {
  for (let i = 0; ; i++) {
    const rect = {
      x: origin.x + PAD + (i % COLS) * (CELL + GAP),
      y: origin.y + PAD + HEADER + Math.floor(i / COLS) * (CELL + GAP),
      width: CELL,
      height: CELL,
    };
    if (!members.some((m) => overlaps(m, rect))) return { x: rect.x, y: rect.y };
  }
}

/** Collapse a group in Advanced Canvas's on-disk format. */
function collapse(data: CanvasData, g: CanvasNode): void {
  const members = data.nodes.filter((n) => n.id !== g.id && inside(n, g));
  const ids = new Set(members.map((n) => n.id));
  const edges = data.edges.filter((e) => ids.has(e.fromNode) || ids.has(e.toNode));
  g.collapsed = true;
  g.automationCollapsed = true;
  g.collapsedData = {
    nodes: [...(g.collapsedData?.nodes ?? []), ...members.map((n) => ({ ...n, x: n.x - g.x, y: n.y - g.y }))],
    edges: [...(g.collapsedData?.edges ?? []), ...edges],
  };
  data.nodes = data.nodes.filter((n) => !ids.has(n.id));
  data.edges = data.edges.filter((e) => !edges.includes(e));
}

/** Pure reconcile of canvas data against a spec; only `idPrefix` elements are added, moved, or removed. */
export function reconcile(data: CanvasData, spec: CanvasSpec): void {
  const p = spec.idPrefix;
  const anchorId = `${p}anchor`;
  const groupId = (key: string) => `${p}group-${key}`;
  const fileId = (path: string) => `${p}file-${pathHash(path)}`;
  const nodeId = (ref: string) => (ref === "anchor" ? anchorId : groupId(ref));

  if (spec.anchor) {
    let anchor = data.nodes.find((n) => n.id === anchorId);
    if (!anchor) {
      anchor = { id: anchorId, type: "file", file: spec.anchor, x: 0, y: 0, width: 400, height: 520 };
      data.nodes.push(anchor);
    }
    anchor.file = spec.anchor;
  }

  const desired = new Map<string, string>(); // file path -> group key
  for (const g of spec.groups) for (const f of g.files) desired.set(f, g.key);
  const wantedGroups = new Set(spec.groups.map((g) => groupId(g.key)));
  const wantedFixed = new Set([...(spec.anchor ? [anchorId] : []), ...wantedGroups]);

  // Drop managed file nodes no longer desired, and managed non-file nodes that are not in the spec.
  const keep = (n: CanvasNode) => {
    if (!n.id.startsWith(p)) return true;
    if (n.id.startsWith(`${p}file-`)) return Boolean(n.file && desired.has(n.file));
    if (n.type === "group" && !wantedFixed.has(n.id)) {
      // An obsolete group survives while it still holds user nodes.
      return data.nodes.some((m) => m !== n && !m.id.startsWith(p) && m.type !== "group" && inside(m, n)) || Boolean(n.collapsedData?.nodes.some((c) => !c.id.startsWith(p)));
    }
    return wantedFixed.has(n.id);
  };
  const dropped = new Set(data.nodes.filter((n) => !keep(n)).map((n) => n.id));
  data.nodes = data.nodes.filter(keep);
  for (const g of data.nodes) {
    if (!g.collapsedData) continue;
    for (const n of g.collapsedData.nodes) if (!keep(n)) dropped.add(n.id);
    g.collapsedData.nodes = g.collapsedData.nodes.filter(keep);
    g.collapsedData.edges = g.collapsedData.edges.filter((e) => !dropped.has(e.fromNode) && !dropped.has(e.toNode));
  }
  data.edges = data.edges.filter((e) => !dropped.has(e.fromNode) && !dropped.has(e.toNode));

  const groups = new Map<string, CanvasNode>();
  for (const g of spec.groups) {
    const id = groupId(g.key);
    let node = data.nodes.find((n) => n.id === id);
    if (!node) {
      const right = data.nodes.reduce((max, n) => Math.max(max, n.x + n.width), 0);
      node = { id, type: "group", label: g.label, x: right + 2 * GAP, y: 0, width: GROUP_WIDTH, height: CELL + 2 * PAD + HEADER };
      data.nodes.push(node);
    }
    node.label = g.label;
    groups.set(g.key, node);
  }

  const shown = new Set<string>();
  for (const n of data.nodes) {
    if (n.file) shown.add(n.file);
    for (const c of n.collapsedData?.nodes ?? []) if (c.file) shown.add(c.file);
  }
  for (const [filePath, key] of desired) {
    if (shown.has(filePath)) continue;
    const group = groups.get(key)!;
    const node: CanvasNode = { id: fileId(filePath), type: "file", file: filePath, x: 0, y: 0, width: CELL, height: CELL };
    if (group.collapsed && group.collapsedData) {
      group.collapsedData.nodes.push({ ...node, ...freeSlot(group.collapsedData.nodes, { x: 0, y: 0 }) });
    } else {
      const placed = { ...node, ...freeSlot(data.nodes.filter((n) => n.type !== "group"), group) };
      data.nodes.push(placed);
      group.width = Math.max(group.width, placed.x + placed.width + PAD - group.x);
      group.height = Math.max(group.height, placed.y + placed.height + PAD - group.y);
    }
    shown.add(filePath);
  }

  for (const g of spec.groups) {
    const node = groups.get(g.key)!;
    if (g.collapse && !node.collapsed && !node.automationCollapsed) collapse(data, node);
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
    async sync(spec) {
      let file = app.vault.getAbstractFileByPath(spec.canvasPath);
      if (!(file instanceof TFile)) file = await app.vault.create(spec.canvasPath, JSON.stringify({ nodes: [], edges: [] }, null, "\t"));
      if (!(file instanceof TFile)) return false;
      let changed = false;
      await app.vault.process(file, (raw) => {
        const data = (raw.trim() ? JSON.parse(raw) : {}) as CanvasData;
        data.nodes ??= [];
        data.edges ??= [];
        const before = JSON.stringify(data);
        reconcile(data, spec);
        changed = JSON.stringify(data) !== before;
        return changed ? JSON.stringify(data, null, "\t") : raw;
      });
      return changed;
    },
  };
}
