import { RelayError } from "../errors.js";
import type { AgentProvider } from "./types.js";

/** The providers this server can delegate to, by id. Today: "antigravity". */
export class ProviderRegistry {
  private readonly providers = new Map<string, AgentProvider>();

  register(provider: AgentProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: string): AgentProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new RelayError("INVALID_INPUT", `Unknown provider "${id}". Available: ${this.ids().join(", ")}.`);
    }
    return provider;
  }

  ids(): string[] {
    return [...this.providers.keys()];
  }

  all(): AgentProvider[] {
    return [...this.providers.values()];
  }
}
