import type { TAbstractFile, TFile } from "obsidian";

/**
 * Public contract of the `vault-automation` plugin, reachable as
 * `app.plugins.plugins["vault-automation"].api`. It knows nothing about any note schema:
 * adapters bring the meaning (which notes, which keys, which transitions).
 */
export interface AutomationApi {
  readonly version: 1;

  /** Activate an adapter now (or once the workspace layout is ready). Dispose to deactivate. */
  registerAdapter(adapter: Adapter): Disposable;
  adapters(): string[];

  /** Frontmatter of a note changed (or was first seen after the engine started). */
  onPropertyChange(filter: PropertyFilter, handler: (e: PropertyChange) => void | Promise<void>): Disposable;
  /** A file or folder was created, deleted, or renamed. */
  onPathEvent(filter: PathFilter, handler: (e: PathEvent) => void | Promise<void>): Disposable;

  /** Run `fn` with event delivery suspended (bulk moves/edits); snapshots stay current. */
  batch<T>(fn: () => Promise<T>): Promise<T>;
  readonly suspended: boolean;

  props: PropsApi;
  notes: NotesApi;
  canvas: CanvasApi;
  spaces: SpacesApi;
  schema: SchemaApi;
  /** Trailing-edge debounce keyed by any string (e.g. a folder path). */
  debounce(key: string, ms: number, fn: () => void | Promise<void>): void;
}

export interface Disposable {
  dispose(): void;
}

export interface Adapter {
  /** Stable id, e.g. "rlos". */
  id: string;
  activate(api: AutomationApi): void | Disposable | Promise<void | Disposable>;
}

export type Frontmatter = Record<string, unknown>;

export interface PropertyFilter {
  /** Only notes under this folder path (vault-relative, no trailing slash). */
  folder?: string;
  /** Only when at least one of these keys changed. Omit for any change. */
  keys?: string[];
  /** Extra predicate on the current frontmatter, e.g. `fm => fm.type === "revision"`. */
  where?: (fm: Frontmatter) => boolean;
}

export interface PropertyChange {
  file: TFile;
  /** Current frontmatter (read-only view). */
  fm: Frontmatter;
  /** Frontmatter before the change; null when the note is seen for the first time. */
  prev: Frontmatter | null;
  /** Keys whose value differs from `prev` (deep compare); every key when `prev` is null. */
  changed: string[];
}

export interface PathFilter {
  folder?: string;
  /** Tested against the new path (and the old path for renames). */
  pattern?: RegExp;
  types?: PathEvent["type"][];
  /** Only folders (true) or only files (false). */
  folders?: boolean;
}

export interface PathEvent {
  type: "create" | "delete" | "rename";
  path: string;
  oldPath?: string;
  isFolder: boolean;
  file: TAbstractFile;
}

export interface PropsApi {
  get(path: string): Frontmatter | null;
  /** Merge a patch, or mutate in a callback. Keys set to `undefined` are deleted. No write when nothing changes. */
  set(path: string, patch: Frontmatter | ((fm: Frontmatter) => void)): Promise<boolean>;
}

export interface NotesApi {
  file(path: string): TFile | null;
  /** Resolve a `[[link]]` property value relative to `fromPath`. */
  resolveLink(value: unknown, fromPath: string): TFile | null;
  /** Files under a folder, sorted by path. */
  list(folder: string, opts?: { recursive?: boolean }): TFile[];
  /** Direct child folder names of a folder. */
  subfolders(folder: string): string[];
  ensureFolder(path: string): Promise<void>;
  /** Rename/move through Obsidian so links update. Case-only renames are supported. */
  move(path: string, target: string): Promise<void>;
  /**
   * Create `target` from a template note. `{{key}}` in frontmatter is replaced by a JSON scalar
   * (YAML-safe), in the body by raw text. `uuid` and `date` (local YYYY-MM-DD) are always available.
   */
  createFromTemplate(templatePath: string, target: string, vars: Record<string, string | number>): Promise<TFile>;
}

export interface SpaceInfo {
  id: string;
  name: string;
  sections?: string[];
  archived?: boolean;
}

export interface SpacesApi {
  /** True when a Window Spaces build with the public API is enabled. */
  available(): boolean;
  find(name: string): SpaceInfo | null;
  /** Saved space (no window opened) showing `file`; returns its id. Existing name → existing id. */
  ensure(file: TFile, opts: { name: string; section: string }): Promise<string | null>;
  setSection(id: string, section: string): Promise<void>;
  setArchived(id: string, archived: boolean): Promise<void>;
}

export interface Violation {
  key: string;
  message: string;
}

export interface Validator {
  /** Names of `$defs` entries. */
  defs(): string[];
  /** `enum` values of a `$defs` entry. */
  enumOf(def: string): unknown[];
  /** Validate frontmatter against an object `$defs` entry (required, const, enum, type, pattern, min/max). */
  validate(def: string, fm: Frontmatter): Violation[];
}

export interface CanvasGroupSpec {
  /** Stable key, unique within the spec; used in managed ids and edges. */
  key: string;
  label: string;
  /** Vault paths of files placed directly in this group. */
  files: string[];
  /** Nested groups, stacked inside this group below its own files. */
  groups?: CanvasGroupSpec[];
  /**
   * `true`: fold once (Advanced Canvas format); a group the user re-expands stays expanded.
   * `false`: unfold it if automation folded it. Omitted: leave folding alone.
   */
  collapse?: boolean;
}

export interface CanvasSpec {
  canvasPath: string;
  /** Prefix of every element this spec owns, e.g. "rlos-". Other elements are never touched. */
  idPrefix: string;
  /** File shown left of the groups; edges can reference it as "anchor". */
  anchor?: string;
  /** Top-level groups, left to right. */
  groups: CanvasGroupSpec[];
  /** Edges between "anchor" and top-level group keys. */
  edges: [string, string][];
}

export interface CanvasApi {
  /**
   * Create or reconcile the canvas. Returns true when the file changed. Growth pushes later
   * siblings down instead of overlapping them. `rebuild` re-lays out every managed element.
   */
  sync(spec: CanvasSpec, opts?: { rebuild?: boolean }): Promise<boolean>;
}

export interface SchemaApi {
  /** Load a JSON Schema file (`$defs` subset) from the vault. */
  load(path: string): Promise<Validator>;
}
