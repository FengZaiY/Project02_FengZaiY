import { check } from './util.mjs';

// Older parsers ignore these references. Fail before import instead of weakening reference protection.
export const requiresNamingFormat = event => /fengzaiy:\/\/|%%\s+fengzaiy-mindmap:/i.test(JSON.stringify(event.data || {}));
export function assertNamingFormat(format, events) {
  check(format >= 8 || !events.some(requiresNamingFormat), 'FengZaiY 新命名引用需要 format 8，请升级所有电脑并重新生成清单', 'INVALID');
}
