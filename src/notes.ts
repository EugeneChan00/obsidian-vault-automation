import { normalizePath, TFile, TFolder, type App } from "obsidian";
import type { Frontmatter, NotesApi, PropsApi } from "./api";

/** Local calendar date as `YYYY-MM-DD`. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** `onWrite(path)` runs before each frontmatter write that changes the note. */
export function createProps(app: App, onWrite: (path: string) => void): PropsApi {
  return {
    get(path) {
      const f = app.vault.getAbstractFileByPath(path);
      return f instanceof TFile ? { ...(app.metadataCache.getFileCache(f)?.frontmatter ?? {}) } : null;
    },
    async set(path, patch) {
      const f = app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) throw new Error(`not a file: ${path}`);
      const current = app.metadataCache.getFileCache(f)?.frontmatter ?? {};
      if (typeof patch !== "function" && Object.entries(patch).every(([k, v]) => JSON.stringify(current[k]) === JSON.stringify(v))) return false;
      let changed = false;
      await app.fileManager.processFrontMatter(f, (fm: Frontmatter) => {
        const before = JSON.stringify(fm);
        if (typeof patch === "function") patch(fm);
        else for (const [k, v] of Object.entries(patch)) v === undefined ? delete fm[k] : (fm[k] = v);
        changed = JSON.stringify(fm) !== before;
        if (changed) onWrite(path);
      });
      return changed;
    },
  };
}

export function createNotes(app: App): NotesApi {
  const ensureFolder = async (path: string) => {
    const p = normalizePath(path);
    if (app.vault.getAbstractFileByPath(p) instanceof TFolder) return;
    await app.vault.createFolder(p);
  };
  return {
    file(path) {
      const f = app.vault.getAbstractFileByPath(path);
      return f instanceof TFile ? f : null;
    },
    resolveLink(value, fromPath) {
      if (typeof value !== "string") return null;
      const m = /^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(value.trim());
      return m ? app.metadataCache.getFirstLinkpathDest(m[1]!, fromPath) : null;
    },
    list(folder, opts) {
      const root = app.vault.getAbstractFileByPath(folder);
      if (!(root instanceof TFolder)) return [];
      const out: TFile[] = [];
      const walk = (f: TFolder) => {
        for (const c of f.children) {
          if (c instanceof TFile) out.push(c);
          else if (c instanceof TFolder && opts?.recursive) walk(c);
        }
      };
      walk(root);
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },
    subfolders(folder) {
      const root = app.vault.getAbstractFileByPath(folder);
      return root instanceof TFolder ? root.children.filter((c) => c instanceof TFolder).map((c) => c.name) : [];
    },
    ensureFolder,
    async move(path, target) {
      const f = app.vault.getAbstractFileByPath(path);
      if (!f) throw new Error(`missing: ${path}`);
      if (path === target) return;
      // Case-insensitive filesystems need an intermediate name for case-only renames.
      if (path.toLowerCase() === target.toLowerCase()) await app.fileManager.renameFile(f, `${target}.tmp-rename`);
      await app.fileManager.renameFile(f, target);
    },
    async createFromTemplate(templatePath, target, vars) {
      const raw = await app.vault.adapter.read(templatePath);
      const all: Record<string, string | number> = { uuid: crypto.randomUUID(), date: today(), ...vars };
      const fmEnd = raw.startsWith("---\n") ? raw.indexOf("\n---", 4) : -1;
      const fill = (text: string, asYaml: boolean) =>
        text.replace(/\{\{(\w+)\}\}/g, (m, key: string) => (all[key] === undefined ? m : asYaml ? JSON.stringify(all[key]) : String(all[key])));
      const body = fmEnd < 0 ? fill(raw, false) : fill(raw.slice(0, fmEnd), true) + fill(raw.slice(fmEnd), false);
      const dir = target.slice(0, target.lastIndexOf("/"));
      if (dir) await ensureFolder(dir);
      return app.vault.create(target, body);
    },
  };
}
