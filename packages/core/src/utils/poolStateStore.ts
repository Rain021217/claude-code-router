import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";

export interface PoolStateStore<T> {
  describe(): { kind: string; target?: string };
  load(logger?: any): Promise<T | null>;
  save(state: T, logger?: any): Promise<void>;
}

export class FilePoolStateStore<T> implements PoolStateStore<T> {
  constructor(private readonly stateFile: string) {}

  describe() {
    return {
      kind: "file",
      target: this.stateFile,
    };
  }

  async load(logger?: any): Promise<T | null> {
    try {
      const raw = await readFile(this.stateFile, "utf8");
      return JSON.parse(raw) as T;
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        logger?.info?.(
          { stateFile: this.stateFile },
          "[PoolStateStore] state file does not exist yet"
        );
        return null;
      }
      throw error;
    }
  }

  async save(state: T, logger?: any): Promise<void> {
    const dir = dirname(this.stateFile);
    const tmpFile = `${this.stateFile}.tmp`;
    await mkdir(dir, { recursive: true });
    await writeFile(tmpFile, JSON.stringify(state, null, 2) + "\n", "utf8");
    await rename(tmpFile, this.stateFile);
    logger?.debug?.(
      { stateFile: this.stateFile },
      "[PoolStateStore] persisted state"
    );
  }
}
