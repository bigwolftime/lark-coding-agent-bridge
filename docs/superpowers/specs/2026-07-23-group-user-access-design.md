# Group User Access Design

## Goal

Replace chat-wide group access with per-group sender allowlists and denylists. Group messages from non-owner, non-admin senders must be explicitly allowed for that group, and a deny entry always wins over an allow entry.

## Configuration

`ProfileAccess` removes `allowedChats` and adds two maps keyed by Feishu/Lark `chat_id`:

```json
{
  "access": {
    "allowedUsers": ["ou_dm_user"],
    "groupAllowedUsers": {
      "oc_group_a": ["ou_human_1", "ou_bot_1"],
      "oc_group_b": ["ou_human_2"]
    },
    "groupDenyUsers": {
      "oc_group_a": ["ou_bot_2"]
    },
    "admins": ["ou_admin"],
    "requireMentionInGroup": false
  }
}
```

Map values contain sender `open_id` values. Human users and bots use the same representation. Missing maps normalize to empty objects. Invalid map entries are discarded using the same fail-closed principle as the existing access configuration.

There is no compatibility migration for `allowedChats`. The removed field is ignored when old configuration is loaded, so non-owner and non-admin group senders remain denied until the new allowlist is configured.

## Access Policy

Direct messages keep the existing policy based on owner, deployment mode, `allowedUsers`, and `admins`.

Group messages use this fixed order in both `personal` and `team` modes:

1. Allow the runtime application owner.
2. Allow configured admins.
3. Deny a sender listed in `groupDenyUsers[chatId]`.
4. Allow a sender listed in `groupAllowedUsers[chatId]`.
5. Deny every other sender.

Owner and admin access is unconditional, including when their IDs appear in a group denylist. For ordinary senders, the denylist takes precedence when an ID appears in both maps.

Denied messages continue through the existing silent-drop path. The group mention setting remains a later, independent gate for senders who pass access control.

## Bot Senders

The policy compares sender `open_id` values and does not distinguish human and bot senders. Existing message normalization retains `sender_type=app|bot`, so explicitly allowed third-party bots can trigger the bridge and explicitly denied bots are rejected.

The bridge's own bot should not be allowlisted because that could create a self-trigger loop. Operators must also avoid mutually triggering bot configurations.

## Configuration Surfaces

This change supports direct `config.json` editing only. It does not add commands or configuration-card controls for the new maps.

Existing `/invite group`, `/invite all group`, and `/remove group` behavior and the configuration-card section backed by `allowedChats` are removed because the underlying chat-wide field no longer exists. Direct-message user and admin management remain unchanged.

## Policy Fingerprint

The access policy digest includes both group maps. Map keys and each value list are sorted before hashing so semantically identical configurations produce the same digest regardless of object or array order.

## Testing

Focused tests cover:

- normalization of missing, valid, and malformed group maps;
- owner and admin bypass;
- denial when a group or sender has no allow entry;
- isolation of allowlists between groups;
- denylist precedence over allowlist;
- identical group behavior in `personal` and `team` modes;
- human and bot sender IDs using the same policy;
- stable and change-sensitive access policy digests;
- removal of `allowedChats` from stored configuration, documentation, commands, and configuration cards.

Implementation follows red-green-refactor: policy and schema expectations are added first and observed failing before production code changes.
