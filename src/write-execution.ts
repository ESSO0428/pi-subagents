import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { createWriteToolDefinition, type ExtensionContext, generateDiffString, generateUnifiedPatch, type ToolDefinition, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/** Maximum UTF-8 size of the durable display diff plus unified patch. */
export const MAX_DURABLE_DIFF_BYTES = 4 * 1024 * 1024;
/** Avoid retaining arbitrarily large previous files in the live-only store. */
export const MAX_COMPARABLE_WRITE_BYTES = 512_000;
export const MAX_WRITE_METADATA_ENTRIES = 100;

export interface DurableWriteDetails {
  diff?: string;
  patch?: string;
  firstChangedLine?: number;
  diffUnavailableReason?: string;
}

/** Ephemeral execution metadata used by the live renderer. Never persisted as a before/after pair. */
export interface WriteExecutionMeta extends DurableWriteDetails {
  fileExistedBeforeWrite: boolean;
  previousContent?: string;
}

export class WriteExecutionMetadataStore {
  readonly entries = new Map<string, WriteExecutionMeta>();

  set(toolCallId: string, metadata: WriteExecutionMeta): void {
    this.entries.delete(toolCallId);
    this.entries.set(toolCallId, metadata);
    while (this.entries.size > MAX_WRITE_METADATA_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get(toolCallId: unknown): WriteExecutionMeta | undefined {
    return typeof toolCallId === "string" ? this.entries.get(toolCallId) : undefined;
  }

  delete(toolCallId: string): void {
    this.entries.delete(toolCallId);
  }

  clear(): void {
    this.entries.clear();
  }
}

type WriteParams = { path: string; content: string };

function resolveWritePath(path: string, cwd: string): string {
  if (path === "~") return process.env.HOME ?? cwd;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(process.env.HOME ?? cwd, path.slice(2));
  }
  return isAbsolute(path) ? path : resolve(cwd, path);
}

async function capturePreviousContent(absolutePath: string): Promise<WriteExecutionMeta> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(absolutePath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return { fileExistedBeforeWrite: false, previousContent: "" };
    return {
      fileExistedBeforeWrite: true,
      diffUnavailableReason: "unable to inspect the previous file",
    };
  }

  if (!info.isFile()) {
    return {
      fileExistedBeforeWrite: true,
      diffUnavailableReason: "previous path is not a regular file",
    };
  }
  if (info.size > MAX_COMPARABLE_WRITE_BYTES) {
    return {
      fileExistedBeforeWrite: true,
      diffUnavailableReason: `previous file exceeds ${MAX_COMPARABLE_WRITE_BYTES} bytes`,
    };
  }

  try {
    const bytes = await readFile(absolutePath);
    if (bytes.byteLength > MAX_COMPARABLE_WRITE_BYTES) {
      return {
        fileExistedBeforeWrite: true,
        diffUnavailableReason: `previous file exceeds ${MAX_COMPARABLE_WRITE_BYTES} bytes`,
      };
    }
    const previousContent = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { fileExistedBeforeWrite: true, previousContent };
  } catch {
    return {
      fileExistedBeforeWrite: true,
      diffUnavailableReason: "previous file is not comparable UTF-8 text",
    };
  }
}

function durableDetails(
  metadata: WriteExecutionMeta,
  path: string,
  content: string,
): DurableWriteDetails {
  if (metadata.diffUnavailableReason) {
    return { diffUnavailableReason: metadata.diffUnavailableReason };
  }
  const previousContent = metadata.previousContent ?? "";
  const diffResult = generateDiffString(previousContent, content);
  const patch = generateUnifiedPatch(path, previousContent, content);
  const totalBytes = Buffer.byteLength(diffResult.diff, "utf8") + Buffer.byteLength(patch, "utf8");
  if (totalBytes > MAX_DURABLE_DIFF_BYTES) {
    return { diffUnavailableReason: `durable diff exceeds ${MAX_DURABLE_DIFF_BYTES} bytes` };
  }
  return {
    diff: diffResult.diff,
    patch,
    firstChangedLine: diffResult.firstChangedLine,
  };
}

export async function executeWriteWithMetadata(
  store: WriteExecutionMetadataStore,
  toolCallId: string,
  params: WriteParams,
  signal: AbortSignal | undefined,
  cwd: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: DurableWriteDetails }> {
  const absolutePath = resolveWritePath(params.path, cwd);
  store.delete(toolCallId);

  return withFileMutationQueue(absolutePath, async () => {
    const throwIfAborted = () => {
      if (signal?.aborted) throw new Error("Operation aborted");
    };
    throwIfAborted();
    const metadata = await capturePreviousContent(absolutePath);
    throwIfAborted();
    await mkdir(dirname(absolutePath), { recursive: true });
    throwIfAborted();
    await writeFile(absolutePath, params.content, "utf8");
    throwIfAborted();

    const details = durableDetails(metadata, params.path, params.content);
    store.set(toolCallId, { ...metadata, ...details });
    return {
      content: [{ type: "text" as const, text: `Successfully wrote to ${params.path}` }],
      details,
    };
  }).catch((error) => {
    store.delete(toolCallId);
    throw error;
  });
}

/**
 * A session-local write definition. It retains Pi's public schema/description
 * and replaces only execution so the parent registry is never mutated.
 */
export function createTrackedWriteTool(
  cwd: string,
  store = new WriteExecutionMetadataStore(),
): ToolDefinition<any, DurableWriteDetails> {
  const nativeWrite = createWriteToolDefinition(cwd);
  return {
    ...nativeWrite,
    async execute(
      toolCallId: string,
      params: WriteParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      return executeWriteWithMetadata(store, toolCallId, params, signal, ctx.cwd || cwd);
    },
  } as ToolDefinition<any, DurableWriteDetails>;
}
