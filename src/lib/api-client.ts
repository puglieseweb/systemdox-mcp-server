import { ResponseCache } from "./cache.js";
import type { ServerConfig } from "./config.js";
import type {
  BlobRefusal,
  FileIn,
  FoundValue,
  Manifest,
  Marketplace,
  MemoryProjectSummary,
  MemoryVersion,
  PartDetail,
  PartName,
  PartPublished,
  PartVersionFiles,
  Person,
  PluginVersion,
  TeamSetup,
  ValueAnswer,
  ValueAnswerListed,
  ValueAnswerResults,
} from "./team-setup-types.js";

/**
 * A refused API call. The message keeps the form every caller has always
 * shown (`SystemDox API error <status>: <body>`), so an SYD- code in the body
 * reaches the user as the server wrote it; `code` and `body` are there for a
 * caller that acts on one (a 409's `currentVersion`, a 503's SYD-K019).
 */
export class SystemDoxApiError extends Error {
  readonly code: string | undefined;
  readonly body: unknown;

  constructor(readonly status: number, readonly text: string) {
    super(`SystemDox API error ${status}: ${text}`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined; // not JSON: the text is the whole answer
    }
    this.body = body;
    const code = (body as { code?: unknown } | undefined)?.code;
    this.code = typeof code === "string" ? code : /\b(SYD-[A-Z]\d{3})\b/.exec(text)?.[1];
  }
}

/** One answer of the REST API, with the `code` of a refusal that named one. */
export type ApiAnswer = Parameters<NonNullable<ServerConfig["onAnswer"]>>[0];

/**
 * A path as a server might read it: the query left off, what a URL parser drops
 * taken out, and the escapes of a dot, a slash, a backslash, a percent and those
 * dropped characters undone until none is left, so `%252e` is seen as the dot it can
 * become. A segment can then only hide a dot segment by being one.
 */
