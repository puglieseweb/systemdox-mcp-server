/**
 * The AWS calls behind the OAuth routes and `POST /connect`, behind one small
 * seam: the handlers take these as `AwsDeps`, so the scenarios drive the real
 * handlers against a double (test/fixtures/fake-aws.mjs) and no test holds a
 * client that could reach an account. SAM bundles the SDK into each function, and
 * the published package, which depends on none of it, leaves these entry points out.
 */

import { KMSClient } from "@aws-sdk/client-kms";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/** A client's `send`, without the SDK's command generics. */
export interface Sender {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(command: any): Promise<any>;
}

export interface AwsDeps {
  ddb: Sender;
  kms: Sender;
  secrets: Sender;
  now(): number;
}

let clients: AwsDeps | undefined;

/** Built on the first request, so importing a handler constructs no client. */
export function awsDeps(): AwsDeps {
  clients ??= {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    kms: new KMSClient({}),
    secrets: new SecretsManagerClient({}),
    now: () => Date.now(),
  };
  return clients;
}

/** A key read from its secret once per warm container, and never logged. */
export function secretKey(deps: () => Pick<AwsDeps, "secrets">, arnEnv: string): () => Promise<string> {
  let key: string | undefined;
  return async () => {
    if (key) return key;
    const arn = process.env[arnEnv];
    if (!arn) throw new Error(`${arnEnv} is not configured`);
    const { SecretString } = await deps().secrets.send(new GetSecretValueCommand({ SecretId: arn }));
    if (!SecretString) throw new Error(`${arnEnv} names a secret with no value`);
    key = SecretString as string;
    return key;
  };
}
