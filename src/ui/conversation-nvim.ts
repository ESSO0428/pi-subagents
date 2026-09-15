import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { ConversationBlock } from "./conversation-blocks.js";

const DEFAULT_EDITOR = "nvim";

function safeFilename(role: string, id: string): string {
  const safeRole = role.replace(/[^a-z0-9]/gi, "") || "message";
  const safeId = id.replace(/[^a-z0-9]/gi, "").slice(0, 24) || "x";
  return `${safeRole}-${safeId}.md`;
}

function vimStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function notify(ctx: ExtensionContext, message: string, level: "error" | "warning" | "info" = "error"): void {
  ctx.ui.notify(message, level);
}

function runFullscreen(tui: TUI, ctx: ExtensionContext, editor: string, args: string[]): number | null {
  try {
    tui.stop();
    process.stdout.write("\x1b[2J\x1b[H");
    const result = spawnSync(editor, args, {
      cwd: ctx.cwd,
      env: process.env,
      stdio: "inherit",
    });
    if (result.error) {
      notify(ctx, `${editor} failed: ${result.error.message}`);
      return null;
    }
    return result.status;
  } catch (error) {
    notify(ctx, `${editor} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    try {
      tui.start();
      tui.requestRender(true);
    } catch (error) {
      notify(ctx, `Could not restore terminal UI: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Open a bounded conversation block without allowing edits to the transcript. */
export async function viewConversationBlockInNvim(
  tui: TUI,
  ctx: ExtensionContext,
  block: ConversationBlock,
): Promise<void> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "pi-subagents-view-"));
    const filePath = path.join(dir, safeFilename(block.role, block.id));
    await writeFile(filePath, `${block.fullText}\n`, "utf8");
    const editor = process.env.VISUAL || process.env.EDITOR || DEFAULT_EDITOR;
    runFullscreen(tui, ctx, editor, ["-R", filePath]);
  } catch (error) {
    notify(ctx, `Could not open block in nvim: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (dir) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (error) {
        notify(ctx, `Could not remove temporary nvim file: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/** Edit a live assistant block and send the saved text as a new user message. */
export async function editLiveAssistantBlockInNvim(
  pi: ExtensionAPI,
  tui: TUI,
  ctx: ExtensionContext,
  block: ConversationBlock,
): Promise<boolean> {
  if (block.role !== "assistant") {
    notify(ctx, "Only assistant messages can be edited and sent back", "warning");
    return false;
  }

  let dir: string | undefined;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "pi-subagents-edit-"));
    const filePath = path.join(dir, safeFilename(block.role, block.id));
    const savedPath = path.join(dir, "saved");
    await writeFile(filePath, `${block.fullText}\n`, "utf8");
    const editor = process.env.VISUAL || process.env.EDITOR || DEFAULT_EDITOR;
    const autocmd = `autocmd BufWritePost <buffer> call writefile(['1'], ${vimStringLiteral(savedPath)}) | qall`;
    const status = runFullscreen(tui, ctx, editor, ["-c", autocmd, filePath]);
    if (status !== 0) {
      notify(ctx, `${editor} exited with code ${status ?? "unknown"}`, "warning");
      return false;
    }
    if (!existsSync(savedPath)) {
      notify(ctx, "No save detected; nothing sent", "info");
      return false;
    }
    const edited = (await readFile(filePath, "utf8")).trimEnd();
    if (!edited.trim()) {
      notify(ctx, "Saved text is empty; nothing sent", "warning");
      return false;
    }
    pi.sendUserMessage(`I edited an earlier assistant response in Neovim. Treat this as my correction / direction:\n\n${edited}`);
    return true;
  } catch (error) {
    notify(ctx, `Could not edit block in nvim: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    if (dir) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (error) {
        notify(ctx, `Could not remove temporary nvim file: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
