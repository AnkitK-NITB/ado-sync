# ADO Sync — Teams app package

`ado-sync-teams-app.zip` is sideloadable as-is. It is a **shell**: the tab opens and shows real
engine output, but Approve is not wired to a backend, so nothing here can write to Azure DevOps.

## What is in the zip

Teams requires these three files at the **root** of the archive, not inside a folder:

| File | Purpose |
|---|---|
| `manifest.json` | App definition, schema v1.17 |
| `color.png` | 192×192, opaque |
| `outline.png` | 32×32, transparent background, white glyph only |

`index.html` is deliberately **not** in the zip — it is the tab content, which Teams loads over
HTTPS from wherever you host it.

## Sideloading

1. Teams → **Apps** → **Manage your apps** → **Upload an app** → **Upload a custom app**
2. Select `ado-sync-teams-app.zip`

Custom app upload is already confirmed available in this tenant.

## Making the tab load

**This is why the tab is blank.** `contentUrl` is `https://localhost:53000`, and Teams will not
render a tab over plain HTTP — it fails silently, showing an empty tab with no error. It also will
not render a certificate it does not trust.

```powershell
powershell -ExecutionPolicy Bypass -File setup-dev-cert.ps1   # once
node serve.js                                                  # each session
```

`setup-dev-cert.ps1` creates a self-signed certificate for localhost and adds it to **your own**
trusted roots (`Cert:\CurrentUser\Root`) — no administrator rights, and no effect on other accounts
on the machine. It is the same approach the Microsoft 365 Agents Toolkit uses. `serve.js` picks up
`devcert.pfx` automatically and switches to HTTPS.

Undo at any time with `.\setup-dev-cert.ps1 -Remove`, which deletes the certificate from both
stores and removes the exported files.

Without the certificate, `serve.js` falls back to plain HTTP. A browser renders that fine, which is
useful for previewing, but Teams will not.

## Pages

| Tab | File | What it shows |
|---|---|---|
| **Home** | `index.html` | What the app does, how it decides, honest per-component status, and an open counter stored in `localStorage` on this device only |
| **Meeting** | `meeting.html` | The cards, with Approve, Edit, Pick and Skip wired to real actions |
| **Meetings** | `index.html` | Watch list, WorkIQ sync, transcript upload, meeting tiles of the pipeline, for presenting |

## Rebuilding the zip after editing the manifest

Validate first — the schema sets `additionalProperties: false` at several levels, so one unknown
key is a hard rejection at upload time:

```powershell
node validate-manifest.js
Compress-Archive -Path manifest.json,color.png,outline.png `
  -DestinationPath ..\ado-sync-teams-app.zip -Force
```

`validate-manifest.js` fetches the published schema for whichever `manifestVersion` the manifest
declares, then checks unknown properties, missing required ones, enums, string lengths and
patterns, plus the actual pixel dimensions of both icons — which the schema itself cannot see.
It exits non-zero on failure, so it can gate packaging.

Note that `packageName` is **not** valid in v1.17. It existed in older manifest versions and is a
easy one to carry over by habit; the validator catches it.

Keep the three files at the archive root. A nested folder is the other common reason Teams rejects
a package.

## What the tab shows

**Home** explains the product, lists the matching rules in plain language, and gives an honest
per-component status — including that writes are disabled in this build.

**Today** shows the consolidated card for PBI 10001001, real output from the engine against live
`contoso/Engineering` work items from the 16 September standup:

- six spoken topics on one work item, one card, one comment
- each update tagged DONE / NEXT / IN PROGRESS
- the vocabulary repair surfaced as *Heard "ACME SDK" — matched as AcmeSDK. Accept into the text?*
- the corroboration line explaining why the match was settled
- what was deliberately kept out of Azure DevOps, and why

Approve shows the patch it would send. It sends nothing.

## Before this is more than a shell

`id` is a placeholder GUID generated for local sideloading. Register a real app in Microsoft Entra
for Phase 3 and use that application ID, or the on-behalf-of exchange will not work.