function unescapedPath(path: string): string {
  let current = path.split(/[?#]/, 1)[0];
  for (;;) {
    // Dropped first, each round: a URL parser drops them before it reads an escape,
    // so `%2<TAB>e` is `%2e` to it.
    const next = current
      .replace(/[\t\n\r]/g, "")
      .replace(/%(?:2e|2f|5c|25|09|0a|0d)/gi, (escape) => decodeURIComponent(escape));
    if (next === current) return current;
    current = next;
  }
}

/** A dot segment in a path is a way out of the route it was built for. */
function walksThePath(path: string): boolean {
  return unescapedPath(path)
    .split(/[/\\]/)
    .some((segment) => segment === "." || segment === "..");
}

const TEAM_SETUP = "/v1/team-setup";
const seg = (s: string | number) => encodeURIComponent(String(s));

export class SystemDoxApiClient {
  private config: ServerConfig;
  private cache: ResponseCache;

  constructor(config: ServerConfig) {
    this.config = config;
    this.cache = new ResponseCache(config.cacheTtlMs);
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = this.buildUrl(path, params);
    const cacheKey = url.toString();

    const cached = this.cache.get<T>(cacheKey);
    if (cached !== undefined) return cached;

    const res = await this.fetchRaw(path, params);
    if (!res.ok) throw new SystemDoxApiError(res.status, await res.text());

    const data = (await res.json()) as T;
    this.cache.set(cacheKey, data);
    return data;
  }

  /** A read that skips the cache: an install must take the version that is
   * latest now, not the one cached before someone published another. */
  async getFresh<T>(path: string, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchRaw(path, undefined, signal);
    if (!res.ok) throw new SystemDoxApiError(res.status, await res.text());
    return (await res.json()) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.mutate<T>("POST", path, body);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.mutate<T>("PUT", path, body);
  }

  private async mutate<T>(
    method: string,
    path: string,
    body: unknown
  ): Promise<T> {
    const url = this.buildUrl(path);
    const res = await this.call(url, {
      method,
      headers: {
        // The API Gateway authorizer only reads the Authorization header;
        // X-API-Key is kept for backwards compatibility.
        Authorization: `Bearer ${this.config.apiKey}`,
        "X-API-Key": this.config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new SystemDoxApiError(res.status, await res.text());

    return (await res.json()) as T;
  }

  // ── Team setup (ADR-217, specs/changes/team-setup/openapi.yaml) ──────────
  // One method per operationId. Every read skips the cache: setup, sync and
  // plugin-path act on what the workspace holds now.

  /** getOwnTeamSetup: the key's own workspace, named in `workspace`. */
  getOwnTeamSetup(signal?: AbortSignal): Promise<TeamSetup> {
    return this.getFresh<TeamSetup>(TEAM_SETUP, signal);
  }

  getTeamSetup(workspace: string): Promise<TeamSetup> {
    return this.getFresh<TeamSetup>(`${TEAM_SETUP}/${seg(workspace)}`);
  }

  getMarketplace(workspace: string): Promise<Marketplace> {
    return this.getFresh<Marketplace>(`${TEAM_SETUP}/${seg(workspace)}/marketplace.json`);
  }

  getPart(workspace: string, part: PartName): Promise<PartDetail> {
    return this.getFresh<PartDetail>(`${TEAM_SETUP}/${seg(workspace)}/parts/${seg(part)}`);
  }

  publishPartVersion(workspace: string, part: PartName, files: FileIn[]): Promise<PartPublished> {
    return this.post<PartPublished>(`${TEAM_SETUP}/${seg(workspace)}/parts/${seg(part)}/versions`, { files });
  }

  getPartVersion(workspace: string, part: PartName, version: number | "latest"): Promise<PartVersionFiles> {
    return this.getFresh<PartVersionFiles>(
      `${TEAM_SETUP}/${seg(workspace)}/parts/${seg(part)}/versions/${seg(version)}`
    );
  }

  getSetupSkills(workspace: string): Promise<{ skills: string[] }> {
    return this.getFresh<{ skills: string[] }>(`${TEAM_SETUP}/${seg(workspace)}/skills`);
  }

  setSetupSkills(workspace: string, skills: string[]): Promise<{ skills: string[] }> {
    return this.put<{ skills: string[] }>(`${TEAM_SETUP}/${seg(workspace)}/skills`, { skills });
  }

  getPlugin(workspace: string): Promise<{ name: string; versions: PluginVersion[] }> {
    return this.getFresh<{ name: string; versions: PluginVersion[] }>(`${TEAM_SETUP}/${seg(workspace)}/plugin`);
  }

  /** getPluginZip: the zip's bytes as served, and its X-Content-SHA256
   * header. The caller checks the BYTES against the hash it was given. */
  async getPluginZip(
    workspace: string,
    version: number | "latest"
  ): Promise<{ bytes: Buffer; sha256: string | null }> {
    const res = await this.call(
      this.buildUrl(`${TEAM_SETUP}/${seg(workspace)}/plugin/versions/${seg(version)}/zip`),
      {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "X-API-Key": this.config.apiKey,
          Accept: "application/zip",
        },
      }
    );
    if (!res.ok) throw new SystemDoxApiError(res.status, await res.text());
    return { bytes: Buffer.from(await res.arrayBuffer()), sha256: res.headers.get("x-content-sha256") };
  }

  listMemoryProjects(workspace: string): Promise<{ projects: MemoryProjectSummary[] }> {
    return this.getFresh<{ projects: MemoryProjectSummary[] }>(`${TEAM_SETUP}/${seg(workspace)}/memory`);
  }

  getMemory(workspace: string, project: string): Promise<MemoryVersion> {
    return this.getFresh<MemoryVersion>(`${TEAM_SETUP}/${seg(workspace)}/memory/${seg(project)}`);
  }

  /** pushMemoryVersion: a stale base throws SystemDoxApiError with status 409,
   * code SYD-K010 and `body.currentVersion`. */
  pushMemoryVersion(
    workspace: string,
    project: string,
    body: { baseVersion: number; manifest: Manifest; spaceId?: string }
  ): Promise<MemoryVersion> {
    return this.post<MemoryVersion>(`${TEAM_SETUP}/${seg(workspace)}/memory/${seg(project)}/versions`, body);
  }

  getMemoryVersion(workspace: string, project: string, version: number | "latest"): Promise<MemoryVersion> {
    return this.getFresh<MemoryVersion>(
      `${TEAM_SETUP}/${seg(workspace)}/memory/${seg(project)}/versions/${seg(version)}`
    );
  }

  findMissingBlobs(workspace: string, project: string, hashes: string[]): Promise<{ missing: string[] }> {
    return this.post<{ missing: string[] }>(
      `${TEAM_SETUP}/${seg(workspace)}/memory/${seg(project)}/blobs/missing`,
      { hashes }
    );
  }

  uploadBlobs(
    workspace: string,
    project: string,
    blobs: { sha256: string; content: string }[]
  ): Promise<{ stored: string[]; refused: BlobRefusal[] }> {
    return this.post(`${TEAM_SETUP}/${seg(workspace)}/memory/${seg(project)}/blobs`, { blobs });
  }

  readBlobs(
    workspace: string,
    project: string,
    hashes: string[]
  ): Promise<{ blobs: { sha256: string; content: string }[]; remaining: string[] }> {
    return this.post(`${TEAM_SETUP}/${seg(workspace)}/memory/${seg(project)}/blobs/read`, { hashes });
  }

  listValueAnswers(workspace: string): Promise<{ answers: ValueAnswerListed[] }> {
    return this.getFresh<{ answers: ValueAnswerListed[] }>(`${TEAM_SETUP}/${seg(workspace)}/values`);
  }

  lookupValues(workspace: string, values: FoundValue[]): Promise<{ answers: ValueAnswer[] }> {
    return this.post<{ answers: ValueAnswer[] }>(`${TEAM_SETUP}/${seg(workspace)}/values`, { values });
  }

  answerValues(
    workspace: string,
    answers: (FoundValue & { answer: "ours" | "member"; label?: string })[]
  ): Promise<ValueAnswerResults> {
    return this.put<ValueAnswerResults>(`${TEAM_SETUP}/${seg(workspace)}/values`, { answers });
  }

  fileMemoryPeople(
    workspace: string,
    people: { values: FoundValue[]; label: string }[]
  ): Promise<ValueAnswerResults> {
    return this.post<ValueAnswerResults>(`${TEAM_SETUP}/${seg(workspace)}/people`, { people });
  }

  resolvePerson(workspace: string, personId: string): Promise<Person> {
    return this.getFresh<Person>(`${TEAM_SETUP}/${seg(workspace)}/people/${seg(personId)}`);
  }

  invalidateCache(path?: string): void {
    if (path) {
      this.cache.invalidate(this.buildUrl(path).toString());
    } else {
      this.cache.clear();
    }
  }

  private buildUrl(path: string, params?: Record<string, string>): URL {
    // new URL(path, base) discards the base's path segment (e.g. /systemdox)
    // when path starts with "/", so join the strings explicitly.
    const base = this.config.apiUrl.replace(/\/+$/, "");
    const url = new URL(`${base}${path.startsWith("/") ? "" : "/"}${path}`);
    // The key travels on this request. An id a caller chose must not carry it to
    // another route of the same domain, which serves every product's API.
    const { origin, pathname } = new URL(base);
    if (walksThePath(path) || url.origin !== origin || !url.pathname.startsWith(`${pathname.replace(/\/+$/, "")}/`)) {
      throw new Error("Refused: this id leaves the API's own path.");
    }
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    return url;
  }

  private async fetchRaw(
    path: string,
    params?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<Response> {
    const url = this.buildUrl(path, params);
    return this.call(url, {
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "X-API-Key": this.config.apiKey,
        Accept: "application/json",
      },
      signal,
    });
  }

  /** Every call of this client, so `onAnswer` hears each answer. */
  private async call(url: URL, init: RequestInit): Promise<Response> {
    const res = await fetch(url, init);
    const { onAnswer } = this.config;
    if (onAnswer) {
      const refused = res.ok ? undefined : new SystemDoxApiError(res.status, await res.clone().text());
      onAnswer({ status: res.status, code: refused?.code });
    }
    return res;
  }
}
