'use strict';
const { EVENT } = require('../events');

/** Operation facts only. No timer, transcript, inference, or reasoning text. */
function project(task, events) {
  if (!task) return { state: 'IDLE', action: '', target: '', timestamp: null };
  const terminal = { PASSED: 'IDLE', FAILED: 'ERROR', INCONCLUSIVE: 'BLOCKED', CANCELLED: 'IDLE', BLOCKED: 'BLOCKED' };
  if (terminal[task.state]) return { state: terminal[task.state], action: task.state.toLowerCase(), target: task.title, timestamp: task.updatedAt };
  for (const ev of [...events].reverse()) {
    if (ev.taskId && ev.taskId !== task.id) continue;
    const base = { target: String(ev.target || ev.name || '').slice(0, 160), timestamp: ev.at };
    if (ev.type === EVENT.TOOL_STARTED) {
      const tool = String(ev.tool || '');
      const state = /^(read|list|search|find)_/.test(tool) ? 'READING'
        : /^(write|edit|replace|insert|rename|delete|patch)_/.test(tool) ? 'WRITING'
          : /^(verify|run_tests)/.test(tool) ? 'VERIFYING'
            : /^(observe|computer)/.test(tool) ? 'OBSERVING' : 'EXECUTING';
      return { state, action: tool, ...base };
    }
    if (ev.type === EVENT.MODEL_THINKING) return { state: 'THINKING', action: 'model response', target: '', timestamp: ev.at };
    if (ev.type === EVENT.VERIFICATION_STARTED) return { state: 'VERIFYING', action: 'checking evidence', ...base };
    if (ev.type === EVENT.QUESTION_PRESENTED || ev.type === EVENT.APPROVAL_REQUIRED) return { state: 'WAITING', action: 'waiting for input', target: '', timestamp: ev.at };
    if (ev.type === EVENT.TOOL_FAILED) return { state: 'ERROR', action: 'tool failed', ...base };
    if ([EVENT.TOOL_COMPLETED, EVENT.QUESTION_RESOLVED, EVENT.APPROVAL_RESOLVED].includes(ev.type)) return { state: 'IDLE', action: 'operation ended', ...base };
  }
  return { state: task.state === 'VERIFYING' ? 'VERIFYING' : 'IDLE', action: '', target: task.title, timestamp: task.updatedAt };
}
module.exports = { project };
