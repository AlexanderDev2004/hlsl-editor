// Structured compiler errors. Every error carries enough context for
// the UI to highlight the related node/port.

export const ERROR_CODES = [
  "InvalidConnection",
  "TypeMismatch",
  "MissingRequiredInput",
  "MissingOutput",
  "InvalidGraph",
  "CycleDetected",
] as const;
export type CompilerErrorCode = (typeof ERROR_CODES)[number];

export interface CompilerError {
  code: CompilerErrorCode;
  message: string;
  nodeId?: string;
  portId?: string;
}

export function err(
  code: CompilerErrorCode,
  message: string,
  nodeId?: string,
  portId?: string,
): CompilerError {
  const out: CompilerError = { code, message };
  if (nodeId !== undefined) {
    out.nodeId = nodeId;
  }
  if (portId !== undefined) {
    out.portId = portId;
  }
  return out;
}
