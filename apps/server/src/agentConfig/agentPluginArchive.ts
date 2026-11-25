import * as NodeStream from "@effect/platform-node/NodeStream";
import { AgentConfigError, AGENT_PLUGIN_ZIP_MAX_BYTES } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { openZipArchive } from "../zipArchive.ts";

const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 2048;
const MANIFEST = ".codex-plugin/plugin.json";
const safeSegment = (segment: string) =>
  segment.length > 0 &&
  !/^[. ]+$|[. ]$|[<>:"|?*\\/\u0000-\u001f]/u.test(segment) &&
  !/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(segment);

const LocalPath = Schema.String.check(
  Schema.makeFilter((value) => value.replace(/^\.\//, "").split("/").every(safeSegment)),
);
const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
      version: Schema.optional(
        Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/)),
      ),
      description: Schema.optional(Schema.NullOr(Schema.String)),
      apps: Schema.optional(Schema.NullOr(LocalPath)),
      skills: Schema.optional(Schema.NullOr(LocalPath)),
      mcpServers: Schema.optional(Schema.NullOr(LocalPath)),
      hooks: Schema.optional(Schema.NullOr(LocalPath)),
      interface: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            displayName: Schema.optional(Schema.NullOr(Schema.String)),
            logo: Schema.optional(Schema.NullOr(LocalPath)),
            logoDark: Schema.optional(Schema.NullOr(LocalPath)),
            composerIcon: Schema.optional(Schema.NullOr(LocalPath)),
            composerIconDark: Schema.optional(Schema.NullOr(LocalPath)),
            screenshots: Schema.optional(Schema.NullOr(Schema.Array(LocalPath))),
          }),
        ),
      ),
    }),
  ),
);

const invalidArchive = () => new AgentConfigError({ reason: "invalid-plugin-archive" });

export const unpackAgentPlugin = Effect.fn("AgentConfig.unpackPlugin")(
  function* (bytes: Uint8Array, staging: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const archivePath = path.join(staging, "upload.zip");
    const unpacked = path.join(staging, "unpacked");
    if (bytes.length === 0 || bytes.length > AGENT_PLUGIN_ZIP_MAX_BYTES)
      return yield* invalidArchive();
    yield* fs.writeFile(archivePath, bytes);
    const zip = yield* openZipArchive(archivePath, invalidArchive);
    if (zip.entryCount > MAX_ENTRIES) return yield* invalidArchive();

    let expanded = 0;
    yield* fs.makeDirectory(unpacked);
    for (;;) {
      const entry = yield* zip.next;
      if (entry === null) break;
      const directory = entry.fileName.endsWith("/");
      const parts = entry.fileName.replace(/\/$/, "").split("/");
      const unixMode = entry.externalFileAttributes >>> 16;
      const type = unixMode & 0o170000;
      expanded += entry.uncompressedSize;
      if (
        !parts.every(safeSegment) ||
        (type !== 0 && type !== (directory ? 0o040000 : 0o100000)) ||
        expanded > MAX_EXPANDED_BYTES ||
        (entry.generalPurposeBitFlag & 1) !== 0 ||
        ![0, 8].includes(entry.compressionMethod)
      )
        return yield* invalidArchive();

      const destination = path.join(unpacked, ...parts);
      if (directory) {
        yield* fs.makeDirectory(destination, { recursive: true });
      } else {
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
        yield* Effect.gen(function* () {
          const readable = yield* zip.streamEntry(entry);
          yield* NodeStream.fromReadable<Uint8Array, AgentConfigError>({
            evaluate: () => readable,
            onError: invalidArchive,
          }).pipe(
            Stream.run(fs.sink(destination, { flag: "wx", mode: 0o600 | (unixMode & 0o100) })),
          );
        }).pipe(Effect.scoped);
      }
    }
    if (yield* fs.exists(path.join(unpacked, MANIFEST))) return unpacked;
    const roots = yield* fs.readDirectory(unpacked);
    if (roots.length === 1 && roots[0] !== undefined) return path.join(unpacked, roots[0]);
    return yield* invalidArchive();
  },
  Effect.scoped,
  Effect.mapError(invalidArchive),
);

export const readAgentPluginManifest = Effect.fn("AgentConfig.readPluginManifest")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = yield* fs.readFileString(path.join(root, MANIFEST));
  const decoded = yield* decodeManifest(manifest);
  const { name, version, description } = decoded;
  return {
    name,
    version: version ?? null,
    description: description?.trim().slice(0, 512) || null,
    displayName: decoded.interface?.displayName?.trim().slice(0, 128) || name,
  };
}, Effect.mapError(invalidArchive));
