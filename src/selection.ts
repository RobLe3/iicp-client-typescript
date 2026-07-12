/** Opt-in, deterministic-testable `iicp.selection.v1` candidate ordering. */
export type SelectableNode = { node_id: string; score: number; load?: number };
export function weightedV1Order<T extends SelectableNode>(nodes: T[], maxRetries: number, randomValue: number): T[] {
  if (nodes.length <= 1) return nodes.slice(0, maxRetries);
  const pool = nodes.slice(0, Math.max(1, Math.min(nodes.length, 3)));
  const weights = pool.map((node) => Math.max(node.score, 0.01) / (1 + Math.max(0, Math.min(node.load ?? 0, 1))));
  let remaining = Math.max(0, Math.min(randomValue, 0.999999999)) * weights.reduce((sum, weight) => sum + weight, 0);
  let chosen = pool[pool.length - 1];
  for (let i = 0; i < pool.length; i++) { remaining -= weights[i]; if (remaining <= 0) { chosen = pool[i]; break; } }
  return [chosen, ...nodes.slice(0, maxRetries).filter((node) => node.node_id !== chosen.node_id)].slice(0, maxRetries);
}
