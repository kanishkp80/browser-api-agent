import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  chmodSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "./errors.js";
import type {
  Artifact,
  HumanReturnOutcome,
  Json,
  Operation,
  ProgressEvent,
  Recipe,
  Site,
} from "./types.js";

export interface StoredHandoffClaim {
  token_hash: string;
  status: "claimed" | "returning";
  outcome?: HumanReturnOutcome;
  note?: string;
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new AppError("invalid_json", "Undefined values are not JSON");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** A single owning service, transactional operation/event writes, durable files. */
export class Store {
  private readonly db: DatabaseSync;
  private lockDb?: DatabaseSync;
  private closed = false;
  constructor(
    readonly dir: string,
    readonly maxArtifactBytes = 50 * 1024 * 1024,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.acquireLock();
    try {
      this.db = new DatabaseSync(join(dir, "state.sqlite"));
      const version = this.db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (version.user_version > 1) {
        this.db.close();
        throw new AppError(
          "unsupported_store_version",
          "This data directory was created by a newer service version",
          409,
        );
      }
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, account_id TEXT NOT NULL, request_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(site_id, account_id, request_id));
        CREATE TABLE IF NOT EXISTS events (operation_id TEXT NOT NULL REFERENCES operations(id), sequence INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(operation_id,sequence));
        CREATE TABLE IF NOT EXISTS recipes (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, endpoint TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS knowledge (site_id TEXT NOT NULL, account_id TEXT NOT NULL, contract_hash TEXT NOT NULL, url TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(site_id,account_id,contract_hash,url));
        CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS handoff_claims (operation_id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE, data TEXT NOT NULL);
        PRAGMA user_version=1;`);
      chmodSync(join(dir, "state.sqlite"), 0o600);
      mkdirSync(join(dir, "artifacts"), { recursive: true, mode: 0o700 });
    } catch (error) {
      this.releaseLock();
      throw error;
    }
  }
  private acquireLock(): void {
    // A separate SQLite exclusive transaction is an OS-owned lock. It is released
    // on process death without unsafe stale-file deletion or PID-reuse races.
    const path = join(this.dir, "service-lock.sqlite");
    const lock = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
      this.lockDb = lock;
    } catch (error) {
      lock.close();
      if (
        (error as { code?: string }).code === "ERR_SQLITE_ERROR" &&
        /locked|busy/i.test(String(error))
      ) {
        throw new AppError(
          "store_locked",
          "Another service owns this data directory",
          409,
        );
      }
      throw error;
    }
  }
  private releaseLock(): void {
    this.lockDb?.close();
    this.lockDb = undefined;
  }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private decode<T>(row: unknown): T | undefined {
    return row ? (JSON.parse((row as { data: string }).data) as T) : undefined;
  }
  site(id: string): Site {
    const site = this.decode<Site>(
      this.db.prepare("SELECT data FROM sites WHERE id=?").get(id),
    );
    if (!site)
      throw new AppError("site_not_found", "Site is not registered", 404);
    return site;
  }
  sites(): Site[] {
    return this.db
      .prepare("SELECT data FROM sites ORDER BY id")
      .all()
      .map((row) => this.decode<Site>(row)!);
  }
  putSite(site: Site): void {
    this.db
      .prepare(
        "INSERT INTO sites(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(site.site_id, JSON.stringify(site));
  }
  operation(id: string): Operation {
    const operation = this.decode<Operation>(
      this.db.prepare("SELECT data FROM operations WHERE id=?").get(id),
    );
    if (!operation)
      throw new AppError("operation_not_found", "Operation was not found", 404);
    return operation;
  }
  operations(): Operation[] {
    return this.db
      .prepare("SELECT data FROM operations ORDER BY rowid")
      .all()
      .map((row) => this.decode<Operation>(row)!);
  }
  findRequest(
    siteId: string,
    accountId: string,
    requestId: string,
  ): Operation | undefined {
    return this.decode<Operation>(
      this.db
        .prepare(
          "SELECT data FROM operations WHERE site_id=? AND account_id=? AND request_id=?",
        )
        .get(siteId, accountId, requestId),
    );
  }
  createOperation(operation: Operation): Operation {
    return this.tx(() => {
      this.db
        .prepare(
          "INSERT INTO operations(id,site_id,account_id,request_id,data) VALUES(?,?,?,?,?)",
        )
        .run(
          operation.operation_id,
          operation.site_id,
          operation.account_id,
          operation.request_id,
          JSON.stringify(operation),
        );
      return this.writeUpdate(
        operation,
        "accepted",
        "Request accepted durably; waiting for browser ownership",
      );
    });
  }
  update(
    id: string,
    change: (operation: Operation) => void,
    eventType: string,
    message: string,
    details?: Json,
  ): Operation {
    return this.tx(() => {
      const operation = this.operation(id);
      change(operation);
      return this.writeUpdate(operation, eventType, message, details);
    });
  }
  private writeUpdate(
    operation: Operation,
    eventType: string,
    message: string,
    details?: Json,
  ): Operation {
    operation.revision++;
    operation.updated_at = new Date().toISOString();
    const event: ProgressEvent = {
      operation_id: operation.operation_id,
      sequence: operation.revision,
      timestamp: operation.updated_at,
      state: operation.state,
      phase: operation.phase,
      event_type: eventType,
      message,
      ...(details === undefined ? {} : { details }),
    };
    this.db
      .prepare("UPDATE operations SET data=? WHERE id=?")
      .run(JSON.stringify(operation), operation.operation_id);
    this.db
      .prepare("INSERT INTO events(operation_id,sequence,data) VALUES(?,?,?)")
      .run(operation.operation_id, event.sequence, JSON.stringify(event));
    return operation;
  }
  events(id: string, after: number, limit = 200): ProgressEvent[] {
    return this.db
      .prepare(
        "SELECT data FROM events WHERE operation_id=? AND sequence>? ORDER BY sequence LIMIT ?",
      )
      .all(id, after, limit)
      .map((row) => this.decode<ProgressEvent>(row)!);
  }
  recipes(siteId: string, endpoint: string): Recipe[] {
    return this.db
      .prepare(
        "SELECT data FROM recipes WHERE site_id=? AND endpoint=? ORDER BY rowid DESC",
      )
      .all(siteId, endpoint)
      .map((row) => this.decode<Recipe>(row)!);
  }
  siteRecipes(siteId: string): Recipe[] {
    return this.db
      .prepare(
        "SELECT data FROM recipes WHERE site_id=? ORDER BY rowid DESC LIMIT 12",
      )
      .all(siteId)
      .map((row) => this.decode<Recipe>(row)!);
  }
  putRecipe(recipe: Recipe): void {
    this.db
      .prepare(
        "INSERT INTO recipes(id,site_id,endpoint,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(
        recipe.recipe_id,
        recipe.site_id,
        recipe.endpoint,
        JSON.stringify(recipe),
      );
  }
  remember(site: Site, url: string, value: Json): void {
    this.db
      .prepare(
        "INSERT INTO knowledge(site_id,account_id,contract_hash,url,data) VALUES(?,?,?,?,?) ON CONFLICT(site_id,account_id,contract_hash,url) DO UPDATE SET data=excluded.data",
      )
      .run(
        site.site_id,
        site.account_id,
        site.contract_hash,
        url,
        JSON.stringify(value),
      );
  }
  knowledge(site: Site): Json[] {
    return this.db
      .prepare(
        "SELECT data FROM knowledge WHERE site_id=? AND account_id=? AND contract_hash=? ORDER BY rowid DESC LIMIT 12",
      )
      .all(site.site_id, site.account_id, site.contract_hash)
      .map((row) => this.decode<Json>(row)!);
  }
  handoffClaim(id: string): StoredHandoffClaim | undefined {
    return this.decode<StoredHandoffClaim>(
      this.db
        .prepare("SELECT data FROM handoff_claims WHERE operation_id=?")
        .get(id),
    );
  }
  verifyHandoffClaim(id: string, tokenHash: string): StoredHandoffClaim {
    const claim = this.handoffClaim(id);
    if (!claim || !this.sameHash(claim.token_hash, tokenHash))
      throw new AppError(
        "invalid_handoff_claim",
        "A valid handoff claim token is required",
        403,
      );
    return claim;
  }
  clearHandoffClaim(id: string): void {
    this.db.prepare("DELETE FROM handoff_claims WHERE operation_id=?").run(id);
  }
  createHandoffClaim(id: string, tokenHash: string): Operation {
    return this.tx(() => {
      const operation = this.operation(id);
      if (operation.state !== "waiting_for_human" || !operation.human_action)
        throw new AppError("no_handoff", "No live handoff is pending", 409);
      if (operation.human_action.claimed || this.handoffClaim(id))
        throw new AppError(
          "handoff_already_claimed",
          "Another human already owns this browser handoff",
          409,
        );
      const claim: StoredHandoffClaim = {
        token_hash: tokenHash,
        status: "claimed",
      };
      this.db
        .prepare("INSERT INTO handoff_claims(operation_id,data) VALUES(?,?)")
        .run(id, JSON.stringify(claim));
      operation.human_action.claimed = true;
      operation.human_action.returning = false;
      return this.writeUpdate(
        operation,
        "human_claimed",
        "Human has exclusive control of the existing browser",
      );
    });
  }
  beginHandoffReturn(
    id: string,
    tokenHash: string,
    note: string,
    outcome: HumanReturnOutcome,
  ): { operation: Operation; retry: boolean } {
    return this.tx(() => {
      const operation = this.operation(id);
      const claim = this.handoffClaim(id);
      if (!claim || !this.sameHash(claim.token_hash, tokenHash))
        throw new AppError(
          "invalid_handoff_claim",
          "A valid handoff claim token is required",
          403,
        );
      if (
        operation.state !== "waiting_for_human" ||
        !operation.human_action?.claimed
      )
        throw new AppError(
          "no_handoff",
          "No claimed browser handoff is pending",
          409,
        );
      if (claim.status === "returning") {
        if (claim.outcome !== outcome)
          throw new AppError(
            "handoff_return_conflict",
            "Retry return control with the same recorded submission outcome",
            409,
          );
        if (operation.error?.code !== "handoff_release_failed")
          throw new AppError(
            "handoff_return_pending",
            "This handoff return is already in progress",
            409,
          );
        operation.error = undefined;
        return {
          operation: this.writeUpdate(
            operation,
            "human_return_retry",
            "Retrying interactive browser release with the durably recorded human outcome",
            { outcome },
          ),
          retry: true,
        };
      }
      const returning: StoredHandoffClaim = {
        ...claim,
        status: "returning",
        outcome,
        note,
      };
      this.db
        .prepare("UPDATE handoff_claims SET data=? WHERE operation_id=?")
        .run(JSON.stringify(returning), id);
      operation.human_action.returning = true;
      operation.recipe_id = undefined;
      operation.error = undefined;
      if (outcome !== "no_submission") {
        if (outcome === "submitted") operation.submission = "observed";
        else if (operation.submission === "none")
          operation.submission = "intent";
        if (!operation.notes.includes("human_may_have_submitted"))
          operation.notes.push("human_may_have_submitted");
      }
      operation.notes.push(
        `Human reported browser outcome (${outcome}): ${note}`,
      );
      return {
        operation: this.writeUpdate(
          operation,
          "human_return_started",
          "Human outcome recorded durably; releasing interactive browser control",
          { outcome },
        ),
        retry: false,
      };
    });
  }
  completeHandoffReturn(id: string, tokenHash: string): Operation {
    return this.tx(() => {
      const operation = this.operation(id);
      const claim = this.handoffClaim(id);
      if (
        !claim ||
        !this.sameHash(claim.token_hash, tokenHash) ||
        claim.status !== "returning" ||
        !claim.outcome
      )
        throw new AppError(
          "invalid_handoff_claim",
          "A valid returning handoff claim is required",
          403,
        );
      operation.human_action = undefined;
      operation.recipe_id = undefined;
      operation.error = undefined;
      operation.state =
        claim.outcome === "no_submission" && operation.submission === "none"
          ? "queued"
          : "reconciling";
      this.db
        .prepare("DELETE FROM handoff_claims WHERE operation_id=?")
        .run(id);
      return this.writeUpdate(
        operation,
        "human_returned",
        "Interactive browser control released; inspecting current page before continuing",
        { outcome: claim.outcome },
      );
    });
  }
  failHandoffReturn(id: string, tokenHash: string): Operation {
    return this.tx(() => {
      const operation = this.operation(id);
      const claim = this.handoffClaim(id);
      if (
        !claim ||
        !this.sameHash(claim.token_hash, tokenHash) ||
        claim.status !== "returning"
      )
        throw new AppError(
          "invalid_handoff_claim",
          "A valid returning handoff claim is required",
          403,
        );
      if (operation.human_action) operation.human_action.returning = true;
      operation.error = {
        code: "handoff_release_failed",
        message:
          "The human outcome is saved, but interactive browser release failed. Retry return control with the same claim token and outcome.",
      };
      return this.writeUpdate(
        operation,
        "human_release_failed",
        "Human outcome remains safely recorded; interactive browser release must be retried",
      );
    });
  }
  private sameHash(expected: string, actual: string): boolean {
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(actual);
    return (
      expectedBytes.length === actualBytes.length &&
      timingSafeEqual(expectedBytes, actualBytes)
    );
  }
  putArtifact(data: Uint8Array, name: string, mediaType: string): Artifact {
    if (data.byteLength > this.maxArtifactBytes)
      throw new AppError(
        "artifact_too_large",
        "Artifact exceeds the configured byte limit",
        413,
      );
    const hash = createHash("sha256").update(data).digest("hex");
    if (
      mediaType.length > 512 ||
      /[\x00-\x1f\x7f]/.test(mediaType) ||
      !/^[^\s;/]+\/[^\s;/]+(?:;[^\r\n]*)?$/.test(mediaType)
    )
      throw new AppError(
        "invalid_media_type",
        "Artifact media type must be a valid MIME value",
      );
    const safeName =
      name.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 200) || "artifact";
    // Same bytes with different representation metadata are distinct artifacts.
    const identity = digest({
      sha256: hash,
      name: safeName,
      media_type: mediaType,
    });
    const artifact: Artifact = {
      artifact_id: `art_${identity}`,
      sha256: hash,
      name: safeName,
      media_type: mediaType,
      bytes: data.byteLength,
    };
    const existing = this.decode<Artifact>(
      this.db
        .prepare("SELECT data FROM artifacts WHERE id=?")
        .get(artifact.artifact_id),
    );
    if (existing) return existing;
    const temporary = join(this.dir, "artifacts", `.tmp-${randomUUID()}`);
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      let offset = 0;
      while (offset < data.byteLength)
        offset += writeSync(descriptor, data, offset, data.byteLength - offset);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.artifactPath(artifact.artifact_id));
    const directory = openSync(join(this.dir, "artifacts"), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    this.db
      .prepare(
        "INSERT INTO artifacts(id,data) VALUES(?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(artifact.artifact_id, JSON.stringify(artifact));
    return artifact;
  }
  artifactPath(id: string): string {
    if (!/^art_[a-f0-9]{64}$/.test(id))
      throw new AppError("invalid_artifact", "Invalid artifact identifier");
    return join(this.dir, "artifacts", id);
  }
  artifact(id: string): { metadata: Artifact; data: Uint8Array } {
    const metadata = this.decode<Artifact>(
      this.db.prepare("SELECT data FROM artifacts WHERE id=?").get(id),
    );
    if (!metadata)
      throw new AppError("artifact_not_found", "Artifact was not found", 404);
    const data = readFileSync(this.artifactPath(id));
    if (
      data.length !== metadata.bytes ||
      createHash("sha256").update(data).digest("hex") !== metadata.sha256
    )
      throw new AppError(
        "artifact_corrupt",
        "Artifact failed integrity verification",
        500,
      );
    return { metadata, data };
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
      this.releaseLock();
    }
  }
}
