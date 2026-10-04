import type { SessionEvent, SessionEventKind, BoardStore } from './board-store.js';

/** 执行时间线：Task Detail 的 Execution Timeline 数据来源（只记关键事件） */
export class SessionRegistry {
  constructor(
    private store: BoardStore,
    private now: () => Date = () => new Date(),
  ) {}

  record(taskId: string, kind: SessionEventKind, detail?: string): void {
    const event: SessionEvent = { at: this.now().toISOString(), kind };
    if (detail) event.detail = detail;
    this.store.appendEvent(taskId, event);
  }
}
