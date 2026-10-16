import type { App } from "obsidian";
import type { Frontmatter, SchemaApi, Validator, Violation } from "./api";

interface Rule {
  $ref?: string;
  const?: unknown;
  enum?: unknown[];
  type?: "string" | "number" | "integer" | "array" | "object";
  pattern?: string;
  minimum?: number;
  maximum?: number;
  required?: string[];
  properties?: Record<string, Rule>;
}

/** JSON Schema subset over `$defs`: required, const, enum, type, pattern, minimum, maximum, $ref. */
class DefsValidator implements Validator {
  constructor(private readonly defsMap: Record<string, Rule>) {}

  defs(): string[] {
    return Object.keys(this.defsMap);
  }

  enumOf(def: string): unknown[] {
    return this.defsMap[def]?.enum ?? [];
  }

  validate(def: string, fm: Frontmatter): Violation[] {
    const rule = this.defsMap[def];
    if (!rule) return [{ key: "", message: `unknown definition ${def}` }];
    const out: Violation[] = [];
    for (const key of rule.required ?? []) {
      if (fm[key] === undefined || fm[key] === null) out.push({ key, message: "missing" });
    }
    for (const [key, sub] of Object.entries(rule.properties ?? {})) {
      const value = fm[key];
      if (value === undefined || value === null) continue;
      const message = this.check(sub, value);
      if (message) out.push({ key, message });
    }
    return out;
  }

  private check(rule: Rule, value: unknown): string | null {
    if (rule.$ref) {
      const target = this.defsMap[rule.$ref.replace("#/$defs/", "")];
      return target ? this.check(target, value) : `unresolved ${rule.$ref}`;
    }
    if (rule.const !== undefined && value !== rule.const) return `expected ${JSON.stringify(rule.const)}`;
    if (rule.enum && !rule.enum.includes(value)) return `${JSON.stringify(value)} not in [${rule.enum.join(", ")}]`;
    switch (rule.type) {
      case "string":
        if (typeof value !== "string") return `expected string, got ${typeof value}`;
        if (rule.pattern && !new RegExp(rule.pattern).test(value)) return `${JSON.stringify(value)} does not match ${rule.pattern}`;
        break;
      case "number":
      case "integer":
        if (typeof value !== "number" || Number.isNaN(value)) return `expected number, got ${JSON.stringify(value)}`;
        if (rule.type === "integer" && !Number.isInteger(value)) return "expected integer";
        if (rule.minimum !== undefined && value < rule.minimum) return `below ${rule.minimum}`;
        if (rule.maximum !== undefined && value > rule.maximum) return `above ${rule.maximum}`;
        break;
      case "array":
        if (!Array.isArray(value)) return "expected list";
        break;
    }
    return null;
  }
}

export function createSchema(app: App): SchemaApi {
  return {
    async load(path) {
      const doc: unknown = JSON.parse(await app.vault.adapter.read(path));
      const defs = doc && typeof doc === "object" && "$defs" in doc ? doc.$defs : null;
      if (!defs || typeof defs !== "object") throw new Error(`${path}: no $defs`);
      // `$defs` values are schema rule objects; the validator only reads the documented subset.
      const rules = defs as Record<string, Rule>;
      return new DefsValidator(rules);
    },
  };
}
