/**
 * A question whose answer is not shown as it is typed or pasted. An API key
 * shown on screen ends up in scrollback and in whatever the member copies
 * from the terminal.
 */

import { createInterface } from "node:readline";
import { Writable } from "node:stream";

export function askHidden(
  question: string,
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): Promise<string> {
  let muted = false;
  const sink = new Writable({
    write(chunk, encoding, done) {
      if (!muted) output.write(chunk, encoding);
      done();
    },
  });
  const rl = createInterface({ input, output: sink, terminal: !!input.isTTY });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      output.write("\n");
      resolve(answer.trim());
    });
    muted = true; // the question is written; nothing after it is
  });
}
