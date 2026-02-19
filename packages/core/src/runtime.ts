import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { getRuntimePath } from './config.js';
import type { RuntimeService, RuntimeState } from './types.js';

export function loadRuntimeState(): RuntimeState {
  const path = getRuntimePath();
  if (!existsSync(path)) {
    const blank: RuntimeState = { services: {} };
    saveRuntimeState(blank);
    return blank;
  }

  const parsed = JSON.parse(readFileSync(path, 'utf8')) as RuntimeState;
  return {
    services: parsed.services ?? {}
  };
}

export function saveRuntimeState(state: RuntimeState): void {
  writeFileSync(getRuntimePath(), JSON.stringify(state, null, 2), 'utf8');
}

export function upsertRuntimeService(service: RuntimeService): RuntimeState {
  const state = loadRuntimeState();
  state.services[service.name] = service;
  saveRuntimeState(state);
  return state;
}

export function clearRuntimeService(name: string): RuntimeState {
  const state = loadRuntimeState();
  delete state.services[name];
  saveRuntimeState(state);
  return state;
}
