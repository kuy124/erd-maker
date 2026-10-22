export interface RecoveryStatus { direct: number; blocked: number; signalling: boolean }

/** Never tear down a healthy room merely because another peer failed. */
export function needsReconnect(status: RecoveryStatus, online: boolean): boolean {
  return online && status.direct === 0 && (status.blocked > 0 || !status.signalling);
}
