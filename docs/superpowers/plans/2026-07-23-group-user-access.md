# Group User Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace group-wide chat access with per-group sender allow and deny maps for both human and bot senders.

**Architecture:** Normalize the two maps into the canonical profile configuration, enforce them in the single `canUseGroup` policy entry point, and include them in the stable access-policy digest. Remove the obsolete chat-wide management surfaces so every group message follows owner/admin bypass, deny-first, allow-second, fail-closed behavior in both deployment modes.

**Tech Stack:** TypeScript, Vitest, pnpm, tsup

---

## File Map

- `src/config/schema.ts`: public optional access input shape.
- `src/config/profile-schema.ts`: canonical access shape and normalization.
- `src/policy/access.ts`: group authorization decision order and reasons.
- `src/policy/fingerprint.ts`: stable digest of both group maps.
- `src/bot/channel.ts`: silent handling for rejected group senders.
- `src/commands/index.ts`: remove obsolete group-wide invite/remove behavior and card inputs.
- `src/card/config-card.ts`: remove obsolete allowed-chat display and team-mode bypass claims.
- `src/bot/wizard.ts`: update default access documentation.
- `README.md`, `README.zh.md`: document direct configuration and sender semantics.
- Focused unit and integration tests listed in the tasks below.

### Task 1: Canonical Configuration Maps

**Files:**
- Modify: `tests/unit/config/profile-schema.test.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/profile-schema.ts`
- Modify: `tests/unit/config/profile-store.test.ts`
- Modify: `tests/integration/config/profile-migration.test.ts`
- Modify: `tests/unit/runtime/profile-runtime.test.ts`

- [x] **Step 1: Write failing normalization tests**

Add expectations showing that a valid configuration normalizes to:

```ts
expect(cfg.access).toEqual({
  allowedUsers: [],
  groupAllowedUsers: {
    oc_group_a: ['ou_user', 'ou_bot'],
  },
  groupDenyUsers: {
    oc_group_a: ['ou_blocked'],
  },
  admins: [],
  requireMentionInGroup: true,
});
```

Add a malformed-input case proving non-array map values, empty chat IDs, and non-string sender IDs are discarded. Add an old-config case proving `allowedChats` is absent from normalized output and both new maps default to `{}`.

- [x] **Step 2: Verify the tests fail for the missing fields**

Run:

```bash
pnpm vitest run tests/unit/config/profile-schema.test.ts
```

Expected: FAIL because `ProfileAccess` and normalized output do not contain `groupAllowedUsers` or `groupDenyUsers`.

- [x] **Step 3: Implement the canonical fields and normalizer**

Change the public and canonical shapes to:

```ts
export interface AppAccess {
  allowedUsers?: string[];
  groupAllowedUsers?: Record<string, string[]>;
  groupDenyUsers?: Record<string, string[]>;
  admins?: string[];
}

export interface ProfileAccess {
  allowedUsers: string[];
  groupAllowedUsers: Record<string, string[]>;
  groupDenyUsers: Record<string, string[]>;
  admins: string[];
  requireMentionInGroup: boolean;
}
```

Add a focused helper that accepts only a non-array object, trims non-empty chat IDs, and normalizes each value through the existing string-array rules. Do not read or emit `allowedChats`.

- [x] **Step 4: Update persisted-config fixtures**

Replace every expected `allowedChats` field in profile store, migration, and runtime tests with both canonical maps. Preserve the tests' existing purpose: round-trip, migration, or runtime projection.

- [x] **Step 5: Verify configuration tests pass**

Run:

```bash
pnpm vitest run tests/unit/config/profile-schema.test.ts tests/unit/config/profile-store.test.ts tests/integration/config/profile-migration.test.ts tests/unit/runtime/profile-runtime.test.ts
```

Expected: PASS.

### Task 2: Deny-First Group Policy

**Files:**
- Modify: `tests/unit/policy/access.test.ts`
- Modify: `src/policy/access.ts`
- Modify: `tests/integration/bot/bot-at-bot-context.test.ts`
- Modify: `tests/integration/bot/topic-quote.test.ts`
- Modify: `tests/integration/bot/claude-security.test.ts`
- Modify: `tests/integration/bot/markdown-stream-startup-failure.test.ts`
- Modify: `tests/integration/card/callback-dispatch.test.ts`

- [x] **Step 1: Write failing policy tests**

Replace the old allowed-chat case with separate tests that assert:

```ts
expect(canUseGroup(profileWithAccess({
  groupAllowedUsers: { chat_a: ['ou_user', 'ou_bot'] },
}), ownerControls, 'chat_a', 'ou_user')).toEqual({
  ok: true,
  reason: 'allowed-group-user',
});

expect(canUseGroup(profileWithAccess({
  groupAllowedUsers: { chat_a: ['ou_user'] },
  groupDenyUsers: { chat_a: ['ou_user'] },
}), ownerControls, 'chat_a', 'ou_user')).toEqual({
  ok: false,
  reason: 'denied-group-user',
});
```

Cover different-group isolation, missing group, owner/admin bypass even when denied, and `team` mode denial for an unlisted sender. Represent a bot sender with an `ou_bot` ID in the integration context test to prove it reaches the agent when allowlisted.

- [x] **Step 2: Verify the policy tests fail**

Run:

```bash
pnpm vitest run tests/unit/policy/access.test.ts tests/integration/bot/bot-at-bot-context.test.ts
```

Expected: FAIL because group access still checks `mode` and `allowedChats`.

- [x] **Step 3: Implement the group decision order**

Update `AccessDecision['reason']` and `canUseGroup`:

