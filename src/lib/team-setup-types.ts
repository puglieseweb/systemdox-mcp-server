/**
 * The team-setup shapes of specs/changes/team-setup/openapi.yaml
 * (components.schemas), as the client reads and sends them, and the two
 * enumerations it checks locally (the parts, the PersonId pattern).
 */

import { PERSON_ID } from "./person-values.js";

export const PARTS = ["hooks", "mcp", "agents", "commands", "instructions"] as const;
export type PartName = (typeof PARTS)[number];

export interface FileIn {
  path: string;
  content: string;
}

export interface FileMeta {
  path: string;
  bytes: number;
  sha256: string;
}

export interface PartVersionSummary {
  part: PartName;
  version: number;
  publishedAt: string;
  publishedBy: string;
  files: FileMeta[];
}

export interface PartDetail {
  part: PartName;
  latestVersion: number;
  versions: PartVersionSummary[];
}

export interface PartVersionFiles extends Omit<PartVersionSummary, "files"> {
  files: (FileMeta & { content: string })[];
}

export interface PartPublished extends PartVersionSummary {
  /** Absent for `instructions`. */
  pluginVersion?: number;
  /** `mcp` only. */
  replacedValues?: { server: string; field: "env" | "headers"; name: string }[];
}

export interface PluginVersion {
  version: number;
  sha256: string;
  bytes: number;
  createdAt: string;
  createdBy?: string;
  parts: Record<string, number>;
  skills: Record<string, number>;
  hookCommands?: string[];
  mcpServers?: { name: string; command?: string; args?: string[]; url?: string }[];
  /** This version carries SystemDox's memory sync hooks (ADR-217 Amendment 3); absent before it. */
  memoryHooks?: boolean;
  command: string;
}

export interface Marketplace {
  name: string;
  owner: { name: string };
  plugins: {
    name: string;
    version: string;
    description: string;
    source: { source: "command"; command: string; timeout: number };
  }[];
}

export interface MemoryProjectSummary {
  project: string;
  latestVersion: number;
  fileCount: number;
  bytes: number;
  updatedAt: string;
  spaceId: string;
}

export interface TeamSetup {
  workspace: string;
  minClaudeCodeVersion: string;
  marketplaceUrl: string;
  plugin?: PluginVersion;
  parts: Record<string, number>;
  skills: string[];
  memory: MemoryProjectSummary[];
  /** Absent on an API older than ADR-223. */
  sessionBrief?: SessionBrief;
}

/** What every session is told (ADR-223, specs/archive/session-brief/contract.md). */
export interface SessionBrief {
  text: string;
  /** What a session may install by itself: in the default space, and unable to run anything by itself. */
  skills: { name: string; description: string; latestVersion: number }[];
  /** The rest: they reach a computer only through the person. Only the name is repeated. */
  heldSkills: { name: string; reason: string }[];
  omittedSkills: number;
}

/** `{path: sha256}`. */
export type Manifest = Record<string, string>;

export interface MemoryVersion {
  project: string;
  version: number;
  createdAt: string;
  createdBy?: string;
  files: Record<string, { sha256: string; bytes: number; syncedBy: string; syncedAt: string }>;
}

export interface BlobRefusal {
  sha256: string;
  code: string;
  detail: string;
  /** SYD-K014 only: each finding's kind and line, never the value. */
  personalData?: { kind: "phone" | "email" | "home-path"; line: number }[];
}

export interface FoundValue {
  kind: "phone" | "email";
  value: string;
}

export interface ValueAnswer extends FoundValue {
  answer: "ours" | "member" | "person" | "unanswered";
  personId?: string;
  label?: string;
}

export interface ValueAnswerListed {
  kind: "phone" | "email";
  answer: "ours" | "member" | "person";
  personId?: string;
  label?: string;
  answeredBy: string;
  answeredAt: string;
}

export interface ValueAnswerResults {
  stored: ValueAnswer[];
  refused: { index: number; code: string; detail: string }[];
}

export interface Person {
  personId: string;
  kind: "contact" | "staff-contact" | "member";
  name?: string;
  email?: string;
  phone?: string;
  label?: string;
  mergedInto?: string;
}

/** openapi PersonId. */
export const PERSON_ID_RE = new RegExp(`^${PERSON_ID}$`);
