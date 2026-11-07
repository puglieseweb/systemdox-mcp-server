// A double of the three AWS services behind the OAuth routes and POST /connect
// (ADR-229). It holds to what the real services refuse, or a test passes against
// something that cannot happen: DynamoDB's key schema and conditions, the document
// client's refusal of `undefined`, KMS's encryption context and each function's
// own grant. An expression it does not know throws, so a new one cannot slip past.

const conditionFailed = () =>
  Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });

const parts = (text, separator) => text.split(separator).map((part) => part.trim()).filter(Boolean);

function holds(condition, item) {
  for (const clause of parts(condition ?? "", " AND ")) {
    const exists = /^attribute_exists\((\w+)\)$/.exec(clause);
    const missing = /^attribute_not_exists\((\w+)\)$/.exec(clause);
    if (exists) {
      if (!item || !(exists[1] in item)) return false;
    } else if (missing) {
      if (item && missing[1] in item) return false;
    } else {
      throw new Error(`fake-aws does not know the condition: ${clause}`);
    }
  }
  return true;
}

function refuseUndefined(value, path = "item") {
  if (value === undefined) throw new Error(`Pass options.removeUndefinedValues=true: ${path} is undefined`);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    for (const [key, inner] of Object.entries(value)) refuseUndefined(inner, `${path}.${key}`);
  }
}

function update(item, expression, values = {}) {
  const next = { ...item };
  const clauses = /^(?:SET (?<set>.+?))?\s*(?:ADD (?<add>.+?))?\s*(?:REMOVE (?<remove>.+))?$/.exec(expression)?.groups;
  if (!clauses) throw new Error(`fake-aws does not know the update: ${expression}`);
  for (const clause of (clauses.set ?? "").split(/,\s*(?=\w+ = )/).filter(Boolean)) {
    const plain = /^(\w+) = (:\w+)$/.exec(clause.trim());
    const first = /^(\w+) = if_not_exists\(\1, (:\w+)\)$/.exec(clause.trim());
    if (plain) next[plain[1]] = values[plain[2]];
    else if (first) next[first[1]] ??= values[first[2]];
    else throw new Error(`fake-aws does not know the update clause: ${clause}`);
  }
  for (const clause of parts(clauses.add ?? "", ",")) {
    const [name, value] = clause.split(/\s+/);
    next[name] = (next[name] ?? 0) + values[value];
  }
  for (const name of parts(clauses.remove ?? "", ",")) delete next[name];
  return next;
}

class FakeDynamo {
  rows = new Map();
  writes = 0;
  // What an eventually consistent read answers: each row as it stood before its
  // last write. A read that needs the truth has to ask for ConsistentRead.
  before = new Map();

  remember(key) {
    this.before.set(key, this.rows.get(key));
  }

  key({ PK, SK }) {
    if (typeof PK !== "string" || !PK || typeof SK !== "string" || !SK) {
      throw new Error("ValidationException: the key must hold PK and SK");
    }
    return `${PK}\u0000${SK}`;
  }

  put({ Item, ConditionExpression }) {
    refuseUndefined(Item);
    const key = this.key(Item);
    if (!holds(ConditionExpression, this.rows.get(key))) throw conditionFailed();
    this.writes += 1;
    this.remember(key);
    this.rows.set(key, structuredClone(Item));
    return {};
  }

  update({ Key, UpdateExpression, ConditionExpression, ExpressionAttributeValues, ReturnValues }) {
    refuseUndefined(ExpressionAttributeValues ?? {});
    const key = this.key(Key);
    const current = this.rows.get(key);
    if (!holds(ConditionExpression, current)) throw conditionFailed();
    const next = update(current ?? Key, UpdateExpression, ExpressionAttributeValues);
    this.writes += 1;
    this.remember(key);
    this.rows.set(key, next);
    return ReturnValues === "ALL_NEW" ? { Attributes: structuredClone(next) } : {};
  }

  delete({ Key, ConditionExpression }) {
    const key = this.key(Key);
    if (!holds(ConditionExpression, this.rows.get(key))) throw conditionFailed();
    this.writes += 1;
    this.remember(key);
    this.rows.delete(key);
    return {};
  }

  query({ KeyConditionExpression, ExpressionAttributeValues: values }) {
    const match = /^PK = (:\w+)(?: AND begins_with\(SK, (:\w+)\))?$/.exec(KeyConditionExpression);
    if (!match) throw new Error(`fake-aws does not know the query: ${KeyConditionExpression}`);
    const prefix = match[2] ? values[match[2]] : "";
    const items = [...this.rows.values()].filter((row) => row.PK === values[match[1]] && row.SK.startsWith(prefix));
    return { Items: structuredClone(items) };
  }

