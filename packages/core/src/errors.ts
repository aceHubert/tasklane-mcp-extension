export type BoardErrorCode =
  | 'VALIDATION'
  | 'TASK_NOT_FOUND'
  | 'BOARD_NOT_FOUND'
  | 'BOARD_MISMATCH'
  | 'TASK_ARCHIVED'
  | 'EXECUTION_BUSY'
  | 'EXECUTION_CONFLICT'
  | 'EXECUTION_STALE'
  | 'EXECUTION_REPORT_REQUIRED'
  | 'INVALID_TRANSITION'
  | 'GIT_ERROR'
  | 'MODEL_CATALOG'
  | 'STORE_ERROR';

export class BoardError extends Error {
  constructor(
    readonly code: BoardErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'BoardError';
  }
}
