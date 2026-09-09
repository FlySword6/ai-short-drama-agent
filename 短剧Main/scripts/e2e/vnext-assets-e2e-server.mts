import { createApp } from "../../src/app.js";
import { createDatabase } from "../../src/db/client.js";
import { createVnextDatabase } from "../../src/modules/vnext/db.js";

const port = Number(process.env.PORT ?? 4309);
const expectedMediaUrl = process.env.VNEXT_ASSETS_E2E_MEDIA_URL;
const expectedMediaSha256 = process.env.VNEXT_ASSETS_E2E_MEDIA_SHA256?.toLowerCase();
if (!expectedMediaUrl || !expectedMediaSha256) throw new Error("VNEXT_ASSETS_E2E_MEDIA_URL and VNEXT_ASSETS_E2E_MEDIA_SHA256 are required");

const databaseHandle = createDatabase();
const vnextDatabaseHandle = createVnextDatabase(process.env.VNEXT_DATABASE_URL);

const app = await createApp({
  databaseHandle,
  vnextDatabaseHandle,
  logger: true,
  createSnapshotARegistration: () => undefined,
  createSnapshotATosVerification: () => ({
    async verify(input: { mediaUrl: string; mediaSha256: string }) {
      if (input.mediaUrl !== expectedMediaUrl || input.mediaSha256.toLowerCase() !== expectedMediaSha256) {
        throw new Error("unexpected E2E media fact");
      }
      return { mediaUrl: input.mediaUrl, mediaSha256: input.mediaSha256.toLowerCase() };
    },
  }),
});

await app.listen({ host: "127.0.0.1", port });
