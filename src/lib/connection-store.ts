/**
 * The rows of a connection (`contract.md` §4), all in SystemTable, each with a
 * `ttl`, none on the bus. The handlers check every expiry themselves: a table's
 * time-to-live only tidies up. Every read is consistent: a token spent or a
 * connection ended a moment ago must be seen as that.
 *
 * backend/functions/erasure_wave2 reads these keys too: backend/tests/
 * test_erasure_coverage.py holds it to them, because a Python scan cannot see
 * rows written from Node.
 */

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Sender } from "./aws-deps.js";

export type Access = "read" | "write";
export type TokenKind = "code" | "access" | "refresh";

export interface PendingRequest {
  clientId: string;
  clientName: string;
  clientNameVerified: boolean;
  redirectUri: string;
  returnHost: string;
  loopback: boolean;
  challenge: string;
  state?: string;
  label: string;
  expiresAt: number;
  ttl: number;
  claimedAt?: number;
  /** Over what the person reads and where the code goes: `requestMac`. */
  mac?: string;
}

export interface Connection {
  PK: string;
  SK: string;
  connectionId: string;
  organisationId: string;
  ownerId: string;
  label: string;
  returnHost: string;
  loopback: boolean;
  access: Access;
  clientHash: string;
  keyId: string;
  encryptedKey: string;
  /** The key's own expiry. */
  expiresAt: number;
  keyRefusedAt?: number;
  keyRefusedCalls?: number;
  ttl: number;
  /** Over all that was approved: `connectionMac`. */
  mac?: string;
}

export interface TokenRow {
  PK: string;
  SK: string;
  organisationId: string;
  connectionId: string;
  kind: TokenKind;
  expiresAt: number;
  replacedAt?: number;
  ttl: number;
  /** Over all of this row, under the derivation key: `tokenMac`. */
  mac?: string;
  /** A code's PKCE challenge and return address. */
  challenge?: string;
  redirectUri?: string;
  clientHash?: string;
}

