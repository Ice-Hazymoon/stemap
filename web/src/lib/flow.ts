import type { Node, ReactFlowInstance } from "@xyflow/react";

/**
 * A rebuilt node that arrives without `measured` loses its handle positions, so every wire and the node itself drop out
 * for a frame until the observer measures again. Handing back the last measurement keeps a hover or a step change blank-free.
 */
export const keepMeasured = <T extends Node>(flow: Pick<ReactFlowInstance, "getInternalNode">, nodes: T[]): T[] =>
  nodes.map((n) => ({ ...n, measured: flow.getInternalNode(n.id)?.measured }));
