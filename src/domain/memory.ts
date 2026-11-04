export const memoryModes = ['advanced', 'simple', 'none'] as const;
export type MemoryMode = (typeof memoryModes)[number];

export function isMemoryTool(name: string) {
  return name === 'memories_get' || name.startsWith('memory_');
}
