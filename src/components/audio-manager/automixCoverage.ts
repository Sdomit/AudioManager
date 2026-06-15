import type { Bus, BusId, Send } from "./types";

/**
 * Automix shares gain only *within a single bus engine* — each output bus runs
 * its own mixer callback over the inputs routed to it, so the cross-input gate
 * can only compare members that feed the same bus. A group whose members are
 * routed to different buses (or routed nowhere) is a silent no-op: each engine
 * sees at most one member and leaves it at unity.
 *
 * Given a group's member input ids and the current routing, return the enabled
 * buses where at least two members are routed (an enabled send to an enabled
 * bus) — those are the buses where the gate actually does something. `gates` is
 * true when at least one such bus exists.
 */
export function groupGateCoverage(
  members: string[],
  sends: Send[],
  buses: Bus[],
): { gates: boolean; gatingBuses: BusId[] } {
  const enabledBuses = new Set(buses.filter((b) => b.enabled).map((b) => b.id));
  const memberSet = new Set(members);
  const countByBus = new Map<BusId, number>();
  for (const s of sends) {
    if (!s.enabled || !memberSet.has(s.inputId) || !enabledBuses.has(s.busId)) {
      continue;
    }
    countByBus.set(s.busId, (countByBus.get(s.busId) ?? 0) + 1);
  }
  const gatingBuses = [...countByBus.entries()]
    .filter(([, n]) => n >= 2)
    .map(([busId]) => busId);
  return { gates: gatingBuses.length > 0, gatingBuses };
}
