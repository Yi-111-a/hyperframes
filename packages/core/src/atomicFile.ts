import * as fs from "node:fs";
import { randomUUID } from "node:crypto";

type SiblingFileSystem = Pick<typeof fs, "writeFileSync" | "chmodSync" | "unlinkSync">;

/** Replace a file only after the complete sibling temp file is written. No mode: the default one. */
export function replaceFileAtomically(
  filePath: string,
  content: string | Uint8Array,
  mode?: number,
  operations: SiblingFileSystem & Pick<typeof fs, "renameSync"> = fs,
): void {
  // Node fs.rename uses libuv uv_fs_rename; win32 calls MoveFileExW with MOVEFILE_REPLACE_EXISTING.
  publishSibling(filePath, content, mode, operations, (tempPath) =>
    operations.renameSync(tempPath, filePath),
  );
}

/** Create a file that must not exist yet (EEXIST otherwise); readers never see it empty or partial. */
export function createFileAtomically(
  filePath: string,
  content: string | Uint8Array,
  operations: SiblingFileSystem & Pick<typeof fs, "linkSync"> = fs,
): void {
  publishSibling(filePath, content, undefined, operations, (tempPath) => {
    try {
      operations.linkSync(tempPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
      // Volumes without hard links (FAT, exFAT) keep the direct exclusive write.
      operations.writeFileSync(filePath, content, { flag: "wx" });
    }
    operations.unlinkSync(tempPath);
  });
}

function publishSibling(
  filePath: string,
  content: string | Uint8Array,
  mode: number | undefined,
  operations: SiblingFileSystem,
  publish: (tempPath: string) => void,
): void {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    operations.writeFileSync(tempPath, content, { encoding: "utf-8", mode });
    if (mode !== undefined) operations.chmodSync(tempPath, mode);
    publish(tempPath);
  } catch (error) {
    try {
      operations.unlinkSync(tempPath);
    } catch {
      // Preserve the write error; cleanup is best effort.
    }
    throw error;
  }
}
