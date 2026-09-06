import * as fs from "fs";
import * as path from "path";

/**
 * 长期记忆存储：跨重启持久化。
 *
 * 设计（与 brain.ts 的"意图白名单"哲学一致：LLM 只建议，代码层把关）：
 * - 存储是简单的 JSON 文件（data/memory.json），条目为一行中文事实。
 * - 写入来源只有一个：LLM 从最近对话中提取（extractMemories），代码层做去重与上限。
 * - 每次写入立即落盘（文件很小，无需批量）。
 * - 服务对象可用聊天口令"清除记忆"一键清空（方便测试）。
 */

interface MemoryEntry {
  /** 一行中文事实，如 "服务对象 喜欢被绳子绑" */
  text: string;
  /** ISO 时间戳（记录时间） */
  at: string;
}

interface MemoryFile {
  version: 1;
  entries: MemoryEntry[];
}

const MAX_ENTRIES = 60;

export class MemoryStore {
  private entries: MemoryEntry[] = [];
  private file = path.resolve(process.cwd(), "data", "memory.json");

  /** 启动时加载；文件不存在或损坏时从空开始（不 crash） */
  load(): void {
    try {
      if (!fs.existsSync(this.file)) {
        this.entries = [];
        return;
      }
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8")) as MemoryFile;
      this.entries = Array.isArray(raw?.entries)
        ? raw.entries.filter((e) => e && typeof e.text === "string" && e.text.trim().length > 0)
        : [];
    } catch (err) {
      console.error("[memory] failed to load, starting empty:", (err as Error).message);
      this.entries = [];
    }
  }

  /** 返回记忆文本列表（注入 LLM 用） */
  getAll(): string[] {
    return this.entries.map((e) => e.text);
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * 追加记忆（去重 + 截断 + 落盘）。返回实际新增的条数。
   * 去重规则：与已有条目互为包含（一方包含另一方）视为重复。
   */
  add(texts: string[]): number {
    const now = new Date().toISOString();
    let added = 0;
    for (const t of texts) {
      const text = t.trim().replace(/\s+/g, " ").slice(0, 120);
      if (!text) continue;
      const dup = this.entries.some((e) => {
        const a = e.text;
        return a === text || a.includes(text) || text.includes(a);
      });
      if (dup) continue;
      this.entries.push({ text, at: now });
      added += 1;
    }
    // 超上限：丢最旧的（记忆条目按时间追加，新的大概率更重要）
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(this.entries.length - MAX_ENTRIES);
    }
    if (added > 0) this.save();
    return added;
  }

  /** 清空全部记忆（聊天口令触发） */
  clear(): void {
    this.entries = [];
    this.save();
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const data: MemoryFile = { version: 1, entries: this.entries };
      fs.writeFileSync(this.file, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error("[memory] failed to save:", (err as Error).message);
    }
  }
}
