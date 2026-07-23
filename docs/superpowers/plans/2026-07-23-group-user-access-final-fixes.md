# Group User Access Final Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three remaining group-user access boundary gaps in config normalization, policy validation, and saved-card messaging.

**Architecture:** Keep each fix at its existing ownership boundary: normalize group sender maps in the profile schema, reject incomplete group identities in the access policy before privileged bypasses, and conditionally render the saved access summary in the card builder. Preserve existing personal-mode and owner/admin behavior for valid inputs.

**Tech Stack:** TypeScript, Vitest, tsup

---

### Task 1: Normalize Group Sender IDs

**Files:**
- Modify: `tests/unit/config/profile-schema.test.ts`
- Modify: `src/config/profile-schema.ts`

- [x] **Step 1: Write the failing test**

Add a focused schema test whose group allow/deny lists include padded sender IDs, whitespace-only entries, and sender IDs that collide after trimming. Assert trimmed, non-empty, insertion-ordered unique output while retaining the existing normalized chat-key merge behavior.

- [x] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run tests/unit/config/profile-schema.test.ts`

Expected: FAIL because padded and whitespace-only sender values are currently preserved.

- [x] **Step 3: Write minimal implementation**

Within `groupSenderMap`, replace the use of the general `stringArray` result with sender-specific normalization equivalent to:

```ts
const normalizedSenders = senders
  .filter((sender): sender is string => typeof sender === 'string')
  .map((sender) => sender.trim())
  .filter(Boolean);
```

Keep `stringArray` unchanged so `allowedUsers` and `admins` retain their current behavior.

- [x] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run tests/unit/config/profile-schema.test.ts`

Expected: PASS, including the existing chat collision and `__proto__` safety tests.

### Task 2: Reject Missing Group Identity Before Bypass

**Files:**
- Modify: `tests/unit/policy/access.test.ts`
- Modify: `src/policy/access.ts`

- [x] **Step 1: Write the failing test**

Add policy assertions showing both personal and team profiles deny owner calls with empty/whitespace chat IDs and admin calls with empty/whitespace sender IDs, returning `{ ok: false, reason: 'denied-group-user' }`.

- [x] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run tests/unit/policy/access.test.ts`

Expected: FAIL because owner/admin checks currently run before group identity validation.

- [x] **Step 3: Write minimal implementation**

At the start of `canUseGroup`, add:

```ts
if (!chatId.trim() || !senderId.trim()) return deny('denied-group-user');
```

Leave the valid owner/admin bypass ordering unchanged after this guard.

- [x] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run tests/unit/policy/access.test.ts`

Expected: PASS with invalid identities denied and valid owner/admin bypass behavior preserved.

### Task 3: Render Team Saved-Card Access Semantics

**Files:**
- Modify: `tests/unit/card/config-card.test.ts`
- Modify: `src/card/config-card.ts`

- [x] **Step 1: Write the failing test**

Import and render `configSavedCard` for both modes. Assert team output states that DMs are open to everyone and group senders remain governed by `groupAllowedUsers/groupDenyUsers`, without the personal allowlist label; assert personal output retains allowed-users and admins summaries.

- [x] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run tests/unit/card/config-card.test.ts`

Expected: FAIL because the saved team card currently renders the personal allowlist summary.

- [x] **Step 3: Write minimal implementation**

Build an access summary string conditional on `opts.mode`: team mode reuses the form card's exact DM/group semantics plus the admins summary, while personal mode preserves the existing allowed-users and admins lines. Substitute that string into the saved-card markdown.

- [x] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run tests/unit/card/config-card.test.ts`

Expected: PASS for both form-card and saved-card mode semantics.

### Task 4: Final Verification And Commit

**Files:**
- Verify all files changed above

- [x] **Step 1: Run focused regression tests**

Run the three direct unit files plus all tests that reference group access fields or decisions.

- [x] **Step 2: Run static and build checks**

Run `./node_modules/.bin/tsc --noEmit`, `./node_modules/.bin/tsup`, and `git diff --check`.

- [x] **Step 3: Scan legacy fields and self-review**

Search source and relevant tests for stale group access field names, inspect `git diff --stat`, `git diff`, and `git status --short`, and confirm no README or management UI changes.

- [x] **Step 4: Commit**

Stage only the planned files and commit with `BugFix: 完善群聊名单边界处理`.
