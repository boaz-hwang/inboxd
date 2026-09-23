import type { ResourceRefV1 } from "../../protocol/src/schema.ts";
import type { TuiState } from "./index.ts";

type RoomDraft = Pick<TuiState, "composeActive" | "composeMode" | "draft" | "draftCursor" | "replyTo" | "templateStep" | "templateId" | "templateArguments">;

/** Unsent editor input belongs to its exact room and lives only for this TUI session. */
export class RoomDrafts {
  private readonly drafts = new Map<string, RoomDraft>();

  private key(resource: ResourceRefV1): string {
    return JSON.stringify([resource.platform, resource.account, resource.kind, resource.kind === "chat" ? resource.chat_id : resource.destination_id]);
  }

  save(resource: ResourceRefV1, state: RoomDraft): void {
    const key = this.key(resource);
    if (!state.composeActive) { this.drafts.delete(key); return; }
    this.drafts.set(key, {
      composeActive: state.composeActive,
      composeMode: state.composeMode,
      draft: state.draft,
      draftCursor: state.draftCursor,
      replyTo: state.replyTo,
      templateStep: state.templateStep,
      templateId: state.templateId,
      templateArguments: state.templateArguments,
    });
  }

  take(resource: ResourceRefV1): RoomDraft | undefined {
    const key = this.key(resource);
    const draft = this.drafts.get(key);
    this.drafts.delete(key);
    return draft;
  }

  clear(): void { this.drafts.clear(); }
}