```ts
if (isCreator(controls, senderId)) return allow('owner');
if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
if (profile.access.groupDenyUsers[chatId]?.includes(senderId)) {
  return deny('denied-group-user');
}
if (profile.access.groupAllowedUsers[chatId]?.includes(senderId)) {
  return allow('allowed-group-user');
}
return deny('denied-group-user');
```

Do not add a team-mode bypass and do not branch on human versus bot sender type.

- [x] **Step 4: Update group integration fixtures**

For each test that previously used `allowedChats: ['oc_group']`, set the matching sender under that chat ID in `groupAllowedUsers`. Keep each test's sender and chat IDs unchanged.

- [x] **Step 5: Verify policy and affected integrations pass**

Run:

```bash
pnpm vitest run tests/unit/policy/access.test.ts tests/integration/bot/bot-at-bot-context.test.ts tests/integration/bot/topic-quote.test.ts tests/integration/bot/claude-security.test.ts tests/integration/bot/markdown-stream-startup-failure.test.ts tests/integration/card/callback-dispatch.test.ts
```

Expected: PASS.

### Task 3: Stable Access Policy Digest

**Files:**
- Modify: `tests/unit/policy/fingerprint.test.ts`
- Modify: `src/policy/fingerprint.ts`

- [x] **Step 1: Write failing digest tests**

Build equivalent access objects with reversed group-key insertion order and reversed sender-array order. Assert equal digests. Then change one deny entry and assert a different digest.

- [x] **Step 2: Verify the digest test fails**

Run:

```bash
pnpm vitest run tests/unit/policy/fingerprint.test.ts
```

Expected: FAIL because the new maps are not included in the digest.

- [x] **Step 3: Canonicalize both maps in the digest**

Add a helper equivalent to:

```ts
function sortedAccessMap(map: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(map)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([chatId, senders]) => [chatId, [...senders].sort()]),
  );
}
```

Hash `groupAllowedUsers` and `groupDenyUsers`; remove `allowedChats`.

- [x] **Step 4: Verify digest tests pass**

Run:

```bash
pnpm vitest run tests/unit/policy/fingerprint.test.ts
```

Expected: PASS.

### Task 4: Remove Obsolete Group-Wide Management and Hints

**Files:**
- Modify: `tests/integration/commands/commands-v1.test.ts`
- Modify: `src/commands/index.ts`
- Modify: `src/card/config-card.ts`
- Modify: `src/bot/channel.ts`
- Modify: `src/bot/wizard.ts`
- Modify: `tests/unit/docs/readme-contract.test.ts`

- [x] **Step 1: Write failing surface-removal assertions**

Change command tests so `/invite` and `/remove` continue managing only DM users and admins. Assert configuration cards and maintained docs do not contain `/invite group`, `/invite all group`, `/remove group`, `allowedChats`, or the claim that team mode disables access control.

Add or update an intake test so a denied, mentioned group sender produces no outgoing hint message.

- [x] **Step 2: Verify the surface tests fail**

Run:

```bash
pnpm vitest run tests/integration/commands/commands-v1.test.ts tests/unit/docs/readme-contract.test.ts
```

Expected: FAIL because old group commands and copy remain.

- [x] **Step 3: Remove group-wide command branches**

Limit `/invite` and `/remove` parsing to `user|admin`, delete `all group` handling, and remove writes and metrics for `allowedChats`. When legacy single-file configuration is saved, project both group maps:

```ts
access: {
  allowedUsers: access.allowedUsers,
  groupAllowedUsers: access.groupAllowedUsers,
  groupDenyUsers: access.groupDenyUsers,
  admins: access.admins,
}
```

- [x] **Step 4: Remove old card and runtime hint behavior**

Remove `allowedChats` and `knownChats` from `ConfigFormOpts`, the chat-list renderer, and card summaries. Replace team-mode text with copy stating that group sender maps still apply. Delete `sendNonAllowedGroupHint` and its denied-group call site so rejected senders are always silent.

Update the wizard comment to name the two group maps.

- [x] **Step 5: Verify command and card tests pass**

Run:

```bash
pnpm vitest run tests/integration/commands/commands-v1.test.ts tests/unit/docs/readme-contract.test.ts tests/integration/commands/profile-config-command.test.ts
```

Expected: PASS.

### Task 5: Documentation and Complete Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: any remaining test fixture found by the repository-wide scan

- [x] **Step 1: Update both README access-control sections**

Document that `allowedUsers` is for DMs, both group maps are keyed by `chat_id`, values may contain human or bot `open_id` values, owner/admin bypass both maps, deny wins, missing entries deny, and team mode still checks group maps. Remove all group-wide invite/remove instructions and the non-allowed-group hint exception.

- [x] **Step 2: Verify the obsolete field is gone**

Run:

```bash
rg -n "allowedChats|allowed_chats|/invite group|/invite all group|/remove group" src tests README.md README.zh.md
```

Expected: no matches except the three legacy-normalization assertions in
`tests/unit/config/profile-schema.test.ts` that prove `allowedChats` is ignored.

- [x] **Step 3: Run focused access and configuration tests**

Run:

```bash
pnpm vitest run tests/unit/config/profile-schema.test.ts tests/unit/policy/access.test.ts tests/unit/policy/fingerprint.test.ts tests/integration/bot/bot-at-bot-context.test.ts tests/integration/commands/commands-v1.test.ts tests/unit/docs/readme-contract.test.ts
```

Expected: PASS.

- [x] **Step 4: Run full project verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: every command exits 0 with no failed tests or TypeScript/build errors.

- [x] **Step 5: Review the final diff against the design**

Confirm the diff contains no management UI for the new maps, no unrelated refactor, and no changes to direct-message or admin-command semantics.
