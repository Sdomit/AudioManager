# FX node wiring (node view) — implementation plan

Goal: in **Nodes** view, effects are first-class nodes with **in/out ports** that
the user **wires manually** (`input.out → fx.in`, `fx.out → fx.in`, `fx.out →
bus.in`), like input/bus nodes. The wired sequence drives the engine's per-input
stage order.

## Status
- **Phase 1 — DONE** (`711aa9a`): engine honors a per-input `DspConfig.order`
  (`Vec<DspStage>`), delivered lock-free through the seqlock (packed u32),
  normalized in `clamp()`. `process_block` walks the wired order. 146 tests.
- **Phase 2 — this doc**: the node-graph UI.

## The hard constraint (must respect)
The engine applies DSP **per input** (one chain, shared by all that input's
buses) — NOT per wire. So the canvas model must be:

```
input.out → fx1.in   fx1.out → fx2.in   fx2.out → [fan out to buses]
```

- An input has **one linear fx chain**. Sends to buses originate from the
  chain **tail** (last fx, or the input itself if no fx). This already matches
  how wires re-anchor today.
- **Disallowed** (needs per-send DSP = a later, bigger feature): a mid-chain fx
  wired straight to a bus, or different chains per bus. The UI must reject these.

So manual wiring builds a **linear per-input chain**; bus sends fan from its tail.

## Data model
- `localFx: Map<fxId, { inputId, stage, uiX, uiY }>` in localStorage
  (mirror `localGroups`). One fx node per (input, stage) — backend has one slot
  per stage per input. `fxId = fx:<inputId>:<stage>`.
- fx nodes enter the render `graph` like group nodes (`graphAddNode`, kind `fx`,
  ports from `defaultPortsFor` → in+out). Positions from `nodePositions`.
- Chain links + tail→bus sends are graph edges; reuse `graphAddEdge` validation
  (port dir/kind, cycle). Persist fx chain edges in `localEdges` (already there).

## Derive backend state from the graph (the key new logic)
On any fx-graph change, for each input:
1. Walk `input.out → fx → fx …` following single out→in links → ordered stage
   list `[denoise, gate, …]` (the chain).
2. `enabled` = stages present in the chain; `order` = chain sequence followed by
   the missing stages (canonical) — `normalize_order` finishes it.
3. Call `updateInputDsp(busId, inputId, dsp)` with that enabled-set + order
   (params preserved from current `input.dsp`).
4. Tail→bus wires map to `onToggleSend(inputId, busId)` (routing unchanged).

## Wiring rules (validation)
- fx `in` port: exactly one inbound (from input or another fx).
- fx `out` port: one outbound to another fx **or** one-or-more to buses (tail).
- Reject: input→bus direct when a chain exists (route from tail instead);
  branch in the middle; cycle (graph already rejects). Show the existing
  drop-rejection tooltip with a reason.

## UI steps
1. fx node component: box + left `in` port + right `out` port; draggable
   (`onNodeMouseDown`), label = stage, × to delete (disables stage).
2. Add fx: drag from a node's out port into empty space → stage menu, OR the
   existing "+" → menu → node spawns, user wires it.
3. Extend the port-drag drop sweep to include fx `in` ports as targets.
4. Replace the current auto-chain boxes (commit `4a49897`) with these wired
   nodes; keep the FX pill/popover for quick param editing.
5. Derivation effect → `updateInputDsp` (debounced); sends via `onToggleSend`.

## Risk / sequencing
Touches the most complex file (`NodeView.tsx`: drag, wiring, persistence).
Build additively (fx nodes alongside existing wiring), verify the existing
input→bus wiring still works at each step, land in small commits:
  2a render fx nodes + ports + drag + persistence (no behavior change to sends)
  2b manual wiring (chain links) + derivation → backend order/enabled
  2c tail→bus sends from the chain tail; remove the auto-chain boxes
  2d validation + rejection UX + tests
