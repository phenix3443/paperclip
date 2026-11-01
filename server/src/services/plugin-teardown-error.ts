export class PluginTeardownError extends Error {
  constructor(pluginKey: string, readonly teardownError: unknown) {
    const reason = teardownError instanceof Error ? teardownError.message : String(teardownError);
    super(`Plugin ${pluginKey} state was saved, but runtime teardown failed: ${reason}`, { cause: teardownError });
    this.name = "PluginTeardownError";
  }
}
