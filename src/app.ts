import { loadConfig, type RelayConfig } from "./config.js";
import { stderrLogger } from "./logger.js";
import { AntigravityProvider } from "./providers/antigravity/provider.js";
import { ProviderRegistry } from "./providers/registry.js";
import { TaskManager, type Logger } from "./tasks/manager.js";
import { TaskStore } from "./tasks/store.js";

export interface App {
  readonly config: RelayConfig;
  readonly store: TaskStore;
  readonly providers: ProviderRegistry;
  readonly manager: TaskManager;
}

/** Wires the pieces together. Adding a provider means registering one more implementation here. */
export function createApp(env: NodeJS.ProcessEnv = process.env, logger: Logger = stderrLogger(env)): App {
  const config = loadConfig(env);
  const store = new TaskStore(config.tasksDir);
  const providers = new ProviderRegistry().register(new AntigravityProvider(config));
  const manager = new TaskManager(config, store, providers, logger);
  return { config, store, providers, manager };
}