  transact({ TransactItems }) {
    const failed = TransactItems.some((entry) => {
      const write = entry.Put ?? entry.Delete ?? entry.Update;
      return !holds(write.ConditionExpression, this.rows.get(this.key(write.Item ?? write.Key)));
    });
    if (failed) {
      throw Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException" });
    }
    for (const entry of TransactItems) {
      if (entry.Put) this.put(entry.Put);
      else if (entry.Delete) this.delete(entry.Delete);
      else this.update(entry.Update);
    }
    return {};
  }

  async send(command) {
    const input = command.input;
    switch (command.constructor.name) {
      case "GetCommand": {
        const key = this.key(input.Key);
        const row = input.ConsistentRead || !this.before.has(key) ? this.rows.get(key) : this.before.get(key);
        return row ? { Item: structuredClone(row) } : {};
      }
      case "PutCommand":
        return this.put(input);
      case "UpdateCommand":
        return this.update(input);
      case "DeleteCommand":
        return this.delete(input);
      case "QueryCommand":
        return this.query(input);
      case "TransactWriteCommand":
        return this.transact(input);
      default:
        throw new Error(`fake-aws does not know ${command.constructor.name}`);
    }
  }
}

const denied = (action) =>
  Object.assign(new Error(`not authorized to perform ${action}`), { name: "AccessDeniedException" });

// Not encryption: enough that a key is not readable in a row and that a blob
// opens only under the context it was sealed with.
class FakeKms {
  constructor(grants) {
    this.grants = grants;
  }

  async send(command) {
    const name = command.constructor.name;
    const input = command.input;
    if (name === "EncryptCommand") {
      if (!this.grants.includes("Encrypt")) throw denied("kms:Encrypt");
      const sealed = JSON.stringify({ c: input.EncryptionContext, p: Buffer.from(input.Plaintext).toString("hex") });
      return { CiphertextBlob: Buffer.from(sealed).reverse() };
    }
    if (name === "DecryptCommand") {
      if (!this.grants.includes("Decrypt")) throw denied("kms:Decrypt");
      const { c, p } = JSON.parse(Buffer.from(input.CiphertextBlob).reverse().toString());
      if (JSON.stringify(c) !== JSON.stringify(input.EncryptionContext)) {
        throw Object.assign(new Error("Invalid ciphertext"), { name: "InvalidCiphertextException" });
      }
      return { Plaintext: Buffer.from(p, "hex") };
    }
    throw new Error(`fake-aws does not know ${name}`);
  }
}

class FakeSecrets {
  constructor(secrets, grants) {
    this.secrets = secrets;
    this.grants = grants;
  }

  async send(command) {
    const { SecretId } = command.input;
    if (command.constructor.name !== "GetSecretValueCommand") throw new Error("fake-aws: only GetSecretValue");
    if (!this.grants.includes(SecretId)) throw denied("secretsmanager:GetSecretValue");
    if (!(SecretId in this.secrets)) {
      throw Object.assign(new Error("Secrets Manager can't find the specified secret."), {
        name: "ResourceNotFoundException",
      });
    }
    return { SecretString: this.secrets[SecretId] };
  }
}

export const CLIENT_SIGNING_SECRET = "arn:aws:secretsmanager:eu-west-2:000000000000:secret:mcp-client-signing";
export const TOKEN_DERIVATION_SECRET = "arn:aws:secretsmanager:eu-west-2:000000000000:secret:mcp-token-derivation";

/**
 * One account: the table and the keys are shared, and each function's deps hold
 * only that function's KMS grant, as the template gives them.
 */
export function fakeAccount({ now = 1_780_000_000_000 } = {}) {
  const account = {
    now,
    ddb: new FakeDynamo(),
    secrets: {
      [CLIENT_SIGNING_SECRET]: ["client", "signing", "fixture"].join("-"),
      [TOKEN_DERIVATION_SECRET]: ["token", "derivation", "fixture"].join("-"),
    },
    deps(kmsGrants, secretGrants) {
      return {
        ddb: account.ddb,
        kms: new FakeKms(kmsGrants),
        secrets: new FakeSecrets(account.secrets, secretGrants),
        now: () => account.now,
      };
    },
    advance(ms) {
      account.now += ms;
    },
  };
  return account;
}
