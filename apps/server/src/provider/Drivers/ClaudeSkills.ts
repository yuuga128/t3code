/**
 * ClaudeSkills — filesystem discovery of Claude Code skills for the `$` picker.
 *
 * Claude Code loads skills from `<config dir>/skills` (user scope) and
 * `<cwd>/.claude/skills` (project scope), one directory per skill with a
 * `SKILL.md` carrying YAML frontmatter. The user root wins on name collisions,
 * matching the CLI. `.agents/skills` is a Codex location: verified against the
 * CLI, a skill that lives only there is answered with `Unknown command`, so it
 * is not scanned here.
 * Installed plugins contribute skills too, published as `<plugin>:<skill>`.
 * The CLI loads a plugin only when `enabledPlugins` in the settings chain says
 * `true` for its `name@marketplace` key; an install record alone is not
 * enough. See {@link discoverPluginSkillRoots}.
 * The Agent SDK init handshake surfaces skills only as slash commands without
 * their filesystem paths, so the provider snapshot scans the same locations
 * directly, mirroring how the Codex app-server reports its skills.
 *
 * @module provider/Drivers/ClaudeSkills
 */
import * as NodeOS from "node:os";

import type { ClaudeSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "../../pathExpansion.ts";

type ClaudeSkillScope = "user" | "project" | "plugin";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "parsed";
      readonly description?: string;
      readonly userInvocationOnly?: boolean;
      readonly userInvocable?: boolean;
    };

/**
 * Claude Code accepts the YAML 1.1 boolean spellings (`yes`/`no`, `on`/`off`,
 * `1`/`0`), which the 1.2 core schema this parser uses leaves as strings and
 * numbers. Verified against the CLI: a skill carrying `user-invocable: no` is
 * absent from its published slash commands, so a strict `=== false` here would
 * offer a command the CLI rejects.
 */
function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "y":
      return true;
    case "false":
    case "no":
    case "off":
    case "n":
      return false;
    default:
      return undefined;
  }
}

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(description ? { description } : {}),
    ...(parseFrontmatterBoolean(record["disable-model-invocation"]) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(parseFrontmatterBoolean(record["user-invocable"]) === false
      ? { userInvocable: false }
      : {}),
  };
}

/**
 * Where an administrator installs the policy file whose settings outrank every
 * user and project one. Absent on almost every machine, which is why a missing
 * file is the normal case rather than an error.
 */
function claudeManagedSettingsPath(
  path: Path.Path,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (platform === "win32") {
    const programData = environment.PROGRAMDATA?.trim();
    return programData ? path.join(programData, "ClaudeCode", "managed-settings.json") : undefined;
  }
  return "/etc/claude-code/managed-settings.json";
}

/**
 * Settings files Claude Code merges for `skillOverrides`, in increasing
 * precedence: user, project, project-local, then the administrator's managed
 * policy, which wins outright. When the workspace sits inside a git
 * repository, the repository root's `settings.local.json` is read too and
 * outranks the workspace's own local file. Verified against the CLI from a
 * nested cwd: a root local file switching a skill off wins over a cwd one
 * switching it on, the root's plain `settings.json` is not consulted, and
 * without a `.git` above the cwd no root file is read. A skill the user
 * switched off is reported disabled rather than dropped, so the picker can
 * grey it out instead of silently losing it.
 */
export function skillOverrideSettingsPaths(
  path: Path.Path,
  configDirPath: string,
  cwd: string | undefined,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  repositoryRoot?: string,
): ReadonlyArray<string> {
  const managedPath = claudeManagedSettingsPath(path, platform, environment);
  const root = repositoryRoot !== undefined && repositoryRoot !== cwd ? repositoryRoot : undefined;
  return [
    path.join(configDirPath, "settings.json"),
    ...(cwd
      ? [
          path.join(cwd, ".claude", "settings.json"),
          path.join(cwd, ".claude", "settings.local.json"),
        ]
      : []),
    ...(root ? [path.join(root, ".claude", "settings.local.json")] : []),
    ...(managedPath ? [managedPath] : []),
  ];
}

/**
 * Nearest ancestor of `cwd` (inclusive) holding a `.git` entry, which is the
 * boundary Claude Code walks up to for project settings. `undefined` outside
 * a repository.
 */
