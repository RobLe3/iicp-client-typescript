// SPDX-License-Identifier: Apache-2.0
//
// Consumer-side example — submit one chat task to the IICP mesh.
//
// Run:
//
//   npm install @iicp/client
//   npx tsx examples/consumer.ts

import { IicpClient } from "@iicp/client";

async function main(): Promise<void> {
  const client = new IicpClient();
  const reply = await client.chat([
    { role: "user", content: "Hi! Tell me one IICP fun fact." },
  ]);
  console.log(reply);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
