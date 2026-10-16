import type { App, TFile } from "obsidian";
import type { SpaceInfo, SpacesApi } from "./api";

/** Shape of the public API exposed by the Window Spaces rlos fork (`plugins["window-spaces"].api`). */
interface WindowSpacesApi {
  findSpaceByName(name: string): SpaceInfo | undefined;
  ensureSpaceForFile(file: TFile, opts: { name: string; section: string }): Promise<string>;
  setSection(spaceId: string, section: string): Promise<void>;
  setArchived(spaceId: string, archived: boolean): Promise<void>;
}

function windowSpaces(app: App): WindowSpacesApi | null {
  // `app.plugins` is undocumented; narrow each hop instead of trusting a shape.
  const registry: unknown = Reflect.get(app, "plugins");
  const plugins: unknown = registry && typeof registry === "object" ? Reflect.get(registry, "plugins") : null;
  const plugin: unknown = plugins && typeof plugins === "object" ? Reflect.get(plugins, "window-spaces") : null;
  const api: unknown = plugin && typeof plugin === "object" ? Reflect.get(plugin, "api") : null;
  if (!api || typeof api !== "object" || !("ensureSpaceForFile" in api) || !("setSection" in api)) return null;
  // Entry points checked above; the fork's api object implements WindowSpacesApi.
  const ws = api as WindowSpacesApi;
  return ws;
}

export function createSpaces(app: App): SpacesApi {
  return {
    available: () => windowSpaces(app) !== null,
    find: (name) => windowSpaces(app)?.findSpaceByName(name) ?? null,
    async ensure(file, opts) {
      const ws = windowSpaces(app);
      return ws ? ws.ensureSpaceForFile(file, opts) : null;
    },
    async setSection(id, section) {
      await windowSpaces(app)?.setSection(id, section);
    },
    async setArchived(id, archived) {
      await windowSpaces(app)?.setArchived(id, archived);
    },
  };
}
