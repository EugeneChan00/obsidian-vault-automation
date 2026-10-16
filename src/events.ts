import { TFile, TFolder, type App, type FrontMatterCache, type TAbstractFile } from "obsidian";
import type { Disposable, Frontmatter, PathEvent, PathFilter, PropertyChange, PropertyFilter } from "./api";

type PropHandler = (e: PropertyChange) => void | Promise<void>;
type PathHandler = (e: PathEvent) => void | Promise<void>;

/** Re-entrant writes to one note within this window count toward the loop guard. */
const LOOP_WINDOW_MS = 2000;
const LOOP_LIMIT = 20;

const inFolder = (path: string, folder: string | undefined) => !folder || path === folder || path.startsWith(`${folder}/`);

/** Frontmatter snapshots + filtered dispatch of property and path events. */
export class EventHub {
  private readonly snapshots = new Map<string, Frontmatter>();
  private readonly propSubs = new Set<{ filter: PropertyFilter; handler: PropHandler }>();
  private readonly pathSubs = new Set<{ filter: PathFilter; handler: PathHandler }>();
  private readonly recentWrites = new Map<string, number[]>();
  private suspendDepth = 0;

  constructor(private readonly app: App) {}

  get suspended(): boolean {
    return this.suspendDepth > 0;
  }

  async batch<T>(fn: () => Promise<T>): Promise<T> {
    this.suspendDepth++;
    try {
      return await fn();
    } finally {
      this.suspendDepth--;
    }
  }

  /** Seed snapshots so the first change is compared against the real prior state. */
  prime(): void {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (fm) this.snapshots.set(file.path, structuredClone({ ...fm }));
    }
  }

  onProperty(filter: PropertyFilter, handler: PropHandler): Disposable {
    const sub = { filter, handler };
    this.propSubs.add(sub);
    return { dispose: () => this.propSubs.delete(sub) };
  }

  onPath(filter: PathFilter, handler: PathHandler): Disposable {
    const sub = { filter, handler };
    this.pathSubs.add(sub);
    return { dispose: () => this.pathSubs.delete(sub) };
  }

  snapshot(path: string): Frontmatter | null {
    return this.snapshots.get(path) ?? null;
  }

  async metadataChanged(file: TFile, cache: FrontMatterCache | undefined): Promise<void> {
    const fm: Frontmatter = cache ? structuredClone({ ...cache }) : {};
    const prev = this.snapshots.get(file.path) ?? null;
    this.snapshots.set(file.path, fm);
    if (this.suspended || !cache) return;
    const keys = new Set([...Object.keys(fm), ...Object.keys(prev ?? {})]);
    // Values are YAML-derived plain data, so JSON equality is a deep compare.
    const changed = [...keys].filter((k) => !prev || JSON.stringify(prev[k]) !== JSON.stringify(fm[k]));
    if (!changed.length || this.looping(file.path)) return;
    const event: PropertyChange = { file, fm, prev, changed };
    for (const { filter, handler } of [...this.propSubs]) {
      if (!inFolder(file.path, filter.folder)) continue;
      if (filter.keys && !filter.keys.some((k) => changed.includes(k))) continue;
      if (filter.where && !filter.where(fm)) continue;
      await this.safely(() => handler(event));
    }
  }

  async pathEvent(type: PathEvent["type"], file: TAbstractFile, oldPath?: string): Promise<void> {
    if (type === "delete") this.snapshots.delete(file.path);
    if (type === "rename" && oldPath) {
      const snap = this.snapshots.get(oldPath);
      this.snapshots.delete(oldPath);
      if (snap) this.snapshots.set(file.path, snap);
    }
    if (this.suspended) return;
    const event: PathEvent = { type, path: file.path, oldPath, isFolder: file instanceof TFolder, file };
    for (const { filter, handler } of [...this.pathSubs]) {
      if (filter.types && !filter.types.includes(type)) continue;
      if (filter.folders !== undefined && filter.folders !== event.isFolder) continue;
      const paths = oldPath ? [file.path, oldPath] : [file.path];
      if (!paths.some((p) => inFolder(p, filter.folder) && (!filter.pattern || filter.pattern.test(p)))) continue;
      await this.safely(() => handler(event));
    }
  }

  /** True when a note keeps re-triggering itself (handlers fighting over a value). */
  private looping(path: string): boolean {
    const now = Date.now();
    const hits = (this.recentWrites.get(path) ?? []).filter((t) => now - t < LOOP_WINDOW_MS);
    hits.push(now);
    this.recentWrites.set(path, hits);
    if (hits.length <= LOOP_LIMIT) return false;
    console.warn(`[vault-automation] dropped change on ${path}: ${hits.length} changes in ${LOOP_WINDOW_MS}ms`);
    return true;
  }

  private async safely(fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      console.error("[vault-automation] handler failed", e);
    }
  }
}