const REQUEST_SK = "REQUEST";
const TOKEN_SK = "TOKEN";
const CONNECTION_PREFIX = "MCPCONN#";

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** S256 (RFC 7636), compared in constant time. */
export function verifierMatches(verifier: string, challenge: string): boolean {
  const expected = Buffer.from(challenge);
  const actual = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const epochSeconds = (ms: number): number => Math.ceil(ms / 1000);

/**
 * What proves a row was written here (`contract.md` §4). Without it, anything that
 * can write the table could write a row and have `/connect` open a key. The object
 * is spelt out field by field, so a field left out and a field held as NULL differ.
 */
function rowMac(purpose: string, covered: Record<string, unknown>, key: string): string {
  return createHmac("sha256", key).update(`${purpose}|${JSON.stringify(covered)}`).digest("base64url");
}

function macMatches(mac: unknown, expected: string): boolean {
  const given = Buffer.from(typeof mac === "string" ? mac : "");
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** The token's own hash is covered, so a genuine row copied under another hash fails. */
const tokenMac = (hash: string, row: TokenRow, key: string): string =>
  rowMac(
    "token-row",
    {
      hash,
      organisationId: row.organisationId,
      connectionId: row.connectionId,
      kind: row.kind,
      expiresAt: row.expiresAt,
      replacedAt: row.replacedAt,
      challenge: row.challenge,
      redirectUri: row.redirectUri,
      clientHash: row.clientHash,
    },
    key
  );

/** All that was approved. The refusal counts change on their own, so they are not in it. */
const connectionMac = (row: Connection, key: string): string =>
  rowMac(
    "connection-row",
    {
      organisationId: row.organisationId,
      connectionId: row.connectionId,
      ownerId: row.ownerId,
      label: row.label,
      returnHost: row.returnHost,
      loopback: row.loopback,
      access: row.access,
      clientHash: row.clientHash,
      keyId: row.keyId,
      encryptedKey: row.encryptedKey,
      expiresAt: row.expiresAt,
    },
    key
  );

/** What the person reads and where the code goes. `claimedAt` changes on its own. */
const requestMac = (requestId: string, row: PendingRequest, key: string): string =>
  rowMac(
    "request-row",
    {
      requestId,
      clientId: row.clientId,
      clientName: row.clientName,
      clientNameVerified: row.clientNameVerified,
      redirectUri: row.redirectUri,
      returnHost: row.returnHost,
      loopback: row.loopback,
      challenge: row.challenge,
      state: row.state,
      label: row.label,
      expiresAt: row.expiresAt,
    },
    key
  );

const refused = (kind: string): undefined => {
  console.warn(JSON.stringify({ event: "mcp.row.refused", row: kind, reason: "mac" }));
  return undefined;
};

const isConditionFailure = (err: unknown): boolean =>
  ["ConditionalCheckFailedException", "TransactionCanceledException"].includes((err as Error).name);

function table(): string {
  const name = process.env.SYSTEM_TABLE;
  if (!name) throw new Error("SYSTEM_TABLE is not configured");
  return name;
}

const requestKey = (requestId: string) => ({ PK: `MCPREQ#${requestId}`, SK: REQUEST_SK });
const tokenKey = (hash: string) => ({ PK: `MCPTOK#${hash}`, SK: TOKEN_SK });
const connectionKey = (organisationId: string, connectionId: string) => ({
  PK: `TENANT#${organisationId}`,
  SK: `${CONNECTION_PREFIX}${connectionId}`,
});
const ownerKey = (ownerId: string, organisationId: string, connectionId: string) => ({
  PK: `MCPOWNER#${ownerId}`,
  SK: `${organisationId}#${connectionId}`,
});

export function newConnectionRow(fields: Omit<Connection, "PK" | "SK" | "ttl">): Connection {
  return {
    ...connectionKey(fields.organisationId, fields.connectionId),
    ...fields,
    ttl: epochSeconds(fields.expiresAt),
  };
}

export function newTokenRow(hash: string, fields: Omit<TokenRow, "PK" | "SK">): TokenRow {
  return { ...tokenKey(hash), ...fields };
}

export class ConnectionStore {
  constructor(
    private readonly ddb: Sender,
    /** The derivation key: every row is sealed and checked under it. */
    private readonly macKey: () => Promise<string>
  ) {}

  private async sealed(hash: string, row: TokenRow): Promise<TokenRow> {
    return { ...row, mac: tokenMac(hash, row, await this.macKey()) };
  }

  async putRequest(requestId: string, request: PendingRequest): Promise<void> {
    const mac = requestMac(requestId, request, await this.macKey());
    await this.ddb.send(new PutCommand({ TableName: table(), Item: { ...requestKey(requestId), ...request, mac } }));
  }

  async request(requestId: string): Promise<PendingRequest | undefined> {
    const { Item } = await this.ddb.send(
      new GetCommand({ TableName: table(), Key: requestKey(requestId), ConsistentRead: true })
    );
    const row = Item as PendingRequest | undefined;
    if (!row) return undefined;
    return macMatches(row.mac, requestMac(requestId, row, await this.macKey())) ? row : refused("request");
  }

  /** The conditional write that lets one click, and only one, create a key. */
  async claimRequest(requestId: string, now: number): Promise<boolean> {
    try {
      await this.ddb.send(
        new UpdateCommand({
          TableName: table(),
          Key: requestKey(requestId),
          UpdateExpression: "SET claimedAt = :now",
          ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(claimedAt)",
          ExpressionAttributeValues: { ":now": now },
        })
      );
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  async releaseRequest(requestId: string): Promise<void> {
    await this.ddb.send(
      new UpdateCommand({
        TableName: table(),
        Key: requestKey(requestId),
        UpdateExpression: "REMOVE claimedAt",
        ConditionExpression: "attribute_exists(PK)",
      })
    );
  }

  /** False when someone already answered it. */
  async deleteRequest(requestId: string): Promise<boolean> {
    try {
      await this.ddb.send(
        new DeleteCommand({
          TableName: table(),
          Key: requestKey(requestId),
          ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(claimedAt)",
        })
      );
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  /** The connection, the way from its owner to it, and the code, or none of them. */
  async writeConnection(connection: Connection, codeHash: string, code: TokenRow): Promise<void> {
    const sealedCode = await this.sealed(codeHash, code);
    const sealedConnection = { ...connection, mac: connectionMac(connection, await this.macKey()) };
    const pointer = {
      ...ownerKey(connection.ownerId, connection.organisationId, connection.connectionId),
      returnHost: connection.returnHost,
      loopback: connection.loopback,
      ttl: connection.ttl,
    };
    await this.ddb.send(
      new TransactWriteCommand({
        TransactItems: [sealedConnection, pointer, sealedCode].map((Item) => ({
          Put: { TableName: table(), Item, ConditionExpression: "attribute_not_exists(PK)" },
        })),
      })
    );
  }

  async connection(organisationId: string, connectionId: string): Promise<Connection | undefined> {
    const { Item } = await this.ddb.send(
      new GetCommand({ TableName: table(), Key: connectionKey(organisationId, connectionId), ConsistentRead: true })
    );
    const row = Item as Connection | undefined;
    if (!row) return undefined;
    // The ids asked for are a checked token row's. A row must be for them, and be ours.
    const genuine =
      row.organisationId === organisationId &&
      row.connectionId === connectionId &&
      macMatches(row.mac, connectionMac(row, await this.macKey()));
    return genuine ? row : refused("connection");
  }

  /** This person's connections in this organisation. */
  async connectionsOf(ownerId: string, organisationId: string): Promise<Connection[]> {
    const { Items = [] } = await this.ddb.send(
      new QueryCommand({
        TableName: table(),
        ConsistentRead: true,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :org)",
        ExpressionAttributeValues: { ":pk": `MCPOWNER#${ownerId}`, ":org": `${organisationId}#` },
      })
    );
    const found = await Promise.all(
      (Items as { SK: string }[]).map(({ SK }) => this.connection(organisationId, SK.slice(organisationId.length + 1)))
    );
    return found.filter((row): row is Connection => row !== undefined);
  }

  /** A token row is dead once this is gone, and its `ttl` removes it. */
  async endConnection(connection: Connection): Promise<void> {
    const { organisationId, connectionId, ownerId } = connection;
    await this.ddb.send(
      new TransactWriteCommand({
        TransactItems: [connectionKey(organisationId, connectionId), ownerKey(ownerId, organisationId, connectionId)].map(
          (Key) => ({ Delete: { TableName: table(), Key } })
        ),
      })
    );
  }

  /** Counts a refused call, and the first refusal's time. Undefined when the connection has gone. */
  async noteKeyRefused(connection: Connection, now: number): Promise<Connection | undefined> {
    try {
      const { Attributes } = await this.ddb.send(
        new UpdateCommand({
          TableName: table(),
          Key: connectionKey(connection.organisationId, connection.connectionId),
          UpdateExpression: "SET keyRefusedAt = if_not_exists(keyRefusedAt, :now) ADD keyRefusedCalls :one",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: { ":now": now, ":one": 1 },
          ReturnValues: "ALL_NEW",
        })
      );
      return Attributes as Connection;
    } catch (err) {
      if (isConditionFailure(err)) return undefined;
      throw err;
    }
  }

  async clearKeyRefused(connection: Connection): Promise<void> {
    try {
      await this.ddb.send(
        new UpdateCommand({
          TableName: table(),
          Key: connectionKey(connection.organisationId, connection.connectionId),
          UpdateExpression: "REMOVE keyRefusedAt, keyRefusedCalls",
          ConditionExpression: "attribute_exists(PK)",
        })
      );
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
  }

  /** The row, if it is one this code wrote. A row whose MAC does not check is no row. */
  async token(hash: string): Promise<TokenRow | undefined> {
    const { Item } = await this.ddb.send(
      new GetCommand({ TableName: table(), Key: tokenKey(hash), ConsistentRead: true })
    );
    const row = Item as TokenRow | undefined;
    if (!row) return undefined;
    return macMatches(row.mac, tokenMac(hash, row, await this.macKey())) ? row : refused("token");
  }

  /** True for the one caller that spent it. The MAC changes with `replacedAt`, in the same write. */
  async spendToken(hash: string, row: TokenRow, now: number): Promise<boolean> {
    try {
      const { mac } = await this.sealed(hash, { ...row, replacedAt: now });
      await this.ddb.send(
        new UpdateCommand({
          TableName: table(),
          Key: tokenKey(hash),
          UpdateExpression: "SET replacedAt = :now, mac = :mac",
          ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(replacedAt)",
          ExpressionAttributeValues: { ":now": now, ":mac": mac },
        })
      );
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  /** Written once: a retry must not revive a token that has since been spent. */
  async putTokenOnce(hash: string, row: TokenRow): Promise<void> {
    try {
      await this.ddb.send(
        new PutCommand({
          TableName: table(),
          Item: await this.sealed(hash, row),
          ConditionExpression: "attribute_not_exists(PK)",
        })
      );
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
  }
}
