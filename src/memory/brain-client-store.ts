import type { ScopeId } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";

export interface BrainClient {
  clientId: string;
  clientSecret: string;
  source: string;
  federatedRead: string[];
}

export interface BrainClientStore {
  get(scopeId: ScopeId): Promise<BrainClient | null>;
  set(scopeId: ScopeId, client: BrainClient): Promise<void>;
  delete(scopeId: ScopeId): Promise<void>;
  onChange(listener: (scopeId: ScopeId) => void): () => void;
}

export function createBrainClientStore(backing: DurableMap<BrainClient>): BrainClientStore {
  const listeners = new Set<(scopeId: ScopeId) => void>();
  const emit = (scopeId: ScopeId) => {
    for (const l of listeners) l(scopeId);
  };
  return {
    get: (scopeId) => backing.get(scopeId),
    set: async (scopeId, client) => {
      await backing.put(scopeId, client);
      emit(scopeId);
    },
    delete: async (scopeId) => {
      await backing.delete(scopeId);
      emit(scopeId);
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
