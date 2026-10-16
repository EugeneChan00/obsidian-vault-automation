import { Notice, Plugin } from "obsidian";
import type { Adapter, AutomationApi, Disposable, PathFilter, PropertyFilter } from "./api";
import { createCanvas } from "./canvas";
import { EventHub } from "./events";
import { createNotes, createProps } from "./notes";
import { createSchema } from "./schema";
import { createSpaces } from "./spaces";

export type * from "./api";

export default class VaultAutomationPlugin extends Plugin {
  api!: AutomationApi;
  private hub!: EventHub;
  private ready = false;
  private readonly active = new Map<string, Disposable[]>();
  private readonly pending: Adapter[] = [];
  private readonly timers = new Map<string, number>();

  async onload(): Promise<void> {
    const hub = new EventHub(this.app);
    this.hub = hub;
    this.api = {
      version: 1,
      registerAdapter: (adapter) => this.addAdapter(adapter),
      adapters: () => [...this.active.keys()],
      onPropertyChange: (filter, handler) => hub.onProperty(filter, handler),
      onPathEvent: (filter, handler) => hub.onPath(filter, handler),
      batch: (fn) => hub.batch(fn),
      get suspended() {
        return hub.suspended;
      },
      props: createProps(this.app),
      notes: createNotes(this.app),
      canvas: createCanvas(this.app),
      spaces: createSpaces(this.app),
      schema: createSchema(this.app),
      debounce: (key, ms, fn) => {
        const prev = this.timers.get(key);
        if (prev !== undefined) window.clearTimeout(prev);
        this.timers.set(
          key,
          window.setTimeout(() => {
            this.timers.delete(key);
            void Promise.resolve(fn()).catch((e) => console.error(`[vault-automation] debounced ${key} failed`, e));
          }, ms),
        );
      },
    };

    this.addCommand({
      id: "list-adapters",
      name: "List active adapters",
      callback: () => new Notice(`Adapters: ${this.api.adapters().join(", ") || "none"}`),
    });

    this.app.workspace.onLayoutReady(() => {
      hub.prime();
      this.registerEvent(this.app.metadataCache.on("changed", (file, _data, cache) => void hub.metadataChanged(file, cache.frontmatter)));
      this.registerEvent(this.app.vault.on("create", (f) => void hub.pathEvent("create", f)));
      this.registerEvent(this.app.vault.on("delete", (f) => void hub.pathEvent("delete", f)));
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => void hub.pathEvent("rename", f, oldPath)));
      this.ready = true;
      for (const a of this.pending.splice(0)) void this.activate(a);
    });
  }

  onunload(): void {
    for (const t of this.timers.values()) window.clearTimeout(t);
    for (const id of [...this.active.keys()]) this.deactivate(id);
  }

  private addAdapter(adapter: Adapter): Disposable {
    if (this.active.has(adapter.id)) this.deactivate(adapter.id);
    if (this.ready) void this.activate(adapter);
    else this.pending.push(adapter);
    return { dispose: () => this.deactivate(adapter.id) };
  }

  private async activate(adapter: Adapter): Promise<void> {
    // Subscriptions made through the scoped api are tracked so deactivation removes them.
    const owned: Disposable[] = [];
    const track = (d: Disposable) => {
      owned.push(d);
      return d;
    };
    const scoped: AutomationApi = Object.create(this.api, {
      onPropertyChange: { value: (f: PropertyFilter, h: Parameters<AutomationApi["onPropertyChange"]>[1]) => track(this.hub.onProperty(f, h)) },
      onPathEvent: { value: (f: PathFilter, h: Parameters<AutomationApi["onPathEvent"]>[1]) => track(this.hub.onPath(f, h)) },
    });
    this.active.set(adapter.id, owned);
    try {
      const result = await adapter.activate(scoped);
      if (result) owned.push(result);
    } catch (e) {
      this.deactivate(adapter.id);
      console.error(`[vault-automation] adapter ${adapter.id} failed to activate`, e);
      new Notice(`Automation adapter ${adapter.id} failed to activate`);
    }
  }

  private deactivate(id: string): void {
    for (const d of this.active.get(id) ?? []) d.dispose();
    this.active.delete(id);
  }
}