const findRepositoryRoot = Effect.fn("findRepositoryRoot")(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(cwd);
  while (true) {
    const isRoot = yield* fileSystem
      .exists(path.join(current, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isRoot) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
});

/**
 * The four states Claude Code accepts. The CLI validates the whole map, not
 * each entry: verified against it, one entry with an unknown value (or a
 * boolean) makes it drop every override in that file, so this schema does the
 * same rather than applying the valid siblings the CLI ignores.
 */
const SkillOverrideValue = Schema.Literals(["on", "name-only", "user-invocable-only", "off"]);

// Lenient because these settings files are hand-edited and Claude Code itself
// tolerates comments and trailing commas in them.
const SkillOverrideSettings = fromLenientJson(
  Schema.Struct({
    skillOverrides: Schema.optional(Schema.Record(Schema.String, SkillOverrideValue)),
  }),
);
const decodeSkillOverrideSettings = Schema.decodeUnknownEffect(SkillOverrideSettings);

// Decoded apart from `skillOverrides` so one malformed map never takes the
// other down with it. Values are left unknown and compared to `true` below:
// a stray non-boolean should drop that entry, not the file.
const EnabledPluginSettings = fromLenientJson(
  Schema.Struct({
    enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodeEnabledPluginSettings = Schema.decodeUnknownEffect(EnabledPluginSettings);

/**
 * `<config dir>/plugins/installed_plugins.json`, keyed by `name@marketplace`.
 * Version 2 keeps one record per install scope; version 1 kept a single
 * record. Only the install path is needed to find the plugin's skills.
 */
const PluginInstallRecord = Schema.Struct({ installPath: Schema.String });
const InstalledPlugins = fromLenientJson(
  Schema.Struct({
    plugins: Schema.optional(
      Schema.Record(
        Schema.String,
        Schema.Union([Schema.Array(PluginInstallRecord), PluginInstallRecord]),
      ),
    ),
  }),
);
const decodeInstalledPlugins = Schema.decodeUnknownEffect(InstalledPlugins);

/**
 * `.claude-plugin/plugin.json`. Verified against the CLI: the manifest `name`
 * is the prefix skills are published under even when it differs from the
 * install key, and `skills` adds roots alongside the default `skills/`
 * directory rather than replacing it.
 */
const PluginManifest = fromLenientJson(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    skills: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  }),
);
const decodePluginManifest = Schema.decodeUnknownEffect(PluginManifest);

/**
 * What a `skillOverrides` entry says about one skill. `"user-invocable-only"`
 * hides it from the agent exactly as `disable-model-invocation` does, so it is
 * kept apart from a plain on/off decision rather than collapsed into one.
 */
type SkillOverride = {
  readonly enabled: boolean;
  readonly userInvocationOnly: boolean;
};

function parseSkillOverride(value: typeof SkillOverrideValue.Type): SkillOverride {
  switch (value) {
    case "off":
      return { enabled: false, userInvocationOnly: false };
    case "user-invocable-only":
      return { enabled: true, userInvocationOnly: true };
    case "on":
    case "name-only":
      return { enabled: true, userInvocationOnly: false };
  }
}

/**
 * What the settings chain says about skills: per-skill overrides, and the
 * `name@marketplace` keys of plugins switched on. Verified against the CLI: a
 * plugin enabled only in the workspace's `.claude/settings.json` loads from
 * that cwd, so both maps read the same files with the same precedence.
 */
const readSkillSettings = Effect.fn("readSkillSettings")(function* (
  configDirPath: string,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  {
    readonly skillOverrides: ReadonlyMap<string, SkillOverride>;
    readonly enabledPlugins: ReadonlySet<string>;
  },
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const overridesByName = new Map<string, SkillOverride>();
  const enabledPlugins = new Set<string>();
  const repositoryRoot = cwd === undefined ? undefined : yield* findRepositoryRoot(cwd);

  for (const settingsPath of skillOverrideSettingsPaths(
    path,
    configDirPath,
    cwd,
    platform,
    environment,
    repositoryRoot,
  )) {
    const contents = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) {
      continue;
    }

    const parsed = yield* decodeSkillOverrideSettings(contents).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("claude settings file is unreadable; ignoring skillOverrides", {
          path: settingsPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    for (const [name, value] of Object.entries(parsed?.skillOverrides ?? {})) {
      overridesByName.set(name, parseSkillOverride(value));
    }

    const pluginSettings = yield* decodeEnabledPluginSettings(contents).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    for (const [key, value] of Object.entries(pluginSettings?.enabledPlugins ?? {})) {
      if (value === true) {
        enabledPlugins.add(key);
      } else {
        enabledPlugins.delete(key);
      }
    }
  }

  return { skillOverrides: overridesByName, enabledPlugins };
});

type ClaudeSkillRoot = {
  readonly directory: string;
  readonly scope: ClaudeSkillScope;
  /** Plugin name the CLI prefixes onto every skill in this root, as `<prefix>:<skill>`. */
  readonly namePrefix?: string;
};

/**
 * Skill roots of every enabled plugin, from the install registry the CLI
 * writes. Verified against the CLI: an installed plugin absent from
 * `enabledPlugins` publishes nothing, a plugin without a manifest is named by
 * its install key, and the first install record is the one that loads.
 */
const discoverPluginSkillRoots = Effect.fn("discoverClaudePluginSkillRoots")(function* (
  configDirPath: string,
  enabledPlugins: ReadonlySet<string>,
): Effect.fn.Return<ReadonlyArray<ClaudeSkillRoot>, never, FileSystem.FileSystem | Path.Path> {
  if (enabledPlugins.size === 0) {
    return [];
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const registryPath = path.join(configDirPath, "plugins", "installed_plugins.json");
  const contents = yield* fileSystem
    .readFileString(registryPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (contents === undefined) {
    return [];
  }
  const registry = yield* decodeInstalledPlugins(contents).pipe(
    Effect.tapError((cause) =>
      Effect.logDebug("claude plugin registry is unreadable; ignoring plugin skills", {
        path: registryPath,
        cause,
      }),
    ),
    Effect.orElseSucceed(() => undefined),
  );

  const roots: Array<ClaudeSkillRoot> = [];
  const pluginEntries = Object.entries(registry?.plugins ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [key, records] of pluginEntries) {
    if (!enabledPlugins.has(key)) {
      continue;
    }
    const record = Array.isArray(records) ? records[0] : records;
    const installPath = record?.installPath.trim();
    if (!installPath) {
      continue;
    }

    const manifest = yield* fileSystem
      .readFileString(path.join(installPath, ".claude-plugin", "plugin.json"))
      .pipe(
        Effect.flatMap((manifestContents) => decodePluginManifest(manifestContents)),
        Effect.orElseSucceed(() => undefined),
      );
    const namePrefix = manifest?.name?.trim() || key.split("@")[0]?.trim();
    if (!namePrefix) {
      continue;
    }

    const manifestSkillPaths =
      manifest?.skills === undefined
        ? []
        : typeof manifest.skills === "string"
          ? [manifest.skills]
          : manifest.skills;
    const directories = new Set<string>();
    for (const skillPath of ["skills", ...manifestSkillPaths]) {
      directories.add(path.resolve(installPath, skillPath));
    }
    for (const directory of directories) {
      roots.push({ directory, scope: "plugin", namePrefix });
    }
  }
  return roots;
});

/**
 * Resolve the Claude config directory the CLI would use, matching the
 * precedence the spawned CLI sees: the instance's `homePath` (exported as
 * `CLAUDE_CONFIG_DIR` by `makeClaudeEnvironment`), then a `CLAUDE_CONFIG_DIR`
 * already present in the process environment, then `~/.claude`.
 */
const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
  }
  // No tilde expansion here: the spawned CLI receives this env var verbatim
  // (env vars are never shell-expanded), so a literal `~` must stay literal
  // for discovery to scan the same directory the runtime would. A relative
  // value is resolved against the workspace cwd — the subprocess's own cwd —
  // for the same reason.
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  return path.join(NodeOS.homedir(), ".claude");
});

/**
 * Enumerate Claude Code skills from the user config dir, the workspace
 * `.claude/skills`, and enabled plugins. Discovery is best-effort: unreadable
 * roots and malformed skill entries are skipped so a broken skill never
 * degrades the provider snapshot. Roots are listed highest precedence first
 * and the first hit for a name wins, matching Claude Code: verified against
 * the CLI with the same skill name in both scopes, the user copy is the one
 * that runs. Reporting the project copy instead would attach its invocation
 * metadata to a command Claude Code resolves elsewhere.
 */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd);
  const { skillOverrides, enabledPlugins } = yield* readSkillSettings(
    configDirPath,
    cwd,
    environment ?? process.env,
  );

  const roots: ReadonlyArray<ClaudeSkillRoot> = [
    { directory: path.join(configDirPath, "skills"), scope: "user" },
    ...(cwd ? [{ directory: path.join(cwd, ".claude", "skills"), scope: "project" as const }] : []),
    ...(yield* discoverPluginSkillRoots(configDirPath, enabledPlugins)),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      // Malformed frontmatter means the skill won't load in Claude Code
      // either — skip it rather than surfacing a broken entry under its
      // directory name.
      if (frontmatter.kind === "malformed") {
        continue;
      }

      // Claude Code identifies a skill by its directory, not by the
      // frontmatter `name`: verified against the CLI, a skill in `probe-alias/`
      // declaring `name: probe-alias-frontmatter` is published as
      // `probe-alias`, and only `skillOverrides["probe-alias"]` switches it
      // off. Keying off the frontmatter name would report a command that does
      // not exist and miss the override that disables it. Plugin skills get
      // the plugin's name in front, as the CLI publishes them.
      const skillName = entry.trim();
      if (!skillName) {
        continue;
      }
      const name = root.namePrefix ? `${root.namePrefix}:${skillName}` : skillName;

      // First root wins, so a later root never displaces a higher-precedence
      // skill of the same name.
      if (skillsByName.has(name)) {
        continue;
      }

      // Verified against the CLI: `skillOverrides` leaves plugin skills alone
      // under both `<plugin>:<skill>` and bare `<skill>` keys, while the same
      // `off` drops a user skill. Applying it here would grey out a skill that
      // still runs.
      const override = root.scope === "plugin" ? undefined : skillOverrides.get(name);
      const userInvocationOnly =
        (frontmatter.kind === "parsed" && frontmatter.userInvocationOnly === true) ||
        override?.userInvocationOnly === true;
      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: override?.enabled ?? true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
        ...(userInvocationOnly ? { userInvocationOnly: true } : {}),
        ...(frontmatter.kind === "parsed" && frontmatter.userInvocable === false
          ? { userInvocable: false }
          : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
